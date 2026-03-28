import { normalizeMerchantName } from "./util.js";

export default class MerchantMemory {
    #db;
    #stmts;

    constructor(database) {
        this.#db = database.db;
        this.#stmts = {
            lookup: this.#db.prepare(
                "SELECT * FROM merchants WHERE name = ?"
            ),
            upsert: this.#db.prepare(`
                INSERT INTO merchants (name, raw_name, category, category_id, confidence, source, first_seen, last_seen, count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(name) DO UPDATE SET
                    category = excluded.category,
                    category_id = excluded.category_id,
                    confidence = excluded.confidence,
                    source = excluded.source,
                    last_seen = excluded.last_seen,
                    count = count + 1
            `),
            correct: this.#db.prepare(`
                UPDATE merchants SET category = ?, category_id = ?, confidence = 1.0,
                    source = 'user-correction', corrected = 1, last_seen = ?
                WHERE name = ?
            `),
            examples: this.#db.prepare(
                "SELECT raw_name AS merchant, category FROM merchants ORDER BY last_seen DESC LIMIT ?"
            ),
            stats: this.#db.prepare(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN corrected = 0 THEN 1 ELSE 0 END) AS ai_learned,
                    SUM(CASE WHEN corrected = 1 THEN 1 ELSE 0 END) AS user_corrected
                FROM merchants
            `),
            list: this.#db.prepare(
                "SELECT * FROM merchants ORDER BY last_seen DESC LIMIT ? OFFSET ?"
            ),
            remove: this.#db.prepare("DELETE FROM merchants WHERE name = ?"),
            clear: this.#db.prepare("DELETE FROM merchants"),
        };
    }

    lookup(merchantName) {
        return this.#stmts.lookup.get(this.#normalize(merchantName)) || null;
    }

    learn(merchantName, { category, categoryId, confidence, source }) {
        const now = new Date().toISOString();
        const normalized = this.#normalize(merchantName);
        this.#stmts.upsert.run(
            normalized, merchantName, category, categoryId,
            confidence, source, now, now
        );
    }

    correct(merchantName, category, categoryId) {
        const now = new Date().toISOString();
        const normalized = this.#normalize(merchantName);
        const result = this.#stmts.correct.run(category, categoryId, now, normalized);
        if (result.changes === 0) {
            this.#stmts.upsert.run(
                normalized, merchantName, category, categoryId,
                1.0, "user-correction", now, now
            );
            this.#db.prepare("UPDATE merchants SET corrected = 1 WHERE name = ?").run(normalized);
        }
    }

    getExamples(limit = 5) {
        return this.#stmts.examples.all(limit);
    }

    getStats() {
        return this.#stmts.stats.get();
    }

    list(limit = 50, offset = 0) {
        return this.#stmts.list.all(limit, offset);
    }

    remove(merchantName) {
        this.#stmts.remove.run(this.#normalize(merchantName));
    }

    clear() {
        this.#stmts.clear.run();
    }

    #normalize(name) {
        return normalizeMerchantName(name);
    }
}
