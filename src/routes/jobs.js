import { Router } from "express";

export default function jobsRoutes({ jobList, merchantMemory, firefly, categoriesCache }) {
    const router = Router();

    function handleError(res, error) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error(error);
        res.status(500).json({ error: error.message });
    }

    router.get("/jobs", (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        res.json(jobList.getJobs(limit, offset));
    });

    router.get("/jobs/review", (req, res) => {
        res.json(jobList.getNeedsReview());
    });

    router.post("/jobs/:id/correct", async (req, res) => {
        try {
            const { category, categoryId } = req.body || {};
            if (!category) return res.status(400).json({ error: "category is required" });

            const job = jobList.getJob(req.params.id);
            if (!job) return res.status(404).json({ error: "Job not found" });

            jobList.correctJob(job.id, category);

            if (job.destination_name) {
                merchantMemory.correct(job.destination_name, category, categoryId || "");
            }

            // Sync correction to Firefly if we have the transaction ID
            if (job.firefly_transaction_id) {
                try {
                    const txnData = await firefly.getTransaction(job.firefly_transaction_id);
                    if (txnData) {
                        const cats = await categoriesCache.getCategories();
                        const catId = categoryId || cats.get(category);
                        if (catId) {
                            await firefly.setCategory(
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

            res.json(jobList.getJob(job.id));
        } catch (error) {
            handleError(res, error);
        }
    });

    return router;
}
