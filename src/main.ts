import { MarkdownView, Plugin, TFile, debounce } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, onProChange, resetPro } from './pro';
import { DEFAULT_SETTINGS, InlineBlockEmbedsSettingTab, effectiveOptions, normalizeSettings, type InlineBlockEmbedsSettings } from './settings';
import { InlineEmbeds } from './render';
import { inlineEmbedExtension, redrawViews } from './editor';
import { ReadingView } from './reading';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
/** Wait after the last edit in a source note before the inline text follows it. */
const EDIT_DELAY_MS = 250;
/** Wait after the last rename event before the redraw. */
const RENAME_DELAY_MS = 300;
/** How often the spans of renders with no component are checked. */
const ORPHAN_SWEEP_MS = 30_000;

export default class InlineBlockEmbedsPlugin extends Plugin {
	settings: InlineBlockEmbedsSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	/** Resolves and draws the inline spans. Created in onload. */
	inline: InlineEmbeds | null = null;
	/** The Reading view post processor. Created in onload. */
	reading: ReadingView | null = null;
	private settingTab: InlineBlockEmbedsSettingTab | null = null;
	private editTimers = new Map<string, number>();

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.register(onProChange(() => this.redrawAll()));
		this.settingTab = new InlineBlockEmbedsSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		const inline = new InlineEmbeds(this.app, this.manifest.id, () => effectiveOptions(this.settings, isPro()));
		this.inline = inline;
		this.registerHoverLinkSource(this.manifest.id, { display: 'Inline Block Embeds', defaultMod: false });
		this.registerEditorExtension(inlineEmbedExtension(inline));
		const reading = new ReadingView(inline);
		this.reading = reading;
		// Spans of a render with no component belong to this plugin, are dropped when they stay out of the document,
		// and unload with the plugin.
		this.addChild(reading.orphans);
		this.registerInterval(window.setInterval(() => reading.sweep(), ORPHAN_SWEEP_MS));
		this.registerMarkdownPostProcessor((el, ctx) => reading.process(el, ctx));

		// Rule 16: a change in a source note redraws its inline spans and the Live Preview widgets.
		// Only the spans and editors that show an embed of the changed note redraw (or that show a missing note).
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				inline.fileChanged(file.path);
				redrawViews(file.path);
			}),
		);
		// A span in Reading view whose block became a table, heading or other native kind: render that view again.
		inline.onNative = (el) => this.rerenderViewOf(el);
		// An open source note saves about 2 seconds after the last key. The editor text updates the spans sooner.
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => {
				const path = info.file?.path;
				if (!path || !inline.watches(path)) return;
				const old = this.editTimers.get(path);
				if (old !== undefined) window.clearTimeout(old);
				this.editTimers.set(
					path,
					window.setTimeout(() => {
						this.editTimers.delete(path);
						// Use the text only while an editor still shows this note. A closed or reloaded editor keeps no draft.
						const open = this.app.workspace.getLeavesOfType('markdown').some((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.editor === editor);
						if (open) this.inline?.editorChanged(path, editor.getValue());
						else this.inline?.fileChanged(path);
					}, EDIT_DELAY_MS),
				);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (!(file instanceof TFile)) return;
				inline.refreshFile(file.path);
				redrawViews(file.path);
			}),
		);
		// A folder rename sends one event for each file in it. The spans and editors redraw once, after the last one.
		const afterRename = debounce(
			() => {
				this.inline?.refreshFile(null);
				this.redrawEditors();
			},
			RENAME_DELAY_MS,
			true,
		);
		this.registerEvent(this.app.vault.on('rename', () => afterRename()));
		this.register(() => afterRename.cancel());

		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
			this.redrawAll();
		});
	}

	onunload(): void {
		for (const t of this.editTimers.values()) window.clearTimeout(t);
		this.editTimers.clear();
		this.inline?.clear();
		this.inline = null;
		resetPro();
		this.rerenderReading();
	}

	/** Draws the Live Preview widgets again in every open editor. */
	redrawEditors(): void {
		redrawViews();
	}

	/** Settings or Pro changed: redraw editors and Reading views. */
	redrawAll(): void {
		this.redrawEditors();
		this.rerenderReading();
		this.inline?.refreshFile(null);
	}

	private pendingRerender = new Set<MarkdownView>();

	/** Renders the Reading view that holds el again, once for a burst of changes. */
	private rerenderViewOf(el: HTMLElement): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== 'preview' || !view.containerEl.contains(el)) return;
			if (this.pendingRerender.has(view)) return;
			this.pendingRerender.add(view);
			window.setTimeout(() => {
				this.pendingRerender.delete(view);
				view.previewMode.rerender(true);
			}, RENAME_DELAY_MS);
		});
	}

	private rerenderReading(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === 'preview') view.previewMode.rerender(true);
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<InlineBlockEmbedsSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
