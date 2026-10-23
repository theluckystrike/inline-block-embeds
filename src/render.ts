// Runtime part shared by Live Preview and Reading view: resolve a block with the metadata cache, read its text,
// render it into a span, and keep the span up to date when the source note changes. Public API only.
import { Component, Keymap, MarkdownRenderer, TFile, resolveSubpath, type App, type BlockSubpathResult, type CachedMetadata, type HoverParent, type HoverPopover } from 'obsidian';
import { blockKey, cleanBlock, inlineFromBlock, isInlineKind, locateBlock, nestState, selectEmbeds, type BlockKind } from './embeds';

export type EmbedStyle = 'underline' | 'background' | 'none';

/** The settings in effect, after the Pro check. */
export interface Options {
	drawAll: boolean;
	listItems: boolean;
	style: EmbedStyle;
}

/** One embed, as written: `![[path#^blockId|display]]`. */
export interface EmbedRef {
	path: string;
	blockId: string;
	linktext: string;
	display: string;
}

export type Plan =
	| { state: 'missing'; ref: EmbedRef }
	| { state: 'native'; ref: EmbedRef; kind: BlockKind }
	| { state: 'inline'; ref: EmbedRef; kind: BlockKind; file: TFile; key: string };

export const INLINE_CLASS = 'ibe-inline';
/** The chain of block keys around the content of an element: on each render box and each filled span. */
export const CHAIN_ATTR = 'data-ibe-chain';
/** No more block reads than this run at one time. The next ones wait in a queue. Only the read holds a slot. */
export const MAX_IN_FLIGHT = 256;
const TOKEN_RE = /\uE000(\d+)\uE001/g;

/**
 * The chain of embeds around an element (rule 18). It walks up the DOM to the nearest render box or span of this
 * plugin, which holds the keys of the inline blocks around it, and adds one entry for each embed that Obsidian draws
 * on the way. So a loop that goes through a heading, note or native block embed still repeats a key, and the depth
 * counts every level. `base` is null when no element of this plugin is above.
 */
export function chainAbove(el: HTMLElement): { base: string[] | null; natives: string[] } {
	const natives: string[] = [];
	for (let node = el.parentElement; node; node = node.parentElement) {
		const attr = node.getAttribute(CHAIN_ATTR);
		if (attr !== null) {
			let base: string[] = [];
			try {
				const parsed: unknown = JSON.parse(attr);
				if (Array.isArray(parsed)) base = parsed.map(String);
			} catch {
				base = [];
			}
			return { base, natives: natives.reverse() };
		}
		if (node.classList.contains('internal-embed') && node.getAttribute('src')) natives.push(`native:${node.getAttribute('src') ?? ''}`);
	}
	return { base: null, natives: natives.reverse() };
}

interface Live {
	el: HTMLElement;
	ref: EmbedRef;
	sourcePath: string;
	chain: string[];
	owner: Component;
	inner: Component | null;
	plan: Plan;
	gen: number;
	hover: HoverParent;
	/** The span that this nested span is inside, if any. */
	parent: Live | null;
}

