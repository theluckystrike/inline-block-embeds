import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, SettingTab } from 'obsidian-test-mocks/obsidian';
import InlineBlockEmbedsPlugin from '../src/main';
import { InlineBlockEmbedsSettingTab, PRO_LEADS } from '../src/settings';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

/** A tab for a plugin that is not loaded. redrawAll is a spy, so the test sees each redraw. */
function tab(): { t: InlineBlockEmbedsSettingTab; plugin: InlineBlockEmbedsPlugin; redraw: ReturnType<typeof vi.fn> } {
	const app = App.createConfigured__({ files: {} });
	const plugin = new InlineBlockEmbedsPlugin(app as never, manifest as never);
	const redraw = vi.fn();
	plugin.redrawAll = redraw;
	return { t: new InlineBlockEmbedsSettingTab(app as never, plugin), plugin, redraw };
}

describe('Pro settings in the settings tab', () => {
	afterEach(() => {
		resetPro();
		vi.restoreAllMocks();
	});

	it('names the Pro feature in each lead', () => {
		expect(PRO_LEADS).toEqual({ drawAll: 'Drawing every block embed inline is a Pro feature.', style: 'The soft background and none styles are Pro features.' });
	});

	it('a free user who selects a Pro setting does not save it', async () => {
		const { t, plugin, redraw } = tab();
		const save = vi.spyOn(SettingTab.prototype, 'setControlValue');
		await t.setControlValue('drawAll', true);
		await t.setControlValue('style', 'background');
		expect(save).not.toHaveBeenCalled();
		expect(redraw).not.toHaveBeenCalled();
		expect(plugin.settings).toEqual({ drawAll: false, style: 'underline' });
	});

	it('a free user sees the values in effect, and a refused select moves the focus out of the tab', async () => {
		const { t, plugin } = tab();
		const update = vi.spyOn(t, 'update').mockImplementation(() => undefined);
		plugin.settings = { drawAll: true, style: 'background' };
		// The rows show what is in effect for a free user. The stored choice stays for the time that Pro comes back.
		expect(t.getControlValue('drawAll')).toBe(false);
		expect(t.getControlValue('style')).toBe('underline');
		// Obsidian does not draw a control again while it has the focus, so the refusal moves the focus out first.
		activeDocument.body.appendChild(t.containerEl);
		const select = t.containerEl.createEl('select');
		select.focus();
		expect(activeDocument.activeElement).toBe(select);
		await t.setControlValue('style', 'none');
		expect(activeDocument.activeElement).not.toBe(select);
		expect(update).toHaveBeenCalledTimes(1);
		expect(plugin.settings).toEqual({ drawAll: true, style: 'background' });
		t.containerEl.remove();
	});

	it('a Pro user sees the stored values', () => {
		bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
		const { t } = tab();
		const base = vi.spyOn(SettingTab.prototype as unknown as { getControlValue(key: string): unknown }, 'getControlValue').mockReturnValue('none');
		expect(t.getControlValue('style')).toBe('none');
		expect(base).toHaveBeenCalledWith('style');
	});

	it('a Pro user who selects a Pro setting saves it, as before', async () => {
		bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
		const { t, redraw } = tab();
		const save = vi.spyOn(SettingTab.prototype, 'setControlValue');
		await t.setControlValue('drawAll', true);
		await t.setControlValue('style', 'background');
		expect(save.mock.calls).toEqual([['drawAll', true], ['style', 'background']]);
		expect(redraw).toHaveBeenCalledTimes(2);
	});
});
