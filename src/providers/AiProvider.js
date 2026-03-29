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

    static get SYSTEM_PROMPT_SINGLE() {
        return 'You are a bank transaction categorizer. Reply with ONLY the category name, nothing else. No quotes, no JSON, no explanation. Correct: Groceries. Wrong: "Groceries". Wrong: {"category":"Groceries"}. If uncertain, reply: UNKNOWN';
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
        prompt += `\nTransaction from "${destinationName}" with description "${description}".\nCategory:`;
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
        let cleaned = raw.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
        }

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
            const matched = categories.includes(guess)
                ? guess
                : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
            return { category: matched, response: guess };
        });
    }
}
