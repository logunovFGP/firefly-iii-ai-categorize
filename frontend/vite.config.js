import { defineConfig } from "vite";

export default defineConfig({
    build: {
        outDir: "../public",
        emptyOutDir: true,
    },
    server: {
        proxy: {
            "/api": "http://localhost:3000",
            "/socket.io": { target: "http://localhost:3000", ws: true },
            "/webhook": "http://localhost:3000",
        },
    },
});
