import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, blockKey, classifyLines, cleanBlock, codeSpans, expandInline, inlineText, locateBlock, nestState, selectEmbeds } from '../src/embeds';

describe('selectEmbeds', () => {
	it('selects an embed with text only after it', () => {
		expect(selectEmbeds('![[A#^p1]] is the claim.')[0]?.selected).toBe(true);
	});
	it('keeps a heading marker out of the other text', () => {
		expect(selectEmbeds('## ![[A#^p1]]')[0]?.selected).toBe(false);
		expect(selectEmbeds('## See ![[A#^p1]]')[0]?.selected).toBe(true);
	});
	it('treats a blank alias as no alias', () => {
		expect(selectEmbeds('a ![[A#^p1| ]] b')[0]).toMatchObject({ alias: null, display: 'A#^p1' });
	});
	it('ignores a double backtick code span with a backtick inside', () => {
		expect(selectEmbeds('``a ` ![[A#^p1]]`` b ![[B#^p2]]').map((e) => e.linktext)).toEqual(['B#^p2']);
	});
	it('leaves an unclosed backtick as text', () => {
		expect(selectEmbeds('a ` b ![[A#^p1]]').length).toBe(1);
		expect(codeSpans('a ` b')).toEqual([]);
	});
});

describe('classifyLines', () => {
	it('marks front matter, code, math, tables and callouts', () => {
		const lines = ['---', 'a: 1', '---', 'text', '```', 'code', '```', '$$', 'x', '$$', '| a |', '| - |', '| 1 |', '', '> [!note]', '> body', '', '> quote'];
		expect(classifyLines(lines)).toEqual(['frontmatter', 'frontmatter', 'frontmatter', 'text', 'code', 'code', 'code', 'math', 'math', 'math', 'table', 'table', 'table', 'text', 'callout', 'callout', 'text', 'text']);
	});
	it('closes a fence only with the same marker and length', () => {
		expect(classifyLines(['````', '```', 'x', '````', 'after'])).toEqual(['code', 'code', 'code', 'code', 'text']);
		expect(classifyLines(['~~~', '```', '~~~', 'after'])).toEqual(['code', 'code', 'code', 'text']);
	});
	it('keeps a one line math block to its line', () => {
		expect(classifyLines(['$$x$$', 'text'])).toEqual(['math', 'text']);
	});
});

describe('cleanBlock and locateBlock', () => {
	it('removes only the trailing marker', () => {
		expect(cleanBlock('Use ^p1 here ^p1', 'p1', 'paragraph')).toBe('Use ^p1 here');
	});
	it('handles an id with a regular expression character safely', () => {
		expect(cleanBlock('Text ^a-b', 'a-b', 'paragraph')).toBe('Text');
	});
	it('handles CRLF line ends', () => {
		expect(inlineText('Line one\r\nline two ^p1\r\n', 'p1').text).toBe('Line one line two');
	});
	it('gives a list for an id on its own line after a list', () => {
		expect(locateBlock('- a\n- b\n\n^l1', 'l1')?.kind).toBe('list');
	});
	it('gives a blockquote for an id after a quote', () => {
		expect(inlineText('> quoted\n\n^q2', 'q2').state).toBe('native');
	});
	it('stops a paragraph at a heading above it', () => {
		expect(inlineText('# Title\nBody text ^p3', 'p3').text).toBe('Body text');
	});
	it('reads a paragraph above an id on its own line', () => {
		expect(inlineText('First\nsecond\n\n^p4', 'p4')).toEqual({ state: 'inline', kind: 'paragraph', text: 'First second' });
	});
	it('reads the right block when two blocks have ids', () => {
		expect(inlineText('One ^a\n\nTwo ^b', 'b').text).toBe('Two');
	});
});

describe('nestState and expandInline', () => {
	it('allows depth 1 to 3', () => {
		expect(nestState([], 'k')).toBe('inline');
		expect(nestState(['a', 'b'], 'k')).toBe('inline');
		expect(nestState(['a', 'b', 'c'], 'k')).toBe('depth');
		expect(MAX_DEPTH).toBe(3);
	});
	it('finds a loop before the depth limit', () => {
		expect(nestState(['a', 'k'], 'k')).toBe('loop');
	});
	it('makes case insensitive keys for block ids', () => {
		expect(blockKey('A.md', 'P1')).toBe('A.md#^p1');
	});
	it('ends on a large ring of notes with no exception', () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 50; i++) files[`N${i}`] = `n${i} ![[N${(i + 1) % 50}#^b]] end ^b`;
		expect(() => expandInline(files, 'N0', 'b')).not.toThrow();
		expect(expandInline(files, 'N0', 'b')).toBe('n0 n1 n2 N3#^b end end end');
	});
	it('keeps a native block as its embed text', () => {
		expect(expandInline({ A: 'See ![[B#^t]] now ^a', B: '## H ^t' }, 'A', 'a')).toBe('See ![[B#^t]] now');
	});
	it('shows a missing note as its link text', () => {
		expect(expandInline({ A: 'See ![[Nope#^t]] now ^a' }, 'A', 'a')).toBe('See Nope#^t now');
	});
});

describe('comments and indented code (review fixes)', () => {
	it('skips an embed in a %% or HTML comment on the line', () => {
		expect(selectEmbeds('a %% ![[A#^p1]] %% b ![[B#^p2]]').map((e) => e.linktext)).toEqual(['B#^p2']);
		expect(selectEmbeds('a <!-- ![[A#^p1]]').length).toBe(0);
	});
	it('keeps %% inside inline code as text', () => {
		expect(selectEmbeds('`%%` see ![[A#^p1]] now').length).toBe(1);
	});
	it('marks the lines of a comment that spans lines', () => {
		expect(classifyLines(['%%', '![[A#^p1]] x', '%%', 'after'])).toEqual(['text', 'comment', 'comment', 'text']);
		expect(classifyLines(['<!--', 'x ![[A#^p1]]', '-->', 'after'])).toEqual(['text', 'comment', 'comment', 'text']);
	});
	it('marks an indented code block, but not an indented list continuation', () => {
		expect(classifyLines(['text', '', '    ![[A#^p1]] code', '', 'after'])).toEqual(['text', 'text', 'code', 'text', 'text']);
		expect(classifyLines(['- item', '', '    more ![[A#^p1]]'])).toEqual(['text', 'text', 'text']);
	});
	it('does not find a block id in a comment', () => {
		expect(inlineText('%%\nHidden ^h1\n%%', 'h1').state).toBe('missing');
	});
});

describe('mixed loops through embeds that Obsidian draws (review C1)', () => {
	it('stops a loop that passes through a heading embed', () => {
		const files = { X: 'See ![[Y#Intro]] now. ^x', Y: '# Intro\n\nRecall ![[X#^x]] here.' };
		expect(expandInline(files, 'X', 'x')).toBe('See [Recall X#^x here.] now.');
		expect(expandInline(files, 'Y', 'none')).toBe('Y#^none');
	});
	it('stops a loop of two heading embeds and one block', () => {
		const files = { A: 'a ![[B#H]] a ^a\n\n# H2\n\nback ![[A#^a]] here', B: '# H\n\nb ![[A#H2]] b' };
		expect(expandInline(files, 'A', 'a')).toBe('a [b [back A#^a here] b] a');
	});
});
