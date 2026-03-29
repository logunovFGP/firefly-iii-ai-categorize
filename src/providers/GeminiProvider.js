import { GoogleGenerativeAI } from "@google/generative-ai";
import AiProvider from "./AiProvider.js";

export default class GeminiProvider extends AiProvider {
    #genAI;

    constructor(apiKey, model = "gemini-2.0-flash") {
        super(apiKey, model);
        this.#genAI = new GoogleGenerativeAI(apiKey);
    }

    async classify(categories, destinationName, description, examples = []) {
        const prompt = this._generatePrompt(categories, destinationName, description, examples);
        return this._withRetry(async () => {
            const model = this.#genAI.getGenerativeModel({
                model: this._model,
                systemInstruction: AiProvider.SYSTEM_PROMPT_SINGLE,
            });
            const result = await model.generateContent(prompt);
            const guess = result.response.text().trim().replace(/^["']|["']$/g, "");
            const category = categories.includes(guess)
                ? guess
                : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
            if (!category) console.warn(`Gemini: "${guess}" not in categories`);
            return { prompt, response: guess, category };
        });
    }

    async classifyBatch(categories, transactions, examples = []) {
        const prompt = this._generateBatchPrompt(categories, transactions, examples);
        return this._withRetry(async () => {
            const model = this.#genAI.getGenerativeModel({
                model: this._model,
                systemInstruction: AiProvider.SYSTEM_PROMPT_BATCH,
                generationConfig: { responseMimeType: "application/json" },
            });
            const result = await model.generateContent(prompt);
            const raw = result.response.text().trim();
            return this._parseBatchResponse(raw, categories, transactions);
        });
    }

    async testConnection() {
        try {
            const model = this.#genAI.getGenerativeModel({ model: this._model });
            await model.generateContent("Reply with OK");
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}
