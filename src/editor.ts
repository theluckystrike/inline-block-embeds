// Live Preview (rules 13 and 14): a CM6 ViewPlugin replaces each selected `![[note#^id]]` with an inline widget while
// the selection does not touch it. Lines in code, front matter, math, tables and callouts are left to Obsidian.
import { Prec, StateEffect, StateField, type ChangeSet, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Component, Keymap, editorInfoField, editorLivePreviewField } from 'obsidian';
import { classifyLines, isListLine, selectEmbeds, type LineKind } from './embeds';
import type { EmbedRef, InlineEmbeds, Plan } from './render';

/** Tells every editor to draw its widgets again (settings, Pro or a source note changed). */
export const redrawEffect = StateEffect.define<null>();

const owners = new WeakMap<HTMLElement, Component>();
/** Every editor that runs the extension, with the source note paths of its visible block embeds. */
const views = new Map<EditorView, Set<string>>();
/** Source note paths of the embeds that are alone on a line, per document (the state field draws those). */
const lineTargets = new WeakMap<Text, Set<string>>();
/** The target entry of an embed whose note does not exist yet. */
const MISSING = '\u0000missing';

/**
 * Sends the redraw effect to the editors that show an embed of this note, or to every editor when path is null.
 * An editor with a missing note redraws on each change, because the change can be the new note.
 */
export function redrawViews(path: string | null = null): void {
	for (const [view, targets] of Array.from(views)) {
		const lines = lineTargets.get(view.state.doc);
		const hit = (set: Set<string> | undefined): boolean => !!set && (set.has(MISSING) || (path !== null && set.has(path)));
		if (path === null || hit(targets) || hit(lines)) view.dispatch({ effects: redrawEffect.of(null) });
	}
}

function targetOf(inline: InlineEmbeds, linkpath: string, sourcePath: string): string {
	return inline.fileOf(linkpath, sourcePath)?.path ?? MISSING;
}

class InlineWidget extends WidgetType {
	constructor(
		readonly inline: InlineEmbeds,
		readonly plan: Plan,
		readonly sourcePath: string,
		readonly style: string,
		/** True for an embed alone on its line ("Draw every block embed inline"): the widget fills the line. */
		readonly line = false,
	) {
		super();
	}

