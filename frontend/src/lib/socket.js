import { io } from "socket.io-client";
import { getAuthToken } from "./api.js";
import Alpine from "alpinejs";

let socket = null;

export function initSocket() {
    socket = io({ auth: { token: getAuthToken() } });

    socket.on("jobs", (jobs) => {
        Alpine.store("jobs").handleJobsEvent(jobs);
    });

    socket.on("job created", (e) => {
        Alpine.store("jobs").handleJobCreated(e);
    });

    socket.on("job updated", (e) => {
        Alpine.store("jobs").handleJobUpdated(e);
    });
}

export function reconnectSocket() {
    if (!socket) return;
    socket.auth = { token: getAuthToken() };
    socket.disconnect().connect();
}
