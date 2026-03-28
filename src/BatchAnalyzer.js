import { normalizeMerchantName } from "./util.js";

export default class BatchAnalyzer {
    #fireflyService;
    #categoriesCache;
    #classificationEngine;
    #merchantMemory;
    #jobList;
    #configStore;

    constructor({ fireflyService, categoriesCache, classificationEngine, merchantMemory, jobList, configStore }) {
        this.#fireflyService = fireflyService;
        this.#categoriesCache = categoriesCache;
        this.#classificationEngine = classificationEngine;
        this.#merchantMemory = merchantMemory;
        this.#jobList = jobList;
        this.#configStore = configStore;
    }

    async analyze(onProgress = null) {
        if (onProgress) onProgress({ phase: "fetching", message: "Fetching transactions from Firefly..." });

        const transactions = await this.#fireflyService.getUncategorizedTransactions((p) => {
            if (onProgress) onProgress({ phase: "fetching", page: p.page, totalPages: p.totalPages, fetchedSoFar: p.fetchedSoFar });
        });

        const categories = await this.#categoriesCache.getCategories();
        const batchSize = this.#configStore?.getBatchClassifySize?.() || 20;

        const proposals = [];
        const unmatchedMerchants = {};
        let skipped = 0;
        let processed = 0;
        let errorCount = 0;

        // Separate: already processed (skip) vs need classification
        const toClassify = [];
        for (const txn of transactions) {
            const first = txn.attributes?.transactions?.[0];
            if (!first) continue;

            const fireflyTxnId = String(txn.id);
            const destinationName = first.destination_name || "";
            const description = first.description || "";

            if (this.#jobList.isAlreadyProcessed(fireflyTxnId)) {
                skipped++;
                processed++;
                continue;
            }

            toClassify.push({ txn, fireflyTxnId, destinationName, description });
        }

        const total = transactions.length;
        if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: 0, current: `${toClassify.length} transactions to classify in batches of ${batchSize}` });

        // Process in batches
        for (let i = 0; i < toClassify.length; i += batchSize) {
            const chunk = toClassify.slice(i, i + batchSize);
            const batchNum = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(toClassify.length / batchSize);

            let batchResults;
            try {
                batchResults = await this.#classificationEngine.classifyBatch(
                    chunk.map(c => ({ destinationName: c.destinationName, description: c.description })),
                    { dryRun: true }
                );
            } catch (err) {
                errorCount += chunk.length;
                processed += chunk.length;
                if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Batch ${batchNum}/${totalBatches}`, lastError: err.message });
                continue;
            }

            batchResults.forEach((result, j) => {
                const item = chunk[j];
                if (result.category && categories.has(result.category)) {
                    proposals.push({
                        fireflyTxnId: item.fireflyTxnId, destinationName: item.destinationName, description: item.description,
                        proposedCategory: result.category, categoryId: result.categoryId ?? categories.get(result.category),
                        confidence: result.confidence, source: result.source, isNewCategory: false,
                    });
                } else {
                    proposals.push({
                        fireflyTxnId: item.fireflyTxnId, destinationName: item.destinationName, description: item.description,
                        proposedCategory: result.response || null, categoryId: null,
                        confidence: result.confidence, source: result.source, isNewCategory: false, needsReview: true,
                    });

                    const normName = normalizeMerchantName(item.destinationName);
                    if (!unmatchedMerchants[normName]) {
                        unmatchedMerchants[normName] = { count: 0, rawName: item.destinationName, aiSuggestions: [] };
                    }
                    unmatchedMerchants[normName].count++;
                    if (result.response) unmatchedMerchants[normName].aiSuggestions.push(result.response);
                }
            });

            processed += chunk.length;
            if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Batch ${batchNum}/${totalBatches} (${chunk.map(c => c.destinationName).slice(0, 3).join(", ")}...)` });
        }

        const newCategoryProposals = [];
        for (const [normName, data] of Object.entries(unmatchedMerchants)) {
            if (data.count >= 3) {
                newCategoryProposals.push({
                    merchantName: data.rawName, normalizedName: normName,
                    transactionCount: data.count,
                    suggestedCategoryName: this.#mostCommon(data.aiSuggestions) || data.rawName,
                });
            }
        }

        const categoryGroups = {};
        for (const p of proposals) {
            const cat = p.proposedCategory || "(unmatched)";
            if (!categoryGroups[cat]) categoryGroups[cat] = { count: 0, merchants: new Set() };
            categoryGroups[cat].count++;
            categoryGroups[cat].merchants.add(p.destinationName);
        }

        const summary = Object.entries(categoryGroups).map(([cat, data]) => ({
            category: cat, transactionCount: data.count,
            uniqueMerchants: data.merchants.size,
            merchants: Array.from(data.merchants).slice(0, 10),
        }));

        return {
            totalTransactions: transactions.length, totalProposals: proposals.length,
            skipped, errors: errorCount,
            proposals, newCategoryProposals, summary,
            existingCategories: Array.from(categories.keys()),
        };
    }

    async apply(approvedProposals, newCategoriesToCreate = [], onProgress = null) {
        for (const catName of newCategoriesToCreate) {
            try { await this.#fireflyService.createCategory(catName); }
            catch (error) { console.error(`Failed to create category "${catName}": ${error.message}`); }
        }

        this.#categoriesCache.invalidate();
        const categories = await this.#categoriesCache.getCategories();
        let applied = 0;
        let failed = 0;

        for (const proposal of approvedProposals) {
            const categoryId = categories.get(proposal.proposedCategory);
            if (!categoryId) {
                failed++;
                if (onProgress) onProgress({ applied, failed, total: approvedProposals.length, current: proposal.destinationName, lastError: `Category "${proposal.proposedCategory}" not found` });
                continue;
            }
            if (this.#jobList.isAlreadyProcessed(proposal.fireflyTxnId)) continue;

            const job = this.#jobList.createJob({ destinationName: proposal.destinationName, description: proposal.description, fireflyTransactionId: proposal.fireflyTxnId });

            try {
                const txnData = await this.#fireflyService.getTransaction(proposal.fireflyTxnId);
                if (!txnData) { this.#jobList.setJobError(job.id, "Transaction not found"); failed++; continue; }

                await this.#fireflyService.setCategory(proposal.fireflyTxnId, txnData.data.attributes.transactions, categoryId);

                this.#merchantMemory.learn(proposal.destinationName, {
                    category: proposal.proposedCategory, categoryId,
                    confidence: proposal.confidence || 0.85, source: "batch:approved",
                });
                this.#jobList.updateJobResult(job.id, {
                    category: proposal.proposedCategory, categoryId,
                    confidence: proposal.confidence || 0.85, source: "batch:approved",
                    provider: null, model: null, needsReview: false,
                });
                applied++;
            } catch (error) {
                this.#jobList.setJobError(job.id, error.message);
                failed++;
                if (onProgress) onProgress({ applied, failed, total: approvedProposals.length, current: proposal.destinationName, lastError: error.message });
                continue;
            }
            if (onProgress) onProgress({ applied, failed, total: approvedProposals.length, current: proposal.destinationName });
        }

        return { applied, failed, total: approvedProposals.length };
    }

    #mostCommon(arr) {
        if (!arr.length) return null;
        const freq = {};
        for (const item of arr) { freq[item] = (freq[item] || 0) + 1; }
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }
}
