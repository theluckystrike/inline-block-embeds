import { describe, expect, it, vi } from 'vitest';
import { Component, MarkdownRenderer } from 'obsidian';
import { InlineEmbeds, MAX_IN_FLIGHT, type EmbedRef, type Plan } from '../src/render';
import { ReadingView } from '../src/reading';
import { blockKey } from '../src/embeds';

// A 3 level chain C1 > C2 > C3 with the metadata cache and the renderer stubbed: the refresh logic of render.ts runs
// as it does in the app. MarkdownRenderer.render writes the text into one paragraph, as a paragraph block renders.
const FILES: Record<string, string> = { C1: 'one ![[C2#^c]] one', C2: 'two ![[C3#^c]] two', C3: 'three', N1: 'n ![[N2#^c]] n', N2: 'leaf' };

class Stub extends InlineEmbeds {
	reads = 0;
	fail = false;
	plan(ref: EmbedRef): Plan {
		if (!(ref.path in FILES)) return { state: 'missing', ref };
		return { state: 'inline', ref, kind: 'paragraph', file: { path: `${ref.path}.md` } as never, key: blockKey(`${ref.path}.md`, ref.blockId) };
	}
	async textOf(plan: Extract<Plan, { state: 'inline' }>): Promise<string | null> {
		this.reads++;
		await new Promise((r) => setTimeout(r, 1));
		if (this.fail) throw new Error('read failed');
		return FILES[plan.file.path.replace(/\.md$/, '')] ?? null;
	}
}

async function settle(inline: InlineEmbeds): Promise<void> {
	for (let i = 0; i < 200 && inline.pending > 0; i++) await new Promise((r) => setTimeout(r, 2));
	await new Promise((r) => setTimeout(r, 10));
}

function mockRender(): void {
	vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, markdown, el) => {
		const p = document.createElement('p');
		p.textContent = markdown;
		el.appendChild(p);
	});
}

function setup(): { inline: Stub; el: HTMLElement; owner: Component } {
	mockRender();
	// The app needs only workspace.trigger (hover). The key is set by name: the export gate rejects the text of a pnpm workspace protocol.
	const app: Record<string, unknown> = {};
	app['workspace'] = { trigger: () => undefined };
	const inline = new Stub(app as never, 'inline-block-embeds', () => ({ drawAll: false, listItems: true, style: 'underline' }));
	const owner = new Component();
	owner.load();
	const ref: EmbedRef = { path: 'C1', blockId: 'c', linktext: 'C1#^c', display: 'C1#^c' };
	const { el } = inline.createSpan(inline.plan(ref), 'Host.md', [], owner);
	return { inline, el, owner };
}

describe('refresh of a 3 level chain (review round 2, major)', () => {
	it('keeps the same number of spans after 10 refreshes, with nothing pending', async () => {
		const { inline, el } = setup();
		await settle(inline);
		expect(el.textContent).toBe('one two three two one');
		const size = inline.size;
		expect(size).toBe(3);
		for (let i = 0; i < 10; i++) {
			inline.refreshFile(null);
			await settle(inline);
			expect(inline.size).toBe(size);
			expect(inline.pending).toBe(0);
			expect(el.querySelectorAll('.ibe-inline').length).toBe(2);
			expect(el.textContent).toBe('one two three two one');
		}
	});

	it('refreshes the files of each level in one pass and leaks nothing', async () => {
		const { inline } = setup();
		await settle(inline);
		for (let i = 0; i < 10; i++) {
			for (const f of ['C3.md', 'C2.md', 'C1.md']) inline.refreshFile(f);
			await settle(inline);
			expect(inline.size).toBe(3);
		}
	});

	it('gives the missing look when a read fails, with no unhandled rejection', async () => {
		const { inline, el } = setup();
		await settle(inline);
		inline.fail = true;
		inline.refreshFile(null);
		await settle(inline);
		expect(el.classList.contains('is-unresolved')).toBe(true);
		expect(el.textContent).toBe('C1#^c');
	});

	it('drops every span when the owner unloads', async () => {
		const { inline, owner } = setup();
		await settle(inline);
		owner.unload();
		expect(inline.size).toBe(0);
	});
});

function stub(): Stub {
	mockRender();
	const app: Record<string, unknown> = {};
	app['workspace'] = { trigger: () => undefined };
	return new Stub(app as never, 'inline-block-embeds', () => ({ drawAll: false, listItems: true, style: 'underline' }));
}