	eq(other: InlineWidget): boolean {
		const a = this.plan;
		const b = other.plan;
		return (
			a.state === b.state &&
			a.ref.linktext === b.ref.linktext &&
			a.ref.display === b.ref.display &&
			this.sourcePath === other.sourcePath &&
			this.style === other.style &&
			this.line === other.line &&
			(a.state !== 'inline' || b.state !== 'inline' || a.file === b.file)
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const owner = new Component();
		owner.load();
		const { el } = this.inline.createSpan(this.plan, this.sourcePath, [], owner);
		if (this.line) el.addClass('ibe-line');
		owners.set(el, owner);
		el.addEventListener('mousedown', (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			if (Keymap.isModEvent(event)) return;
			// Rule 12: a plain click puts the cursor in the embed text, which shows the raw link (rule 14).
			let pos: number;
			try {
				pos = view.posAtDOM(el);
			} catch {
				return;
			}
			view.dispatch({ selection: { anchor: pos + 3 }, scrollIntoView: false });
			view.focus();
		});
		return el;
	}

	destroy(dom: HTMLElement): void {
		owners.get(dom)?.unload();
		owners.delete(dom);
	}

	ignoreEvent(event: Event): boolean {
		return event.type === 'mousedown' || event.type === 'click';
	}
}

const lineKinds = new WeakMap<Text, LineKind[]>();

export function kindsOf(doc: Text): LineKind[] {
	let kinds = lineKinds.get(doc);
	if (!kinds) {
		const lines: string[] = [];
		for (let n = 1; n <= doc.lines; n++) lines.push(doc.line(n).text);
		kinds = classifyLines(lines);
		lineKinds.set(doc, kinds);
	}
	return kinds;
}

/** The decorations of one editor. */
export function buildDecorations(view: EditorView, inline: InlineEmbeds): DecorationSet {
	if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
	const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? '';
	const opts = inline.options();
	const doc = view.state.doc;
	const targets = new Set<string>();
	views.set(view, targets);
	// Only lines with an embed in the visible part matter. Without one, the note is not classified at all.
	const candidates: number[] = [];
	let lastLine = 0;
	for (const { from, to } of view.visibleRanges) {
		for (let n = Math.max(doc.lineAt(from).number, lastLine + 1); n <= doc.lineAt(to).number; n++) {
			lastLine = n;
			if (doc.line(n).text.includes('![[')) candidates.push(n);
		}
	}
	if (!candidates.length) return Decoration.none;
	const kinds = kindsOf(doc);
	const ranges = view.state.selection.ranges;
	const out = [];
	for (const n of candidates) {
		if (kinds[n - 1] !== 'text') continue;
		const line = doc.line(n);
		const alone = opts.drawAll && isAlone(line.text);
		for (const m of selectEmbeds(line.text, opts.drawAll)) {
			if (!m.selected) continue;
			targets.add(targetOf(inline, m.path, sourcePath));
			if (alone) continue;
			const a = line.from + m.from;
			const b = line.from + m.to;
			// Rule 14: Live Preview shows the raw link only in a focused editor, so the widget does the same.
			if (view.hasFocus && ranges.some((r) => r.from <= b && r.to >= a)) continue;
			const ref: EmbedRef = { path: m.path, blockId: m.blockId, linktext: m.linktext, display: m.display };
			const plan = inline.plan(ref, sourcePath);
			if (plan.state === 'native') continue;
			out.push(Decoration.replace({ widget: new InlineWidget(inline, plan, sourcePath, opts.style) }).range(a, b));
		}
	}
	return Decoration.set(out, true);
}

const aloneLines = new WeakMap<Text, number[]>();

/** A blank line outside any block, where the classification can start again with no state from above. */
function isRestart(lines: (n: number) => string, kinds: (n: number) => LineKind | undefined, n: number, count: number): boolean {
	if (lines(n).trim() !== '' || kinds(n) !== 'text') return false;
	for (let k = n - 1; k >= 1; k--) {
		const t = lines(k);
		if (t.trim() === '') continue;
		if (isListLine(t) || /^\s/.test(t)) return false;
		break;
	}
	for (let k = n + 1; k <= count; k++) {
		const t = lines(k);
		if (t.trim() === '') continue;
		return !/^\s/.test(t);
	}
	return true;
}

/**
 * Moves the line kinds and the lone-embed lines of the old document to the new one. Only the lines from the last
 * restart point before the change to the first restart point after it are classified again, so a keystroke costs
 * a few lines, not the whole note. Without old caches, nothing happens and the next use computes them in full.
 */
export function carryCaches(oldDoc: Text, newDoc: Text, changes: ChangeSet): void {
	const old = lineKinds.get(oldDoc);
	if (!old || lineKinds.has(newDoc) || changes.empty) return;
	let fromA = Infinity;
	let toA = -1;
	let fromB = Infinity;
	let toB = -1;
	changes.iterChangedRanges((a0, a1, b0, b1) => {
		fromA = Math.min(fromA, a0);
		toA = Math.max(toA, a1);
		fromB = Math.min(fromB, b0);
		toB = Math.max(toB, b1);
	});
	const firstB = newDoc.lineAt(fromB).number;
	const lastB = newDoc.lineAt(toB).number;
	const lastA = oldDoc.lineAt(toA).number;
	const firstA = oldDoc.lineAt(fromA).number;
	// Front matter depends on line 1 and on a closing line far below it, so a change near the top or of a `---` or
	// `...` line classifies the whole note again.
	const fence = (doc: Text, from: number, to: number): boolean => {
		for (let n = from; n <= to; n++) if (/^\s*(?:---|\.\.\.)\s*$/.test(doc.line(n).text)) return true;
		return false;
	};
	if (firstA <= 2 || firstB <= 2 || fence(oldDoc, firstA, lastA) || fence(newDoc, firstB, lastB)) {
		lineKinds.set(newDoc, classifyLines(Array.from({ length: newDoc.lines }, (_, i) => newDoc.line(i + 1).text)));
		return;
	}
	const delta = newDoc.lines - oldDoc.lines;
	const newText = (n: number): string => newDoc.line(n).text;
	const oldText = (n: number): string => oldDoc.line(n).text;
	// Restart above the change: lines before it are the same in both documents.
	let start = firstB - 1;
	while (start >= 1 && !isRestart(newText, (n) => old[n - 1], start, newDoc.lines)) start--;
	if (start < 1) start = 1;
	// End below the change: a restart line in the old document after the change, at its new number.
	const kinds: LineKind[] = old.slice(0, start - 1);
	let end = newDoc.lines;
	let tail: LineKind[] = [];
	for (let n = lastB + 1; n <= newDoc.lines; n++) {
		const a = n - delta;
		if (a <= lastA || a > oldDoc.lines) continue;
		if (isRestart(oldText, (k) => old[k - 1], a, oldDoc.lines) && isRestart(newText, () => 'text', n, newDoc.lines)) {
			end = n;
			tail = old.slice(a);
			break;
		}
	}
	const slice: string[] = [];
	for (let n = start; n <= end; n++) slice.push(newText(n));
	const middle = classifyLines(slice);
	if (end < newDoc.lines && middle[middle.length - 1] !== 'text') {
		// The change opened or closed a block that runs past the end point: classify the whole note once.
		lineKinds.set(newDoc, classifyLines(Array.from({ length: newDoc.lines }, (_, i) => newText(i + 1))));
		return;
	}
	const kindsNew = [...kinds, ...middle, ...tail];
	lineKinds.set(newDoc, kindsNew);
	const alone = aloneLines.get(oldDoc);
	if (alone) {
		const keep = alone.filter((n) => n < start).concat(alone.filter((n) => n + delta > end && n > lastA).map((n) => n + delta));
		for (let n = start; n <= end; n++) {
			const t = newText(n);
			if (t.includes('![[') && kindsNew[n - 1] === 'text' && isAlone(t)) keep.push(n);
		}
		aloneLines.set(newDoc, keep.sort((x, y) => x - y));
	}
}

/** Numbers of the text lines that hold one block embed and nothing else. Computed once per document. */
export function aloneLinesOf(doc: Text): number[] {
	let found = aloneLines.get(doc);
	if (found) return found;
	found = [];
	const withEmbed: number[] = [];
	for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text.includes('![[')) withEmbed.push(n);
	if (withEmbed.length) {
		const kinds = kindsOf(doc);
		for (const n of withEmbed) if (kinds[n - 1] === 'text' && isAlone(doc.line(n).text)) found.push(n);
	}
	aloneLines.set(doc, found);
	return found;
}

