import {getConfigVariable} from "./util.js";

export default class FireflyService {
    #BASE_URL;
    #configStore;

    constructor(configStore) {
        this.#configStore = configStore;
        this.#BASE_URL = getConfigVariable("FIREFLY_URL")
        if (this.#BASE_URL.slice(-1) === "/") {
            this.#BASE_URL = this.#BASE_URL.substring(0, this.#BASE_URL.length - 1)
        }
    }

    async getCategories() {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", {required: true});
        const categories = new Map();
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
            const response = await fetch(`${this.#BASE_URL}/api/v1/categories?limit=50&page=${page}`, {
                headers: { Authorization: `Bearer ${personalToken}` },
            });

            if (!response.ok) {
                throw new FireflyException(response.status, response, await response.text());
            }

            const contentType = response.headers.get("content-type") || "";
            if (!contentType.includes("json")) {
                throw new FireflyException(200, response, "Firefly returned HTML instead of JSON. Check your Personal Access Token — it may be invalid or expired.");
            }

            const data = await response.json();
            totalPages = data.meta?.pagination?.total_pages || 1;

            data.data.forEach(category => {
                categories.set(category.attributes.name, category.id);
            });

            page++;
        }

        return categories;
    }

    async setCategory(transactionId, transactions, categoryId) {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", {required: true});
        const tag = getConfigVariable("FIREFLY_TAG", "AI categorized");

        const body = {
            apply_rules: true,
            fire_webhooks: true,
            transactions: [],
        }

        transactions.forEach(transaction => {
            const tags = [...(transaction.tags || []), tag];

            body.transactions.push({
                transaction_journal_id: transaction.transaction_journal_id,
                category_id: categoryId,
                tags,
            });
        })

        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${personalToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text())
        }

        await response.json();
        console.info("Transaction updated");
    }

    async checkConnection() {
        try {
            const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN");
            if (!personalToken) return { connected: false, error: "No Firefly token configured" };

            const response = await fetch(`${this.#BASE_URL}/api/v1/about`, {
                headers: { Authorization: `Bearer ${personalToken}` },
            });
            if (!response.ok) return { connected: false, error: `HTTP ${response.status}` };

            const data = await response.json();
            return { connected: true, version: data.data?.version };
        } catch (error) {
            return { connected: false, error: error.message };
        }
    }

    async createCategory(name) {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
        const response = await fetch(`${this.#BASE_URL}/api/v1/categories`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${personalToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ name }),
        });
        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }
        return await response.json();
    }

    /**
     * Bulk-update categories and tags for up to 100 transactions in one request.
     * Returns null if the endpoint doesn't exist (Firefly III not updated).
     */
    async bulkCategorize(items) {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
        const response = await fetch(`${this.#BASE_URL}/api/v1/data/bulk/categorize`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${personalToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                transactions: items.map(it => ({
                    transaction_group_id: parseInt(it.transactionGroupId, 10),
                    category_name: it.categoryName,
                    tag: it.tag || undefined,
                })),
            }),
        });
        if (!response.ok) {
            if (response.status === 404) return null;
            throw new FireflyException(response.status, response, await response.text());
        }
        return await response.json();
    }

    /**
     * Probe whether the bulk categorize endpoint exists.
     * Sends an empty array which triggers 422 (exists) vs 404 (missing).
     */
    async checkBulkCategorizeSupport() {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
        try {
            const response = await fetch(`${this.#BASE_URL}/api/v1/data/bulk/categorize`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${personalToken}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({ transactions: [] }),
            });
            return response.status !== 404;
        } catch { return false; }
    }

    async getTransaction(transactionId) {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
            headers: { Authorization: `Bearer ${personalToken}` },
        });
        if (!response.ok) return null;
        return await response.json();
    }

    async getUncategorizedTransactions(onPageFetched = null) {
        const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
        const results = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
            const url = `${this.#BASE_URL}/api/v1/transactions?type=withdrawal&without_category=true&limit=50&page=${page}`;
            const response = await fetch(url, {
                headers: { Authorization: `Bearer ${personalToken}` },
            });

            if (!response.ok) {
                throw new FireflyException(response.status, response, await response.text());
            }

            const data = await response.json();
            totalPages = data.meta?.pagination?.total_pages || 1;

            for (const txn of data.data) {
                results.push(txn);
            }

            if (onPageFetched) onPageFetched({ page, totalPages, fetchedSoFar: results.length });
            page++;
        }

        return results;
    }
}

class FireflyException extends Error {
    code;
    response;
    body;

    constructor(statusCode, response, body) {
        super(`Error while communicating with Firefly III: ${statusCode} - ${body}`);

        this.code = statusCode;
        this.response = response;
        this.body = body;
    }
}
