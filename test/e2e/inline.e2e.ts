import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId } from './load';

// Real-app checks for acceptance criteria 7 to 10 of the spec, on minAppVersion and on the latest app (wdio.conf.mts).
const SOURCE = ['Hello **world** ^p1', '', '- [ ] Call Bob ^t1', '- [x] Mail Ann', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '^tb1', '', '## Plan ^h1', ''].join('\n');
const HOST = [
	'Confirm the facts in ![[A#^p1]] today.',
	'',
	'![[A#^p1]]',
	'',
	'See ![[A#^missing|see]] and ![[A#^tb1]] here.',
	'',
	'Task: ![[A#^t1]] now.',
	'',
	'End.',
].join('\n');
const ACTIVE = '.workspace-leaf.mod-active';

/** Text of each line of the active editor. A block widget is not a line, so tests find lines by their start. */
async function lines(): Promise<string[]> {
	return browser.execute((sel: string) => Array.from(document.querySelectorAll(`${sel} .markdown-source-view .cm-content > .cm-line`)).map((l) => l.textContent ?? ''), ACTIVE);
}

/** Waits until the editor line that starts with `start` has exactly `text` (or contains it with `part`). */
async function waitForLine(start: string, text: string, part = false, timeout = 10000): Promise<void> {
	let last: string[] = [];
	await browser
		.waitUntil(
			async () => {
				last = await lines();
				const line = last.find((l) => l.startsWith(start));
				return line !== undefined && (part ? line.includes(text) : line === text);
			},
			{ timeout, interval: 100 },
		)
		.catch(() => {
			throw new Error(`the line "${start}..." is not "${text}": ${JSON.stringify(last)}`);
		});
}

/** Number of inline spans in the editor line that starts with `start`. */
async function inlineIn(start: string): Promise<number> {
	return browser.execute(
		(sel: string, st: string) => {
			const line = Array.from(document.querySelectorAll(`${sel} .markdown-source-view .cm-content > .cm-line`)).find((l) => (l.textContent ?? '').startsWith(st));
			return line ? line.querySelectorAll('.ibe-inline').length : -1;
		},
		ACTIVE,
		start,
	);
}

/**
 * Writes a note and waits until Obsidian has it: the vault text matches and the metadata cache lists every block id
 * of the text. This replaces a fixed pause after a write.
 */
async function writeNote(path: string, text: string): Promise<void> {
	await obsidianPage.write(path, text);
	const ids = Array.from(text.matchAll(/\^([A-Za-z0-9-]+)\s*$/gm)).map((m) => (m[1] ?? '').toLowerCase());
	await browser.waitUntil(
		async () =>
			browser.executeObsidian(
				async ({ app }, p, t, want) => {
					const file = app.vault.getFileByPath(p);
					if (!file || (await app.vault.cachedRead(file)) !== t) return false;
					const cache = app.metadataCache.getFileCache(file);
					if (!cache) return false;
					const blocks = Object.keys(cache.blocks ?? {});
					return want.every((id) => blocks.includes(id));
				},
				path,
				text,
				ids,
			),
		{ timeout: 10000, interval: 50, timeoutMsg: `${path} was not indexed` },
	);
}

/** Waits until the plugin has no render running or queued. */
async function waitIdle(): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.executeObsidian(({ app }, id) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { inline: { pending: number } }> } }).plugins.plugins[id]!;
				return p.inline.pending === 0;
			}, pluginId),
		{ timeout: 15000, interval: 50, timeoutMsg: 'renders did not finish' },
	);
}

/** Brings the app window to the front: Live Preview shows a raw link and the page preview only in a focused window. */
async function focusWindow(): Promise<void> {
	await browser.execute(() => {
		try {
			const req = (window as unknown as { require: (m: string) => { app?: { focus(o?: unknown): void }; getCurrentWindow(): { focus(): void; show(): void } } }).require;
			const remote = req('@electron/remote');
			remote.app?.focus({ steal: true });
			remote.getCurrentWindow().show();
			remote.getCurrentWindow().focus();
		} catch {
			window.focus();
		}
	});
	// The raw link and the page preview need a focused window, as in Live Preview without the plugin.
	await browser.waitUntil(async () => browser.execute(() => document.hasFocus()), { timeout: 5000, interval: 50, timeoutMsg: 'the app window has no focus' });
}

