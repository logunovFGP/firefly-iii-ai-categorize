export default class KeywordRules {
    #rules;

    constructor(rules = []) {
        this.#rules = rules;
    }

    reload(rules) {
        this.#rules = rules;
    }

    match(destinationName, description) {
        const text = `${destinationName} ${description}`.toLowerCase();

        for (const rule of this.#rules) {
            for (const keyword of rule.keywords) {
                if (text.includes(keyword.toLowerCase())) {
                    return { category: rule.category, matchedKeyword: keyword };
                }
            }
        }

        return null;
    }
}