/** The kind of a block from the cache, and its raw lines from the note text (rules 4, 5 and 9). */
export function blockFromCache(cache: CachedMetadata, sub: BlockSubpathResult, source: string, blockId: string): { kind: BlockKind; raw: string } {
	const lines = source.replace(/\r/g, '').split('\n');
	if (sub.list) {
		// The list item, from its marker line to the line that holds the id. Child items are left out.
		const start = sub.list.position.start.line;
		const end = Math.max(start, sub.list.position.end.line, sub.block.position.end.line);
		const idRe = new RegExp(`\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
		let last = start;
		for (let i = start; i <= end && i < lines.length; i++) {
			if (idRe.test(lines[i] ?? '')) {
				last = i;
				break;
			}
		}
		return { kind: 'listItem', raw: lines.slice(start, last + 1).join('\n') };
	}
	const pos = sub.block.position;
	return { kind: kindOf(cache, sub), raw: source.slice(pos.start.offset, pos.end.offset) };
}

const SECTION_KINDS: Record<string, BlockKind> = { paragraph: 'paragraph', heading: 'heading', table: 'table', code: 'code', math: 'math', callout: 'callout', blockquote: 'blockquote', list: 'list' };

/** Rule 9: the kind of a block from the section that holds it. A list item block has `list` set. */
export function kindOf(cache: CachedMetadata, sub: BlockSubpathResult): BlockKind {
	if (sub.list) return 'listItem';
	const line = sub.block.position.start.line;
	const section = cache.sections?.find((s) => s.position.start.line <= line && s.position.end.line >= line);
	return SECTION_KINDS[section?.type ?? 'paragraph'] ?? 'other';
}

export class InlineEmbeds {
	private live = new Set<Live>();
	/** Unsaved text of a source note that is open in an editor, by path. The saved cache replaces it on "changed". */
	private unsaved = new Map<string, string>();
	/** Chains of the renders that run now. A post processor that core calls inside a render reads the top one. */
	private renderStack: string[][] = [];
	private inFlight = 0;
	/** Renders that wait for a free slot, when MAX_IN_FLIGHT renders run. */
	private waiting: Array<() => void> = [];
	private capLogged = false;
	/** Fills started since load (tests wait on it in place of a fixed pause). */
	fills = 0;
	/** Called when a Reading view must render again: a span there now shows a block that Obsidian draws itself. */
	onNative: ((el: HTMLElement) => void) | null = null;

	constructor(
		readonly app: App,
		readonly pluginId: string,
		readonly options: () => Options,
	) {}

	/** The file of a link, or the note itself for `![[#^id]]`. */
	fileOf(path: string, sourcePath: string): TFile | null {
		if (path === '') return this.app.vault.getFileByPath(sourcePath);
		return this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	}

	/** Decides, without a file read, how an embed is drawn (rules 4, 9 and 17). */
	plan(ref: EmbedRef, sourcePath: string): Plan {
		const file = this.fileOf(ref.path, sourcePath);
		const cache = file ? this.app.metadataCache.getFileCache(file) : null;
		const sub = cache ? resolveSubpath(cache, `#^${ref.blockId}`) : null;
		if (!file || !cache || !sub || sub.type !== 'block') return { state: 'missing', ref };
		const kind = kindOf(cache, sub);
		if (!isInlineKind(kind, this.options().listItems)) return { state: 'native', ref, kind };
		return { state: 'inline', ref, kind, file, key: blockKey(file.path, ref.blockId) };
	}

	/** The cleaned inline text of a planned block (rules 5, 6 and 7). */
	async textOf(plan: Extract<Plan, { state: 'inline' }>): Promise<string | null> {
		const draft = this.unsaved.get(plan.file.path);
		if (draft !== undefined) {
			// The cache positions are for the saved file, so the pure locator reads the editor text.
			const res = inlineFromBlock(locateBlock(draft, plan.ref.blockId), plan.ref.blockId, this.options().listItems);
			return res.state === 'inline' ? res.text : null;
		}
		const cache = this.app.metadataCache.getFileCache(plan.file);
		const sub = cache ? resolveSubpath(cache, `#^${plan.ref.blockId}`) : null;
		if (!cache || !sub || sub.type !== 'block') return null;
		const source = await this.app.vault.cachedRead(plan.file);
		const block = blockFromCache(cache, sub, source, plan.ref.blockId);
		if (!isInlineKind(block.kind, this.options().listItems)) return null;
		return cleanBlock(block.raw, plan.ref.blockId, block.kind);
	}

	/**
	 * Makes the span for one embed and starts to fill it. `owner` owns the render children and the update listener:
	 * the span stops updating when the owner unloads. `chain` holds the keys of the inline embeds around this one.
	 */
	createSpan(plan: Plan, sourcePath: string, chain: string[], owner: Component, el: HTMLElement = createSpan(), parent: Live | null = null): { el: HTMLElement; done: Promise<void> } {
		el.addClass(INLINE_CLASS);
		el.setText(plan.ref.display);
		el.setAttr(CHAIN_ATTR, JSON.stringify(chain));
		const live: Live = { el, ref: plan.ref, sourcePath, chain, owner, inner: null, plan, gen: 0, hover: { hoverPopover: null as HoverPopover | null }, parent };
		this.live.add(live);
		owner.register(() => {
			this.live.delete(live);
			live.gen++;
		});
		el.setAttr('data-ibe-link', plan.ref.linktext);
		el.addEventListener('mouseover', (event) => {
			if (live.plan.state !== 'inline') return;
			this.app.workspace.trigger('hover-link', { event, source: this.pluginId, hoverParent: live.hover, targetEl: el, linktext: live.plan.ref.linktext, sourcePath });
		});
		el.addEventListener('click', (event) => {
			if (!Keymap.isModEvent(event)) return;
			event.preventDefault();
			event.stopPropagation();
			this.open(live.ref, sourcePath, event);
		});
		const done = this.fill(live);
		return { el, done };
	}

	/** The chain for an element that a post processor gets: from the DOM, or from the render that runs now. */
	chainFor(el: HTMLElement): string[] {
		const { base, natives } = chainAbove(el);
		return [...(base ?? this.renderStack[this.renderStack.length - 1] ?? []), ...natives];
	}

	/** True when the chain of the element comes from the DOM or from a render that runs now. */
	knowsChain(el: HTMLElement): boolean {
		return chainAbove(el).base !== null || this.renderStack.length > 0;
	}

	/** The span for a loop or a level past the limit: the link text, no render (rule 18). */
	linkText(ref: EmbedRef): HTMLElement {
		return createSpan({ cls: 'ibe-link-text', text: ref.display, attr: { 'data-ibe-link': ref.linktext } });
	}

	/** Renders that wait in the queue for a slot (tests). */
	get queued(): number {
		return this.waiting.length;
	}

	/** Spans that wait for a render now (tests). */
	get pending(): number {
		return this.inFlight + this.waiting.length;
	}

	/** Opens the source block (rule 12). */
	open(ref: EmbedRef, sourcePath: string, event: MouseEvent): void {
		void this.app.workspace.openLinkText(ref.linktext, sourcePath, Keymap.isModEvent(event));
	}

	private setLook(live: Live, state: Plan['state']): void {
		const { el } = live;
		el.removeClass('ibe-style-underline', 'ibe-style-background', 'ibe-style-none', 'is-unresolved');
		el.addClass(INLINE_CLASS, `ibe-style-${this.options().style}`);
		if (state === 'missing') {
			el.addClass('is-unresolved');
			el.setAttr('aria-label', `No block ${live.ref.linktext}`);
		} else {
			el.removeAttribute('aria-label');
		}
	}

	/** Waits for a render slot. Over the limit, a render waits in a queue and runs when a slot frees. */
	private async acquire(): Promise<void> {
		if (this.inFlight < MAX_IN_FLIGHT) {
			this.inFlight++;
			return;
		}
		if (!this.capLogged) {
			this.capLogged = true;
			console.debug(`Inline Block Embeds: ${MAX_IN_FLIGHT} inline renders run at one time; the next ones wait for a free slot.`);
		}
		await new Promise<void>((resolve) =>
			this.waiting.push(() => {
				this.inFlight++;
				resolve();
			}),
		);
	}

	private release(): void {
		this.inFlight--;
		this.waiting.shift()?.();
	}

	/** True while the span is in use and no newer fill started. */
	private current(live: Live, gen: number): boolean {
		return gen === live.gen && this.live.has(live);
	}

	/** Draws the span for its current plan. A failed read (the note was deleted or renamed) gives the missing look. */
	private async fill(live: Live): Promise<void> {
		this.fills++;
		const gen = live.gen + 1;
		try {
			await this.fillOnce(live);
		} catch {
			if (!this.current(live, gen)) return;
			this.setLook(live, 'missing');
			live.el.setText(live.ref.display);
		}
	}

	/** A newer call wins over an older one that still waits for a read. */
	private async fillOnce(live: Live): Promise<void> {
		if (!this.live.has(live)) return;
		const gen = ++live.gen;
		if (live.inner) {
			live.owner.removeChild(live.inner);
			live.inner = null;
		}
		const plan = live.plan;
		this.setLook(live, plan.state);
		if (plan.state !== 'inline') {
			live.el.setText(live.ref.display);
			return;
		}
		live.el.setAttr('data-ibe-key', plan.key);
		if (nestState(live.chain, plan.key) !== 'inline') {
			live.el.addClass('ibe-link-text');
			live.el.setText(live.ref.display);
			return;
		}
		// The slot covers only the file read. The render by Obsidian and the nested spans run with no slot held,
		// because embeds that Obsidian draws inside the render run this post processor and need slots of their own.
		let text: string | null = null;
		await this.acquire();
		try {
			if (!this.current(live, gen)) return;
			text = await this.textOf(plan);
		} finally {
			this.release();
		}
		if (!this.current(live, gen)) return;
		await Promise.all(await this.render(live, plan, gen, text));
	}

	/** Renders the text of one span. Returns the fills of its nested spans, which the caller waits for. */
	private async render(live: Live, plan: Extract<Plan, { state: 'inline' }>, gen: number, text: string | null): Promise<Promise<void>[]> {
		live.el.removeClass('ibe-link-text');
		if (text === null) {
			this.setLook(live, 'missing');
			live.el.setText(live.ref.display);
			return [];
		}
		const inner = new Component();
		live.inner = live.owner.addChild(inner);
		const next = [...live.chain, plan.key];
		// Nested inline embeds become tokens before the render, so the depth and loop checks see the whole chain.
		const nested: Array<{ plan: Plan; state: 'inline' | 'loop' | 'depth' }> = [];
		let markdown = '';
		let last = 0;
		const opts = this.options();
		for (const m of selectEmbeds(text, opts.drawAll)) {
			if (!m.selected) continue;
			const ref: EmbedRef = { path: m.path, blockId: m.blockId, linktext: m.linktext, display: m.display };
			const p = this.plan(ref, plan.file.path);
			if (p.state === 'native') continue;
			const state = p.state === 'inline' ? nestState(next, p.key) : 'inline';
			markdown += `${text.slice(last, m.from)}${nested.length}`;
			nested.push({ plan: p, state });
			last = m.to;
		}
		markdown += text.slice(last);
		// The box and the span carry the chain, so an embed that Obsidian draws inside them keeps it (rule 18).
		const box = createDiv({ attr: { [CHAIN_ATTR]: JSON.stringify(next) } });
		this.renderStack.push(next);
		let rendered: Promise<void>;
		try {
			rendered = MarkdownRenderer.render(this.app, markdown, box, plan.file.path, inner);
		} finally {
			this.renderStack.pop();
		}
		await rendered;
		if (!this.current(live, gen)) {
			// The span was removed or filled again while the render ran: drop what this render made.
			if (live.inner === inner) live.inner = null;
			live.owner.removeChild(inner);
			return [];
		}
		live.el.empty();
		live.el.setAttr(CHAIN_ATTR, JSON.stringify(next));
		unwrapInto(box, live.el);
		const waits: Promise<void>[] = [];
		replaceTokens(live.el, (n) => {
			const item = nested[n];
			if (!item) return null;
			if (item.state !== 'inline') {
				// Rule 18: a loop or a level past the limit shows the link text.
				return this.linkText(item.plan.ref);
			}
			const child = this.createSpan(item.plan, plan.file.path, next, inner, createSpan(), live);
			waits.push(child.done);
			return child.el;
		});
		return waits;
	}

	/** True when a span shows a block of this file. */
	watches(path: string): boolean {
		for (const live of this.live) if (live.plan.state === 'inline' && live.plan.file.path === path) return true;
		return false;
	}

	/** Rule 16 before the save: an editor changed the text of a source note. */
	editorChanged(path: string, text: string): void {
		this.unsaved.set(path, text);
		this.refreshFile(path);
	}

	/** The note is saved and indexed again: the cache is current. */
	fileChanged(path: string): void {
		this.unsaved.delete(path);
		this.refreshFile(path);
	}

	/** Rule 16: redraws each span that shows a block of this file, and each span that shows a missing block. */
	refreshFile(path: string | null): void {
		const due = Array.from(this.live).filter((live) => {
			const target = live.plan.state === 'inline' ? live.plan.file.path : null;
			return path === null || target === path || live.plan.state === 'missing' || live.plan.state === 'native';
		});
		const dueSet = new Set(due);
		const parents = new Set<Live>();
		for (const live of due) {
			// A span whose parent fills again in this pass is made new by that fill. A removed span is never filled.
			if (!this.live.has(live) || hasAncestor(live, dueSet)) continue;
			const before = live.plan.state;
			live.plan = this.plan(live.ref, live.sourcePath);
			if (live.plan.state === 'native' && before !== 'native') {
				// The block is now a table, a heading or another kind that Obsidian draws: give it back to Obsidian.
				if (live.parent) parents.add(live.parent);
				else this.onNative?.(live.el);
				continue;
			}
			void this.fill(live);
		}
		for (const parent of parents) if (this.live.has(parent) && !hasAncestor(parent, dueSet)) void this.fill(parent);
	}

	/** The source paths of the spans that are in use, missing ones included as their link path. */
	targets(): Set<string> {
		const out = new Set<string>();
		for (const live of this.live) out.add(live.plan.state === 'inline' ? live.plan.file.path : live.ref.path);
		return out;
	}

	/** Number of spans that are in use (tests). */
	get size(): number {
		return this.live.size;
	}

	clear(): void {
		this.live.clear();
		this.unsaved.clear();
	}
}

/** True when a span inside a span of the set holds this one. */
function hasAncestor(live: Live, set: Set<Live>): boolean {
	for (let p = live.parent; p; p = p.parent) if (set.has(p)) return true;
	return false;
}

/** Rule 8: moves the rendered nodes into the span and unwraps a single paragraph. */
export function unwrapInto(box: HTMLElement, el: HTMLElement): void {
	const elements = Array.from(box.children);
	const onlyText = Array.from(box.childNodes).every((n) => n.nodeType !== Node.TEXT_NODE || (n.nodeValue ?? '').trim() === '');
	const source = elements.length === 1 && elements[0]?.tagName === 'P' && onlyText ? (elements[0] as HTMLElement) : box;
	while (source.firstChild) el.appendChild(source.firstChild);
}

/** Replaces each `n` token in the text nodes of el with the node that make() returns. */
export function replaceTokens(el: HTMLElement, make: (n: number) => Node | null): number {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.nodeValue ?? '').includes('')) nodes.push(n as Text);
	let done = 0;
	for (const node of nodes) {
		const value = node.nodeValue ?? '';
		const frag = createFragment();
		let last = 0;
		for (const m of value.matchAll(TOKEN_RE)) {
			frag.appendChild(el.ownerDocument.createTextNode(value.slice(last, m.index)));
			const made = make(Number(m[1]));
			if (made) {
				frag.appendChild(made);
				done++;
			}
			last = m.index + m[0].length;
		}
		frag.appendChild(el.ownerDocument.createTextNode(value.slice(last)));
		node.replaceWith(frag);
	}
	return done;
}
