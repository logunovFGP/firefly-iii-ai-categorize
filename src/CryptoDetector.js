const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CRYPTO_DESC = /^(USDT|TRX|USDC|USDD|ETH|BTC|BNB|SOL|MATIC|DAI)\s+transfer\s+/i;
const TRC20_DESC = /^TRC20\s+(outgoing|incoming)\s+transfer\s+/i;
const TOKEN_SYMBOL = /^(USDT|TRX|USDC|USDD|ETH|BTC|BNB|SOL|MATIC|DAI)\b/i;

export default class CryptoDetector {
    #defaultCategory;
    #perTokenCategories;

    constructor(configStore) {
        this.#defaultCategory = configStore.getCryptoCategory?.() || "Crypto";
        this.#perTokenCategories = configStore.getCryptoTokenCategories?.() || {};
    }

    detect(destinationName, description) {
        const isAddress = TRON_ADDRESS.test(destinationName) || ETH_ADDRESS.test(destinationName);
        const isCryptoDesc = CRYPTO_DESC.test(description) || TRC20_DESC.test(description);
        if (!isAddress && !isCryptoDesc) return null;

        const tokenMatch = description.match(TOKEN_SYMBOL);
        const symbol = tokenMatch ? tokenMatch[1].toUpperCase() : null;
        const category = symbol && this.#perTokenCategories[symbol]
            ? this.#perTokenCategories[symbol]
            : this.#defaultCategory;

        return { category, tokenSymbol: symbol, confidence: 1.0, source: `crypto:${symbol || "unknown"}`, needsReview: false };
    }
}
