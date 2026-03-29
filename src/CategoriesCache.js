export default class CategoriesCache {
    #fireflyService;
    #cache = null;
    #cachedAt = 0;
    #ttlMs;

    constructor(fireflyService, ttlMs = 60_000) {
        this.#fireflyService = fireflyService;
        this.#ttlMs = ttlMs;
    }

    async getCategories() {
        if (this.#cache && (Date.now() - this.#cachedAt) < this.#ttlMs) {
            return this.#cache;
        }
        this.#cache = await this.#fireflyService.getCategories();
        this.#cachedAt = Date.now();
        return this.#cache;
    }

    async ensureCategory(name) {
        const categories = await this.getCategories();
        if (categories.has(name)) return categories.get(name);
        await this.#fireflyService.createCategory(name);
        this.invalidate();
        return (await this.getCategories()).get(name) || null;
    }

    invalidate() {
        this.#cache = null;
        this.#cachedAt = 0;
    }

    async getCategoryList() {
        const cats = await this.getCategories();
        return Array.from(cats.entries()).map(([name, id]) => ({ name, id }));
    }
}
