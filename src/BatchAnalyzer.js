import { normalizeMerchantName, mapConcurrent, findCategoryDuplicates, mergeProposals } from "./util.js";

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
        // Phase: Fetch
        if (onProgress) onProgress({ phase: "fetching", message: "Fetching transactions from Firefly..." });
        const transactions = await this.#fireflyService.getUncategorizedTransactions((p) => {
            if (onProgress) onProgress({ phase: "fetching", page: p.page, totalPages: p.totalPages, fetchedSoFar: p.fetchedSoFar });
        });

        const categories = await this.#categoriesCache.getCategories();
        const batchSize = this.#configStore?.getBatchClassifySize?.() || 20;
        const concurrency = this.#configStore?.getParallelWorkers?.() || 3;
        const SEED_BATCHES = 3;

        const proposals = [];
        const unmatchedMerchants = {};
        let skipped = 0;
        let processed = 0;
        let errorCount = 0;

        // Filter already-processed
        const toClassify = [];
        for (const txn of transactions) {
            const first = txn.attributes?.transactions?.[0];
            if (!first) continue;
            const fireflyTxnId = String(txn.id);
            if (this.#jobList.isAlreadyProcessed(fireflyTxnId)) { skipped++; processed++; continue; }
            toClassify.push({ txn, fireflyTxnId, destinationName: first.destination_name || "", description: first.description || "" });
        }

        const total = transactions.length;
        const batches = [];
        for (let i = 0; i < toClassify.length; i += batchSize) {
            batches.push(toClassify.slice(i, i + batchSize));
        }

        if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: 0, current: `${toClassify.length} txns in ${batches.length} batches (${concurrency} parallel)` });

        // Growing category set
        const knownCategories = new Set(categories.keys());

        const processChunkResults = (batchResults, chunk) => {
            batchResults.forEach((result, j) => {
                const item = chunk[j];
                // Track new AI suggestions for growing category list
                if (result.category) knownCategories.add(result.category);
                if (result.response && typeof result.response === "string") knownCategories.add(result.response);

                if (result.category && (categories.has(result.category) || knownCategories.has(result.category))) {
                    proposals.push({
                        fireflyTxnId: item.fireflyTxnId, destinationName: item.destinationName, description: item.description,
                        proposedCategory: result.category, categoryId: categories.get(result.category) || null,
                        confidence: result.confidence, source: result.source, isNewCategory: !categories.has(result.category),
                    });
                } else {
                    proposals.push({
                        fireflyTxnId: item.fireflyTxnId, destinationName: item.destinationName, description: item.description,
                        proposedCategory: result.response || null, categoryId: null,
                        confidence: result.confidence, source: result.source, isNewCategory: true, needsReview: true,
                    });
                    const normName = normalizeMerchantName(item.destinationName);
                    if (!unmatchedMerchants[normName]) unmatchedMerchants[normName] = { count: 0, rawName: item.destinationName, aiSuggestions: [] };
                    unmatchedMerchants[normName].count++;
                    if (result.response) unmatchedMerchants[normName].aiSuggestions.push(result.response);
                }
            });
        };

        // Phase A: Sequential seed batches (build category vocabulary)
        const seedCount = Math.min(SEED_BATCHES, batches.length);
        for (let i = 0; i < seedCount; i++) {
            const chunk = batches[i];
            try {
                const batchResults = await this.#classificationEngine.classifyBatch(
                    chunk.map(c => ({ destinationName: c.destinationName, description: c.description })),
                    { dryRun: true, extraCategories: [...knownCategories] }
                );
                processChunkResults(batchResults, chunk);
            } catch (err) {
                errorCount += chunk.length;
                if (onProgress) onProgress({ phase: "classifying", processed: processed + (i + 1) * batchSize, total, skipped, errors: errorCount, lastError: err.message, current: `Seed batch ${i + 1}/${seedCount}` });
            }
            processed += chunk.length;
            if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Seed ${i + 1}/${seedCount} (vocabulary: ${knownCategories.size} categories)` });
        }

        // Phase B: Parallel remaining batches
        const remaining = batches.slice(seedCount);
        if (remaining.length > 0) {
            const frozenCategories = [...knownCategories];
            let completedParallel = 0;

            await mapConcurrent(remaining, concurrency, async (chunk) => {
                try {
                    const batchResults = await this.#classificationEngine.classifyBatch(
                        chunk.map(c => ({ destinationName: c.destinationName, description: c.description })),
                        { dryRun: true, extraCategories: frozenCategories }
                    );
                    processChunkResults(batchResults, chunk);
                } catch (err) {
                    errorCount += chunk.length;
                    if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, lastError: err.message });
                }
                processed += chunk.length;
                completedParallel++;
                if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Parallel ${completedParallel}/${remaining.length} (${concurrency} workers)` });
            });
        }

        // Phase C: Post-analysis category dedup
        const allProposed = [...new Set(proposals.map(p => p.proposedCategory).filter(Boolean))];
        const existingNames = Array.from(categories.keys());
        const duplicates = findCategoryDuplicates(allProposed, existingNames);

        let mergedProposals = proposals;
        const autoMergeMap = {};
        const needsUserReview = [];

        if (duplicates.length > 0) {
            for (const dup of duplicates) {
                const existing = dup.variants.find(v => existingNames.includes(v));
                if (existing) {
                    for (const v of dup.variants) { if (v !== existing) autoMergeMap[v.toLowerCase()] = existing; }
                } else {
                    needsUserReview.push(dup);
                }
            }
            mergedProposals = mergeProposals(proposals, autoMergeMap);
        }

        // New category proposals
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

        // Summary
        const categoryGroups = {};
        for (const p of mergedProposals) {
            const cat = p.proposedCategory || "(unmatched)";
            if (!categoryGroups[cat]) categoryGroups[cat] = { count: 0, merchants: new Set() };
            categoryGroups[cat].count++;
            categoryGroups[cat].merchants.add(p.destinationName);
        }
        const summary = Object.entries(categoryGroups).map(([cat, data]) => ({
            category: cat, transactionCount: data.count, uniqueMerchants: data.merchants.size,
            merchants: Array.from(data.merchants).slice(0, 10),
        }));

        return {
            totalTransactions: transactions.length, totalProposals: mergedProposals.length,
            skipped, errors: errorCount,
            proposals: mergedProposals, newCategoryProposals, summary,
            existingCategories: existingNames,
            duplicates: needsUserReview,
            autoMerged: Object.keys(autoMergeMap).length,
        };
    }

    async apply(approvedProposals, newCategoriesToCreate = [], onProgress = null) {
        const toCreate = [...new Set(newCategoriesToCreate.map(c => c.trim()).filter(Boolean))];
        for (const catName of toCreate) {
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
                this.#merchantMemory.learn(proposal.destinationName, { category: proposal.proposedCategory, categoryId, confidence: proposal.confidence || 0.85, source: "batch:approved" });
                this.#jobList.updateJobResult(job.id, { category: proposal.proposedCategory, categoryId, confidence: proposal.confidence || 0.85, source: "batch:approved", provider: null, model: null, needsReview: false });
                applied++;
            } catch (error) {
                this.#jobList.setJobError(job.id, error.message); failed++;
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
