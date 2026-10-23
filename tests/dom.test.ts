import { describe, expect, it } from 'vitest';
import { CHAIN_ATTR, blockFromCache, chainAbove, kindOf, replaceTokens, unwrapInto } from '../src/render';
import { nestState } from '../src/embeds';
import { lineHasOtherContent, nativesBetween } from '../src/reading';
import type { BlockSubpathResult, CachedMetadata } from 'obsidian';

function html(markup: string): HTMLElement {
	const div = document.createElement('div');
	div.innerHTML = markup;
	return div;
}

describe('unwrapInto', () => {
	it('unwraps a single paragraph', () => {
		const span = document.createElement('span');
		unwrapInto(html('<p>Hello <strong>world</strong></p>'), span);
		expect(span.innerHTML).toBe('Hello <strong>world</strong>');
	});
	it('keeps two paragraphs as they are', () => {
		const span = document.createElement('span');
		unwrapInto(html('<p>a</p><p>b</p>'), span);
		expect(span.innerHTML).toBe('<p>a</p><p>b</p>');
	});
});

describe('replaceTokens', () => {
	it('swaps each token for a node and keeps the text around it', () => {
		const el = html('<span>a 0 b <em>c 1</em></span>');
		const n = replaceTokens(el, (i) => {
			const s = document.createElement('b');
			s.textContent = `T${i}`;
			return s;
		});
		expect(n).toBe(2);
		expect(el.textContent).toBe('a T0 b c T1');
	});
	it('drops a token with no node', () => {
		const el = html('x9y');
		replaceTokens(el, () => null);
		expect(el.textContent).toBe('xy');
	});
});

describe('lineHasOtherContent (rule 2 in Reading view)', () => {
	const embed = '<span class="internal-embed" src="A#^p1"></span>';
	it('is true with text in the paragraph', () => {
		const el = html(`<p>Text ${embed} more.</p>`);
		expect(lineHasOtherContent(el.querySelector('.internal-embed') as HTMLElement)).toBe(true);
	});
	it('is false for an embed alone in its paragraph', () => {
		const el = html(`<p>${embed}</p>`);
		expect(lineHasOtherContent(el.querySelector('.internal-embed') as HTMLElement)).toBe(false);
	});
	it('stops at a line break', () => {
		const el = html(`<p>Line one<br>\n${embed}</p>`);
		expect(lineHasOtherContent(el.querySelector('.internal-embed') as HTMLElement)).toBe(false);
	});
	it('ignores a task box and a list bullet', () => {
		const el = html(`<ul><li><span class="list-bullet"></span><input type="checkbox">${embed}</li></ul>`);
		expect(lineHasOtherContent(el.querySelector('.internal-embed') as HTMLElement)).toBe(false);
	});
	it('looks out of inline wrappers such as strong', () => {
		const el = html(`<p>See <strong>${embed}</strong></p>`);
		expect(lineHasOtherContent(el.querySelector('.internal-embed') as HTMLElement)).toBe(true);
	});
});

describe('blockFromCache and kindOf (rules 4, 5 and 9)', () => {
	const source = 'Intro text ^p1\n\n- [ ] Call Bob ^t1\n  - child\n\n| a |\n| - |\n| 1 |\n\n^tb\n';
	const pos = (sl: number, so: number, el: number, eo: number) => ({ start: { line: sl, col: 0, offset: so }, end: { line: el, col: 0, offset: eo } });
	const cache = {
		sections: [
			{ type: 'paragraph', position: pos(0, 0, 0, 14) },
			{ type: 'list', position: pos(2, 16, 3, 43) },
			{ type: 'table', position: pos(5, 45, 7, 59) },
		],
	} as unknown as CachedMetadata;
	it('reads a paragraph', () => {
		const sub = { type: 'block', block: { id: 'p1', position: pos(0, 0, 0, 14) }, start: pos(0, 0, 0, 0).start, end: null } as unknown as BlockSubpathResult;
		expect(kindOf(cache, sub)).toBe('paragraph');
		expect(blockFromCache(cache, sub, source, 'p1')).toEqual({ kind: 'paragraph', raw: 'Intro text ^p1' });
	});
	it('reads a list item without its children', () => {
		const sub = { type: 'block', block: { id: 't1', position: pos(2, 16, 3, 43) }, list: { position: pos(2, 16, 3, 43) }, start: pos(2, 16, 2, 16).start, end: null } as unknown as BlockSubpathResult;
		expect(blockFromCache(cache, sub, source, 't1')).toEqual({ kind: 'listItem', raw: '- [ ] Call Bob ^t1' });
	});
	it('gives a table as a native kind', () => {
		const sub = { type: 'block', block: { id: 'tb', position: pos(5, 45, 7, 59) }, start: pos(5, 45, 5, 45).start, end: null } as unknown as BlockSubpathResult;
		expect(kindOf(cache, sub)).toBe('table');
	});
});

describe('chainAbove (review C1: the chain goes through embeds that Obsidian draws)', () => {
	function mixed(): { box: HTMLElement; inner: HTMLElement; section: HTMLElement } {
		const box = document.createElement('div');
		box.setAttribute(CHAIN_ATTR, JSON.stringify(['X.md#^x']));
		box.innerHTML = '<p>See <span class="internal-embed markdown-embed" src="Y#Intro"><div class="markdown-embed-content"><div class="sec"><p>Recall <span class="internal-embed" src="X#^x"></span> here.</p></div></div></span> now.</p>';
		return { box, inner: box.querySelector('[src="X#^x"]') as HTMLElement, section: box.querySelector('.sec') as HTMLElement };
	}
	it('adds the heading embed to the chain, so the block repeats: a loop', () => {
		const { inner } = mixed();
		const { base, natives } = chainAbove(inner);
		const chain = [...(base ?? []), ...natives];
		expect(chain).toEqual(['X.md#^x', 'native:Y#Intro']);
		expect(nestState(chain, 'X.md#^x')).toBe('loop');
	});
	it('counts the native levels between an embed and the root of a post processor call', () => {
		const { inner, box } = mixed();
		expect(nativesBetween(inner, box)).toEqual(['native:Y#Intro']);
	});
	it('gives no base outside the plugin elements', () => {
		const el = html('<p><span class="internal-embed" src="A#^p1"></span></p>');
		expect(chainAbove(el.querySelector('span') as HTMLElement)).toEqual({ base: null, natives: [] });
	});
	it('stops past depth 3 when the chain holds native levels', () => {
		expect(nestState(['A.md#^a', 'native:B#H', 'C.md#^c'], 'D.md#^d')).toBe('depth');
	});
});
