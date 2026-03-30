import { matchCategory } from "../util.js";

export default class AiProvider {
    constructor(apiKey, model) {
        if (new.target === AiProvider) {
            throw new Error("AiProvider is abstract and cannot be instantiated directly");
        }
        this._apiKey = apiKey;
        this._model = model;
    }

    async classify(categories, destinationName, description, examples = []) {
        throw new Error("classify() must be implemented by subclass");
    }

    async classifyBatch(categories, transactions, examples = []) {
        throw new Error("classifyBatch() must be implemented by subclass");
    }

    async testConnection() {
        throw new Error("testConnection() must be implemented by subclass");
    }

    async _withRetry(fn, maxRetries = 3) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isRateLimit = err.status === 429 || err.code === 429
                    || err.message?.includes("rate") || err.message?.includes("429")
                    || err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
                if (attempt < maxRetries && isRateLimit) {
                    const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                    console.warn(`Rate limited, retry in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
    }

    async _callWithJsonRetry(callFn, validateFn, maxRetries = 2) {
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const raw = await callFn(attempt > 0 ? lastError : null);
            const cleaned = this._cleanJson(raw);
            try {
                const parsed = JSON.parse(cleaned);
                const result = validateFn(parsed);
                if (result !== null) return result;
                lastError = `Parsed JSON but validation failed. Got: ${cleaned.slice(0, 300)}`;
            } catch (e) {
                lastError = `Invalid JSON: ${e.message}. You returned: ${cleaned.slice(0, 200)}. Reply with valid JSON only.`;
            }
        }
        return null;
    }

    _cleanJson(raw) {
        let s = (raw || "").trim();
        if (s.startsWith("```")) {
            s = s.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
        }
        return s;
    }

    static get SYSTEM_PROMPT_SINGLE() {
        return 'You are a bank transaction categorizer. Reply with JSON only: {"category":"CategoryName"}. If uncertain: {"category":null}. No markdown, no explanation. Correct: {"category":"Groceries"}. Wrong: Groceries. Wrong: "Groceries".';
    }

    static get SYSTEM_PROMPT_BATCH() {
        return `You categorize bank transactions. You receive JSON with knownCategories (prefer these) and transactions (each with id, merchant, description, category:null). Reply with {"transactions":[{"id":1,"category":"CategoryName"},...]}.  Rules: prefer knownCategories, may suggest new names, use null if uncertain, include every input ID.`;
    }

    static get SYSTEM_PROMPT_SEMANTIC_DEDUP() {
        return `You are a financial category deduplication assistant. You receive two lists:
1. existingCategories: categories already in the user's finance system (these are preferred canonical names)
2. discoveredCategories: categories suggested by AI analysis of bank transactions

Your task: identify groups of categories that refer to the SAME spending concept and should be merged.

Rules:
- If a group contains a category from existingCategories, that MUST be the canonical name
- If no existing category is in the group, recommend the most descriptive/general name
- Only group categories that genuinely overlap in meaning — do not group loosely related concepts
- Return ONLY groups with 2+ members. Do not return singletons.

Examples of semantic duplicates:
- "Video Games", "Gaming/App Purchases" → same concept (digital gaming purchases)
- "Health & Beauty", "Beauty & Personal Care" → same concept
- "Health & Wellness", "Healthcare" → same concept
- "Restaurants", "Dining" → same concept
- "Bank & Service Fees", "Financial Services" → same concept
- "Crypto", "Cryptocurrency" → same concept
- "Digital Purchases", "Digital Applications" → overlapping concept
- "Private Transfers", "Internal Transfers", "Transfers" → same concept

Examples of NOT duplicates (different scopes):
- "Groceries" vs "Food & Drink" → different (supermarket vs includes restaurants)
- "Transport" vs "Gas" → different (broad vs specific fuel)
- "Entertainment" vs "Video Games" → different (broad vs specific)

Reply with JSON only: {"groups":[{"canonical":"PreferredName","variants":["Name1","Name2"],"reason":"brief explanation"}]}
If no semantic duplicates found, reply: {"groups":[]}`;
    }

    _generateSemanticDedupPrompt(existingCategories, discoveredCategories) {
        return JSON.stringify({ existingCategories, discoveredCategories }, null, 2);
    }

