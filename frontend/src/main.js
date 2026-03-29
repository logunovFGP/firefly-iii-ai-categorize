import Alpine from "alpinejs";
import focus from "@alpinejs/focus";

import { initAppStore } from "./stores/app.js";
import { initBatchStore } from "./stores/batch.js";
import { initJobsStore } from "./stores/jobs.js";
import { initToastStore } from "./lib/toast.js";
import { initSocket } from "./lib/socket.js";

import "./styles/main.css";

Alpine.plugin(focus);

initToastStore(Alpine);
initAppStore(Alpine);
initBatchStore(Alpine);
initJobsStore(Alpine);

window.Alpine = Alpine;
Alpine.start();

initSocket();
Alpine.store("app").init();
