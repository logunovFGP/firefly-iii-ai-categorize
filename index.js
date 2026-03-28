import App from "./src/App.js";

(async function () {
    const app = new App();
    await app.run();
})().catch(err => {
    console.error("Startup failed:", err);
    process.exit(1);
});
