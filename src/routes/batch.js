import { Router } from "express";

/** Throttle SSE progress events to max 1 per minIntervalMs. Non-progress events pass through immediately. */
function createThrottledSend(res, minIntervalMs = 500) {
    let lastSentAt = 0;
    let buffered = null;

    function write(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function send(event, data) {
        if (event !== "progress") {
            // Flush any buffered progress before non-progress events
            if (buffered) { write("progress", buffered); buffered = null; }
            write(event, data);
            return;
        }
        const now = Date.now();
        if (now - lastSentAt >= minIntervalMs) {
            write("progress", data);
            lastSentAt = now;
            buffered = null;
        } else {
            buffered = data;
        }
    }

    return send;
}

export default function batchRoutes({ batchAnalyzer, categoriesCache, batchLimiter }) {
    const router = Router();

    router.post("/batch/analyze", batchLimiter, async (req, res) => {
        const ac = new AbortController();
        req.on("close", () => ac.abort());

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = createThrottledSend(res);
        try {
            const result = await batchAnalyzer.analyze((progress) => send("progress", progress), ac.signal);
            send("complete", result);
        } catch (error) {
            if (error.name === "AbortError") {
                console.log("Analyze cancelled by client");
            } else {
                send("error", { message: error.message });
            }
        } finally {
            res.end();
        }
    });

    router.post("/batch/apply", batchLimiter, async (req, res) => {
        const { proposals, newCategories } = req.body || {};
        if (!Array.isArray(proposals)) return res.status(400).json({ error: "proposals array required" });

        const ac = new AbortController();
        req.on("close", () => ac.abort());

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = createThrottledSend(res);
        try {
            const result = await batchAnalyzer.apply(proposals, newCategories || [], (progress) => send("progress", progress), ac.signal);
            categoriesCache.invalidate();
            send("complete", result);
        } catch (error) {
            if (error.name === "AbortError") {
                console.log("Apply cancelled by client");
            } else {
                send("error", { message: error.message });
            }
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

        const ac = new AbortController();
        req.on("close", () => ac.abort());

        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const send = createThrottledSend(res);
        try {
            const result = await batchAnalyzer.retryUnmatched(proposals, (progress) => send("progress", progress), ac.signal);
            send("complete", result);
        } catch (error) {
            if (error.name === "AbortError") {
                console.log("Retry cancelled by client");
            } else {
                send("error", { message: error.message });
            }
        } finally {
            res.end();
        }
    });

    return router;
}
