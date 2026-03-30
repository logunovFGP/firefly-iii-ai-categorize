import { Router } from "express";

export default function memoryRoutes({ merchantMemory }) {
    const router = Router();

    router.get("/memory", (req, res) => {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        res.json(merchantMemory.list(limit, offset));
    });

    router.get("/memory/stats", (req, res) => {
        res.json(merchantMemory.getStats());
    });

    router.delete("/memory/:merchant", (req, res) => {
        merchantMemory.remove(decodeURIComponent(req.params.merchant));
        res.json({ ok: true });
    });

    router.delete("/memory", (req, res) => {
        merchantMemory.clear();
        res.json({ ok: true });
    });

    return router;
}
