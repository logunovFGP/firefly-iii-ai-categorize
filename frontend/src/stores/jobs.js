import { api } from "../lib/api.js";
import Alpine from "alpinejs";

export function initJobsStore(Alpine) {
    Alpine.store("jobs", {
        allJobs: [],
        filter: "all",

        get filteredJobs() {
            return this.filter === "review"
                ? this.allJobs.filter(j => j.needs_review === 1)
                : this.allJobs;
        },

        setFilter(value) { this.filter = value; },

        handleJobsEvent(jobs) { this.allJobs = jobs; },

        handleJobCreated(e) {
            if (e.job) this.allJobs = [e.job, ...this.allJobs.filter(j => j.id !== e.job.id)];
        },

        handleJobUpdated(e) {
            if (e.job) this.allJobs = this.allJobs.map(j => j.id === e.job.id ? e.job : j);
        },

        async correctJob(jobId, category, categoryId) {
            await api("POST", `/api/jobs/${jobId}/correct`, { category, categoryId });
            Alpine.store("toast").show("Correction saved", "success");
        },
    });
}
