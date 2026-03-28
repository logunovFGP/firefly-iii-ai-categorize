import { v4 as uuid } from "uuid";
import EventEmitter from "events";

export default class JobList {
    #db;
    #stmts;
    #eventEmitter = new EventEmitter();

    constructor(database) {
        this.#db = database.db;
        this.#stmts = {
            insert: this.#db.prepare(
                `INSERT INTO jobs (id, status, created, destination_name, description, firefly_transaction_id)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ),
            get: this.#db.prepare("SELECT * FROM jobs WHERE id = ?"),
            findByFireflyTxnId: this.#db.prepare(
                "SELECT id FROM jobs WHERE firefly_transaction_id = ?"
            ),
            update: this.#db.prepare(
                `UPDATE jobs SET status=?, category=?, category_id=?, confidence=?,
                 source=?, provider=?, model=?, prompt=?, response=?,
                 needs_review=?, finished=?
                 WHERE id=?`
            ),
            setStatus: this.#db.prepare("UPDATE jobs SET status = ? WHERE id = ?"),
            correct: this.#db.prepare("UPDATE jobs SET corrected_category = ? WHERE id = ?"),
            recent: this.#db.prepare("SELECT * FROM jobs ORDER BY created DESC LIMIT ? OFFSET ?"),
            needsReview: this.#db.prepare(
                "SELECT * FROM jobs WHERE needs_review = 1 ORDER BY created DESC"
            ),
            setError: this.#db.prepare(
                "UPDATE jobs SET status = 'error', response = ?, finished = ? WHERE id = ?"
            ),
        };
    }

    on(event, listener) {
        this.#eventEmitter.on(event, listener);
    }

    getJobs(limit = 50, offset = 0) {
        return this.#stmts.recent.all(limit, offset);
    }

    getJob(id) {
        return this.#stmts.get.get(id) || null;
    }

    getNeedsReview() {
        return this.#stmts.needsReview.all();
    }

    isAlreadyProcessed(fireflyTransactionId) {
        if (!fireflyTransactionId) return false;
        return !!this.#stmts.findByFireflyTxnId.get(String(fireflyTransactionId));
    }

    createJob(data) {
        const id = uuid();
        const created = new Date().toISOString();
        this.#stmts.insert.run(
            id, "queued", created,
            data.destinationName, data.description,
            data.fireflyTransactionId || null
        );
        const job = this.#stmts.get.get(id);
        this.#eventEmitter.emit("job created", { job, jobs: this.getJobs() });
        return job;
    }

    setJobInProgress(id) {
        this.#stmts.setStatus.run("in_progress", id);
        const job = this.#stmts.get.get(id);
        this.#eventEmitter.emit("job updated", { job, jobs: this.getJobs() });
    }

    updateJobResult(id, result) {
        this.#stmts.update.run(
            result.needsReview ? "review" : "finished",
            result.category || null,
            result.categoryId || null,
            result.confidence ?? null,
            result.source || null,
            result.provider || null,
            result.model || null,
            result.prompt || null,
            result.response || null,
            result.needsReview ? 1 : 0,
            new Date().toISOString(),
            id
        );
        const job = this.#stmts.get.get(id);
        this.#eventEmitter.emit("job updated", { job, jobs: this.getJobs() });
        return job;
    }

    setJobError(id, errorMessage) {
        this.#stmts.setError.run(errorMessage, new Date().toISOString(), id);
        const job = this.#stmts.get.get(id);
        this.#eventEmitter.emit("job updated", { job, jobs: this.getJobs() });
    }

    correctJob(id, category) {
        this.#stmts.correct.run(category, id);
        const job = this.#stmts.get.get(id);
        this.#eventEmitter.emit("job updated", { job, jobs: this.getJobs() });
        return job;
    }
}
