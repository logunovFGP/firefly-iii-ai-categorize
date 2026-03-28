import BetterSqlite3 from "better-sqlite3";

export default class Database {
    #db;

    constructor(filePath = "./storage/categorizer.db") {
        this.#db = new BetterSqlite3(filePath);
        this.#db.pragma("journal_mode = WAL");
        this.#db.pragma("foreign_keys = ON");
        this.#migrate();
    }

    get db() {
        return this.#db;
    }

    close() {
        this.#db.close();
    }

    #migrate() {
        const version = this.#db.pragma("user_version", { simple: true });

        if (version < 1) {
            this.#db.exec(`
                CREATE TABLE IF NOT EXISTS merchants (
                    name TEXT PRIMARY KEY,
                    raw_name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    category_id TEXT NOT NULL,
                    confidence REAL NOT NULL DEFAULT 0.85,
                    source TEXT NOT NULL,
                    corrected INTEGER NOT NULL DEFAULT 0,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'queued',
                    created TEXT NOT NULL,
                    destination_name TEXT,
                    description TEXT,
                    category TEXT,
                    category_id TEXT,
                    confidence REAL,
                    source TEXT,
                    provider TEXT,
                    model TEXT,
                    prompt TEXT,
                    response TEXT,
                    needs_review INTEGER NOT NULL DEFAULT 0,
                    corrected_category TEXT,
                    finished TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
                CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created DESC);
                CREATE INDEX IF NOT EXISTS idx_jobs_needs_review ON jobs(needs_review) WHERE needs_review = 1;
            `);
            this.#db.pragma("user_version = 1");
        }

        if (version < 2) {
            this.#db.exec(`
                ALTER TABLE jobs ADD COLUMN firefly_transaction_id TEXT;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_firefly_txn
                    ON jobs(firefly_transaction_id)
                    WHERE firefly_transaction_id IS NOT NULL;
            `);
            this.#db.pragma("user_version = 2");
        }
    }
}
