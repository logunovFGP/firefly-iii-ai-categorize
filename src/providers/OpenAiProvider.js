import OpenAI from "openai";
import AiProvider from "./AiProvider.js";

export default class OpenAiProvider extends AiProvider {
    #client;

    constructor(apiKey, model = "gpt-4o-mini") {
        super(apiKey, model);
        this.#client = new OpenAI({ apiKey });
    }

    async classify(categories, destinationName, description, examples = []) {
        const prompt = this._generatePrompt(categories, destinationName, description, examples);
        return this._withRetry(async () => {
            const response = await this.#client.chat.completions.create({
                model: this._model,
                messages: [
                    { role: "system", content: AiProvider.SYSTEM_PROMPT },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 50,
            });
            const guess = response.choices[0].message.content.trim();
            const category = categories.includes(guess)
                ? guess
                : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
            if (!category) console.warn(`OpenAI: "${guess}" not in categories`);
            return { prompt, response: guess, category };
        });
    }

    async classifyBatch(categories, transactions, examples = []) {
        const prompt = this._generateBatchPrompt(categories, transactions, examples);
        return this._withRetry(async () => {
            const response = await this.#client.chat.completions.create({
                model: this._model,
                messages: [
                    { role: "system", content: AiProvider.SYSTEM_PROMPT },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,
                max_tokens: Math.max(100, transactions.length * 30),
                response_format: { type: "json_object" },
            });
            const raw = response.choices[0].message.content.trim();
            return this._parseBatchResponse(raw, categories, transactions);
        });
    }

    async testConnection() {
        try {
            await this.#client.models.list({ limit: 1 });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}
