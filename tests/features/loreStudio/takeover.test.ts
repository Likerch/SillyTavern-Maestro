// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createLoreStudioModule, loreStudioRuntime } from '../../../src/features/loreStudio/module';
import { defaultStudioSettings } from '../../../src/features/loreStudio/studio';
import { ButtonTakeover, DES_NAMESPACE } from '../../../src/features/loreStudio/takeover';
import { buildWiDrawer, installFakeJQuery, removeFakeJQuery } from './fake-jquery';
import type { FakeJQuery } from './fake-jquery';
import { createStand, resetDom, settle } from './stand';
import type { Stand } from './stand';

let s: Stand;
let $: FakeJQuery;
let calls: string[];
type Handler = (this: Element, event: Event) => unknown;
let st: Mock<Handler>;
let des: Mock<Handler>;
let open: Mock<(book?: string) => void>;
let takeover: ButtonTakeover;
let dom: ReturnType<typeof buildWiDrawer>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
    resetDom();
    s = createStand();
    s.addBook('Anna', {});
    s.addBook('World', {});
    $ = installFakeJQuery();
    dom = buildWiDrawer(['Anna', 'World']);
    calls = [];
    st = vi.fn<Handler>(function (this: Element) {
        calls.push(`st:${this.className}`);
        dom.drawer.classList.toggle('openDrawer');
    });
    des = vi.fn<Handler>((event: Event) => {
        calls.push('des');
        event.stopImmediatePropagation();
    });
    s.script.doNavbarIconClick = st;
    // ST binds its handler to every .drawer-toggle first (script.js:12150); DES adds its own later.
    $(dom.toggle).on('click', st);
    $(dom.toggle).on(`click.${DES_NAMESPACE}`, des);
    open = vi.fn<(book?: string) => void>();
    takeover = new ButtonTakeover({ app: s.app, log: s.app.log, open });
});

afterEach(() => {
    takeover.restore();
    removeFakeJQuery();
});

describe('button takeover', () => {
    it('starts from ST then DES', () => {
        dom.icon.click();
        expect(calls).toEqual(['st:drawer-toggle drawer-header', 'des']);
    });

    it('unbinds ST and DES and opens the studio instead', async () => {
        expect(await takeover.install()).toBe(true);
        expect(takeover.active()).toBe(true);
        dom.icon.click();
        expect(calls).toEqual([]);
        await tick();
        expect(open).toHaveBeenCalledWith(undefined);
        expect(await takeover.install()).toBe(true);
    });

    it('follows deep links of openWorldInfoEditor (click, then the editor select changes)', async () => {
        await takeover.install();
        // openWorldInfoEditor: $('#WIDrawerIcon').trigger('click'); $('#world_editor_select').val(i).trigger('change').
        $('#WIDrawerIcon').trigger('click');
        $('#world_editor_select').val(1).trigger('change');
        await tick();
        expect(open).toHaveBeenCalledWith('World');
        // A change without a click (ST deleting or importing a book) is not a deep link.
        open.mockClear();
        $('#world_editor_select').val(0).trigger('change');
        await tick();
        expect(open).not.toHaveBeenCalled();
    });

    it('lets the click close the classic drawer when it is open (Escape path)', async () => {
        await takeover.install();
        dom.drawer.classList.add('openDrawer');
        dom.icon.click();
        await tick();
        expect(st).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
    });

    it('restores ST and DES in their order', async () => {
        await takeover.install();
        takeover.restore();
        expect(takeover.active()).toBe(false);
        dom.icon.click();
        await tick();
        expect(calls).toEqual(['st:drawer-toggle drawer-header', 'des']);
        expect(open).not.toHaveBeenCalled();
        takeover.restore();
    });

    it('does not duplicate DES handlers that DES re-bound meanwhile', async () => {
        await takeover.install();
        $(dom.toggle).on(`click.${DES_NAMESPACE}`, des);
        // Ours was bound first and stops the click before DES.
        dom.icon.click();
        await tick();
        expect(des).not.toHaveBeenCalled();
        takeover.restore();
        const events = $._data(dom.toggle, 'events') as { click: { namespace: string }[] };
        expect(events.click.filter((item) => item.namespace === DES_NAMESPACE)).toHaveLength(1);
    });

    it('opens the classic editor on a book without treating it as a deep link', async () => {
        await takeover.install();
        expect(await takeover.openClassic('World')).toBe(true);
        expect(st).toHaveBeenCalledTimes(1);
        expect(dom.editor.value).toBe('1');
        await tick();
        expect(open).not.toHaveBeenCalled();
    });

    it('cancels an install that a restore overtook', async () => {
        const pending = takeover.install();
        takeover.restore();
        expect(await pending).toBe(false);
        expect(takeover.active()).toBe(false);
        dom.icon.click();
        expect(calls).toEqual(['st:drawer-toggle drawer-header', 'des']);
    });

    it('gives up without jQuery, the toggle or ST’s handler', async () => {
        removeFakeJQuery();
        expect(await takeover.install()).toBe(false);
        installFakeJQuery();
        s.script.doNavbarIconClick = undefined;
        expect(await takeover.install()).toBe(false);
        expect(await new ButtonTakeover({ app: s.app, log: s.app.log, open }).openClassic()).toBe(false);
    });
});

describe('module lifecycle', () => {
    it('takes over when the setting is on and restores everything on dispose', async () => {
        const module = createLoreStudioModule(null);
        const disposers: (() => void | Promise<void>)[] = [];
        const settings = { ...defaultStudioSettings(), takeoverButton: true };
        await module.init({ app: s.app, settings, log: s.app.log, own: (dispose) => disposers.push(dispose) });
        await settle(20);
        expect(s.apis.get('loreStore')).toBeDefined();
        expect(loreStudioRuntime()?.takeover.active()).toBe(true);
        dom.icon.click();
        await tick();
        expect(calls).toEqual([]);
        expect(document.querySelector('.maestro-m23')).not.toBeNull();
        loreStudioRuntime()?.studio.close();
        for (const dispose of disposers.reverse()) await dispose();
        expect(s.apis.get('loreStore')).toBeUndefined();
        expect(loreStudioRuntime()).toBeNull();
        dom.icon.click();
        expect(calls).toEqual(['st:drawer-toggle drawer-header', 'des']);
    });
});