    _parseSemanticDedupResponse(raw) {
        const cleaned = this._cleanJson(raw);
        try {
            const parsed = JSON.parse(cleaned);
            const groups = parsed?.groups;
            if (!Array.isArray(groups)) return [];
            return groups
                .filter(g => g.canonical && Array.isArray(g.variants) && g.variants.length >= 2)
                .map(g => ({
                    canonical: String(g.canonical),
                    variants: g.variants.map(String),
                    reason: g.reason ? String(g.reason) : null,
                }));
        } catch {
            console.warn("Semantic dedup parse failed:", cleaned.slice(0, 200));
            return [];
        }
    }

    static get SYSTEM_PROMPT_RESEARCH() {
        return `You are a financial transaction research assistant. For each transaction, analyze the merchant name and description to determine:
1) The language of the description (could be English, Russian, Georgian, or mixed)
2) What company, service, or merchant this likely represents based on public knowledge
3) What spending category best fits this transaction

You receive JSON with knownCategories (prefer these when appropriate) and transactions. Reply with {"transactions":[{"id":1,"category":"CategoryName"},...]}.
Rules: use knownCategories when they fit, may suggest new category names if none fit, use null only if truly unidentifiable, include every input ID.`;
    }

    _generateResearchPrompt(categories, transactions) {
        const input = {
            context: "These transactions could not be categorized in a first pass. Please research what each merchant/description means.",
            knownCategories: categories,
            transactions: transactions.map((t, i) => ({
                id: i + 1,
                merchant: t.destinationName,
                description: t.description,
                category: null,
            })),
        };
        return JSON.stringify(input, null, 2);
    }

    _generatePrompt(categories, destinationName, description, examples = []) {
        let prompt = `Allowed categories: ${categories.join(", ")}\n`;
        if (examples.length > 0) {
            prompt += `\nExamples:\n`;
            for (const ex of examples) prompt += `- "${ex.merchant}" → ${ex.category}\n`;
        }
        prompt += `\nTransaction from "${destinationName}" with description "${description}".\nJSON:`;
        return prompt;
    }

    _generateBatchPrompt(categories, transactions, examples = []) {
        const input = {
            knownCategories: categories,
            transactions: transactions.map((t, i) => ({
                id: i + 1,
                merchant: t.destinationName,
                description: t.description,
                category: null,
            })),
        };
        let prompt = JSON.stringify(input, null, 2);
        if (examples.length > 0) {
            prompt += `\n\nExamples: ${examples.map(e => `"${e.merchant}" → ${e.category}`).join(", ")}`;
        }
        return prompt;
    }

    _parseBatchResponse(raw, categories, transactions) {
        const cleaned = this._cleanJson(raw);
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            console.warn("Batch response parse failed:", cleaned.slice(0, 200));
            return transactions.map(() => ({ category: null, response: null }));
        }

        // Format 1: { transactions: [...] } (new structured format)
        // Format 2: [...] (Gemini may return top-level array; OpenAI json_object cannot)
        let items = null;
        if (parsed?.transactions && Array.isArray(parsed.transactions)) {
            items = parsed.transactions;
        } else if (Array.isArray(parsed)) {
            items = parsed; // Gemini compatibility
        } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
            // Format 3 (legacy): {"1":"Cat","2":"Cat"}
            return transactions.map((_, i) => {
                const key = String(i + 1);
                const guess = parsed[key];
                if (!guess || guess === null) return { category: null, response: null };
                const guessStr = typeof guess === "string" ? guess : null;
                return { category: matchCategory(guessStr, categories), response: guessStr };
            });
        }

        if (!items) {
            console.warn("Batch response unrecognized format:", cleaned.slice(0, 200));
            return transactions.map(() => ({ category: null, response: null }));
        }

        // Map by id or by position
        return transactions.map((_, i) => {
            const item = items.find(r => r.id === i + 1) || items[i];
            if (!item) return { category: null, response: null };
            const guess = typeof item === "string" ? item : (item.category ?? null);
            if (!guess || guess === null) return { category: null, response: null };
            const guessStr = String(guess);
            // category = matched to known list (or null). response = raw suggestion (clean string).
            return { category: matchCategory(guessStr, categories), response: guessStr };
        });
    }
}
