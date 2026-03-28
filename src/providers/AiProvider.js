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
}
