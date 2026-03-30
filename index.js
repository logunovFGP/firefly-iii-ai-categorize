import App from "./src/App.js";

const app = new App();

(async function () {
    await app.run();
})().catch(err => {
    console.error("Startup failed:", err);
    process.exit(1);
});

const shutdown = () => {
    console.log("Shutting down gracefully...");
    try { app._database?.close(); } catch { /* best effort */ }
    try { app._server?.close(); } catch { /* best effort */ }
    process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
