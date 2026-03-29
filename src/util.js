class MissingEnvironmentVariableException extends Error {
    variableName;

    constructor(variableName) {
        super(`The required environment variable '${variableName}' is missing`);

        this.variableName = variableName;
    }
}

export function normalizeMerchantName(name) {
    if (!name) return "";
    return name
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\s*[*#]\s*[\d]+$/g, "")
        .toUpperCase();
}

export async function mapConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

export function findCategoryDuplicates(categoryNames, existingCategories = []) {
    const existingLower = new Set(existingCategories.map(c => c.toLowerCase()));
    const groups = {};
    for (const cat of categoryNames) {
        const key = cat.toLowerCase().replace(/[\s\-_]+/g, " ").trim();
        if (!groups[key]) groups[key] = [];
        if (!groups[key].includes(cat)) groups[key].push(cat);
    }
    const duplicates = [];
    for (const variants of Object.values(groups)) {
        if (variants.length <= 1) continue;
        const existing = variants.find(v => existingLower.has(v.toLowerCase()));
        duplicates.push({ variants, recommended: existing || variants[0] });
    }
    return duplicates;
}

export function mergeProposals(proposals, mergeMap) {
    return proposals.map(p => {
        const key = p.proposedCategory?.toLowerCase();
        if (key && mergeMap[key]) return { ...p, proposedCategory: mergeMap[key] };
        return p;
    });
}

export function matchCategory(guess, categoryList) {
    if (!guess || typeof guess !== 'string') return null;
    if (categoryList.includes(guess)) return guess;
    const lower = guess.toLowerCase();
    return categoryList.find(c => c.toLowerCase() === lower) || null;
}

export function getConfigVariable(name, defaultValue = null) {
    if (!process.env.hasOwnProperty(name) || process.env[name] == null) {
        if (defaultValue == null) {
            throw new MissingEnvironmentVariableException(name)
        }

        return defaultValue;
    }

    return process.env[name];
}