// Reading view (rule 15): a Markdown post processor replaces the core embed element of a selected block embed with
// the inline span. The post processor also runs for PDF export, so the export keeps the inline text (criterion 10).
import { Component, MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { nestState, selectEmbeds } from './embeds';
import type { EmbedRef, InlineEmbeds } from './render';

const SRC_RE = /^([^#|]*)#\^([A-Za-z0-9-]+)$/;
/** Elements that do not count as text on the line: list bullets, fold arrows, task boxes. */
const SKIP = '.list-bullet, .list-collapse-indicator, .collapse-indicator, input';
const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DD', 'DT', 'SECTION']);

function counts(node: Node): boolean {
	if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').trim() !== '';
	if (!node.instanceOf(HTMLElement)) return false;
	if (node.matches(SKIP)) return false;
	if (node.tagName === 'BR') return false;
	return (node.textContent ?? '').trim() !== '' || node.matches('img, .internal-embed, .math, mjx-container');
}

/** Rule 2 in the DOM: true when the line of the element (between <br> tags in its block) has other content. */
export function lineHasOtherContent(el: HTMLElement): boolean {
	let node: HTMLElement = el;
	for (;;) {
		for (const dir of ['previousSibling', 'nextSibling'] as const) {
			for (let s = node[dir]; s; s = s[dir]) {
				if (s.instanceOf(HTMLElement) && s.tagName === 'BR') break;
				if (counts(s)) return true;
			}
		}
		const parent = node.parentElement;
		if (!parent || BLOCK_TAGS.has(parent.tagName)) return false;
		node = parent;
	}
}

/** A span of a render with no owner is dropped when it has been out of the document for this long. */
export const ORPHAN_MS = 60_000;

export class ReadingView {
	/**
	 * Owner of the spans of a render that has no component (another plugin can render Markdown without one). Then
	 * ctx.addChild gives nothing and the child would never load or unload, so this component holds it instead.
	 */
	readonly orphans = new Component();
	private orphanSince = new Map<MarkdownRenderChild, number>();

	constructor(private readonly inline: InlineEmbeds) {}

	/** Unloads each owned span that has been out of the document for ORPHAN_MS. Returns the number dropped. */
	sweep(now = Date.now()): number {
		let dropped = 0;
		for (const [child, since] of Array.from(this.orphanSince)) {
			if (child.containerEl.isConnected) {
				this.orphanSince.set(child, now);
				continue;
			}
			if (now - since < ORPHAN_MS) continue;
			this.orphanSince.delete(child);
			this.orphans.removeChild(child);
			dropped++;
		}
		return dropped;
	}

	/** Number of spans that this view owns because their render had no component (tests). */
	get orphanCount(): number {
		return this.orphanSince.size;
	}

	/** The aliases that the section text gives to each embed source, in order. */
	private aliases(el: HTMLElement, ctx: MarkdownPostProcessorContext): Map<string, Array<string | null>> | null {
		const info = ctx.getSectionInfo(el);
		if (!info) return null;
		const map = new Map<string, Array<string | null>>();
		const lines = info.text.split('\n').slice(info.lineStart, info.lineEnd + 1);
		for (const line of lines) {
			for (const m of selectEmbeds(line)) {
				const list = map.get(m.linktext) ?? [];
				list.push(m.alias);
				map.set(m.linktext, list);
			}
		}
		return map;
	}

	process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
		const embeds = Array.from(el.querySelectorAll<HTMLElement>('.internal-embed[src*="#^"]'));
		if (!embeds.length) return;
		const aliases = this.aliases(el, ctx);
		// Rule 18: the chain of the embeds around this content. A render that Obsidian starts in a detached element
		// may attach it a moment later, so an element with no known chain waits one task and looks again.
		if (!this.inline.knowsChain(el) && !el.isConnected) {
			return new Promise<void>((resolve) => window.setTimeout(resolve, 0)).then(() => this.replace(el, embeds, ctx, aliases, this.inline.chainFor(el)));
		}
		return this.replace(el, embeds, ctx, aliases, this.inline.chainFor(el));
	}

	private replace(root: HTMLElement, embeds: HTMLElement[], ctx: MarkdownPostProcessorContext, aliases: Map<string, Array<string | null>> | null, chain: string[]): Promise<void> | undefined {
		const opts = this.inline.options();
		const seen = new Map<string, number>();
		const waits: Promise<void>[] = [];
		for (const embed of embeds) {
			if (!embed.isConnected && !embed.parentElement) continue;
			const src = embed.getAttribute('src') ?? '';
			const m = SRC_RE.exec(src);
			if (!m) continue;
			const path = (m[1] ?? '').trim();
			const blockId = m[2] ?? '';
			const linktext = `${path}#^${blockId}`;
			const n = seen.get(linktext) ?? 0;
			seen.set(linktext, n + 1);
			const alias = aliases ? (aliases.get(linktext)?.[n] ?? null) : altAlias(embed, path, blockId);
			if (!opts.drawAll && !lineHasOtherContent(embed)) continue;
			const ref: EmbedRef = { path, blockId, linktext, display: alias ?? linktext };
			const plan = this.inline.plan(ref, ctx.sourcePath);
			if (plan.state === 'native') continue;
			// The chain of this embed: the chain of the content plus the core embeds between it and the content.
			const own = [...chain, ...nativesBetween(embed, root)];
			if (plan.state === 'inline' && nestState(own, plan.key) !== 'inline') {
				embed.replaceWith(this.inline.linkText(ref));
				continue;
			}
			const span = createSpan();
			const child = new MarkdownRenderChild(span);
			// Core returns the child when the render has a component, and nothing when it has none.
			// The typings say void; the value is read as unknown on purpose.
			const added: unknown = ctx.addChild(child);
			if (added === undefined || added === null) {
				this.orphans.addChild(child);
				this.orphanSince.set(child, Date.now());
			}
			const made = this.inline.createSpan(plan, ctx.sourcePath, own, child, span);
			embed.replaceWith(made.el);
			waits.push(made.done);
		}
		if (waits.length) return Promise.all(waits).then(() => undefined);
		return undefined;
	}
}

/** One chain entry for each embed that Obsidian draws between an element and the root of a post processor call. */
export function nativesBetween(el: HTMLElement, root: HTMLElement): string[] {
	const out: string[] = [];
	for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
		if (node.classList.contains('internal-embed') && node.getAttribute('src')) out.push(`native:${node.getAttribute('src') ?? ''}`);
	}
	return out.reverse();
}

/** The alias from the alt text of the core element, when the section text is not known. */
function altAlias(embed: HTMLElement, path: string, blockId: string): string | null {
	const alt = (embed.getAttribute('alt') ?? '').trim();
	const defaults = new Set(['', `${path}#^${blockId}`, `${path} > ^${blockId}`, `${path} > ${blockId}`, `^${blockId}`]);
	return defaults.has(alt) ? null : alt;
}
