import { Router } from "express";
import { getConfigVariable, handleRouteError } from "../util.js";

export default function settingsRoutes({ configStore, secretStore, categoriesCache, merchantMemory, firefly, fireflyStatus, PROVIDER_MODELS, createProvider }) {
    const router = Router();
    const state = { fireflyStatus };
    const handleError = handleRouteError;

    router.get("/settings", (req, res) => {
        const settings = configStore.getPublicSettings();
        settings.memoryStats = merchantMemory.getStats();
        settings.fireflyStatus = state.fireflyStatus;
        settings.fireflyUrl = getConfigVariable("FIREFLY_URL", "");
        res.json(settings);
    });

    router.put("/settings", async (req, res) => {
        try {
            const { activeProvider, activeModel, fireflyPersonalToken,
                    providerName, providerApiKey, confidenceThreshold, enableWebhook } = req.body || {};

            if (fireflyPersonalToken?.trim()) {
                await configStore.setFireflyToken(fireflyPersonalToken.trim());
            }
            if (providerName && providerApiKey?.trim()) {
                await configStore.setProviderToken(providerName, providerApiKey.trim());
            }
            if (activeProvider) {
                await configStore.setActiveProvider(
                    activeProvider,
                    activeModel || PROVIDER_MODELS[activeProvider]?.defaultModel
                );
            }
            if (confidenceThreshold !== undefined) {
                await configStore.setConfidenceThreshold(parseFloat(confidenceThreshold));
            }
            if (enableWebhook !== undefined) {
                await configStore.setEnableWebhook(!!enableWebhook);
            }

            if (fireflyPersonalToken?.trim()) {
                state.fireflyStatus = await firefly.checkConnection();
            }

            const settings = configStore.getPublicSettings();
            settings.memoryStats = merchantMemory.getStats();
            settings.fireflyStatus = state.fireflyStatus;
            res.json(settings);
        } catch (error) {
            handleError(res, error);
        }
    });

    router.get("/providers", (req, res) => {
        res.json(PROVIDER_MODELS);
    });

    router.get("/categories", async (req, res) => {
        try {
            res.json(await categoriesCache.getCategoryList());
        } catch (error) {
            handleError(res, error);
        }
    });

    router.get("/firefly/status", async (req, res) => {
        state.fireflyStatus = await firefly.checkConnection();
        res.json(state.fireflyStatus);
    });

    router.put("/settings/tokens", async (req, res) => {
        try {
            const { provider, apiKey, fireflyPersonalToken } = req.body || {};
            if (fireflyPersonalToken?.trim()) {
                await configStore.setFireflyToken(fireflyPersonalToken.trim());
            }
            if (provider && apiKey?.trim()) {
                await configStore.setProviderToken(provider, apiKey.trim());
            }
            if (!fireflyPersonalToken?.trim() && !apiKey?.trim()) {
                return res.status(400).json({ error: "No token provided." });
            }
            res.json(configStore.getPublicSettings());
        } catch (error) {
            handleError(res, error);
        }
    });

    router.put("/settings/provider", async (req, res) => {
        try {
            const { provider, model } = req.body || {};
            if (!provider) return res.status(400).json({ error: "provider is required" });
            await configStore.setActiveProvider(provider, model || PROVIDER_MODELS[provider]?.defaultModel);
            res.json(configStore.getPublicSettings());
        } catch (error) {
            handleError(res, error);
        }
    });

    router.put("/settings/threshold", async (req, res) => {
        try {
            const { threshold } = req.body || {};
            if (threshold === undefined) return res.status(400).json({ error: "threshold is required" });
            await configStore.setConfidenceThreshold(parseFloat(threshold));
            res.json({ confidenceThreshold: configStore.getConfidenceThreshold() });
        } catch (error) {
            handleError(res, error);
        }
    });

    router.put("/settings/webhook", async (req, res) => {
        try {
            const { enabled } = req.body || {};
            await configStore.setEnableWebhook(!!enabled);
            res.json({ enableWebhook: configStore.getEnableWebhook(), note: "Restart required for webhook change to take effect" });
        } catch (error) {
            handleError(res, error);
        }
    });

    router.post("/settings/test", async (req, res) => {
        try {
            const { provider: providerName } = req.body || {};
            if (!providerName) return res.status(400).json({ error: "provider is required" });
            const apiKey = configStore.getProviderToken(providerName);
            if (!apiKey) return res.status(400).json({ error: `No API key configured for ${providerName}` });
            const model = PROVIDER_MODELS[providerName]?.defaultModel;
            const provider = createProvider(providerName, apiKey, model);
            const result = await provider.testConnection();
            res.json(result);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post("/settings/rotate-key", async (req, res) => {
        try {
            const newKey = await secretStore.rotateKey();
            res.json({ success: true, message: "Master key rotated. Back up the new key.", keyPreview: newKey.slice(0, 8) + "..." });
        } catch (error) {
            handleError(res, error);
        }
    });

    /**
     * Returns the mutable fireflyStatus reference so App.js can update it
     * during the initial connection check.
     */
    router._state = state;

    return router;
}
