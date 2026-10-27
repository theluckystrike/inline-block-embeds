import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';
import type Plugin from '../../src/main';

const DRAW_ALL = 'Draw every block embed inline';
const STYLE = 'Inline style';
const LEAD_DRAW_ALL = 'Drawing every block embed inline is a Pro feature.';
const LEAD_STYLE = 'The soft background and none styles are Pro features.';
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';

interface Notice { text: string; buttons: number }
interface Row { disabled: boolean; checked: boolean | null; value: string | null }

/**
 * Text and Sponsor button count of each shown notice. Obsidian puts a notice in the document of activeWindow. While the
 * settings modal is open in this test, activeWindow is not the main window, so the test reads the document of activeWindow.
 */
async function notices(): Promise<Notice[]> {
	return browser.execute(() => [...(window as unknown as { activeWindow: Window }).activeWindow.document.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })));
}

/** Opens the settings tab of the plugin. Removes old notices. */
async function openTab(): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		for (const doc of new Set([document, (window as unknown as { activeWindow: Window }).activeWindow.document])) doc.querySelectorAll('.notice').forEach((n) => n.remove());
		const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(id);
	}, pluginId);
	await browser.waitUntil(async () => (await row(DRAW_ALL)) !== null, { timeout: 5000 }).catch(async () => {
		throw new Error(`The settings tab did not show the Pro rows: ${await tabDump()}`);
	});
}

/** The names and control classes of the rows in the open tab, for a failure message. */
async function tabDump(): Promise<string> {
	return browser.execute(() => {
		const root = (window as unknown as { app: { setting: { activeTab?: { containerEl: HTMLElement } } } }).app.setting.activeTab?.containerEl ?? document.body;
		return [...root.querySelectorAll('.setting-item')].map((el) => `${el.querySelector('.setting-item-name')?.textContent ?? '?'} [${el.querySelector('.setting-item-control')?.innerHTML.slice(0, 160) ?? ''}]`).join(' | ').slice(0, 1500);
	});
}

