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

    _generatePrompt(categories, destinationName, description, examples = []) {
        let prompt = `Categorize this bank transaction into exactly one of these categories: ${categories.join(", ")}\n`;
        if (examples.length > 0) {
            prompt += `\nExamples of past categorizations:\n`;
            for (const ex of examples) {
                prompt += `- "${ex.merchant}" → ${ex.category}\n`;
            }
        }
        prompt += `\nTransaction from "${destinationName}" with description "${description}".\n`;
        prompt += `Reply with ONLY the category name, nothing else.`;
        return prompt;
    }

    _generateBatchPrompt(categories, transactions, examples = []) {
        let prompt = `Categorize these bank transactions. For each, reply with the exact category name from this list:\n${categories.join(", ")}\n`;
        if (examples.length > 0) {
            prompt += `\nExamples:\n`;
            for (const ex of examples) prompt += `- "${ex.merchant}" → ${ex.category}\n`;
        }
        prompt += `\nTransactions:\n`;
        transactions.forEach((t, i) => {
            prompt += `${i + 1}. From "${t.destinationName}" — "${t.description}"\n`;
        });
        prompt += `\nReply in JSON format like: {"1":"CategoryA","2":"CategoryB"}\nRules:\n- Use ONLY names from the list above\n- Use null if unsure\n- Valid JSON only, no explanation`;
        return prompt;
    }

    _parseBatchResponse(raw, categories, transactions) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return transactions.map(() => ({ category: null, response: raw }));
        }

        return transactions.map((t, i) => {
            const key = String(i + 1);
            const guess = parsed[key];
            if (!guess || guess === "null" || guess === null) {
                return { category: null, response: guess };
            }
            const matched = categories.includes(guess)
                ? guess
                : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
            return { category: matched, response: guess };
        });
    }
}