async function drain(inline: InlineEmbeds, ms = 20000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end && (inline.pending > 0 || inline.queued > 0)) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 10));
}

describe('render slots with many nested spans (review round 3, major)', () => {
	it('finishes 300 three level chains and 600 one nested spans, with no slot held by a waiting parent', async () => {
		const inline = stub();
		const owner = new Component();
		owner.load();
		const spans: Array<{ el: HTMLElement; text: string }> = [];
		for (let i = 0; i < 300; i++) {
			const ref: EmbedRef = { path: 'C1', blockId: 'c', linktext: 'C1#^c', display: 'C1#^c' };
			spans.push({ el: inline.createSpan(inline.plan(ref), 'Host.md', [], owner).el, text: 'one two three two one' });
		}
		for (let i = 0; i < 600; i++) {
			const ref: EmbedRef = { path: 'N1', blockId: 'c', linktext: 'N1#^c', display: 'N1#^c' };
			spans.push({ el: inline.createSpan(inline.plan(ref), 'Host.md', [], owner).el, text: 'n leaf n' });
		}
		expect(spans.length).toBeGreaterThan(MAX_IN_FLIGHT);
		await drain(inline);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
		expect(spans.every((s) => s.el.textContent === s.text)).toBe(true);
		expect(inline.size).toBe(300 * 3 + 600 * 2);
		// A refresh of every span in one pass also drains.
		inline.refreshFile(null);
		await drain(inline);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
		expect(spans.every((s) => s.el.textContent === s.text)).toBe(true);
		expect(inline.size).toBe(300 * 3 + 600 * 2);
	}, 60000);

	it('PDF export path: the post processor promise of such a note resolves, with every span drawn', async () => {
		const inline = stub();
		const reading = new ReadingView(inline);
		const root = document.createElement('div');
		const rows: string[] = [];
		for (let i = 0; i < 300; i++) rows.push('<p>a <span class="internal-embed" src="C1#^c"></span> b</p>');
		for (let i = 0; i < 600; i++) rows.push('<p>a <span class="internal-embed" src="N1#^c"></span> b</p>');
		root.innerHTML = rows.join('');
		const component = new Component();
		component.load();
		const ctx = { sourcePath: 'Host.md', docId: 'x', frontmatter: null, getSectionInfo: () => null, addChild: (c: Component) => component.addChild(c) };
		const done = reading.process(root, ctx as never);
		const result = await Promise.race([Promise.resolve(done).then(() => 'done'), new Promise((r) => setTimeout(() => r('stalled'), 30000))]);
		expect(result).toBe('done');
		const paras = Array.from(root.querySelectorAll(':scope > p')).map((p) => p.textContent);
		expect(paras.filter((t) => t === 'a one two three two one b').length).toBe(300);
		expect(paras.filter((t) => t === 'a n leaf n b').length).toBe(600);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
	}, 60000);

	it('owns and later drops the spans of a render that has no component', async () => {
		const inline = stub();
		const reading = new ReadingView(inline);
		reading.orphans.load();
		const root = document.createElement('div');
		root.innerHTML = '<p>a <span class="internal-embed" src="N1#^c"></span> b</p>';
		const ctx = { sourcePath: 'Host.md', docId: 'x', frontmatter: null, getSectionInfo: () => null, addChild: () => undefined };
		await reading.process(root, ctx as never);
		expect(reading.orphanCount).toBe(1);
		expect(inline.size).toBe(2);
		expect(reading.sweep(Date.now() + 1000)).toBe(0);
		expect(reading.sweep(Date.now() + 61000)).toBe(1);
		expect(inline.size).toBe(0);
		expect(reading.orphanCount).toBe(0);
	});
});

