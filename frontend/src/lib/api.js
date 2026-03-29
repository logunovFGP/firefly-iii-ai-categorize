export function getAuthToken() {
    return localStorage.getItem("categorizer_api_token") || "";
}

export function setAuthToken(token) {
    if (token) localStorage.setItem("categorizer_api_token", token);
    else localStorage.removeItem("categorizer_api_token");
}

export async function api(method, url, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    const token = getAuthToken();
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) opts.body = JSON.stringify(body);

    const response = await fetch(url, opts);
    if (response.status === 401 || response.status === 403) {
        window.dispatchEvent(new CustomEvent("auth:required"));
        throw new Error("Authentication required");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}
