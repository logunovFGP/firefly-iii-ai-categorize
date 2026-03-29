import { streamSSE } from "../lib/sse.js";
import Alpine from "alpinejs";

export function initBatchStore(Alpine) {
    Alpine.store("batch", {
        analyzing: false,
        analyzeProgress: { phase: "", processed: 0, total: 0, skipped: 0, errors: 0, current: "", lastError: "", elapsed: 0, pct: 0 },
        analyzeErrors: [],
        result: null,
        vocabulary: { initial: [], current: [], get added() { return this.current.filter(c => !this.initial.includes(c)); } },
        mergeSelections: {},
        newCategoryChecked: {},
        applying: false,
        applyProgress: { applied: 0, failed: 0, total: 0, current: "", elapsed: 0, pct: 0 },
        applyErrors: [],
        _abortController: null,

        get hasResults() { return this.result?.proposals?.length > 0; },
        get hasDuplicates() { return this.result?.duplicates?.length > 0; },
        get hasNewCategories() { return this.result?.newCategoryProposals?.length > 0; },

        async startAnalysis() {
            this.analyzing = true;
            this.result = null;
            this.analyzeErrors = [];
            this.vocabulary = { initial: [], current: [], get added() { return this.current.filter(c => !this.initial.includes(c)); } };
            this._abortController = new AbortController();
            const startTime = Date.now();

            try {
                const result = await streamSSE("/api/batch/analyze", "POST", undefined, {
                    signal: this._abortController.signal,
                    onProgress: (p) => {
                        if (p.lastError) this.analyzeErrors = [...this.analyzeErrors, p.lastError];
                        const elapsed = Date.now() - startTime;
                        if (p.phase === "fetching") {
                            this.analyzeProgress = { ...this.analyzeProgress, phase: "fetching", processed: p.page || 0, total: p.totalPages || 1, current: p.fetchedSoFar ? `Fetching page ${p.page}/${p.totalPages} (${p.fetchedSoFar} txns)` : (p.message || "Fetching..."), elapsed, pct: p.totalPages ? (p.page / p.totalPages * 100) : 0 };
                        } else {
                            this.analyzeProgress = { ...p, elapsed, pct: p.total > 0 ? ((p.processed || 0) / p.total * 100) : 0 };
                        }
                        if (p.vocabulary) {
                            this.vocabulary = { initial: p.vocabulary.initial, current: p.vocabulary.current, get added() { return this.current.filter(c => !this.initial.includes(c)); } };
                        }
                    },
                });
                this.result = result;
                if (result.autoMerged > 0) Alpine.store("toast").show(`Auto-merged ${result.autoMerged} duplicate category name(s)`, "info");
                Alpine.store("toast").show(`Analysis complete: ${result.totalProposals} proposals`, "success");
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
            } finally {
                this.analyzing = false;
                this._abortController = null;
            }
        },

        cancelAnalysis() {
            this._abortController?.abort();
            this._abortController = null;
            this.analyzing = false;
        },

        applyMerge() {
            if (!this.result) return;
            const mergeMap = {};
            for (const [idx, keep] of Object.entries(this.mergeSelections)) {
                const dup = this.result.duplicates[idx];
                if (dup) for (const v of dup.variants) { if (v !== keep) mergeMap[v.toLowerCase()] = keep; }
            }
            this.result = {
                ...this.result,
                proposals: this.result.proposals.map(p => {
                    const key = p.proposedCategory?.toLowerCase();
                    if (key && mergeMap[key]) return { ...p, proposedCategory: mergeMap[key] };
                    return p;
                }),
                duplicates: [],
            };
            Alpine.store("toast").show("Categories merged", "success");
        },

        async applyAll() {
            if (!this.result) return;
            this.applying = true;
            this.applyErrors = [];
            const startTime = Date.now();
            const newCategories = Object.entries(this.newCategoryChecked).filter(([, v]) => v !== false).map(([k]) => k);

            try {
                const r = await streamSSE("/api/batch/apply", "POST", { proposals: this.result.proposals, newCategories }, {
                    onProgress: (p) => {
                        if (p.lastError) this.applyErrors = [...this.applyErrors, `${p.current}: ${p.lastError}`];
                        this.applyProgress = { ...p, elapsed: Date.now() - startTime, pct: p.total > 0 ? ((p.applied || 0) / p.total * 100) : 0 };
                    },
                });
                this.applyProgress = { ...r, elapsed: Date.now() - startTime, pct: 100 };
                this.result = null;
                Alpine.store("toast").show(`Applied ${r.applied} categorizations`, r.failed ? "info" : "success");
                await Alpine.store("app").loadSettings();
                await Alpine.store("app").loadMemory();
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
            } finally {
                this.applying = false;
            }
        },

        reset() {
            this.result = null;
            this.analyzeErrors = [];
            this.applyErrors = [];
            this.vocabulary = { initial: [], current: [], get added() { return []; } };
        },
    });
}
