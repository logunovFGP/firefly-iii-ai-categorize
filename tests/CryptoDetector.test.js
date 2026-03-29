import { describe, it, expect } from 'vitest';
import CryptoDetector from '../src/CryptoDetector.js';

const mockConfig = {
    getCryptoCategory: () => 'Crypto',
    getCryptoTokenCategories: () => ({ USDT: 'Crypto/USDT' }),
};

describe('CryptoDetector', () => {
    const detector = new CryptoDetector(mockConfig);

    it('detects TRON address in destination', () => {
        const result = detector.detect('TJYMzh5GUaeqGWDxTV3E7MaTvjXYVSgsR5', 'USDT transfer abc123');
        expect(result).not.toBeNull();
        expect(result.category).toBe('Crypto/USDT');
        expect(result.tokenSymbol).toBe('USDT');
        expect(result.confidence).toBe(1.0);
        expect(result.source).toBe('crypto:USDT');
    });

    it('detects ETH address', () => {
        const result = detector.detect('0x1234567890abcdef1234567890abcdef12345678', 'ETH transfer xyz');
        expect(result).not.toBeNull();
        expect(result.category).toBe('Crypto');
        expect(result.tokenSymbol).toBe('ETH');
    });

    it('detects TRC20 description pattern', () => {
        const result = detector.detect('Some Name', 'TRC20 outgoing transfer abc123def456');
        expect(result).not.toBeNull();
        expect(result.category).toBe('Crypto');
    });

    it('returns null for normal transactions', () => {
        expect(detector.detect('UBER EATS', 'Food delivery order #123')).toBeNull();
        expect(detector.detect('REWE', 'Purchase')).toBeNull();
        expect(detector.detect('Netflix', 'Monthly subscription')).toBeNull();
    });

    it('uses per-token category override', () => {
        const result = detector.detect('TJYMzh5GUaeqGWDxTV3E7MaTvjXYVSgsR5', 'USDT transfer abc');
        expect(result.category).toBe('Crypto/USDT');
    });

    it('falls back to default category for unknown tokens', () => {
        const result = detector.detect('TJYMzh5GUaeqGWDxTV3E7MaTvjXYVSgsR5', 'DOGE transfer abc');
        expect(result).not.toBeNull();
        expect(result.category).toBe('Crypto');
    });
});
