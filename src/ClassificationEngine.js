import { createProvider, PROVIDER_MODELS } from "./providers/ProviderRegistry.js";

export default class ClassificationEngine {
    #keywordRules;
    #merchantMemory;
    #configStore;
    #categoriesCache;

    constructor(keywordRules, merchantMemory, configStore, categoriesCache) {
        this.#keywordRules = keywordRules;
        this.#merchantMemory = merchantMemory;
        this.#configStore = configStore;
        this.#categoriesCache = categoriesCache;
    }

    async classify(destinationName, description, { dryRun = false } = {}) {
        const categories = await this.#categoriesCache.getCategories();
        const categoryNames = Array.from(categories.keys());

        // Stage 1: Keyword rules (instant, no API call)
        const ruleMatch = this.#keywordRules.match(destinationName, description);
        if (ruleMatch && categories.has(ruleMatch.category)) {
            return {
                category: ruleMatch.category,
                categoryId: categories.get(ruleMatch.category),
                confidence: 1.0,
                source: `rule:${ruleMatch.matchedKeyword}`,
                needsReview: false,
            };
        }

        // Stage 2: Merchant memory (instant, SQLite lookup)
        const memHit = this.#merchantMemory.lookup(destinationName);
        if (memHit && categories.has(memHit.category)) {
            return {
                category: memHit.category,
                categoryId: memHit.category_id,
                confidence: memHit.corrected ? 1.0 : 0.95,
                source: memHit.corrected ? "memory:corrected" : "memory:learned",
                needsReview: false,
            };
        }

        // Stage 3: AI classification (API call)
        const { provider: providerName, model } = this.#configStore.getActiveProvider();
        const providerDef = PROVIDER_MODELS[providerName];
        if (!providerDef) {
            return { category: null, confidence: 0, source: "error:unknown-provider", needsReview: true };
        }

        const apiKey = this.#configStore.getProviderToken(providerName);
        if (!apiKey) {
            return { category: null, confidence: 0, source: "error:no-api-key", needsReview: true };
        }

        let result;
        try {
            const provider = createProvider(providerName, apiKey, model);
            const examples = this.#merchantMemory.getExamples(5);
            result = await provider.classify(categoryNames, destinationName, description, examples);
        } catch (error) {
            console.error(`AI classification failed: ${error.message}`);
            return {
                category: null,
                confidence: 0,
                source: `ai:${providerName}/${model}`,
                needsReview: true,
                error: error.message,
            };
        }

        // Try exact match first, then case-insensitive match
        let matchedCategory = result.category && categoryNames.includes(result.category)
            ? result.category
            : null;

        if (!matchedCategory && result.category) {
            const lower = result.category.toLowerCase();
            matchedCategory = categoryNames.find(c => c.toLowerCase() === lower) || null;
        }

        const confidence = matchedCategory ? 0.85 : 0;
        const threshold = this.#configStore.getConfidenceThreshold();
        const accepted = matchedCategory && confidence >= threshold;

        if (accepted && !dryRun) {
            this.#merchantMemory.learn(destinationName, {
                category: matchedCategory,
                categoryId: categories.get(matchedCategory),
                confidence,
                source: `ai:${providerName}/${model}`,
            });
        }

        return {
            category: accepted ? matchedCategory : null,
            categoryId: accepted ? categories.get(matchedCategory) : null,
            confidence,
            source: `ai:${providerName}/${model}`,
            prompt: result.prompt,
            response: result.response,
            needsReview: !accepted && confidence > 0,
        };
    }
}