/** True for a line that holds one block embed and nothing else. Live Preview draws it as a block widget. */
function isAlone(text: string): boolean {
	const found = selectEmbeds(text, true);
	return found.length === 1 && text.trim() === text.slice(found[0]!.from, found[0]!.to);
}

/**
 * Rule 3 in Live Preview. Obsidian draws an embed that is alone on its line as a block widget, and an inline
 * decoration cannot win over a block one. Block decorations must come from a state field, so this field gives a block
 * widget that holds the inline text for those lines.
 */
export function buildLineDecorations(state: EditorState, inline: InlineEmbeds): DecorationSet {
	const opts = inline.options();
	if (!opts.drawAll || !state.field(editorLivePreviewField, false)) return Decoration.none;
	const sourcePath = state.field(editorInfoField, false)?.file?.path ?? '';
	const doc = state.doc;
	const targets = new Set<string>();
	lineTargets.set(doc, targets);
	const out = [];
	for (const n of aloneLinesOf(doc)) {
		const line = doc.line(n);
		const m = selectEmbeds(line.text, true)[0]!;
		targets.add(targetOf(inline, m.path, sourcePath));
		if (state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from)) continue;
		const plan = inline.plan({ path: m.path, blockId: m.blockId, linktext: m.linktext, display: m.display }, sourcePath);
		if (plan.state === 'native') continue;
		out.push(Decoration.replace({ widget: new InlineWidget(inline, plan, sourcePath, opts.style, true), block: true }).range(line.from, line.to));
	}
	return Decoration.set(out, true);
}

/** The editor extension. Highest precedence, so the inline widget wins over the embed box of Live Preview. */
export function inlineEmbedExtension(inline: InlineEmbeds): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(readonly view: EditorView) {
				views.set(view, new Set());
				this.decorations = buildDecorations(view, inline);
			}
			destroy(): void {
				views.delete(this.view);
			}
			update(u: ViewUpdate): void {
				if (u.docChanged) carryCaches(u.startState.doc, u.state.doc, u.changes);
				const redraw = u.transactions.some((t) => t.effects.some((e) => e.is(redrawEffect)));
				const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
				if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || redraw || modeChanged) this.decorations = buildDecorations(u.view, inline);
			}
		},
		{ decorations: (v) => v.decorations },
	);
	const lineField = StateField.define<DecorationSet>({
		create: (state) => buildLineDecorations(state, inline),
		update(value, tr) {
			if (tr.docChanged) carryCaches(tr.startState.doc, tr.state.doc, tr.changes);
			const redraw = tr.effects.some((e) => e.is(redrawEffect));
			const modeChanged = tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false);
			return tr.docChanged || tr.selection || redraw || modeChanged ? buildLineDecorations(tr.state, inline) : value;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	return [Prec.highest(plugin), Prec.highest(lineField)];
}