async function setCursor(line: number, ch: number): Promise<void> {
	await focusWindow();
	// A real click on the last line gives the editor the focus that a cursor set by code does not give.
	await browser.$(`${ACTIVE} .markdown-source-view .cm-content > .cm-line:last-child`).click();
	await browser.executeObsidian(
		({ app }, l, c) => {
			const editor = app.workspace.activeEditor?.editor;
			editor?.focus();
			editor?.setCursor({ line: l, ch: c });
		},
		line,
		ch,
	);
}

async function setMode(mode: 'source' | 'preview'): Promise<void> {
	await browser.executeObsidian(async ({ app }, m) => {
		const leaf = app.workspace.getMostRecentLeaf();
		if (!leaf) return;
		const s = leaf.getViewState();
		await leaf.setViewState({ ...s, state: { ...s.state, mode: m, source: false } });
	}, mode);
}

/** Opens the host note in Live Preview with the cursor on the last line. */
async function openHost(): Promise<void> {
	await obsidianPage.openFile('Host.md');
	await setMode('source');
	await setCursor(8, 0);
	await waitForLine('Confirm', 'Confirm the facts in Hello world today.');
}

/** Pro on: a stubbed GitHub Sponsors reply ($5 a month) and a fake token, then Refresh. Pro off: sign out. No real request. */
async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, value) => {
			interface Pro {
				opts: { http: unknown };
				refreshNow(): Promise<void>;
				signOut(): void;
			}
			const p = (app as unknown as { plugins: { plugins: Record<string, { pro: Pro }> } }).plugins.plugins[id]!;
			if (!value) {
				p.pro.signOut();
				return;
			}
			const reply = { status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
			p.pro.opts.http = () => Promise.resolve(reply);
			app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
			await p.pro.refreshNow();
		},
		pluginId,
		on,
	);
}

async function setSettings(values: Record<string, unknown>): Promise<void> {
	await browser.executeObsidian(
		({ app }, id, v) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { settings: Record<string, unknown>; redrawAll(): void }> } }).plugins.plugins[id]!;
			Object.assign(p.settings, v);
			p.redrawAll();
		},
		pluginId,
		values,
	);
}

async function takeErrors(): Promise<string[]> {
	return browser.execute(() => (window as unknown as { __ibeErrors?: string[] }).__ibeErrors?.splice(0) ?? []);
}

