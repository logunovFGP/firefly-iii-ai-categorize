import { getAuthToken } from "./api.js";

export function streamSSE(url, method, body, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
        const opts = { method, headers: { "Content-Type": "application/json" }, signal };
        const token = getAuthToken();
        if (token) opts.headers["Authorization"] = `Bearer ${token}`;
        if (body !== undefined) opts.body = JSON.stringify(body);

        let settled = false;
        const done_ = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        fetch(url, opts).then(response => {
            if (!response.ok) return done_(reject, new Error(`HTTP ${response.status}`));
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let currentEvt = "";

            function processBuffer() {
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.startsWith("event: ")) {
                        currentEvt = line.slice(7);
                    } else if (line.startsWith("data: ")) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (currentEvt === "progress" && onProgress) onProgress(data);
                            else if (currentEvt === "complete") { done_(resolve, data); return true; }
                            else if (currentEvt === "error") { done_(reject, new Error(data.message)); return true; }
                        } catch {}
                        currentEvt = "";
                    } else if (line === "") {
                        currentEvt = "";
                    }
                }
                return false;
            }

            function read() {
                reader.read().then(({ done, value }) => {
                    if (value) buffer += decoder.decode(value, { stream: !done });
                    if (processBuffer()) return;
                    if (done) {
                        if (buffer.trim()) { buffer += "\n"; if (processBuffer()) return; }
                        return done_(reject, new Error("Stream ended without completion"));
                    }
                    read();
                }).catch(err => {
                    done_(reject, err.name === "AbortError" ? new Error("Cancelled") : err);
                });
            }
            read();
        }).catch(err => {
            done_(reject, err.name === "AbortError" ? new Error("Cancelled") : err);
        });
    });
}
