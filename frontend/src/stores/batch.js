import { streamSSE } from "../lib/sse.js";
import { api } from "../lib/api.js";

export function initBatchStore(Alpine) {
    Alpine.store("batch", {
        // Step state: null | 'analyzing' | 'merge' | 'merging' | 'review' | 'retrying' | 'applying' | 'done'
        step: null,
        result: null,
        analyzeProgress: { phase: "", processed: 0, total: 0, skipped: 0, errors: 0, current: "", lastError: "", elapsed: 0, pct: 0 },
        analyzeErrors: [],
        vocabulary: { initial: [], current: [], get added() { return this.current.filter(c => c && typeof c === "string" && c.length < 100 && !c.startsWith("[") && !c.startsWith("{") && !this.initial.includes(c)); } },
        mergeSelections: {},
        newCategoryChecked: {},
        applyProgress: { applied: 0, failed: 0, total: 0, current: "", elapsed: 0, pct: 0 },
        applyErrors: [],
        applyResult: null,
        retryProgress: { phase: "", processed: 0, total: 0, errors: 0, current: "", pct: 0 },
        _abortController: null,

        // --- Getters ---
        get hasResults() { return this.result?.proposals?.length > 0; },
        get hasDuplicates() { return this.result?.duplicates?.length > 0; },
        get hasNewCategories() { return this.result?.newCategoryProposals?.length > 0; },
        get hasUnmatched() { return (this.result?.uncategorized || 0) > 0; },
        get isBusy() { return ["analyzing", "merging", "retrying", "applying"].includes(this.step); },

        // Reactive getter: categories available to add to any merge group
        get availableForGroups() {
            if (!this.result?.duplicates?.length || !this.result?.discoveredCategories?.length) return [];
            const inGroups = new Set(this.result.duplicates.flatMap(d => d.variants));
            return this.result.discoveredCategories.filter(c => !inGroups.has(c));
        },

        // --- Step transition helpers ---
        _enterMergeOrReview(result) {
            this.result = result;
            this._initNewCategoryChecked();
            if (result.duplicates?.length > 0) {
                this._initMergeSelections();
                this.step = "merge";
            } else {
                this.step = "review";
            }
        },

        _initMergeSelections() {
            this.mergeSelections = {};
            for (let i = 0; i < (this.result?.duplicates || []).length; i++) {
                this.mergeSelections[i] = this.result.duplicates[i].recommended || this.result.duplicates[i].variants[0];
            }
        },

        _initNewCategoryChecked() {
            this.newCategoryChecked = {};
            for (const p of this.result?.newCategoryProposals || []) {
                this.newCategoryChecked[p.suggestedCategoryName] = true;
            }
        },

        // --- Merge UI editing (display only — no data transformation) ---
        removeFromGroup(groupIndex, variantToRemove) {
            const dup = this.result?.duplicates?.[groupIndex];
            if (!dup || dup.variants.length <= 2) return;
            const newVariants = dup.variants.filter(v => v !== variantToRemove);
            const newDups = this.result.duplicates.map((d, i) =>
                i === groupIndex ? { ...d, variants: newVariants } : d
            );
            const newSelections = { ...this.mergeSelections };
            if (newSelections[groupIndex] === variantToRemove) {
                newSelections[groupIndex] = newDups[groupIndex].recommended || newVariants[0];
            }
            this.result = { ...this.result, duplicates: newDups };
            this.mergeSelections = newSelections;
        },

        addToGroup(groupIndex, variant) {
            const dup = this.result?.duplicates?.[groupIndex];
            if (!dup || !variant || dup.variants.includes(variant)) return;
            const newDups = this.result.duplicates.map((d, i) =>
                i === groupIndex ? { ...d, variants: [...d.variants, variant] } : d
            );
            this.result = { ...this.result, duplicates: newDups };
        },

        // --- Server calls ---
        async startAnalysis() {
            if (this.isBusy) return;
            this.step = "analyzing";
            this.result = null;
            this.analyzeErrors = [];
            this.mergeSelections = {};
            this.newCategoryChecked = {};
            this.applyResult = null;
            const existingCats = (Alpine.store("app").categories || []).map(c => c.name).sort();
            this.vocabulary = { initial: existingCats, current: [...existingCats], get added() { return this.current.filter(c => c && typeof c === "string" && c.length < 100 && !c.startsWith("[") && !c.startsWith("{") && !this.initial.includes(c)); } };
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
                            this.vocabulary = { initial: p.vocabulary.initial, current: p.vocabulary.current, get added() { return this.current.filter(c => c && typeof c === "string" && c.length < 100 && !c.startsWith("[") && !c.startsWith("{") && !this.initial.includes(c)); } };
                        }
                    },
                });
                if (result.autoMerged > 0) Alpine.store("toast").show(`Auto-merged ${result.autoMerged} duplicate category name(s)`, "info");
                if (result.duplicates?.length > 0) Alpine.store("toast").show(`${result.duplicates.length} semantic duplicate group(s) found`, "warning");
                Alpine.store("toast").show(`Analysis complete: ${result.totalProposals} proposals`, "success");
                this._enterMergeOrReview(result);
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
                this.step = null;
            } finally {
                this._abortController = null;
            }
        },

        cancelAnalysis() {
            this._abortController?.abort();
            this._abortController = null;
            this.step = null;
        },

        async confirmMerge() {
            if (!this.result?.duplicates?.length) { this.step = "review"; return; }
            const mergeMap = {};
            for (const [idx, keep] of Object.entries(this.mergeSelections)) {
                const dup = this.result.duplicates[idx];
                if (!dup) continue;
                for (const v of dup.variants) {
                    if (v !== keep) mergeMap[v.toLowerCase()] = keep;
                }
            }
            if (Object.keys(mergeMap).length === 0) { this.step = "review"; return; }

            this.step = "merging";
            try {
                const serverResult = await api("POST", "/api/batch/merge", {
                    proposals: this.result.proposals,
                    existingCategories: this.result.existingCategories,
                    mergeMap,
                });
                Alpine.store("toast").show("Categories merged", "success");
                this._enterMergeOrReview({
                    ...serverResult,
                    totalTransactions: this.result.totalTransactions,
                    totalProposals: serverResult.proposals.length,
                    skipped: this.result.skipped,
                    errors: this.result.errors,
                    autoMerged: (this.result.autoMerged || 0) + Object.keys(mergeMap).length,
                    duplicates: serverResult.duplicates || [],
                });
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
                this.step = "merge";
            }
        },

        skipMerge() { this.step = "review"; },

        async retryUnmatched() {
            if (!this.result?.proposals || this.isBusy) return;
            this.step = "retrying";
            const startTime = Date.now();
            try {
                const result = await streamSSE("/api/batch/retry-unmatched", "POST", { proposals: this.result.proposals }, {
                    onProgress: (p) => {
                        this.retryProgress = { ...p, elapsed: Date.now() - startTime, pct: p.total > 0 ? ((p.processed || 0) / p.total * 100) : 0 };
                    },
                });
                const msg = result.newlyMatched > 0
                    ? `Research pass: ${result.newlyMatched} of ${result.totalRetried} newly categorized`
                    : `Research pass: no new matches for ${result.totalRetried} transactions`;
                Alpine.store("toast").show(msg, result.newlyMatched > 0 ? "success" : "info");
                this._enterMergeOrReview(result);
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
                this.step = "review";
            }
        },

        async applyAll() {
            if (!this.result || this.isBusy) return;
            this.step = "applying";
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
                this.applyResult = {
                    applied: r.applied, failed: r.failed, skippedNull: r.skippedNull, total: r.total,
                    categoriesCreated: r.categoriesCreated || [], categoriesExisted: r.categoriesExisted || [],
                };
                this.result = null;
                Alpine.store("toast").show(`Applied ${r.applied} categorizations`, r.failed ? "info" : "success");
                await Alpine.store("app").loadSettings();
                await Alpine.store("app").loadMemory();
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
            } finally {
                this.step = "done";
            }
        },

        reset() {
            this.step = null;
            this.result = null;
            this.analyzeErrors = [];
            this.applyErrors = [];
            this.applyResult = null;
            this.mergeSelections = {};
            this.newCategoryChecked = {};
            this.vocabulary = { initial: [], current: [], get added() { return []; } };
        },
    });
}
