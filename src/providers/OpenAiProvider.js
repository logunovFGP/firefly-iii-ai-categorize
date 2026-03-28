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

        const response = await this.#client.chat.completions.create({
            model: this._model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 50,
        });

        const guess = response.choices[0].message.content.trim();
        const category = categories.includes(guess) ? guess : null;

        if (!category) {
            console.warn(`OpenAI could not classify. Model: ${this._model}, Guess: "${guess}"`);
        }

        return { prompt, response: guess, category };
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
