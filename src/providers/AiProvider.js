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
        return "You are a bank transaction categorizer. Reply with valid JSON only. Use ONLY category names from the allowed list. Use null for uncertain. No markdown, no explanation, no extra text.";
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
        let prompt = `Allowed categories: ${categories.join(", ")}\n`;
        if (examples.length > 0) {
            prompt += `\nExamples:\n`;
            for (const ex of examples) prompt += `- "${ex.merchant}" → ${ex.category}\n`;
        }
        prompt += `\nTransactions:\n`;
        transactions.forEach((t, i) => {
            prompt += `${i + 1}. "${t.destinationName}" — "${t.description}"\n`;
        });
        prompt += `\nJSON:`;
        return prompt;
    }

    _parseBatchResponse(raw, categories, transactions) {
        const cleaned = this._cleanJson(raw);

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return transactions.map(() => ({ category: null, response: raw }));
        }

        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            return transactions.map(() => ({ category: null, response: raw }));
        }

        return transactions.map((t, i) => {
            const key = String(i + 1);
            const guess = parsed[key];
            if (!guess || guess === "null" || guess === null || guess === "UNKNOWN") {
                return { category: null, response: guess };
            }
            const matched = matchCategory(guess, categories);
            return { category: matched, response: guess };
        });
    }
}
