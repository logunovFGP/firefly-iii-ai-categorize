import { Router } from "express";

export default function webhookRoutes({ configStore, jobList, queue, engine, firefly }) {
    const router = Router();

    router.post("/webhook", (req, res) => {
        if (!configStore.getEnableWebhook()) {
            return res.status(503).json({ error: "Webhook is disabled" });
        }
        try {
            handleWebhook(req);
            res.send("Queued");
        } catch (e) {
            console.error(e);
            res.status(400).send(e.message);
        }
    });

    function handleWebhook(req) {
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

        if (req.body.content.transactions.length > 1) {
            console.warn(`Webhook: transaction group has ${req.body.content.transactions.length} splits, processing first only`);
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
        if (jobList.isAlreadyProcessed(fireflyTxnId)) {
            throw new Error(`Transaction ${fireflyTxnId} already processed`);
        }

        const destinationName = txn.destination_name;
        const description = txn.description || "";

        const job = jobList.createJob({
            destinationName,
            description,
            fireflyTransactionId: fireflyTxnId,
        });

        queue.push(async () => {
            jobList.setJobInProgress(job.id);
            try {
                const result = await engine.classify(destinationName, description);
                const { provider, model } = configStore.getActiveProvider();
                jobList.updateJobResult(job.id, { ...result, provider, model });

                if (result.category) {
                    await firefly.setCategory(
                        req.body.content.id,
                        req.body.content.transactions,
                        result.categoryId
                    );
                }
            } catch (error) {
                console.error(`Classification failed: ${error.message}`);
                jobList.setJobError(job.id, error.message);
            }
        });
    }

    return router;
}