/** The state of the control in the settings row with this name, or null when the row is not shown. */
async function row(name: string): Promise<Row | null> {
	return browser.execute((label: string) => {
		const root = (window as unknown as { app: { setting: { activeTab?: { containerEl: HTMLElement } } } }).app.setting.activeTab?.containerEl ?? document.body;
		const item = [...root.querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-name')?.textContent?.trim() === label);
		if (!item) return null;
		const toggle = item.querySelector('.checkbox-container');
		const select = item.querySelector('select');
		const box = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (toggle || box) return { disabled: !!toggle?.classList.contains('is-disabled') || !!box?.disabled || item.classList.contains('is-disabled'), checked: toggle ? toggle.classList.contains('is-enabled') : !!box?.checked, value: null };
		if (select) return { disabled: select.disabled, checked: null, value: select.value };
		return null;
	}, name);
}

/** Clicks the toggle of the row, or selects a value in its dropdown, as a user does. */
async function useControl(name: string, value?: string): Promise<void> {
	await browser.execute((label: string, v: string | null) => {
		const root = (window as unknown as { app: { setting: { activeTab?: { containerEl: HTMLElement } } } }).app.setting.activeTab?.containerEl ?? document.body;
		const item = [...root.querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-name')?.textContent?.trim() === label);
		if (!item) throw new Error(`no row ${label}`);
		// A real click moves the focus into the row. Obsidian does not draw a focused control again, so the test focuses it too.
		if (v === null) { const box = (item.querySelector('.checkbox-container') ?? item.querySelector('input[type="checkbox"]')) as HTMLElement; box.focus(); box.click(); return; }
		const select = item.querySelector('select')!;
		select.focus();
		select.value = v;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	}, name, value ?? null);
}

/** Pro state, settings, notices and the toggle row, for a failure message. */
async function diagnose(): Promise<string> {
	const state = await browser.executeObsidian(({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!;
		const pro = p.pro as unknown as { isPro(): boolean; hasToken(): boolean; getState(): { status: string } } | null;
		return { isPro: pro?.isPro() ?? null, token: pro?.hasToken() ?? null, status: pro?.getState().status ?? null, settings: { ...p.settings } };
	}, pluginId);
	return JSON.stringify({ state, notices: await notices(), row: await row(DRAW_ALL) });
}

async function settings(): Promise<{ drawAll: boolean; style: string }> {
	return browser.executeObsidian(({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!;
		return { drawAll: p.settings.drawAll, style: p.settings.style };
	}, pluginId);
}

async function closeAndReset(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!;
		(app as unknown as { setting: { close(): void } }).setting.close();
		p.settings.drawAll = false;
		p.settings.style = 'underline';
		await p.saveData(p.settings);
		for (const doc of new Set([document, (window as unknown as { activeWindow: Window }).activeWindow.document])) doc.querySelectorAll('.notice').forEach((n) => n.remove());
	}, pluginId);
}

describe('Pro settings for a free user and a Pro user', () => {
	it('a free user who selects a Pro setting gets a Pro notice with a Sponsor button and no change', async () => {
		await browser.executeObsidian(({ app }, id) => {
			(app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!.pro?.signOut();
		}, pluginId);
		await browser.waitUntil(async () => !(await browser.executeObsidian(({ app }, id) => (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!.pro?.isPro() ?? false, pluginId)), { timeout: 5000, timeoutMsg: 'Pro is still on after sign out.' });
		await openTab();
		expect(await row(DRAW_ALL)).toEqual({ disabled: false, checked: false, value: null });
		expect(await row(STYLE)).toEqual({ disabled: false, checked: null, value: 'underline' });

		await useControl(DRAW_ALL);
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes(LEAD_DRAW_ALL)), { timeout: 5000 }).catch(async () => {
			throw new Error(`No Pro notice after the Draw every block embed inline toggle: ${await diagnose()}`);
		});
		const draw = (await notices()).find((n) => n.text.includes(LEAD_DRAW_ALL))!;
		expect(draw.text).toContain(`${LEAD_DRAW_ALL} ${PITCH}`);
		expect(draw.buttons).toBe(1);
		await browser.waitUntil(async () => (await row(DRAW_ALL))?.checked === false, { timeout: 5000, timeoutMsg: 'The toggle does not show the saved value (off) again.' });

		await useControl(STYLE, 'background');
		await browser.waitUntil(async () => (await notices()).some((n) => n.text.includes(LEAD_STYLE)), { timeout: 5000, timeoutMsg: 'No Pro notice after the Inline style dropdown.' });
		const style = (await notices()).find((n) => n.text.includes(LEAD_STYLE))!;
		expect(style.text).toContain(`${LEAD_STYLE} ${PITCH}`);
		expect(style.buttons).toBe(1);
		await browser.waitUntil(async () => (await row(STYLE))?.value === 'underline', { timeout: 5000, timeoutMsg: 'The dropdown does not show the saved value (underline) again.' });

		expect(await settings()).toEqual({ drawAll: false, style: 'underline' });
		const saved = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!;
			const data = (await p.loadData()) as { drawAll?: boolean; style?: string } | null;
			return { drawAll: data?.drawAll ?? false, style: data?.style ?? 'underline' };
		}, pluginId);
		expect(saved).toEqual({ drawAll: false, style: 'underline' });
		await closeAndReset();
	});

	it('a Pro user who selects the same settings changes them (simulated Sponsors check)', async () => {
		const pro = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!;
			if (!p.pro) throw new Error('Sponsors manager missing');
			const manager = p.pro as unknown as { opts: { http: unknown }; refreshNow(): Promise<unknown>; isPro(): boolean };
			manager.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'fixture-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
			app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
			await manager.refreshNow();
			return manager.isPro();
		}, pluginId);
		expect(pro).toBe(true);
		try {
			await openTab();
			await useControl(DRAW_ALL);
			await browser.waitUntil(async () => (await settings()).drawAll, { timeout: 5000, timeoutMsg: 'A Pro user could not turn on Draw every block embed inline.' });
			await useControl(STYLE, 'background');
			await browser.waitUntil(async () => (await settings()).style === 'background', { timeout: 5000, timeoutMsg: 'A Pro user could not select the soft background style.' });
			expect(await row(DRAW_ALL)).toEqual({ disabled: false, checked: true, value: null });
			expect(await row(STYLE)).toEqual({ disabled: false, checked: null, value: 'background' });
			expect((await notices()).filter((n) => n.text.includes('Pro feature')).length).toBe(0);
		} finally {
			await browser.executeObsidian(({ app }, id) => {
				(app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[id]!.pro?.signOut();
			}, pluginId);
			await closeAndReset();
		}
	});
});
