import { describe, it, expect } from 'vitest';
import { normalizeMerchantName, matchCategory, findCategoryDuplicates, mergeProposals } from '../src/util.js';

describe('normalizeMerchantName', () => {
    it('uppercases and trims', () => { expect(normalizeMerchantName('  uber eats  ')).toBe('UBER EATS'); });
    it('strips trailing IDs', () => { expect(normalizeMerchantName('AMZN MKTP US*1234')).toBe('AMZN MKTP US'); });
    it('collapses whitespace', () => { expect(normalizeMerchantName('UBER   EATS')).toBe('UBER EATS'); });
    it('handles null', () => { expect(normalizeMerchantName(null)).toBe(''); });
    it('handles empty', () => { expect(normalizeMerchantName('')).toBe(''); });
});

describe('matchCategory', () => {
    const cats = ['Groceries', 'Transport', 'Entertainment'];
    it('exact match', () => { expect(matchCategory('Groceries', cats)).toBe('Groceries'); });
    it('case-insensitive', () => { expect(matchCategory('groceries', cats)).toBe('Groceries'); });
    it('no match', () => { expect(matchCategory('Food', cats)).toBeNull(); });
    it('null input', () => { expect(matchCategory(null, cats)).toBeNull(); });
});

describe('findCategoryDuplicates', () => {
    it('finds case duplicates', () => {
        const dups = findCategoryDuplicates(['Food', 'food', 'FOOD'], ['Food']);
        expect(dups).toHaveLength(1);
        expect(dups[0].recommended).toBe('Food');
    });
    it('no duplicates', () => {
        expect(findCategoryDuplicates(['A', 'B', 'C'])).toHaveLength(0);
    });
});

describe('mergeProposals', () => {
    it('remaps proposals', () => {
        const proposals = [{ proposedCategory: 'food' }, { proposedCategory: 'Food' }];
        const merged = mergeProposals(proposals, { 'food': 'Food' });
        expect(merged[0].proposedCategory).toBe('Food');
        expect(merged[1].proposedCategory).toBe('Food');
    });
});
