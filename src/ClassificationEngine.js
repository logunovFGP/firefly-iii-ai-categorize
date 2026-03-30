import { createProvider, PROVIDER_MODELS } from "./providers/ProviderRegistry.js";
import { matchCategory } from "./util.js";

export default class ClassificationEngine {
    #keywordRules;
    #merchantMemory;
    #configStore;
    #categoriesCache;
    #cryptoDetector;
    #cachedProvider = null;
    #cachedProviderKey = "";

    constructor(keywordRules, merchantMemory, configStore, categoriesCache, cryptoDetector = null) {
        this.#keywordRules = keywordRules;
        this.#merchantMemory = merchantMemory;
        this.#configStore = configStore;
        this.#categoriesCache = categoriesCache;
        this.#cryptoDetector = cryptoDetector;
    }

    #getProvider() {
        const { provider: providerName, model } = this.#configStore.getActiveProvider();
        const apiKey = this.#configStore.getProviderToken(providerName);
        if (!apiKey) return null;

        const key = `${providerName}:${model}:${apiKey.slice(-8)}`;
        if (this.#cachedProvider && this.#cachedProviderKey === key) {
            return this.#cachedProvider;
        }

        this.#cachedProvider = createProvider(providerName, apiKey, model);
        this.#cachedProviderKey = key;
        return this.#cachedProvider;
    }

    #preFilter(destinationName, description, categories) {
        // Stage 1: Keyword rules
        const ruleMatch = this.#keywordRules.match(destinationName, description);
        if (ruleMatch && categories.has(ruleMatch.category)) {
            return { category: ruleMatch.category, categoryId: categories.get(ruleMatch.category), confidence: 1.0, source: `rule:${ruleMatch.matchedKeyword}`, needsReview: false };
        }

        // Stage 1.5: Crypto static detection
        if (this.#cryptoDetector) {
            const cryptoMatch = this.#cryptoDetector.detect(destinationName, description);
            if (cryptoMatch) {
                return { ...cryptoMatch, categoryId: categories.get(cryptoMatch.category) || null, _ensureCrypto: !categories.has(cryptoMatch.category) };
            }
        }

        // Stage 2: Merchant memory
        const memHit = this.#merchantMemory.lookup(destinationName);
        if (memHit && categories.has(memHit.category)) {
            return { category: memHit.category, categoryId: memHit.category_id, confidence: memHit.corrected ? 1.0 : 0.95, source: memHit.corrected ? "memory:corrected" : "memory:learned", needsReview: false };
        }

        return null;
    }

    async classify(destinationName, description, { dryRun = false } = {}) {
        const categories = await this.#categoriesCache.getCategories();
        const categoryNames = Array.from(categories.keys());

        // Pre-filter: rules → crypto → memory
        const preResult = this.#preFilter(destinationName, description, categories);
        if (preResult) {
            if (preResult._ensureCrypto) {
                await this.#categoriesCache.ensureCategory(preResult.category);
                preResult.categoryId = (await this.#categoriesCache.getCategories()).get(preResult.category) || null;
            }
            delete preResult._ensureCrypto;
            return preResult;
        }

        // Stage 3: AI classification
        const { provider: providerName, model } = this.#configStore.getActiveProvider();
        const provider = this.#getProvider();
        if (!provider) {
            return { category: null, confidence: 0, source: "error:no-api-key", needsReview: true };
        }

        let result;
        try {
            const examples = this.#merchantMemory.getExamples(5);
            result = await provider.classify(categoryNames, destinationName, description, examples);
        } catch (error) {
            console.error(`AI classification failed: ${error.message}`);
            return { category: null, confidence: 0, source: `ai:${providerName}/${model}`, needsReview: true, error: error.message };
        }

        const matched = matchCategory(result.category, categoryNames);
        const confidence = matched ? 0.85 : 0;
        const threshold = this.#configStore.getConfidenceThreshold();
        const accepted = matched && confidence >= threshold;

        if (accepted && !dryRun) {
            this.#merchantMemory.learn(destinationName, {
                category: matched, categoryId: categories.get(matched),
                confidence, source: `ai:${providerName}/${model}`,
            });
        }

        return {
            category: accepted ? matched : null,
            categoryId: accepted ? categories.get(matched) : null,
            confidence, source: `ai:${providerName}/${model}`,
            prompt: result.prompt, response: result.response,
            needsReview: !accepted && confidence > 0,
        };
    }

    async classifyBatch(transactionList, { dryRun = false, extraCategories = [] } = {}) {
        const categories = await this.#categoriesCache.getCategories();
        const categoryNames = [...new Set([...categories.keys(), ...extraCategories])];
        const threshold = this.#configStore.getConfidenceThreshold();

        const results = new Map();
        const needsAI = [];
        const cryptoEnsureSet = new Set();

        for (const t of transactionList) {
            const preResult = this.#preFilter(t.destinationName, t.description, categories);
            if (preResult) {
                if (preResult._ensureCrypto) cryptoEnsureSet.add(preResult.category);
                delete preResult._ensureCrypto;
                results.set(t, preResult);
                continue;
            }
            needsAI.push(t);
        }

        // Ensure crypto categories exist, then update categoryId in prefiltered results
        if (cryptoEnsureSet.size > 0) {
            for (const catName of cryptoEnsureSet) {
                await this.#categoriesCache.ensureCategory(catName);
            }
            const refreshed = await this.#categoriesCache.getCategories();
            for (const [t, result] of results.entries()) {
                if (result.categoryId === null && result.category && refreshed.has(result.category)) {
                    results.set(t, { ...result, categoryId: refreshed.get(result.category) });
                }
            }
        }

        if (needsAI.length > 0) {
            const { provider: providerName, model } = this.#configStore.getActiveProvider();
            const provider = this.#getProvider();

            if (provider) {
                const examples = this.#merchantMemory.getExamples(5);

                try {
                    const batchResults = await provider.classifyBatch(categoryNames, needsAI, examples);

                    batchResults.forEach((r, i) => {
                        const t = needsAI[i];
                        const matched = matchCategory(r.category, categoryNames);
                        const confidence = matched ? 0.85 : 0;
                        const accepted = matched && confidence >= threshold;

                        if (accepted && !dryRun) {
                            this.#merchantMemory.learn(t.destinationName, {
                                category: matched, categoryId: categories.get(matched),
                                confidence, source: `ai:${providerName}/${model}`,
                            });
                        }

                        results.set(t, {
                            category: accepted ? matched : null,
                            categoryId: accepted ? categories.get(matched) : null,
                            confidence, source: `ai:${providerName}/${model}`,
                            response: r.response,
                            needsReview: !accepted && confidence > 0,
                        });
                    });
                } catch (error) {
                    console.error(`Batch AI classification failed: ${error.message}`);
                    for (const t of needsAI) {
                        results.set(t, { category: null, confidence: 0, source: `ai:${providerName}/${model}`, needsReview: true, error: error.message });
                    }
                }
            } else {
                for (const t of needsAI) {
                    results.set(t, { category: null, confidence: 0, source: "error:no-api-key", needsReview: true });
                }
            }
        }

        return transactionList.map(t => results.get(t) || { category: null, confidence: 0, source: "error:no-result", needsReview: true });
    }

    async semanticDedup(discoveredCategories, existingCategories) {
        const { provider: providerName } = this.#configStore.getActiveProvider();
        const apiKey = this.#configStore.getProviderToken(providerName);
        if (!apiKey) { console.warn("semanticDedup: no API key"); return []; }

        const researchModel = PROVIDER_MODELS[providerName]?.researchModel
            || PROVIDER_MODELS[providerName]?.defaultModel;
        console.log(`semanticDedup: using ${providerName}/${researchModel}, ${discoveredCategories.length} discovered, ${existingCategories.length} existing`);
        const provider = createProvider(providerName, apiKey, researchModel);

        try {
            const result = await provider.semanticDedup(existingCategories, discoveredCategories);
            console.log(`semanticDedup: returned ${result.length} groups`);
            return result;
        } catch (error) {
            console.error(`Semantic dedup failed: ${error.message}`, error.stack);
            return [];
        }
    }

    async classifyBatchResearch(transactionList, { extraCategories = [] } = {}) {
        const categories = await this.#categoriesCache.getCategories();
        const categoryNames = [...new Set([...categories.keys(), ...extraCategories])];

        const { provider: providerName } = this.#configStore.getActiveProvider();
        const apiKey = this.#configStore.getProviderToken(providerName);
        if (!apiKey) {
            return transactionList.map(() => ({ category: null, confidence: 0, source: "error:no-api-key", needsReview: true }));
        }

        const researchModel = PROVIDER_MODELS[providerName]?.researchModel
            || PROVIDER_MODELS[providerName]?.defaultModel;
        const provider = createProvider(providerName, apiKey, researchModel);

        try {
            const batchResults = await provider.classifyBatchResearch(categoryNames, transactionList);
            return batchResults.map((r) => {
                const matched = matchCategory(r.category, categoryNames);
                return {
                    category: matched || null,
                    categoryId: matched ? (categories.get(matched) || null) : null,
                    confidence: matched ? 0.80 : 0,
                    source: `ai-research:${providerName}/${researchModel}`,
                    response: r.response,
                    needsReview: !matched,
                };
            });
        } catch (error) {
            console.error(`Research batch classification failed: ${error.message}`);
            return transactionList.map(() => ({
                category: null, confidence: 0,
                source: `ai-research:${providerName}/${researchModel}`,
                needsReview: true, error: error.message,
            }));
        }
    }
}
