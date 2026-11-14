import { describe, expect, it } from 'vitest';
import { matchText, parseSearchQuery, searchPattern } from './search.ts';

const query = (text: string, options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}) => ({
    text,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...options,
});

function pattern(text: string, options?: Parameters<typeof query>[1]): RegExp {
    const result = searchPattern(query(text, options));
    if (typeof result === 'string') {
        throw new Error(result);
    }
    return result;
}

describe('parseSearchQuery', () => {
    it('takes text and the three options, and nothing malformed', () => {
        expect(parseSearchQuery({ text: 'a', regex: true, extra: 1 })).toEqual(query('a', { regex: true }));
        expect(parseSearchQuery({ text: '' })).toMatch(/text/);
        expect(parseSearchQuery({ text: 'a\nb' })).toMatch(/one line/);
        expect(parseSearchQuery(null)).toMatch(/object/);
    });
});

describe('searchPattern', () => {
    it('reads text literally unless it is a regular expression', () => {
        expect(pattern('a.b').test('axb')).toBe(false);
        expect(pattern('a.b', { regex: true }).test('axb')).toBe(true);
        expect(searchPattern(query('(', { regex: true }))).toEqual(expect.any(String));
    });
});

describe('matchText', () => {
    it('finds every match with its line and column, ignoring case unless asked', () => {
        const text = 'const Foo = 1;\r\nfoo(foo);\n';
        expect(matchText(pattern('foo'), text, 10).map(({ line, column, length }) => [line, column, length])).toEqual([
            [1, 7, 3],
            [2, 1, 3],
            [2, 5, 3],
        ]);
        expect(matchText(pattern('foo', { caseSensitive: true }), text, 10)).toHaveLength(2);
        expect(matchText(pattern('foo', { caseSensitive: true }), text, 1)).toHaveLength(1);
    });

    it('matches whole words and skips empty matches', () => {
        expect(matchText(pattern('foo', { wholeWord: true }), 'foo food foo_ (foo)', 10)).toHaveLength(2);
        expect(matchText(pattern('x*', { regex: true }), 'abxc', 10).map((match) => match.column)).toEqual([3]);
    });

    it('clips the preview around a match far into a long line', () => {
        const line = `${'a'.repeat(1000)}needle${'b'.repeat(1000)}`;
        const [match] = matchText(pattern('needle'), line, 10);
        expect(match.column).toBe(1001);
        expect(match.preview.slice(match.previewStart, match.previewStart + match.length)).toBe('needle');
        expect(match.preview.length).toBeLessThan(300);
    });
});
