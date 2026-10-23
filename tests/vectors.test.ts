import { describe, expect, it } from 'vitest';
import vectors from './vectors/inline-block-embeds.json';
import { expandInline, inlineText, selectEmbeds } from '../src/embeds';

const fns: Record<string, (...args: never[]) => unknown> = { inlineText, selectEmbeds, expandInline };

describe('golden vectors (packages/spec/vectors/inline-block-embeds.json)', () => {
	it('covers acceptance cases 1 to 6', () => {
		for (const n of ['1', '2', '3', '4', '5', '6']) expect(vectors.cases.some((c) => c.name.startsWith(`${n} `))).toBe(true);
		expect(vectors.cases.length).toBeGreaterThanOrEqual(20);
	});
	for (const c of vectors.cases) {
		it(c.name, () => {
			const fn = fns[c.fn];
			expect(fn).toBeTypeOf('function');
			expect(fn!(...(c.args as never[]))).toEqual(c.expected);
		});
	}
});