describe(`${pluginId} in the real app`, function () {
	before(async function () {
		await browser.execute(() => {
			const w = window as unknown as { __ibeErrors?: string[] };
			if (w.__ibeErrors) return;
			const errors: string[] = [];
			w.__ibeErrors = errors;
			const original = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(args.map(String).join(' '));
				original(...args);
			};
			window.addEventListener('error', (e) => errors.push(String(e.message)));
			window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
		});
		await setPro(false);
		await writeNote('A.md', SOURCE);
		await writeNote('Host.md', HOST);
		await openHost();
	});

	it('criterion 7: Live Preview shows the sentence as one line with the block text inside', async function () {
		const info = await browser.execute((sel: string) => {
			const line = document.querySelectorAll<HTMLElement>(`${sel} .markdown-source-view .cm-content > .cm-line`)[0]!;
			const span = line.querySelector<HTMLElement>('.ibe-inline')!;
			const lh = parseFloat(getComputedStyle(line).lineHeight) || 24;
			return {
				display: getComputedStyle(span).display,
				bold: span.querySelector('strong')?.textContent ?? '',
				boxes: line.querySelectorAll('.markdown-embed, .internal-embed').length,
				oneLine: line.getBoundingClientRect().height < lh * 1.8,
				underline: getComputedStyle(span).borderBottomStyle,
			};
		}, ACTIVE);
		expect(info).toEqual({ display: 'inline', bold: 'world', boxes: 0, oneLine: true, underline: 'dotted' });
	});

	it('rule 2: an embed alone on its line stays a block; a table embed stays as Obsidian draws it', async function () {
		const info = await browser.execute((sel: string) => {
			const root = document.querySelector<HTMLElement>(`${sel} .markdown-source-view .cm-content`)!;
			const blocks = Array.from(root.querySelectorAll<HTMLElement>('.internal-embed, .markdown-embed')).filter((e) => !e.closest('.ibe-inline'));
			return {
				spans: root.querySelectorAll('.ibe-inline').length,
				aloneBox: blocks.some((e) => (e.textContent ?? '').includes('Hello world')),
				tableBox: blocks.some((e) => e.querySelector('table') !== null),
			};
		}, ACTIVE);
		expect(info).toEqual({ spans: 2, aloneBox: true, tableBox: true });
	});

	it('rule 17: a missing block shows its alias in the unresolved style', async function () {
		const missing = await browser.execute((sel: string) => {
			const el = document.querySelector<HTMLElement>(`${sel} .ibe-inline.is-unresolved`);
			return el?.textContent ?? null;
		}, ACTIVE);
		expect(missing).toBe('see');
	});

	it('free: a list item block is not drawn inline', async function () {
		expect(await inlineIn('Task:')).toBe(0);
	});

	it('criterion 7: moving the cursor into the embed shows the raw link', async function () {
		await setCursor(0, 24);
		await waitForLine('Confirm', 'Confirm the facts in ![[A#^p1]]', true);
		expect(await inlineIn('Confirm')).toBe(0);
		await setCursor(8, 0);
		await waitForLine('Confirm', 'Confirm the facts in Hello world today.');
	});

	it('rule 12: a plain click puts the cursor in the embed text', async function () {
		await browser.$(`${ACTIVE} .cm-line .ibe-inline`).click();
		await waitForLine('Confirm', 'Confirm the facts in ![[A#^p1]]', true);
		const cursor = await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.getCursor());
		expect(cursor?.line).toBe(0);
		await setCursor(8, 0);
		await waitForLine('Confirm', 'Confirm the facts in Hello world today.');
	});

	it('rule 11: hover shows the core page preview of the block', async function () {
		// Live Preview may draw the widget again just after a cursor move, so the pointer moves again until the preview shows.
		let nudge = 0;
		await focusWindow();
		await browser.waitUntil(
			async () => {
				nudge = (nudge + 3) % 9;
				// The pointer leaves first: the preview starts on mouseover, when the pointer enters the span.
				await browser.$(`${ACTIVE} .cm-line:last-child`).moveTo();
				await browser.pause(300);
				await browser.$(`${ACTIVE} .cm-line .ibe-inline`).moveTo({ xOffset: nudge });
				await browser.pause(900);
				return (await browser.execute(() => document.querySelector('.hover-popover')?.textContent ?? '')).includes('Hello world');
			},
			{ timeout: 15000, interval: 100, timeoutMsg: 'no page preview' },
		);
		await browser.$(`${ACTIVE} .cm-line:last-child`).moveTo();
		await browser.execute(() => document.querySelectorAll('.hover-popover').forEach((p) => p.remove()));
	});

	it('rule 12: Ctrl or Cmd click opens the source block', async function () {
		await browser.executeObsidian(({ obsidian }, sel) => {
			const mac = obsidian.Platform.isMacOS;
			document.querySelector(`${sel} .cm-line .ibe-inline`)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: !mac, metaKey: mac }));
		}, ACTIVE);
		await browser.waitUntil(async () => (await browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path)) === 'A.md', { timeout: 5000, timeoutMsg: 'A.md did not open' });
		await browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.detach());
		await openHost();
	});

	it('criterion 7: Reading view shows the same text in a span', async function () {
		await setMode('preview');
		await browser.waitUntil(async () => (await browser.execute((sel: string) => document.querySelector(`${sel} .markdown-reading-view .markdown-preview-view .ibe-inline`)?.textContent ?? '', ACTIVE)) === 'Hello world', { timeout: 10000, timeoutMsg: 'no inline span in Reading view' });
		const info = await browser.execute((sel: string) => {
			const span = document.querySelector<HTMLElement>(`${sel} .markdown-reading-view .markdown-preview-view .ibe-inline`)!;
			const p = span.closest('p');
			const view = document.querySelector<HTMLElement>(`${sel} .markdown-reading-view .markdown-preview-view`)!;
			return {
				tag: span.tagName,
				paragraph: p?.textContent ?? '',
				unresolved: view.querySelector('.ibe-inline.is-unresolved')?.textContent ?? '',
				count: view.querySelectorAll('.ibe-inline').length,
			};
		}, ACTIVE);
		expect(info).toEqual({ tag: 'SPAN', paragraph: 'Confirm the facts in Hello world today.', unresolved: 'see', count: 2 });
		await setMode('source');
		await setCursor(8, 0);
		await waitForLine('Confirm', 'Confirm the facts in Hello world today.');
	});

	it('criterion 8: an edit of the block in A updates the open host note within 1 second', async function () {
		const ms = await browser.executeObsidian(async ({ app }) => {
			const host = app.workspace.getMostRecentLeaf()!;
			const leaf = app.workspace.getLeaf('split');
			await leaf.openFile(app.vault.getFileByPath('A.md')!);
			for (let i = 0; i < 100 && (leaf.view as unknown as { file?: { path: string } }).file?.path !== 'A.md'; i++) await new Promise((r) => setTimeout(r, 20));
			const editor = (leaf.view as unknown as { editor: { replaceRange(t: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void } }).editor;
			const t0 = performance.now();
			editor.replaceRange('there', { line: 0, ch: 8 }, { line: 0, ch: 13 });
			for (;;) {
				const text = host.view.containerEl.querySelector('.cm-line .ibe-inline')?.textContent;
				if (text === 'Hello there') return performance.now() - t0;
				if (performance.now() - t0 > 5000) return -1;
				await new Promise((r) => setTimeout(r, 25));
			}
		});
		console.info('Edit to inline update in ms', ms);
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThan(1000);
		const saved = await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath('A.md')!;
			const host = app.workspace.getLeavesOfType('markdown').find((l) => (l.view as unknown as { file?: { path: string } }).file?.path === 'Host.md')!;
			// Wait for the editor of A to save the edit, so the write below does not race with that save.
			for (let i = 0; i < 200 && !(await app.vault.read(file)).includes('Hello **there**'); i++) await new Promise((r) => setTimeout(r, 25));
			const t0 = performance.now();
			await app.vault.modify(file, (await app.vault.read(file)).replace('Hello **there**', 'Hello **again**'));
			for (;;) {
				const text = host.view.containerEl.querySelector('.cm-line .ibe-inline')?.textContent;
				if (text === 'Hello again') return performance.now() - t0;
				if (performance.now() - t0 > 5000) return -1;
				await new Promise((r) => setTimeout(r, 25));
			}
		});
		console.info('File write to inline update in ms', saved);
		expect(saved).toBeGreaterThan(0);
		expect(saved).toBeLessThan(1000);
		await browser.executeObsidian(async ({ app }) => {
			for (const leaf of app.workspace.getLeavesOfType('markdown')) if ((leaf.view as unknown as { file?: { path: string } }).file?.path === 'A.md') leaf.detach();
		});
		await writeNote('A.md', SOURCE);
		await openHost();
	});

	it('criterion 9: the note file is byte for byte unchanged after open and close', async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const before = await app.vault.adapter.read('Host.md');
			const statBefore = await app.vault.adapter.stat('Host.md');
			const leaf = app.workspace.getLeaf('tab');
			await leaf.openFile(app.vault.getFileByPath('Host.md')!);
			for (let i = 0; i < 100 && !leaf.view.containerEl.querySelector('.cm-line .ibe-inline'); i++) await new Promise((r) => setTimeout(r, 20));
			const s = leaf.getViewState();
			await leaf.setViewState({ ...s, state: { ...s.state, mode: 'preview' } });
			for (let i = 0; i < 100 && !leaf.view.containerEl.querySelector('.markdown-reading-view .ibe-inline'); i++) await new Promise((r) => setTimeout(r, 20));
			leaf.detach();
			// An observation window, not a wait for a state: a save after close would come within 2 seconds.
			await new Promise((r) => setTimeout(r, 2500));
			const after = await app.vault.adapter.read('Host.md');
			const statAfter = await app.vault.adapter.stat('Host.md');
			return { same: before === after, mtime: statBefore?.mtime === statAfter?.mtime, size: statBefore?.size === statAfter?.size };
		});
		expect(result).toEqual({ same: true, mtime: true, size: true });
		expect(await browser.executeObsidian(async ({ app }) => app.vault.adapter.read('Host.md'))).toBe(HOST);
	});

	it('criterion 10: a detached Reading view render, as PDF export makes it, keeps the inline text', async function () {
		const out = await browser.executeObsidian(async ({ app, obsidian }, text) => {
			const el = document.createElement('div');
			const comp = new obsidian.Component();
			comp.load();
			await obsidian.MarkdownRenderer.render(app, text, el, 'Host.md', comp);
			for (let i = 0; i < 40 && !el.querySelector('.ibe-inline:not(.is-unresolved) strong'); i++) await new Promise((r) => setTimeout(r, 50));
			const result = { first: el.querySelector('p')?.textContent ?? '', missing: el.querySelector('.is-unresolved')?.textContent ?? '' };
			comp.unload();
			return result;
		}, HOST);
		expect(out).toEqual({ first: 'Confirm the facts in Hello world today.', missing: 'see' });
	});

	it('criterion 5 and rule 18: a loop between two notes stops with no exception', async function () {
		await writeNote('L1.md', 'L1 cites ![[L2#^b]] here. ^a\n');
		await writeNote('L2.md', 'L2 cites ![[L1#^a]] there. ^b\n');
		await writeNote('Loop.md', 'Start ![[L1#^a]] end.\n\nLast.\n');
		await obsidianPage.openFile('Loop.md');
		await setMode('source');
		await setCursor(2, 0);
		await waitForLine('Start', 'Start L1 cites L2 cites L1#^a there. here. end.');
		await setMode('preview');
		await browser
			.waitUntil(async () => (await browser.execute((sel: string) => document.querySelector(`${sel} .markdown-reading-view .markdown-preview-view p`)?.textContent ?? '', ACTIVE)) === 'Start L1 cites L2 cites L1#^a there. here. end.', { timeout: 10000 })
			.catch(async () => {
				const html = await browser.execute((sel: string) => document.querySelector(`${sel} .markdown-reading-view .markdown-preview-view`)?.innerHTML.slice(-1500) ?? 'none', ACTIVE);
				throw new Error(`loop text in Reading view: ${html}`);
			});
		await setMode('source');
	});

	it('rule 18: a chain stops at depth 3', async function () {
		await writeNote('D1.md', 'one ![[D2#^d]] one ^d\n');
		await writeNote('D2.md', 'two ![[D3#^d]] two ^d\n');
		await writeNote('D3.md', 'three ![[D4#^d]] three ^d\n');
		await writeNote('D4.md', 'four ^d\n');
		await writeNote('Deep.md', 'Go ![[D1#^d]] stop.\n\nLast.\n');
		await obsidianPage.openFile('Deep.md');
		await setMode('source');
		await setCursor(2, 0);
		await waitForLine('Go', 'Go one two three D4#^d three two one stop.');
	});

	it('review C1: a loop through a heading embed that Obsidian draws stops, and the DOM stays bounded', async function () {
		await writeNote('X.md', 'See ![[Y#Intro]] now. ^x\n');
		await writeNote('Y.md', '# Intro\n\nRecall ![[X#^x]] here.\n\n# Other\n\nNo.\n');
		await writeNote('Mixed.md', 'Start ![[X#^x]] end.\n\nA heading embed: ![[Y#Intro]]\n\nLast.\n');
		const sample = async (): Promise<{ nodes: number; spans: number; links: number; pending: number; heap: number }> =>
			browser.executeObsidian(({ app }, id) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { inline: { pending: number } }> } }).plugins.plugins[id]!;
				const root = document.querySelector('.workspace-leaf.mod-active .view-content')!;
				const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
				return {
					nodes: root.querySelectorAll('*').length,
					spans: root.querySelectorAll('.ibe-inline').length,
					links: Array.from(root.querySelectorAll('.ibe-link-text')).filter((e) => e.textContent === 'X#^x').length,
					pending: p.inline.pending,
					heap: mem?.usedJSHeapSize ?? 0,
				};
			}, pluginId);
		for (const mode of ['source', 'preview'] as const) {
			await obsidianPage.openFile('Mixed.md');
			await setMode(mode);
			if (mode === 'source') await setCursor(4, 0);
			await browser.waitUntil(async () => (await sample()).links > 0, { timeout: 10000, timeoutMsg: `no loop link text in ${mode}` });
			await waitIdle();
			// Core draws Reading view sections lazily: wait until the node count holds for 3 polls in a row.
			let prev = -1;
			let same = 0;
			await browser.waitUntil(
				async () => {
					const now = (await sample()).nodes;
					same = now === prev ? same + 1 : 0;
					prev = now;
					return same >= 3;
				},
				{ timeout: 10000, interval: 250, timeoutMsg: `the ${mode} view did not finish drawing` },
			);
			const a = await sample();
			// An observation window: a loop that never ends would add nodes and renders during it.
			await browser.pause(2500);
			const b = await sample();
			console.info('Mixed loop sample', mode, JSON.stringify({ a, b }));
			// Bounded: nothing waits for a render, the DOM does not grow, and the heap does not climb by more than 20 MB.
			expect(b.pending).toBe(0);
			expect(b.nodes).toBe(a.nodes);
			expect(b.nodes).toBeLessThan(2000);
			expect(b.spans).toBeLessThan(20);
			if (a.heap && b.heap) expect(b.heap - a.heap).toBeLessThan(20_000_000);
		}
		await setMode('source');
	});

	it('review round 2: a 3 level chain keeps the same spans after 5 setting changes and 5 renames', async function () {
		await writeNote('C1.md', 'one ![[C2#^c]] one ^c\n');
		await writeNote('C2.md', 'two ![[C3#^c]] two ^c\n');
		await writeNote('C3.md', 'three ^c\n');
		await writeNote('Spare.md', 'spare\n');
		await writeNote('Chain.md', 'Go ![[C1#^c]] stop.\n\nLast.\n');
		await obsidianPage.openFile('Chain.md');
		await setMode('source');
		await setCursor(2, 0);
		await waitForLine('Go', 'Go one two three two one stop.');
		const sample = async (): Promise<{ size: number; pending: number; dom: number; text: string }> =>
			browser.executeObsidian(({ app }, id) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { inline: { size: number; pending: number } }> } }).plugins.plugins[id]!;
				const root = document.querySelector('.workspace-leaf.mod-active .markdown-source-view .cm-content')!;
				return { size: p.inline.size, pending: p.inline.pending, dom: root.querySelectorAll('.ibe-inline').length, text: root.querySelector('.cm-line')?.textContent ?? '' };
			}, pluginId);
		const settle = async (): Promise<{ size: number; pending: number; dom: number; text: string }> => {
			let last = await sample();
			await browser.waitUntil(
				async () => {
					last = await sample();
					return last.pending === 0 && last.text === 'Go one two three two one stop.';
				},
				{ timeout: 10000, interval: 100, timeoutMsg: 'renders did not settle' },
			);
			return sample();
		};
		const fills = async (): Promise<number> =>
			browser.executeObsidian(({ app }, id) => (app as unknown as { plugins: { plugins: Record<string, { inline: { fills: number } }> } }).plugins.plugins[id]!.inline.fills, pluginId);
		/** Waits until a refresh has started (the fill counter moved), so settle() checks the state after it. */
		const refreshed = async (before: number): Promise<void> => {
			await browser.waitUntil(async () => (await fills()) > before, { timeout: 5000, interval: 25, timeoutMsg: 'no refresh started' });
		};
		const base = await settle();
		expect(base.dom).toBe(3);
		for (let i = 0; i < 5; i++) {
			let before = await fills();
			await setSettings({ style: i % 2 ? 'underline' : 'none' });
			await refreshed(before);
			expect(await settle()).toEqual(base);
			before = await fills();
			await browser.executeObsidian(async ({ app }, n) => {
				const file = app.vault.getFileByPath(n % 2 ? 'Spare2.md' : 'Spare.md')!;
				await app.vault.rename(file, n % 2 ? 'Spare.md' : 'Spare2.md');
			}, i);
			await refreshed(before);
			expect(await settle()).toEqual(base);
		}
		console.info('Chain refresh sample', JSON.stringify(base));
		await setSettings({ style: 'underline' });
	});

	it('review round 3: the PDF export path of a note with 300 three level chains and 600 nested spans completes', async function () {
		await writeNote('N1.md', 'n ![[N2#^c]] n ^c\n');
		await writeNote('N2.md', 'leaf ^c\n');
		const out = await browser.executeObsidian(
			async ({ app, obsidian }, id) => {
				const rows: string[] = [];
				for (let i = 0; i < 300; i++) rows.push(`a ![[C1#^c]] b`, '');
				for (let i = 0; i < 600; i++) rows.push(`x ![[N1#^c]] y`, '');
				const el = document.createElement('div');
				const comp = new obsidian.Component();
				comp.load();
				const t0 = performance.now();
				// A detached render with a component, as the PDF export makes it. The post processors finish before it resolves.
				await obsidian.MarkdownRenderer.render(app, rows.join('\n'), el, 'Host.md', comp);
				const p = (app as unknown as { plugins: { plugins: Record<string, { inline: { pending: number; queued: number }; reading: { orphanCount: number } }> } }).plugins.plugins[id]!;
				for (let i = 0; i < 600 && p.inline.pending > 0; i++) await new Promise((r) => setTimeout(r, 50));
				const paras = Array.from(el.querySelectorAll('p')).map((x) => x.textContent ?? '');
				const result = {
					chains: paras.filter((x) => x === 'a one two three two one b').length,
					nested: paras.filter((x) => x === 'x n leaf n y').length,
					pending: p.inline.pending,
					queued: p.inline.queued,
					orphans: p.reading.orphanCount,
					ms: Math.round(performance.now() - t0),
				};
				comp.unload();
				return result;
			},
			pluginId,
		);
		console.info('Large export path', JSON.stringify(out));
		// orphans 0: a render with a component owns its spans, so none falls back to the plugin owner.
		expect({ chains: out.chains, nested: out.nested, pending: out.pending, queued: out.queued, orphans: out.orphans }).toEqual({ chains: 300, nested: 600, pending: 0, queued: 0, orphans: 0 });
	});

	it('review: an embed in a %% comment or in indented code is not drawn inline', async function () {
		await writeNote('Hidden.md', 'Seen ![[A#^p1]] here.\n\n%% hidden ![[A#^p1]] note %%\n\n    code ![[A#^p1]] block\n\nEnd.\n');
		await obsidianPage.openFile('Hidden.md');
		await setMode('source');
		await setCursor(6, 0);
		await waitForLine('Seen', 'Seen Hello world here.');
		const spans = await browser.execute((sel: string) => document.querySelectorAll(`${sel} .markdown-source-view .ibe-inline`).length, ACTIVE);
		expect(spans).toBe(1);
	});

	it('Pro: list items, draw every block embed inline, and the soft background style', async function () {
		await setPro(true);
		await openHost();
		await waitForLine('Task:', 'Task: Call Bob now.');
		expect(await inlineIn('Hello world')).toBe(-1);
		await setSettings({ drawAll: true, style: 'background' });
		// The embed alone on its line is now a line of inline text, not the embed box.
		await browser.waitUntil(
			async () =>
				browser.execute((sel: string) => {
					const root = document.querySelector(`${sel} .markdown-source-view .cm-content`);
					const line = root?.querySelector(':scope > .ibe-inline.ibe-line');
					const boxes = Array.from(root?.querySelectorAll('.internal-embed, .markdown-embed') ?? []).filter((e) => !e.closest('.ibe-inline') && (e.textContent ?? '').includes('Hello world'));
					return line?.textContent === 'Hello world' && boxes.length === 0;
				}, ACTIVE),
			{ timeout: 10000, timeoutMsg: 'the embed alone on its line is not inline' },
		);
		const cls = await browser.execute((sel: string) => document.querySelector(`${sel} .cm-line .ibe-inline`)?.className ?? '', ACTIVE);
		expect(cls).toContain('ibe-style-background');
		await setSettings({ drawAll: false, style: 'underline' });
		await setPro(false);
		await openHost();
	});

	it('logs no errors', async function () {
		expect(await takeErrors()).toEqual([]);
	});
});
