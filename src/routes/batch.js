import { Router } from "express";

export default function batchRoutes({ batchAnalyzer, categoriesCache, batchLimiter }) {
    const router = Router();

    router.post("/batch/analyze", batchLimiter, async (req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
            const result = await batchAnalyzer.analyze((progress) => send("progress", progress));
            send("complete", result);
        } catch (error) {
            send("error", { message: error.message });
        } finally {
            res.end();
        }
    });

    router.post("/batch/apply", batchLimiter, async (req, res) => {
        const { proposals, newCategories } = req.body || {};
        if (!Array.isArray(proposals)) return res.status(400).json({ error: "proposals array required" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
            const result = await batchAnalyzer.apply(proposals, newCategories || [], (progress) => send("progress", progress));
            categoriesCache.invalidate();
            send("complete", result);
        } catch (error) {
            send("error", { message: error.message });
        } finally {
            res.end();
        }
    });

    router.post("/batch/merge", (req, res) => {
        const { proposals, existingCategories, mergeMap } = req.body || {};
        if (!Array.isArray(proposals)) return res.status(400).json({ error: "proposals array required" });
        if (!mergeMap || typeof mergeMap !== "object") return res.status(400).json({ error: "mergeMap object required" });
        if (!Array.isArray(existingCategories)) return res.status(400).json({ error: "existingCategories array required" });
        try {
            const result = batchAnalyzer.applyMergeMap(proposals, existingCategories, mergeMap);
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post("/batch/retry-unmatched", batchLimiter, async (req, res) => {
        const { proposals } = req.body || {};
        if (!Array.isArray(proposals)) return res.status(400).json({ error: "proposals array required" });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
            const result = await batchAnalyzer.retryUnmatched(proposals, (progress) => send("progress", progress));
            send("complete", result);
        } catch (error) {
            send("error", { message: error.message });
        } finally {
            res.end();
        }
    });

    return router;
}
