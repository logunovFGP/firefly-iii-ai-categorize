import OpenAI from "openai";
import AiProvider from "./AiProvider.js";
import { matchCategory } from "../util.js";

export default class OpenAiProvider extends AiProvider {
    #client;

    constructor(apiKey, model = "gpt-4o-mini") {
        super(apiKey, model);
        this.#client = new OpenAI({ apiKey });
    }

    async classify(categories, destinationName, description, examples = []) {
        const basePrompt = this._generatePrompt(categories, destinationName, description, examples);
        return this._withRetry(async () => {
            const result = await this._callWithJsonRetry(
                async (errorCtx) => {
                    const messages = [
                        { role: "system", content: AiProvider.SYSTEM_PROMPT_SINGLE },
                        { role: "user", content: basePrompt },
                    ];
                    if (errorCtx) messages.push({ role: "user", content: `Fix: ${errorCtx}` });
                    const response = await this.#client.chat.completions.create({
                        model: this._model, messages,
                        temperature: 0.1, max_tokens: 60,
                        response_format: { type: "json_object" },
                    });
                    return response.choices[0].message.content;
                },
                (parsed) => {
                    if (!parsed || typeof parsed !== "object") return null;
                    const guess = parsed.category;
                    if (guess === null || guess === undefined) return { category: null, response: null, prompt: basePrompt };
                    const matched = matchCategory(guess, categories);
                    if (!matched) console.warn(`OpenAI: "${guess}" not in categories`);
                    return { category: matched, response: guess, prompt: basePrompt };
                }
            );
            return result || { category: null, response: null, prompt: basePrompt };
        });
    }

    async classifyBatch(categories, transactions, examples = []) {
        const prompt = this._generateBatchPrompt(categories, transactions, examples);
        return this._withRetry(async () => {
            const response = await this.#client.chat.completions.create({
                model: this._model,
                messages: [
                    { role: "system", content: AiProvider.SYSTEM_PROMPT_BATCH },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,
                max_tokens: Math.max(200, transactions.length * 50),
                response_format: { type: "json_object" },
            });
            const raw = response.choices[0].message.content.trim();
            return this._parseBatchResponse(raw, categories, transactions);
        });
    }

    async semanticDedup(existingCategories, discoveredCategories) {
        const prompt = this._generateSemanticDedupPrompt(existingCategories, discoveredCategories);
        return this._withRetry(async () => {
            const response = await this.#client.chat.completions.create({
                model: this._model,
                messages: [
                    { role: "system", content: AiProvider.SYSTEM_PROMPT_SEMANTIC_DEDUP },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,
                max_tokens: Math.max(500, (existingCategories.length + discoveredCategories.length) * 40),
                response_format: { type: "json_object" },
            });
            const raw = response.choices[0].message.content.trim();
            return this._parseSemanticDedupResponse(raw);
        });
    }

    async classifyBatchResearch(categories, transactions) {
        const prompt = this._generateResearchPrompt(categories, transactions);
        return this._withRetry(async () => {
            const response = await this.#client.chat.completions.create({
                model: this._model,
                messages: [
                    { role: "system", content: AiProvider.SYSTEM_PROMPT_RESEARCH },
                    { role: "user", content: prompt },
                ],
                temperature: 0.3,
                max_tokens: Math.max(300, transactions.length * 80),
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
