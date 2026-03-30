import OpenAiProvider from "./OpenAiProvider.js";
import GeminiProvider from "./GeminiProvider.js";

export const PROVIDER_MODELS = {
    openai: {
        label: "OpenAI",
        envKey: "OPENAI_API_KEY",
        models: [
            { id: "gpt-4o", label: "GPT-4o" },
            { id: "gpt-4o-mini", label: "GPT-4o Mini" },
            { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
            { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
        ],
        defaultModel: "gpt-4o-mini",
        researchModel: "gpt-4o-mini",
    },
    gemini: {
        label: "Google Gemini",
        envKey: "GEMINI_API_KEY",
        models: [
            { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
            { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        ],
        defaultModel: "gemini-2.0-flash",
        researchModel: "gemini-2.0-flash",
    },
};

export function createProvider(providerName, apiKey, model) {
    switch (providerName) {
        case "openai":
            return new OpenAiProvider(apiKey, model);
        case "gemini":
            return new GeminiProvider(apiKey, model);
        default:
            throw new Error(`Unknown AI provider: ${providerName}`);
    }
}
