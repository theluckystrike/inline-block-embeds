import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro, proNotice } from './pro';
import type { EmbedStyle, Options } from './render';
import type InlineBlockEmbedsPlugin from './main';
import { helloSettingItems } from './hello/settings';

export interface InlineBlockEmbedsSettings {
	/** Pro: also draw a block embed that is alone on its line inline (rule 3). */
	drawAll: boolean;
	/** Pro: the look of the inline text. Free uses the dotted underline. */
	style: EmbedStyle;
}

export const STYLES: Record<EmbedStyle, string> = {
	underline: 'Dotted underline',
	background: 'Soft background',
	none: 'None',
};

export const DEFAULT_SETTINGS: InlineBlockEmbedsSettings = {
	drawAll: false,
	style: 'underline',
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<InlineBlockEmbedsSettings> | null | undefined): InlineBlockEmbedsSettings {
	const s = saved ?? {};
	return {
		drawAll: typeof s.drawAll === 'boolean' ? s.drawAll : DEFAULT_SETTINGS.drawAll,
		style: typeof s.style === 'string' && s.style in STYLES ? s.style : DEFAULT_SETTINGS.style,
	};
}

/** The settings in effect. Without Pro: paragraphs only, no "draw every embed", the underline style. */
export function effectiveOptions(settings: InlineBlockEmbedsSettings, pro: boolean): Options {
	return {
		drawAll: pro && settings.drawAll,
		listItems: pro,
		style: pro ? settings.style : 'underline',
	};
}

/** First sentences of the Pro notices. A free user who selects a Pro setting gets the notice; the value is not saved. */
export const PRO_LEADS: Partial<Record<keyof InlineBlockEmbedsSettings, string>> = {
	drawAll: 'Drawing every block embed inline is a Pro feature.',
	style: 'The soft background and none styles are Pro features.',
};

export class InlineBlockEmbedsSettingTab extends PluginSettingTab {
	plugin: InlineBlockEmbedsPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: InlineBlockEmbedsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Draw every block embed inline',
				desc: 'Pro. Also draw a block embed that is alone on its line as inline text. When this is off, only an embed with other text on its line is inline.',
				control: { type: 'toggle', key: 'drawAll', defaultValue: DEFAULT_SETTINGS.drawAll },
			},
			{
				name: 'Inline style',
				desc: 'Pro. How the inline text looks. The free version uses the dotted underline.',
				control: { type: 'dropdown', key: 'style', defaultValue: DEFAULT_SETTINGS.style, options: { ...STYLES } },
			},
			{
				name: 'Pro features',
				desc: isPro()
					? 'Pro is on: list item blocks are inline, and the two settings above work.'
					: 'Free version: paragraph blocks inside a sentence are inline, with a hover preview and Ctrl or Cmd click to open the source. Pro adds list item blocks, the setting to draw every block embed inline, and two more styles.',
			},
			// The Pro group comes after the settings of the plugin.
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}

	getControlValue(key: string): unknown {
		// A free user sees the values in effect. The stored choice stays for the time that Pro comes back.
		if ((key === 'drawAll' || key === 'style') && !isPro()) return effectiveOptions(this.plugin.settings, false)[key];
		return super.getControlValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const lead = PRO_LEADS[key as keyof InlineBlockEmbedsSettings];
		if (lead && !isPro()) {
			// Free users can select the Pro settings: the notice shows what Pro adds and how to get it. Nothing is saved.
			proNotice(lead);
			// Obsidian does not draw a control again while it has the focus. Move the focus out, then draw the tab
			// again, so the row shows the value in effect.
			const active = this.containerEl.ownerDocument.activeElement as HTMLElement | null;
			if (active && this.containerEl.contains(active)) active.blur();
			this.update();
			return;
		}
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
		this.plugin.redrawAll();
	}
}
