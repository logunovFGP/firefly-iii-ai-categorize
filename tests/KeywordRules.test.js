import { describe, it, expect } from 'vitest';
import KeywordRules from '../src/KeywordRules.js';

describe('KeywordRules', () => {
    const rules = new KeywordRules([
        { keywords: ['uber', 'lyft', 'bolt'], category: 'Transport' },
        { keywords: ['netflix', 'spotify'], category: 'Entertainment' },
    ]);

    it('matches keyword in destination name', () => {
        const result = rules.match('UBER EATS', 'delivery');
        expect(result).toEqual({ category: 'Transport', matchedKeyword: 'uber' });
    });

    it('matches keyword in description', () => {
        const result = rules.match('Some Merchant', 'payment to netflix.com');
        expect(result).toEqual({ category: 'Entertainment', matchedKeyword: 'netflix' });
    });

    it('returns null for no match', () => {
        expect(rules.match('REWE', 'groceries')).toBeNull();
    });

    it('is case insensitive', () => {
        expect(rules.match('BOLT Ride', '')).not.toBeNull();
    });

    it('reloads rules', () => {
        const r = new KeywordRules([]);
        expect(r.match('UBER', '')).toBeNull();
        r.reload([{ keywords: ['uber'], category: 'Rides' }]);
        expect(r.match('UBER', '')).toEqual({ category: 'Rides', matchedKeyword: 'uber' });
    });
});
