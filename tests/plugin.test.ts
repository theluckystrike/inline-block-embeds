import { describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import InlineBlockEmbedsPlugin from '../src/main';
import { DEFAULT_SETTINGS, effectiveOptions, normalizeSettings } from '../src/settings';
import manifest from '../manifest.json';

describe('InlineBlockEmbedsPlugin', () => {
	it('loads with default settings against an in-memory vault', async () => {
		const app = App.createConfigured__({ files: { 'notes/a.md': '# Hello world' } });
		const plugin = new InlineBlockEmbedsPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(DEFAULT_SETTINGS.drawAll).toBe(false);
	});

	it('repairs bad saved settings', () => {
		expect(normalizeSettings({ drawAll: 'yes' as never, style: 'loud' as never })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ style: 'background' }).style).toBe('background');
	});

	it('keeps the Pro options off without Pro', () => {
		const saved = { drawAll: true, style: 'none' as const };
		expect(effectiveOptions(saved, false)).toEqual({ drawAll: false, listItems: false, style: 'underline' });
		expect(effectiveOptions(saved, true)).toEqual({ drawAll: true, listItems: true, style: 'none' });
	});
});
