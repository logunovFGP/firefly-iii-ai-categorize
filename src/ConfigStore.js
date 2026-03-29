import { promises as fs } from "fs";
import path from "path";
import { PROVIDER_MODELS } from "./providers/ProviderRegistry.js";

const SECRET_KEYS = ["FIREFLY_PERSONAL_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "CATEGORIZER_API_TOKEN"];

export default class ConfigStore {
    #settingsFilePath;
    #secretStore;
    #config = {};

    constructor(secretStore) {
        this.#secretStore = secretStore;
        this.#settingsFilePath = process.env.SETTINGS_FILE_PATH || "./storage/local-settings.json";
    }

    async init() {
        await this.#loadPlainConfig();
        await this.#migrateFromPlaintext();
    }

    getValue(name, options = {}) {
        if (SECRET_KEYS.includes(name)) {
            const secretVal = this.#secretStore.getSecret(name);
            if (secretVal) return secretVal;
        }

        const rawValue = this.#config[name] ?? process.env[name];
        const value = this.#str(rawValue);

        if (options.required === true && value.length === 0) {
            throw new ConfigStoreException(
                400,
                `The required setting '${name}' is missing. Configure it in environment variables or the UI settings page.`
            );
        }

        return value;
    }

    getActiveProvider() {
        const provider = this.#str(this.#config.ACTIVE_PROVIDER) || process.env.ACTIVE_PROVIDER || "openai";
        const model = this.#str(this.#config.ACTIVE_MODEL)
            || process.env.ACTIVE_MODEL
            || PROVIDER_MODELS[provider]?.defaultModel
            || "gpt-4o-mini";
        return { provider, model };
    }

    async setActiveProvider(provider, model) {
        if (!PROVIDER_MODELS[provider]) {
            throw new ConfigStoreException(400, `Unknown provider: ${provider}`);
        }
        this.#config.ACTIVE_PROVIDER = provider;
        this.#config.ACTIVE_MODEL = model;
        await this.#savePlainConfig();
    }

    getProviderToken(providerName) {
        const def = PROVIDER_MODELS[providerName];
        if (!def) return "";
        const secretVal = this.#secretStore.getSecret(def.envKey);
        if (secretVal) return secretVal;
        return this.#str(process.env[def.envKey]);
    }

    async setProviderToken(providerName, apiKey) {
        const def = PROVIDER_MODELS[providerName];
        if (!def) {
            throw new ConfigStoreException(400, `Unknown provider: ${providerName}`);
        }
        await this.#secretStore.setSecret(def.envKey, apiKey);
    }

    async setFireflyToken(token) {
        await this.#secretStore.setSecret("FIREFLY_PERSONAL_TOKEN", token);
    }

    getConfidenceThreshold() {
        const val = parseFloat(this.#config.CONFIDENCE_THRESHOLD ?? process.env.CONFIDENCE_THRESHOLD ?? "0.5");
        return isNaN(val) ? 0.5 : Math.max(0, Math.min(1, val));
    }

    async setConfidenceThreshold(value) {
        this.#config.CONFIDENCE_THRESHOLD = value;
        await this.#savePlainConfig();
    }

    getKeywordRules() {
        return this.#config.KEYWORD_RULES || [];
    }

    async setKeywordRules(rules) {
        this.#config.KEYWORD_RULES = rules;
        await this.#savePlainConfig();
    }

    getParallelWorkers() {
        const val = parseInt(this.#config.PARALLEL_WORKERS ?? process.env.PARALLEL_WORKERS ?? "3");
        return Math.max(1, Math.min(10, isNaN(val) ? 3 : val));
    }

    getBatchClassifySize() {
        const val = parseInt(this.#config.BATCH_CLASSIFY_SIZE ?? process.env.BATCH_CLASSIFY_SIZE ?? "20");
        return Math.max(1, Math.min(50, isNaN(val) ? 20 : val));
    }

    getCryptoCategory() {
        return this.#str(this.#config.CRYPTO_CATEGORY) || process.env.CRYPTO_CATEGORY || "Crypto";
    }

    getCryptoTokenCategories() {
        const raw = this.#str(this.#config.CRYPTO_TOKEN_CATEGORIES) || process.env.CRYPTO_TOKEN_CATEGORIES || "";
        if (!raw) return {};
        const result = {};
        for (const pair of raw.split(",")) {
            const [symbol, category] = pair.split(":").map(s => s.trim());
            if (symbol && category) result[symbol.toUpperCase()] = category;
        }
        return result;
    }

    getEnableWebhook() {
        const val = this.#config.ENABLE_WEBHOOK ?? process.env.ENABLE_WEBHOOK ?? "true";
        return String(val).toLowerCase() === "true";
    }

    async setEnableWebhook(enabled) {
        this.#config.ENABLE_WEBHOOK = String(enabled);
        await this.#savePlainConfig();
    }

    getPublicSettings() {
        const { provider, model } = this.getActiveProvider();

        const providers = {};
        for (const [name, def] of Object.entries(PROVIDER_MODELS)) {
            const token = this.getProviderToken(name);
            providers[name] = {
                label: def.label,
                hasApiKey: token.length > 0,
                apiKeyPreview: this.#maskToken(token),
                models: def.models,
                defaultModel: def.defaultModel,
            };
        }

        const fireflyToken = this.getValue("FIREFLY_PERSONAL_TOKEN");

        return {
            hasFireflyPersonalToken: fireflyToken.length > 0,
            fireflyPersonalTokenPreview: this.#maskToken(fireflyToken),
            activeProvider: provider,
            activeModel: model,
            confidenceThreshold: this.getConfidenceThreshold(),
            keywordRules: this.getKeywordRules(),
            enableWebhook: this.getEnableWebhook(),
            providers,
        };
    }

    async #loadPlainConfig() {
        try {
            const data = await fs.readFile(this.#settingsFilePath, "utf8");
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") {
                this.#config = parsed;
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`Could not load settings: ${error.message}`);
            }
            this.#config = {};
        }
    }

    async #savePlainConfig() {
        try {
            const directory = path.dirname(this.#settingsFilePath);
            await fs.mkdir(directory, { recursive: true });

            const toSave = {};
            for (const [key, value] of Object.entries(this.#config)) {
                if (!SECRET_KEYS.includes(key)) {
                    toSave[key] = value;
                }
            }

            await fs.writeFile(this.#settingsFilePath, JSON.stringify(toSave, null, 2), "utf8");
        } catch (error) {
            throw new ConfigStoreException(500, `Could not save settings file: ${error.message}`);
        }
    }

    async #migrateFromPlaintext() {
        let migrated = false;

        for (const key of SECRET_KEYS) {
            const plainValue = this.#str(this.#config[key]);
            if (plainValue.length > 0 && !this.#secretStore.hasSecret(key)) {
                await this.#secretStore.setSecret(key, plainValue);
                delete this.#config[key];
                migrated = true;
                console.info(`Migrated ${key} from plaintext to encrypted storage`);
            }
        }

        if (migrated) {
            await this.#savePlainConfig();
        }
    }

    #maskToken(value) {
        if (!value || value.length === 0) return "";
        if (value.length <= 8) return "*".repeat(value.length);
        return `${value.slice(0, 4)}...${value.slice(-4)}`;
    }

    #str(value) {
        if (typeof value !== "string") return "";
        return value.trim();
    }
}

export class ConfigStoreException extends Error {
    statusCode;

    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
