import { api, setAuthToken, getAuthToken } from "../lib/api.js";
import { reconnectSocket } from "../lib/socket.js";

export function initAppStore(Alpine) {
    Alpine.store("app", {
        authenticated: false,
        authOverlayVisible: false,
        authError: "",
        _authInput: "",
        activeTab: "setup",
        connection: { status: "checking", version: "", error: "" },
        server: null,
        categories: [],
        memoryEntries: [],
        loading: { settings: false, memory: false, settingsSave: false, firefly: false, ai: false },

        get isSetupComplete() {
            return this.server?.hasFireflyPersonalToken && this.connection.status === "ok" && this.activeProviderHasKey;
        },
        get activeProviderHasKey() {
            const def = this.server?.providers?.[this.server?.activeProvider];
            return def?.hasApiKey ?? false;
        },

        async init() {
            window.addEventListener("auth:required", () => { this.authOverlayVisible = true; });
            try {
                const status = await fetch("/api/setup-status").then(r => r.json());
                if (status.apiTokenRequired) {
                    if (getAuthToken()) {
                        try { await this.loadSettings(); await this.loadMemory(); this.authenticated = true; return; }
                        catch { this.authOverlayVisible = true; return; }
                    }
                    this.authOverlayVisible = true;
                    return;
                }
                await this.loadSettings();
                await this.loadMemory();
                this.authenticated = true;
            } catch {
                try { await this.loadSettings(); await this.loadMemory(); this.authenticated = true; }
                catch { this.authOverlayVisible = true; }
            }
        },

        switchTab(name) { this.activeTab = name; },

        async authenticate(token) {
            if (!token?.trim()) return;
            setAuthToken(token.trim());
            try {
                await this.loadSettings();
                this.authOverlayVisible = false;
                this.authError = "";
                this.authenticated = true;
                reconnectSocket();
                await this.loadMemory();
            } catch {
                setAuthToken("");
                this.authError = "Invalid token";
            }
        },

        async loadSettings() {
            this.loading.settings = true;
            try {
                this.server = await api("GET", "/api/settings");
                this.categories = await api("GET", "/api/categories").catch(() => []);
                this.connection = this.server.fireflyStatus?.connected
                    ? { status: "ok", version: this.server.fireflyStatus.version, error: "" }
                    : { status: "fail", version: "", error: this.server.fireflyStatus?.error || "unreachable" };
                if (this.isSetupComplete && this.activeTab === "setup") this.switchTab("classify");
            } finally {
                this.loading.settings = false;
            }
        },

        async loadMemory() {
            this.loading.memory = true;
            try {
                this.memoryEntries = await api("GET", "/api/memory?limit=100");
            } catch { this.memoryEntries = []; }
            finally { this.loading.memory = false; }
        },

        async saveSettings(payload) {
            this.loading.settingsSave = true;
            try {
                await api("PUT", "/api/settings", payload);
                await this.loadSettings();
                Alpine.store("toast").show("Settings saved", "success");
            } catch (err) {
                Alpine.store("toast").show(err.message, "error");
                throw err;
            } finally {
                this.loading.settingsSave = false;
            }
        },

        async saveRules(rules) {
            await api("PUT", "/api/rules", rules);
            Alpine.store("toast").show("Rules saved", "success");
        },

        async testFirefly(token) {
            this.loading.firefly = true;
            try {
                if (token?.trim()) await api("PUT", "/api/settings", { fireflyPersonalToken: token.trim() });
                const status = await api("GET", "/api/firefly/status");
                await this.loadSettings();
                Alpine.store("toast").show(
                    status.connected ? `Firefly III v${status.version} connected!` : `Unreachable: ${status.error}`,
                    status.connected ? "success" : "error"
                );
            } catch (err) { Alpine.store("toast").show(err.message, "error"); }
            finally { this.loading.firefly = false; }
        },

        async testAi(provider, apiKey) {
            this.loading.ai = true;
            try {
                if (apiKey?.trim()) await api("PUT", "/api/settings/tokens", { provider, apiKey: apiKey.trim() });
                const r = await api("POST", "/api/settings/test", { provider });
                await this.loadSettings();
                Alpine.store("toast").show(r.success ? `${provider} connected!` : `Failed: ${r.error}`, r.success ? "success" : "error");
            } catch (err) { Alpine.store("toast").show(err.message, "error"); }
            finally { this.loading.ai = false; }
        },

        async clearMemory() {
            await api("DELETE", "/api/memory");
            await this.loadMemory();
            await this.loadSettings();
            Alpine.store("toast").show("Memory cleared", "info");
        },
    });
}
