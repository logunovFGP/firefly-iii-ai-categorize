import { Router } from "express";

export default function rulesRoutes({ configStore, keywordRules }) {
    const router = Router();

    function handleError(res, error) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error(error);
        res.status(500).json({ error: error.message });
    }

    router.get("/rules", (req, res) => {
        res.json(configStore.getKeywordRules());
    });

    router.put("/rules", async (req, res) => {
        try {
            const rules = req.body;
            if (!Array.isArray(rules)) return res.status(400).json({ error: "Body must be an array of rules" });
            for (const rule of rules) {
                if (!Array.isArray(rule.keywords) || !rule.keywords.length || typeof rule.category !== "string" || !rule.category.trim()) {
                    return res.status(400).json({ error: "Each rule must have a non-empty keywords array and a category string" });
                }
            }
            await configStore.setKeywordRules(rules);
            keywordRules.reload(rules);
            res.json(rules);
        } catch (error) {
            handleError(res, error);
        }
    });

    return router;
}
