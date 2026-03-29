import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";
import * as http from "http";
import Queue from "queue";

import crypto from "node:crypto";
import { getConfigVariable } from "./util.js";
import Database from "./db/Database.js";
import SecretStore from "./SecretStore.js";
import ConfigStore from "./ConfigStore.js";
import FireflyService from "./FireflyService.js";
import CategoriesCache from "./CategoriesCache.js";
import KeywordRules from "./KeywordRules.js";
import CryptoDetector from "./CryptoDetector.js";
import MerchantMemory from "./MerchantMemory.js";
import ClassificationEngine from "./ClassificationEngine.js";
import BatchAnalyzer from "./BatchAnalyzer.js";
import JobList from "./JobList.js";
import { PROVIDER_MODELS, createProvider } from "./providers/ProviderRegistry.js";

import settingsRoutes from "./routes/settings.js";
import rulesRoutes from "./routes/rules.js";
import memoryRoutes from "./routes/memory.js";
import jobsRoutes from "./routes/jobs.js";
import batchRoutes from "./routes/batch.js";
import webhookRoutes from "./routes/webhook.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    constructor() {
        this.#PORT = getConfigVariable("PORT", "3000");
        this.#ENABLE_UI = getConfigVariable("ENABLE_UI", "false") === "true";
    }

    async run() {
        // Storage
        const database = new Database("./storage/categorizer.db");
        const secretStore = new SecretStore("./storage/local-settings.enc.json");
        await secretStore.init();

        // Config
        const configStore = new ConfigStore(secretStore);
        await configStore.init();

        // Services
        const firefly = new FireflyService(configStore);
        const categoriesCache = new CategoriesCache(firefly, 60_000);
        const merchantMemory = new MerchantMemory(database);
        const keywordRules = new KeywordRules(configStore.getKeywordRules());
        const cryptoDetector = new CryptoDetector(configStore);
        const engine = new ClassificationEngine(
            keywordRules, merchantMemory, configStore, categoriesCache, cryptoDetector
        );
        const jobList = new JobList(database);
        const batchAnalyzer = new BatchAnalyzer({
            fireflyService: firefly,
            categoriesCache,
            classificationEngine: engine,
            merchantMemory,
            jobList,
            configStore,
        });

        // Queue
        const queue = new Queue({ timeout: 60 * 1000, concurrency: 1, autostart: true });
        queue.addEventListener("start", (job) => console.log("Job started", job));
        queue.addEventListener("success", (event) => console.log("Job success", event.job));
        queue.addEventListener("error", (event) => console.error("Job error", event.job, event.err));
        queue.addEventListener("timeout", (event) => console.log("Job timeout", event.job));

        // HTTP + WebSocket
        const app = express();
        const server = http.createServer(app);
        const io = new Server(server);
        app.use(express.json({ limit: "1mb" }));
        app.use(helmet({ contentSecurityPolicy: false }));

        const webhookLimiter = rateLimit({ windowMs: 60000, max: 60, message: { error: "Too many webhook requests" } });
        const batchLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many batch requests" } });

        if (this.#ENABLE_UI) {
            app.use("/", express.static("public"));
        }

        // Socket.IO events
        jobList.on("job created", (data) => io.emit("job created", data));
        jobList.on("job updated", (data) => io.emit("job updated", data));

        // --- Route modules ---
        const deps = {
            configStore, secretStore, categoriesCache, merchantMemory, firefly,
            keywordRules, jobList, batchAnalyzer, engine, queue,
            PROVIDER_MODELS, createProvider,
        };

        const settingsRouter = settingsRoutes({
            ...deps,
            fireflyStatus: { connected: false, error: "Not checked yet" },
        });

        // Setup status is public (no auth required)
        app.get("/api/setup-status", (req, res) => {
            const apiTokenConfigured = !!configStore.getValue("CATEGORIZER_API_TOKEN");
            const hasFireflyToken = !!configStore.getValue("FIREFLY_PERSONAL_TOKEN");
            const { provider } = configStore.getActiveProvider();
            const hasAiProvider = !!configStore.getProviderToken(provider);
            res.json({ apiTokenRequired: apiTokenConfigured, hasFireflyToken, hasAiProvider });
        });

        // Auth middleware for all /api routes
        app.use("/api", (req, res, next) => {
            const configuredToken = configStore.getValue("CATEGORIZER_API_TOKEN");
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
        });

        // Mount authenticated API routes
        app.use("/api", settingsRouter);
        app.use("/api", rulesRoutes(deps));
        app.use("/api", memoryRoutes(deps));
        app.use("/api", jobsRoutes(deps));
        app.use("/api", batchRoutes({ ...deps, batchLimiter }));

        // Webhook (not under /api — has its own rate limiter)
        app.use(webhookLimiter, webhookRoutes(deps));

        // Start
        server.listen(this.#PORT, () => {
            console.log(`Application running on port ${this.#PORT}`);
        });

        // Socket.IO auth
        io.use((socket, next) => {
            const configuredToken = configStore.getValue("CATEGORIZER_API_TOKEN");
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

        io.on("connection", (socket) => {
            socket.emit("jobs", jobList.getJobs());
        });

        // Non-blocking Firefly connection check
        firefly.checkConnection().then(result => {
            settingsRouter._state.fireflyStatus = result;
            if (result.connected) {
                console.log(`Connected to Firefly III v${result.version}`);
            } else {
                console.warn(`Firefly III unreachable: ${result.error}`);
            }
        });
    }
}
