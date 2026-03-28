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
        const model = this.#genAI.getGenerativeModel({ model: this._model });
        const result = await model.generateContent(prompt);
        const guess = result.response.text().trim();
        const category = categories.includes(guess) ? guess : null;
        if (!category) console.warn(`Gemini could not classify. Model: ${this._model}, Guess: "${guess}"`);
        return { prompt, response: guess, category };
    }

    async classifyBatch(categories, transactions, examples = []) {
        const prompt = this._generateBatchPrompt(categories, transactions, examples);
        const model = this.#genAI.getGenerativeModel({
            model: this._model,
            generationConfig: { responseMimeType: "application/json" },
        });
        const result = await model.generateContent(prompt);
        const raw = result.response.text().trim();
        return this._parseBatchResponse(raw, categories, transactions);
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
