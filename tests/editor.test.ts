import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { aloneLinesOf, carryCaches, kindsOf } from '../src/editor';
import { classifyLines, selectEmbeds } from '../src/embeds';

const BASE = [
	'---', 'a: 1', '---', 'Intro ![[A#^p1]] here.', '', '![[A#^p1]]', '', '```js', 'code ![[A#^p1]]', '```', '',
	'%% note', '![[B#^b]]', '%%', '', '- item', '', '    continued ![[A#^p1]]', '', 'Para', '', '    code ![[A#^p1]]', '',
	'| a | b |', '| - | - |', '| 1 | ![[A#^p1]] |', '', '> [!note]', '> ![[A#^p1]]', '', 'End ![[C#^c]] x.', '', '![[D#^d]]',
].join('\n');

function full(doc: Text): string[] {
	return classifyLines(Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text));
}
function fullAlone(doc: Text): number[] {
	const kinds = full(doc);
	const out: number[] = [];
	for (let n = 1; n <= doc.lines; n++) {
		const t = doc.line(n).text;
		const f = selectEmbeds(t, true);
		if (kinds[n - 1] === 'text' && f.length === 1 && t.trim() === t.slice(f[0]!.from, f[0]!.to)) out.push(n);
	}
	return out;
}

describe('carryCaches (only the changed lines are classified again)', () => {
	const doc = Text.of(BASE.split('\n'));
	const edits: Array<[string, number, number, string]> = [
		['type a letter', doc.line(4).from + 2, doc.line(4).from + 2, 'x'],
		['open a fence', doc.line(19).from, doc.line(19).from, '```\n'],
		['close the comment early', doc.line(12).from, doc.line(12).from, '%%\n'],
		['delete the fence opener', doc.line(8).from, doc.line(9).from, ''],
		['add a lone embed', doc.line(20).to, doc.line(20).to, '\n\n![[E#^e]]'],
		['remove the list item', doc.line(16).from, doc.line(17).from, ''],
		['indent a paragraph', doc.line(20).from, doc.line(20).from, '    '],
		['add front matter text', doc.line(2).to, doc.line(2).to, '\nb: 2'],
		['join two lines', doc.line(30).to, doc.line(31).to, ''],
		['type at the end', doc.length, doc.length, ' more ![[F#^f]] x'],
		['remove the front matter opener', doc.line(1).from, doc.line(2).from, ''],
		['remove the front matter closer', doc.line(3).from, doc.line(4).from, ''],
	];
	for (const [name, from, to, insert] of edits) {
		it(name, () => {
			kindsOf(doc);
			aloneLinesOf(doc);
			const changes = ChangeSet.of([{ from, to, insert }], doc.length);
			const next = changes.apply(doc);
			carryCaches(doc, next, changes);
			expect(kindsOf(next)).toEqual(full(next));
			expect(aloneLinesOf(next)).toEqual(fullAlone(next));
		});
	}
	it('carries through a chain of 30 single letter edits', () => {
		let cur = doc;
		kindsOf(cur);
		aloneLinesOf(cur);
		for (let i = 0; i < 30; i++) {
			const line = cur.line(1 + ((i * 7) % cur.lines));
			const changes = ChangeSet.of([{ from: line.from, insert: i % 5 === 0 ? '\n' : 'a' }], cur.length);
			const next = changes.apply(cur);
			carryCaches(cur, next, changes);
			expect(kindsOf(next)).toEqual(full(next));
			expect(aloneLinesOf(next)).toEqual(fullAlone(next));
			cur = next;
		}
	});
});

describe('carryCaches and front matter across a blank line (review round 3)', () => {
	const probe = Text.of(['x', '', 'Go ![[A#^p1]] now.', '', '---', 'tail']);
	const cases: Array<[string, Text, number, number, string]> = [
		['line 1 becomes the opener', probe, 0, 1, '---'],
		['the closer is typed under a blank line', Text.of(['---', '', 'Go ![[A#^p1]] now.', '', '--', 'tail']), 0, 0, ''],
		['the closer is removed', Text.of(['---', 'a: 1', '', 'Go ![[A#^p1]] now.', '---', 'tail']), 0, 0, ''],
	];
	for (const [name, start, from, to, insert] of cases) {
		it(name, () => {
			kindsOf(start);
			aloneLinesOf(start);
			let changes = ChangeSet.of([{ from, to, insert }], start.length);
			if (name === 'the closer is typed under a blank line') changes = ChangeSet.of([{ from: start.line(5).to, insert: '-' }], start.length);
			if (name === 'the closer is removed') changes = ChangeSet.of([{ from: start.line(5).from, to: start.line(5).to, insert: 'x' }], start.length);
			const next = changes.apply(start);
			carryCaches(start, next, changes);
			expect(kindsOf(next)).toEqual(full(next));
			expect(aloneLinesOf(next)).toEqual(fullAlone(next));
		});
	}
	it('matches a full rescan over 40 chained edits that type and remove front matter lines', () => {
		let cur = Text.of(['x', '', 'Go ![[A#^p1]] now.', '', 'mid', '', '![[B#^b]]', '', 'tail ![[C#^c]] end.']);
		kindsOf(cur);
		aloneLinesOf(cur);
		const steps: Array<(d: Text) => { from: number; to?: number; insert: string }> = [
			(d) => ({ from: d.line(1).from, to: d.line(1).to, insert: '---' }),
			(d) => ({ from: d.line(Math.min(5, d.lines)).from, insert: '---\n' }),
			(d) => ({ from: d.line(Math.min(3, d.lines)).to, insert: ' typed' }),
			(d) => ({ from: d.line(Math.min(5, d.lines)).from, to: d.line(Math.min(5, d.lines)).to, insert: '' }),
			(d) => ({ from: d.line(1).from, to: d.line(1).to, insert: 'x' }),
			(d) => ({ from: d.length, insert: '\n\n---' }),
			(d) => ({ from: d.line(d.lines).from, to: d.line(d.lines).to, insert: '--' }),
			(d) => ({ from: d.line(Math.min(2, d.lines)).from, insert: '\n' }),
		];
		for (let i = 0; i < 40; i++) {
			const spec = steps[i % steps.length]!(cur);
			const changes = ChangeSet.of([spec], cur.length);
			const next = changes.apply(cur);
			carryCaches(cur, next, changes);
			expect(kindsOf(next)).toEqual(full(next));
			expect(aloneLinesOf(next)).toEqual(fullAlone(next));
			cur = next;
		}
	});
});