// Review round 4 probe: the block of each host span holds a heading embed that Obsidian draws, and that heading
// section holds an inline block embed. The render mock loads heading embeds as core does: it renders the section into
// the embed element and runs the post processor on it, and the outer render resolves only after that.
describe('slots with heading embeds that Obsidian draws inside the render (review round 4, major)', () => {
	const SECTIONS: Record<string, string> = { 'H#Sec': 'h ![[N2#^c]] h' };
	const BLOCKS: Record<string, string> = { P: 'p ![[H#Sec]] p', N2: 'leaf' };

	class CoreStub extends InlineEmbeds {
		plan(ref: EmbedRef): Plan {
			if (!(ref.path in BLOCKS)) return { state: 'missing', ref };
			return { state: 'inline', ref, kind: 'paragraph', file: { path: `${ref.path}.md` } as never, key: blockKey(`${ref.path}.md`, ref.blockId) };
		}
		async textOf(plan: Extract<Plan, { state: 'inline' }>): Promise<string | null> {
			await new Promise((r) => setTimeout(r, 1));
			return BLOCKS[plan.file.path.replace(/\.md$/, '')] ?? null;
		}
	}

	function coreLike(): { inline: CoreStub; reading: ReadingView } {
		const app: Record<string, unknown> = {};
		app['workspace'] = { trigger: () => undefined };
		const inline = new CoreStub(app as never, 'inline-block-embeds', () => ({ drawAll: false, listItems: true, style: 'underline' }));
		const reading = new ReadingView(inline);
		const render = async (markdown: string, el: HTMLElement, component: Component): Promise<void> => {
			const p = document.createElement('p');
			// Embeds become core embed elements; the rest stays text (tokens included).
			let last = 0;
			for (const m of markdown.matchAll(/!\[\[([^\]]+)\]\]/g)) {
				p.appendChild(document.createTextNode(markdown.slice(last, m.index)));
				const span = document.createElement('span');
				span.className = 'internal-embed';
				span.setAttribute('src', m[1] ?? '');
				p.appendChild(span);
				last = m.index + m[0].length;
			}
			p.appendChild(document.createTextNode(markdown.slice(last)));
			el.appendChild(p);
			const waits: Array<Promise<void> | void> = [];
			// Core loads a heading embed: it renders the section inside the embed element and post processes it.
			for (const span of Array.from(p.querySelectorAll<HTMLElement>('.internal-embed'))) {
				const section = SECTIONS[span.getAttribute('src') ?? ''];
				if (section === undefined) continue;
				const content = document.createElement('div');
				content.className = 'markdown-embed-content';
				span.appendChild(content);
				waits.push(render(section, content, component));
			}
			const ctx = { sourcePath: 'Host.md', docId: 'x', frontmatter: null, getSectionInfo: () => null, addChild: (c: Component) => component.addChild(c) };
			waits.push(reading.process(el, ctx as never));
			await Promise.all(waits);
		};
		vi.spyOn(MarkdownRenderer, 'render').mockImplementation((_app, markdown, el, _path, component) => render(markdown, el, component));
		return { inline, reading };
	}

	it('finishes 300 host spans whose block holds a heading embed with an inline embed', async () => {
		const { inline } = coreLike();
		const owner = new Component();
		owner.load();
		const els: HTMLElement[] = [];
		for (let i = 0; i < 300; i++) {
			const ref: EmbedRef = { path: 'P', blockId: 'c', linktext: 'P#^c', display: 'P#^c' };
			els.push(inline.createSpan(inline.plan(ref), 'Host.md', [], owner).el);
		}
		await drain(inline);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
		expect(els.filter((e) => e.textContent === 'p h leaf h p').length).toBe(300);
		inline.refreshFile(null);
		await drain(inline);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
		expect(els.filter((e) => e.textContent === 'p h leaf h p').length).toBe(300);
	}, 60000);

	it('PDF export path: the post processor promise of a note with 300 such embeds resolves', async () => {
		const { inline, reading } = coreLike();
		const root = document.createElement('div');
		root.innerHTML = Array.from({ length: 300 }, () => '<p>a <span class="internal-embed" src="P#^c"></span> b</p>').join('');
		const component = new Component();
		component.load();
		const ctx = { sourcePath: 'Host.md', docId: 'x', frontmatter: null, getSectionInfo: () => null, addChild: (c: Component) => component.addChild(c) };
		const done = reading.process(root, ctx as never);
		const result = await Promise.race([Promise.resolve(done).then(() => 'done'), new Promise((r) => setTimeout(() => r('stalled'), 30000))]);
		expect(result).toBe('done');
		const paras = Array.from(root.querySelectorAll(':scope > p')).map((p) => p.textContent);
		expect(paras.filter((t) => t === 'a p h leaf h p b').length).toBe(300);
		expect(inline.pending).toBe(0);
		expect(inline.queued).toBe(0);
	}, 60000);
});
