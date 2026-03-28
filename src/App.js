import express from "express";
import { Server } from "socket.io";
import * as http from "http";
import Queue from "queue";

import crypto from "node:crypto";
import { getConfigVariable } from "./util.js";
import Database from "./db/Database.js";
import SecretStore from "./SecretStore.js";
import ConfigStore, { ConfigStoreException } from "./ConfigStore.js";
import FireflyService from "./FireflyService.js";
import CategoriesCache from "./CategoriesCache.js";
import KeywordRules from "./KeywordRules.js";
import MerchantMemory from "./MerchantMemory.js";
import ClassificationEngine from "./ClassificationEngine.js";
import BatchAnalyzer from "./BatchAnalyzer.js";
import JobList from "./JobList.js";
import { PROVIDER_MODELS, createProvider } from "./providers/ProviderRegistry.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    #database;
    #secretStore;
    #configStore;
    #firefly;
    #categoriesCache;
    #keywordRules;
    #merchantMemory;
    #engine;
    #batchAnalyzer;
    #jobList;
    #fireflyStatus = { connected: false, error: "Not checked yet" };

    #server;
    #io;
    #express;
    #queue;

    constructor() {
        this.#PORT = getConfigVariable("PORT", "3000");
        this.#ENABLE_UI = getConfigVariable("ENABLE_UI", "false") === "true";
    }

    async run() {
        // Storage
        this.#database = new Database("./storage/categorizer.db");
        this.#secretStore = new SecretStore("./storage/local-settings.enc.json");
        await this.#secretStore.init();

        // Config
        this.#configStore = new ConfigStore(this.#secretStore);
        await this.#configStore.init();

        // Services
        this.#firefly = new FireflyService(this.#configStore);
        this.#categoriesCache = new CategoriesCache(this.#firefly, 60_000);
        this.#merchantMemory = new MerchantMemory(this.#database);
        this.#keywordRules = new KeywordRules(this.#configStore.getKeywordRules());
        this.#engine = new ClassificationEngine(
            this.#keywordRules, this.#merchantMemory, this.#configStore, this.#categoriesCache
        );
        this.#jobList = new JobList(this.#database);
        this.#batchAnalyzer = new BatchAnalyzer({
            fireflyService: this.#firefly,
            categoriesCache: this.#categoriesCache,
            classificationEngine: this.#engine,
            merchantMemory: this.#merchantMemory,
            jobList: this.#jobList,
        });

        // Queue
        this.#queue = new Queue({ timeout: 60 * 1000, concurrency: 1, autostart: true });
        this.#queue.addEventListener("start", (job) => console.log("Job started", job));
        this.#queue.addEventListener("success", (event) => console.log("Job success", event.job));
        this.#queue.addEventListener("error", (event) => console.error("Job error", event.job, event.err));
        this.#queue.addEventListener("timeout", (event) => console.log("Job timeout", event.job));

        // HTTP + WebSocket
        this.#express = express();
        this.#server = http.createServer(this.#express);
        this.#io = new Server(this.#server);
        this.#express.use(express.json());

        if (this.#ENABLE_UI) {
            this.#express.use("/", express.static("public"));
        }

        // Socket.IO
        this.#jobList.on("job created", (data) => this.#io.emit("job created", data));
        this.#jobList.on("job updated", (data) => this.#io.emit("job updated", data));

        // --- API Auth middleware ---
        this.#express.get("/api/setup-status", this.#getSetupStatus.bind(this));
        this.#express.use("/api", this.#apiAuth.bind(this));

        // --- API: Settings ---
        this.#express.get("/api/settings", this.#getSettings.bind(this));
        this.#express.put("/api/settings", this.#updateAllSettings.bind(this));
        this.#express.get("/api/providers", this.#getProviders.bind(this));
        this.#express.get("/api/categories", this.#getCategories.bind(this));
        this.#express.get("/api/firefly/status", this.#getFireflyStatus.bind(this));
        this.#express.put("/api/settings/tokens", this.#updateTokens.bind(this));
        this.#express.put("/api/settings/provider", this.#updateProvider.bind(this));
        this.#express.put("/api/settings/threshold", this.#updateThreshold.bind(this));
        this.#express.put("/api/settings/webhook", this.#updateWebhook.bind(this));
        this.#express.post("/api/settings/test", this.#testConnection.bind(this));

        // --- API: Rules ---
        this.#express.get("/api/rules", this.#getRules.bind(this));
        this.#express.put("/api/rules", this.#updateRules.bind(this));

        // --- API: Memory ---
        this.#express.get("/api/memory", this.#getMemory.bind(this));
        this.#express.get("/api/memory/stats", this.#getMemoryStats.bind(this));
        this.#express.delete("/api/memory/:merchant", this.#removeMerchant.bind(this));
        this.#express.delete("/api/memory", this.#clearMemory.bind(this));

        // --- API: Jobs ---
        this.#express.get("/api/jobs", this.#getJobs.bind(this));
        this.#express.get("/api/jobs/review", this.#getJobsNeedingReview.bind(this));
        this.#express.post("/api/jobs/:id/correct", this.#correctJob.bind(this));

        // --- API: Batch (two-pass) ---
        this.#express.post("/api/batch/analyze", this.#batchAnalyze.bind(this));
        this.#express.post("/api/batch/apply", this.#batchApply.bind(this));

        // --- Webhook (conditional) ---
        if (this.#configStore.getEnableWebhook()) {
            this.#express.post("/webhook", this.#onWebhook.bind(this));
            console.log("Webhook endpoint enabled");
        } else {
            console.log("Webhook endpoint disabled (ENABLE_WEBHOOK=false)");
        }

        // Start
        this.#server.listen(this.#PORT, () => {
            console.log(`Application running on port ${this.#PORT}`);
        });

        this.#io.use((socket, next) => {
            const configuredToken = this.#configStore.getValue("CATEGORIZER_API_TOKEN");
            if (!configuredToken) return next();
            const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.slice(7);
            if (token) {
                const provided = Buffer.from(token);
                const expected = Buffer.from(configuredToken);
                if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
                    return next();
                }
            }
            next(new Error("Unauthorized"));
        });

        this.#io.on("connection", (socket) => {
            socket.emit("jobs", this.#jobList.getJobs());
        });

        // Non-blocking Firefly connection check
        this.#firefly.checkConnection().then(result => {
            this.#fireflyStatus = result;
            if (result.connected) {
                console.log(`Connected to Firefly III v${result.version}`);
            } else {
                console.warn(`Firefly III unreachable: ${result.error}`);
            }
        });
    }

    // ─── Settings ────────────────────────────────────

    #getSettings(req, res) {
        const settings = this.#configStore.getPublicSettings();
        settings.memoryStats = this.#merchantMemory.getStats();
        settings.fireflyStatus = this.#fireflyStatus;
        settings.fireflyUrl = getConfigVariable("FIREFLY_URL", "");
        res.json(settings);
    }

    #getProviders(req, res) {
        res.json(PROVIDER_MODELS);
    }

    async #getCategories(req, res) {
        try {
            res.json(await this.#categoriesCache.getCategoryList());
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #getFireflyStatus(req, res) {
        this.#fireflyStatus = await this.#firefly.checkConnection();
        res.json(this.#fireflyStatus);
    }

    async #updateAllSettings(req, res) {
        try {
            const { activeProvider, activeModel, fireflyPersonalToken,
                    providerName, providerApiKey, confidenceThreshold, enableWebhook } = req.body || {};

            if (fireflyPersonalToken?.trim()) {
                await this.#configStore.setFireflyToken(fireflyPersonalToken.trim());
            }
            if (providerName && providerApiKey?.trim()) {
                await this.#configStore.setProviderToken(providerName, providerApiKey.trim());
            }
            if (activeProvider) {
                await this.#configStore.setActiveProvider(
                    activeProvider,
                    activeModel || PROVIDER_MODELS[activeProvider]?.defaultModel
                );
            }
            if (confidenceThreshold !== undefined) {
                await this.#configStore.setConfidenceThreshold(parseFloat(confidenceThreshold));
            }
            if (enableWebhook !== undefined) {
                await this.#configStore.setEnableWebhook(!!enableWebhook);
            }

            if (fireflyPersonalToken?.trim()) {
                this.#fireflyStatus = await this.#firefly.checkConnection();
            }

            const settings = this.#configStore.getPublicSettings();
            settings.memoryStats = this.#merchantMemory.getStats();
            settings.fireflyStatus = this.#fireflyStatus;
            res.json(settings);
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #updateTokens(req, res) {
        try {
            const { provider, apiKey, fireflyPersonalToken } = req.body || {};
            if (fireflyPersonalToken?.trim()) {
                await this.#configStore.setFireflyToken(fireflyPersonalToken.trim());
            }
            if (provider && apiKey?.trim()) {
                await this.#configStore.setProviderToken(provider, apiKey.trim());
            }
            if (!fireflyPersonalToken?.trim() && !apiKey?.trim()) {
                return res.status(400).json({ error: "No token provided." });
            }
            res.json(this.#configStore.getPublicSettings());
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #updateProvider(req, res) {
        try {
            const { provider, model } = req.body || {};
            if (!provider) return res.status(400).json({ error: "provider is required" });
            await this.#configStore.setActiveProvider(provider, model || PROVIDER_MODELS[provider]?.defaultModel);
            res.json(this.#configStore.getPublicSettings());
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #updateThreshold(req, res) {
        try {
            const { threshold } = req.body || {};
            if (threshold === undefined) return res.status(400).json({ error: "threshold is required" });
            await this.#configStore.setConfidenceThreshold(parseFloat(threshold));
            res.json({ confidenceThreshold: this.#configStore.getConfidenceThreshold() });
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #updateWebhook(req, res) {
        try {
            const { enabled } = req.body || {};
            await this.#configStore.setEnableWebhook(!!enabled);
            res.json({ enableWebhook: this.#configStore.getEnableWebhook(), note: "Restart required for webhook change to take effect" });
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    async #testConnection(req, res) {
        try {
            const { provider: providerName } = req.body || {};
            if (!providerName) return res.status(400).json({ error: "provider is required" });
            const apiKey = this.#configStore.getProviderToken(providerName);
            if (!apiKey) return res.status(400).json({ error: `No API key configured for ${providerName}` });
            const model = PROVIDER_MODELS[providerName]?.defaultModel;
            const provider = createProvider(providerName, apiKey, model);
            const result = await provider.testConnection();
            res.json(result);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ─── Rules ───────────────────────────────────────

    #getRules(req, res) {
        res.json(this.#configStore.getKeywordRules());
    }

    async #updateRules(req, res) {
        try {
            const rules = req.body;
            if (!Array.isArray(rules)) return res.status(400).json({ error: "Body must be an array of rules" });
            for (const rule of rules) {
                if (!Array.isArray(rule.keywords) || !rule.keywords.length || typeof rule.category !== "string" || !rule.category.trim()) {
                    return res.status(400).json({ error: "Each rule must have a non-empty keywords array and a category string" });
                }
            }
            await this.#configStore.setKeywordRules(rules);
            this.#keywordRules.reload(rules);
            res.json(rules);
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    // ─── Memory ──────────────────────────────────────

    #getMemory(req, res) {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        res.json(this.#merchantMemory.list(limit, offset));
    }

    #getMemoryStats(req, res) {
        res.json(this.#merchantMemory.getStats());
    }

    #removeMerchant(req, res) {
        this.#merchantMemory.remove(decodeURIComponent(req.params.merchant));
        res.json({ ok: true });
    }

    #clearMemory(req, res) {
        this.#merchantMemory.clear();
        res.json({ ok: true });
    }

    // ─── Jobs ────────────────────────────────────────

    #getJobs(req, res) {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        res.json(this.#jobList.getJobs(limit, offset));
    }

    #getJobsNeedingReview(req, res) {
        res.json(this.#jobList.getNeedsReview());
    }

    async #correctJob(req, res) {
        try {
            const { category, categoryId } = req.body || {};
            if (!category) return res.status(400).json({ error: "category is required" });

            const job = this.#jobList.getJob(req.params.id);
            if (!job) return res.status(404).json({ error: "Job not found" });

            this.#jobList.correctJob(job.id, category);

            if (job.destination_name) {
                this.#merchantMemory.correct(job.destination_name, category, categoryId || "");
            }

            // Sync correction to Firefly if we have the transaction ID
            if (job.firefly_transaction_id) {
                try {
                    const txnData = await this.#firefly.getTransaction(job.firefly_transaction_id);
                    if (txnData) {
                        const cats = await this.#categoriesCache.getCategories();
                        const catId = categoryId || cats.get(category);
                        if (catId) {
                            await this.#firefly.setCategory(
                                job.firefly_transaction_id,
                                txnData.data.attributes.transactions,
                                catId
                            );
                        }
                    }
                } catch (err) {
                    console.error(`Failed to sync correction to Firefly: ${err.message}`);
                }
            }

            res.json(this.#jobList.getJob(job.id));
        } catch (error) {
            this.#handleError(res, error);
        }
    }

    // ─── Batch (two-pass) ────────────────────────────

    async #batchAnalyze(req, res) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
            const result = await this.#batchAnalyzer.analyze((progress) => send("progress", progress));
            send("complete", result);
        } catch (error) {
            send("error", { message: error.message });
        } finally {
            res.end();
        }
    }

    async #batchApply(req, res) {
        const { proposals, newCategories } = req.body || {};
        if (!Array.isArray(proposals)) return res.status(400).json({ error: "proposals array required" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
            const result = await this.#batchAnalyzer.apply(proposals, newCategories || [], (progress) => send("progress", progress));
            this.#categoriesCache.invalidate();
            send("complete", result);
        } catch (error) {
            send("error", { message: error.message });
        } finally {
            res.end();
        }
    }

    // ─── Webhook ─────────────────────────────────────

    #onWebhook(req, res) {
        try {
            this.#handleWebhook(req);
            res.send("Queued");
        } catch (e) {
            console.error(e);
            res.status(400).send(e.message);
        }
    }

    #handleWebhook(req) {
        if (req.body?.trigger !== "STORE_TRANSACTION") {
            throw new Error("trigger is not STORE_TRANSACTION");
        }
        if (req.body?.response !== "TRANSACTIONS") {
            throw new Error("response is not TRANSACTIONS");
        }
        if (!req.body?.content?.id) {
            throw new Error("Missing content.id");
        }
        if (!req.body?.content?.transactions?.length) {
            throw new Error("No transactions in content.transactions");
        }

        const txn = req.body.content.transactions[0];
        if (txn.type !== "withdrawal") {
            throw new Error("Only withdrawals are categorized");
        }
        if (txn.category_id !== null) {
            throw new Error("Transaction already has a category");
        }
        if (!txn.destination_name) {
            throw new Error("Missing destination_name");
        }

        const fireflyTxnId = String(req.body.content.id);

        // Dedup check
        if (this.#jobList.isAlreadyProcessed(fireflyTxnId)) {
            throw new Error(`Transaction ${fireflyTxnId} already processed`);
        }

        const destinationName = txn.destination_name;
        const description = txn.description || "";

        const job = this.#jobList.createJob({
            destinationName,
            description,
            fireflyTransactionId: fireflyTxnId,
        });

        this.#queue.push(async () => {
            this.#jobList.setJobInProgress(job.id);
            try {
                const result = await this.#engine.classify(destinationName, description);
                const { provider, model } = this.#configStore.getActiveProvider();
                this.#jobList.updateJobResult(job.id, { ...result, provider, model });

                if (result.category) {
                    await this.#firefly.setCategory(
                        req.body.content.id,
                        req.body.content.transactions,
                        result.categoryId
                    );
                }
            } catch (error) {
                console.error(`Classification failed: ${error.message}`);
                this.#jobList.setJobError(job.id, error.message);
            }
        });
    }

    // ─── Auth ─────────────────────────────────────

    #apiAuth(req, res, next) {
        const configuredToken = this.#configStore.getValue("CATEGORIZER_API_TOKEN");
        if (!configuredToken) return next();

        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Authorization required. Provide Bearer token." });
        }

        const provided = Buffer.from(authHeader.slice(7));
        const expected = Buffer.from(configuredToken);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
            return res.status(403).json({ error: "Invalid API token" });
        }

        next();
    }

    #getSetupStatus(req, res) {
        const apiTokenConfigured = !!this.#configStore.getValue("CATEGORIZER_API_TOKEN");
        const hasFireflyToken = !!this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN");
        const { provider } = this.#configStore.getActiveProvider();
        const hasAiProvider = !!this.#configStore.getProviderToken(provider);

        res.json({ apiTokenRequired: apiTokenConfigured, hasFireflyToken, hasAiProvider });
    }

    #handleError(res, error) {
        if (error instanceof ConfigStoreException) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}
