import { GoogleGenerativeAI } from "@google/generative-ai";
import AiProvider from "./AiProvider.js";
import { matchCategory } from "../util.js";

export default class GeminiProvider extends AiProvider {
    #genAI;

    constructor(apiKey, model = "gemini-2.0-flash") {
        super(apiKey, model);
        this.#genAI = new GoogleGenerativeAI(apiKey);
    }

    async classify(categories, destinationName, description, examples = []) {
        const basePrompt = this._generatePrompt(categories, destinationName, description, examples);
        return this._withRetry(async () => {
            const result = await this._callWithJsonRetry(
                async (errorCtx) => {
                    const fullPrompt = errorCtx ? `${basePrompt}\n\nFix: ${errorCtx}` : basePrompt;
                    const model = this.#genAI.getGenerativeModel({
                        model: this._model,
                        systemInstruction: AiProvider.SYSTEM_PROMPT_SINGLE,
                        generationConfig: { responseMimeType: "application/json" },
                    });
                    const r = await model.generateContent(fullPrompt);
                    return r.response.text();
                },
                (parsed) => {
                    if (!parsed || typeof parsed !== "object") return null;
                    const guess = parsed.category;
                    if (guess === null || guess === undefined) return { category: null, response: null, prompt: basePrompt };
                    const matched = matchCategory(guess, categories);
                    if (!matched) console.warn(`Gemini: "${guess}" not in categories`);
                    return { category: matched, response: guess, prompt: basePrompt };
                }
            );
            return result || { category: null, response: null, prompt: basePrompt };
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
