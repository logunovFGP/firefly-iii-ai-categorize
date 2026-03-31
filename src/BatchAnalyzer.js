import { mapConcurrent, findCategoryDuplicates, mergeProposals, normalizeCategoryKey } from "./util.js";

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

    async analyze(onProgress = null, signal = null) {
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

        // Growing category set — starts from Firefly DB categories
        const knownCategories = new Set(categories.keys());
        const initialCategoryList = Array.from(categories.keys()).sort();

        if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: 0, current: `${toClassify.length} txns in ${batches.length} batches (${concurrency} parallel)`, vocabulary: { initial: initialCategoryList, current: initialCategoryList } });

        const processChunkResults = (batchResults, chunk) => {
            batchResults.forEach((result, j) => {
                const item = chunk[j];
                // Track new AI suggestions for growing category list (only clean strings, not raw JSON)
                if (result.category && typeof result.category === "string") {
                    knownCategories.add(result.category);
                }
                if (result.response && typeof result.response === "string"
                    && result.response.length < 80 && !result.response.startsWith("[") && !result.response.startsWith("{")) {
                    knownCategories.add(result.response);
                }

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
                }
            });
        };

        // Phase A: Sequential seed batches (build category vocabulary)
        const seedCount = Math.min(SEED_BATCHES, batches.length);
        for (let i = 0; i < seedCount; i++) {
            if (signal?.aborted) break;
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
            if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Seed ${i + 1}/${seedCount}`, vocabulary: { initial: initialCategoryList, current: [...knownCategories].sort() } });
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
                if (onProgress) onProgress({ phase: "classifying", processed, total, skipped, errors: errorCount, current: `Parallel ${completedParallel}/${remaining.length} (${concurrency} workers)`, vocabulary: { initial: initialCategoryList, current: [...knownCategories].sort() } });
            }, signal);
        }

        // Phase C: Post-analysis category dedup + summary
        const existingNames = Array.from(categories.keys());
        const postProcessed = await this.#postProcessProposals(proposals, existingNames, onProgress);
        console.log(`analyze() final: duplicates=${postProcessed.duplicates?.length}, autoMerged=${postProcessed.autoMerged}, discovered=${postProcessed.discoveredCategories?.length}`);

        return {
            totalTransactions: transactions.length,
            totalProposals: postProcessed.proposals.length,
            skipped, errors: errorCount,
            ...postProcessed,
        };
    }

    async retryUnmatched(previousProposals, onProgress = null, signal = null) {
        const unmatched = previousProposals.filter(p => !p.proposedCategory);
        if (unmatched.length === 0) {
            return { totalRetried: 0, newlyMatched: 0, proposals: previousProposals };
        }

        const categories = await this.#categoriesCache.getCategories();
        const batchSize = this.#configStore?.getBatchClassifySize?.() || 20;

        // Build known categories from Firefly + first-pass discoveries
        const knownCategories = new Set(categories.keys());
        for (const p of previousProposals) {
            if (p.proposedCategory) knownCategories.add(p.proposedCategory);
        }

        const batches = [];
        for (let i = 0; i < unmatched.length; i += batchSize) {
            batches.push(unmatched.slice(i, i + batchSize));
        }

        if (onProgress) onProgress({ phase: "research", processed: 0, total: unmatched.length, current: `Researching ${unmatched.length} unmatched in ${batches.length} batches` });

        let processed = 0;
        let errorCount = 0;
        let newlyMatched = 0;
        const researchResults = new Map();

        for (let i = 0; i < batches.length; i++) {
            if (signal?.aborted) break;
            const chunk = batches[i];
            try {
                const batchResults = await this.#classificationEngine.classifyBatchResearch(
                    chunk.map(c => ({ destinationName: c.destinationName, description: c.description })),
                    { extraCategories: [...knownCategories] }
                );
                batchResults.forEach((result, j) => {
                    const item = chunk[j];
                    if (result.category) {
                        knownCategories.add(result.category);
                        newlyMatched++;
                        researchResults.set(item.fireflyTxnId, {
                            ...item, proposedCategory: result.category,
                            categoryId: categories.get(result.category) || null,
                            confidence: result.confidence, source: result.source,
                            isNewCategory: !categories.has(result.category),
                        });
                    } else if (result.response && typeof result.response === "string" && result.response.length < 80) {
                        newlyMatched++;
                        researchResults.set(item.fireflyTxnId, {
                            ...item, proposedCategory: result.response,
                            categoryId: null, confidence: result.confidence,
                            source: result.source, isNewCategory: true, needsReview: true,
                        });
                    }
                });
            } catch (err) {
                errorCount += chunk.length;
            }
            processed += chunk.length;
            if (onProgress) onProgress({ phase: "research", processed, total: unmatched.length, errors: errorCount, current: `Research batch ${i + 1}/${batches.length}` });
        }

        // Merge: replace null proposals with research results
        const mergedProposals = previousProposals.map(p => {
            if (!p.proposedCategory && researchResults.has(p.fireflyTxnId)) {
                return researchResults.get(p.fireflyTxnId);
            }
            return p;
        });

        const existingNames = Array.from(categories.keys());
        const postProcessed = await this.#postProcessProposals(mergedProposals, existingNames, onProgress);

        return {
            ...postProcessed,
            totalTransactions: previousProposals.length,
            totalProposals: postProcessed.proposals.length,
            totalRetried: unmatched.length,
            newlyMatched,
            errors: errorCount,
            pass: 2,
        };
    }

    async #postProcessProposals(proposals, existingNames, onProgress = null) {
        // Step 1: Formatting dedup (fast, no AI)
        const allProposed = [...new Set(proposals.map(p => p.proposedCategory).filter(Boolean))];
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

        // Step 2: Semantic dedup (AI-powered)
        const allProposedAfterFormat = [...new Set(mergedProposals.map(p => p.proposedCategory).filter(Boolean))];
        const discoveredOnly = allProposedAfterFormat.filter(c => !existingNames.includes(c));
        console.log(`Semantic dedup: ${discoveredOnly.length} discovered categories, ${existingNames.length} existing`);

        if (discoveredOnly.length > 1) {
            if (onProgress) onProgress({ phase: "semantic-dedup", message: "Running AI semantic deduplication..." });
            try {
                console.log("Calling semanticDedup with categories:", discoveredOnly.slice(0, 10).join(", "), "...");
                const semanticGroups = await this.#classificationEngine.semanticDedup(discoveredOnly, existingNames);
                console.log(`Semantic dedup returned ${semanticGroups.length} groups:`, JSON.stringify(semanticGroups).slice(0, 500));
                for (const group of semanticGroups) {
                    const existingMatch = group.variants.find(v => existingNames.includes(v));
                    if (existingMatch || existingNames.includes(group.canonical)) {
                        const canonical = existingMatch || group.canonical;
                        for (const v of group.variants) {
                            if (v !== canonical) autoMergeMap[v.toLowerCase()] = canonical;
                        }
                    } else {
                        needsUserReview.push({
                            variants: group.variants,
                            recommended: group.canonical,
                            reason: group.reason,
                            source: "semantic-ai",
                        });
                    }
                }
                console.log(`After semantic dedup: ${needsUserReview.length} groups for user review, ${Object.keys(autoMergeMap).length} auto-merged`);
                for (const r of needsUserReview) console.log(`  Review group: [${r.variants.join(", ")}] → recommended: "${r.recommended}"`);
                mergedProposals = mergeProposals(mergedProposals, autoMergeMap);
            } catch (err) {
                console.error("Semantic dedup failed, continuing without:", err.message, err.stack);
            }
        }

        // Step 3: Deterministic derived fields (shared with applyMerge)
        const derived = this.#computeDerivedFields(mergedProposals, existingNames);

        return {
            ...derived,
            duplicates: needsUserReview,
            autoMerged: Object.keys(autoMergeMap).length,
        };
    }

    /** Deterministic post-processing: case-insensitive dedup, newCategoryProposals, summary. No AI calls. */
    #computeDerivedFields(proposals, existingNames) {
        const rawCategories = proposals
            .map(p => p.proposedCategory)
            .filter(c => c && typeof c === "string" && c.length < 100 && !c.startsWith("[") && !c.startsWith("{"));

        const dedupMap = {};
        const uniqueCategories = [];
        for (const cat of rawCategories) {
            const key = normalizeCategoryKey(cat);
            if (!dedupMap[key]) { dedupMap[key] = cat; uniqueCategories.push(cat); }
        }

        const remapLookup = {};
        for (const cat of rawCategories) {
            const key = normalizeCategoryKey(cat);
            remapLookup[cat] = dedupMap[key];
        }
        const dedupedProposals = proposals.map(p => {
            if (p.proposedCategory && remapLookup[p.proposedCategory]) {
                return { ...p, proposedCategory: remapLookup[p.proposedCategory] };
            }
            return p;
        });

        const dedupRemaps = [];
        for (const cat of rawCategories) {
            const canonical = remapLookup[cat];
            if (canonical && canonical !== cat) dedupRemaps.push({ from: cat, to: canonical });
        }
        const dedupRemapsUnique = [...new Map(dedupRemaps.map(r => [`${r.from}→${r.to}`, r])).values()];

        const newCategoryProposals = uniqueCategories
            .filter(c => !existingNames.includes(c))
            .map(cat => ({
                suggestedCategoryName: cat,
                transactionCount: dedupedProposals.filter(p => p.proposedCategory === cat).length,
            }))
            .filter(p => p.transactionCount > 0)
            .sort((a, b) => b.transactionCount - a.transactionCount);

        const categoryGroups = {};
        for (const p of dedupedProposals) {
            const cat = p.proposedCategory || "(unmatched)";
            if (!categoryGroups[cat]) categoryGroups[cat] = { count: 0, merchants: new Set() };
            categoryGroups[cat].count++;
            categoryGroups[cat].merchants.add(p.destinationName);
        }
        const summary = Object.entries(categoryGroups).map(([cat, data]) => ({
            category: cat, transactionCount: data.count, uniqueMerchants: data.merchants.size,
            merchants: Array.from(data.merchants).slice(0, 10),
        }));

        const uncategorized = dedupedProposals.filter(p => !p.proposedCategory).length;

        return {
            proposals: dedupedProposals, newCategoryProposals, summary,
            existingCategories: existingNames,
            dedupRemaps: dedupRemapsUnique,
            discoveredCategories: uniqueCategories.filter(c => !existingNames.includes(c)),
            uncategorized,
        };
    }

    /** Server-side merge: apply user's merge map and recalculate all derived fields. */
    applyMergeMap(proposals, existingCategories, mergeMap) {
        const merged = mergeProposals(proposals, mergeMap);
        return this.#computeDerivedFields(merged, existingCategories);
    }

    async apply(approvedProposals, newCategoriesToCreate = [], onProgress = null, signal = null) {
        const toCreate = [...new Set(newCategoriesToCreate.map(c => c.trim()).filter(Boolean))];
        const existingBefore = await this.#categoriesCache.getCategories();
        const categoriesCreated = [];
        const categoriesExisted = [];

        for (const catName of toCreate) {
            if (signal?.aborted) break;
            if (existingBefore.has(catName)) {
                categoriesExisted.push(catName);
                continue;
            }
            try {
                await this.#fireflyService.createCategory(catName);
                categoriesCreated.push(catName);
            } catch (error) {
                console.error(`Failed to create category "${catName}": ${error.message}`);
                categoriesExisted.push(catName);
            }
        }

        if (onProgress && toCreate.length > 0) {
            onProgress({ phase: "creating-categories", created: categoriesCreated.length, existed: categoriesExisted.length, total: toCreate.length });
        }

        this.#categoriesCache.invalidate();
        const categories = await this.#categoriesCache.getCategories();

        // Filter valid proposals
        const validProposals = approvedProposals.filter(p => {
            if (!p.proposedCategory) return false;
            if (this.#jobList.isAlreadyProcessed(p.fireflyTxnId)) return false;
            if (!categories.get(p.proposedCategory)) return false;
            return true;
        });
        const skippedNull = approvedProposals.filter(p => !p.proposedCategory).length;

        // Determine bulk support
        const bulkSupported = await this.#fireflyService.checkBulkCategorizeSupport();
        const mode = bulkSupported ? "bulk" : "legacy";
        console.log(`Apply: using ${mode} mode for ${validProposals.length} proposals`);

        let applied = 0;
        let failed = 0;
        const tagValue = this.#configStore?.getValue?.("FIREFLY_TAG") || "AI categorized";

        if (bulkSupported) {
            // Bulk mode: chunk into groups of 50
            const CHUNK_SIZE = 50;
            for (let i = 0; i < validProposals.length; i += CHUNK_SIZE) {
                if (signal?.aborted) break;
                const chunk = validProposals.slice(i, i + CHUNK_SIZE);
                const items = chunk.map(p => ({
                    transactionGroupId: p.fireflyTxnId,
                    categoryName: p.proposedCategory,
                    tag: tagValue,
                }));

                try {
                    const result = await this.#fireflyService.bulkCategorize(items);
                    if (!result) {
                        // Endpoint returned null (unexpected 404 after probe) — abort bulk, switch to legacy
                        console.warn("Bulk endpoint returned 404 unexpectedly, cannot continue in bulk mode");
                        failed += chunk.length;
                        continue;
                    }
                    applied += result.applied;
                    failed += result.failed;

                    // Record in merchantMemory only — skip jobList during bulk apply
                    // to avoid 100 Socket.IO events per chunk flooding the browser
                    for (const p of chunk) {
                        this.#merchantMemory.learn(p.destinationName, {
                            category: p.proposedCategory,
                            categoryId: categories.get(p.proposedCategory),
                            confidence: p.confidence || 0.85,
                            source: "batch:approved",
                        });
                    }
                } catch (error) {
                    failed += chunk.length;
                    console.error(`Bulk apply chunk failed: ${error.message}`);
                }

                if (onProgress) onProgress({ applied, failed, total: validProposals.length, current: `Chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(validProposals.length / CHUNK_SIZE)}` });
            }
        } else {
            // Legacy mode: per-transaction GET+PUT (fallback)
            // Skip jobList writes to avoid Socket.IO event flood (same as bulk mode)
            let progressCounter = 0;
            for (const proposal of validProposals) {
                if (signal?.aborted) break;
                const categoryId = categories.get(proposal.proposedCategory);
                try {
                    const txnData = await this.#fireflyService.getTransaction(proposal.fireflyTxnId);
                    if (!txnData) { failed++; continue; }
                    await this.#fireflyService.setCategory(proposal.fireflyTxnId, txnData.data.attributes.transactions, categoryId);
                    this.#merchantMemory.learn(proposal.destinationName, { category: proposal.proposedCategory, categoryId, confidence: proposal.confidence || 0.85, source: "batch:approved" });
                    applied++;
                } catch (error) {
                    failed++;
                }
                progressCounter++;
                if (onProgress && progressCounter % 10 === 0) {
                    onProgress({ applied, failed, total: validProposals.length, current: proposal.destinationName });
                }
            }
            // Final progress event for legacy mode
            if (onProgress) onProgress({ applied, failed, total: validProposals.length, current: "Complete" });
        }

        if (skippedNull > 0) console.warn(`Apply: skipped ${skippedNull} proposals with null category`);
        return { applied, failed, skippedNull, total: approvedProposals.length, categoriesCreated, categoriesExisted, mode };
    }

}
