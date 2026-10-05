// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Dock, MAX_ADOPTIONS } from '../../../src/features/dock/dock';
import type { DockEvent, DockTarget } from '../../../src/features/dock/dock';
import { silentLog } from '../../helpers/ui-env';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BLOCK: DockTarget = { id: 'ck', selectors: ['#ck_block'] };
const OTHER: DockTarget = { id: 'qvink', selectors: ['#missing_block', '#qvink_block'] };

let dock: Dock;
let events: { id: string; event: DockEvent }[];
let slot: HTMLElement;

function page(): void {
    document.body.innerHTML = `
        <div id="extensions_settings">
            <div id="left_a"></div>
        </div>
        <div id="extensions_settings2">
            <div id="first"></div>
            <div id="ck_block" class="inline-drawer"><input id="ck_input"></div>
            <div id="qvink_block"><span>q</span></div>
            <div id="last"></div>
        </div>
        <div id="popup"><div id="slot"></div><div id="slot2"></div></div>`;
    slot = document.getElementById('slot')!;
}

const childIds = (selector: string) =>
    [...document.querySelector(selector)!.childNodes]
        .filter((node) => node.nodeType !== Node.TEXT_NODE)
        .map((node) => (node.nodeType === Node.COMMENT_NODE ? '#comment' : (node as HTMLElement).id));

beforeEach(() => {
    page();
    events = [];
    dock = new Dock({ log: silentLog, onEvent: (id, event) => events.push({ id, event }) });
});

describe('Dock', () => {
    it('moves the real node (no clone) and returns it to the exact position', () => {
        const node = document.getElementById('ck_block')!;
        const input = document.getElementById('ck_input') as HTMLInputElement;
        input.value = 'typed';
        expect(dock.dock(BLOCK, slot)).toBe('docked');
        expect(slot.firstElementChild).toBe(node);
        expect(document.querySelectorAll('#ck_block')).toHaveLength(1);
        expect(childIds('#extensions_settings2')).toEqual(['first', '#comment', 'qvink_block', 'last']);
        expect(dock.isDocked('ck')).toBe(true);
        expect(dock.dock(BLOCK, slot)).toBe('already');
        expect(dock.undock('ck')).toBe(true);
        expect(childIds('#extensions_settings2')).toEqual(['first', 'ck_block', 'qvink_block', 'last']);
        expect(document.getElementById('ck_block')).toBe(node);
        expect((document.getElementById('ck_input') as HTMLInputElement).value).toBe('typed');
        expect(dock.ids()).toEqual([]);
    });

    it('two neighbouring blocks return to their own places in any order', () => {
        dock.dock(BLOCK, slot);
        dock.dock(OTHER, document.getElementById('slot2')!);
        expect(childIds('#extensions_settings2')).toEqual(['first', '#comment', '#comment', 'last']);
        dock.undock('ck');
        dock.undock('qvink');
        expect(childIds('#extensions_settings2')).toEqual(['first', 'ck_block', 'qvink_block', 'last']);
        dock.dock(BLOCK, slot);
        dock.dock(OTHER, document.getElementById('slot2')!);
        dock.undockAll();
        expect(childIds('#extensions_settings2')).toEqual(['first', 'ck_block', 'qvink_block', 'last']);
    });

    it('reports a missing node and tries the selectors in order', () => {
        expect(dock.dock({ id: 'x', selectors: ['#nope'] }, slot)).toBe('missing');
        expect(dock.dock(OTHER, slot)).toBe('docked');
        expect(slot.firstElementChild?.id).toBe('qvink_block');
    });

    it('falls back to the remembered parent and next sibling when the placeholder is gone', () => {
        dock.dock(BLOCK, slot);
        const column = document.getElementById('extensions_settings2')!;
        for (const node of [...column.childNodes]) if (node.nodeType === Node.COMMENT_NODE) node.remove();
        dock.undock('ck');
        expect(childIds('#extensions_settings2')).toEqual(['first', 'ck_block', 'qvink_block', 'last']);
    });

    it("puts the node into ST's extensions column when its parent is gone", () => {
        document
            .getElementById('extensions_settings2')!
            .insertAdjacentHTML('beforeend', '<div id="wrapper"><div id="ck_block2"></div></div>');
        const target: DockTarget = { id: 'nested', selectors: ['#ck_block2'] };
        dock.dock(target, slot);
        document.getElementById('wrapper')!.remove();
        dock.undock('nested');
        expect(document.querySelector('#extensions_settings2 > #ck_block2')).not.toBeNull();
    });

    it("uses ST's first column when the remembered one is gone too", () => {
        dock.dock(BLOCK, slot);
        document.getElementById('extensions_settings2')!.remove();
        dock.undock('ck');
        expect(document.querySelector('#extensions_settings > #ck_block')).not.toBeNull();
    });

    it('honours a target fallback (or none)', () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div id="sheld"><div id="bar_parent"><div id="bar"></div></div><div id="send_form"></div></div>',
        );
        const target: DockTarget = {
            id: 'bar',
            selectors: ['#bar'],
            fallback: (doc) => {
                const form = doc.getElementById('send_form');
                return form?.parentNode ? { parent: form.parentNode, before: form } : null;
            },
        };
        dock.dock(target, slot);
        document.getElementById('bar_parent')!.remove();
        dock.undock('bar');
        expect(document.getElementById('send_form')?.previousElementSibling?.id).toBe('bar');
        dock.dock(target, slot);
        document.getElementById('sheld')!.remove();
        expect(dock.undock('bar')).toBe(false);
        expect(document.getElementById('bar')).toBeNull();
    });

    it('adopts a block the neighbour re-rendered at home and drops the stale one (no duplicate ids)', async () => {
        const stale = document.getElementById('ck_block')!;
        dock.dock(BLOCK, slot);
        const fresh = document.createElement('div');
        fresh.id = 'ck_block';
        document.getElementById('extensions_settings2')!.appendChild(fresh);
        await flush();
        expect(events).toEqual([{ id: 'ck', event: 'adopted' }]);
        expect(slot.firstElementChild).toBe(fresh);
        expect(stale.isConnected).toBe(false);
        expect(document.querySelectorAll('#ck_block')).toHaveLength(1);
        dock.undock('ck');
        expect(childIds('#extensions_settings2')).toEqual(['first', 'qvink_block', 'last', 'ck_block']);
    });

    it('gives up after repeated re-renders and leaves the fresh block home', async () => {
        dock.dock(BLOCK, slot);
        const column = document.getElementById('extensions_settings2')!;
        for (let round = 0; round <= MAX_ADOPTIONS; round++) {
            const fresh = document.createElement('div');
            fresh.id = 'ck_block';
            column.appendChild(fresh);
            await flush();
        }
        expect(events.map((entry) => entry.event)).toEqual([
            ...Array.from({ length: MAX_ADOPTIONS }, () => 'adopted'),
            'redrawn',
        ]);
        expect(dock.ids()).toEqual([]);
        expect(slot.children).toHaveLength(0);
        expect(document.querySelectorAll('#ck_block')).toHaveLength(1);
        expect(document.querySelector('#extensions_settings2 > #ck_block')).not.toBeNull();
        expect([...column.childNodes].some((node) => node.nodeType === Node.COMMENT_NODE)).toBe(false);
    });

    it('a re-render right before closing (observer not run yet) does not bring the stale block back', () => {
        const stale = document.getElementById('ck_block')!;
        dock.dock(BLOCK, slot);
        const fresh = document.createElement('div');
        fresh.id = 'ck_block';
        document.getElementById('first')!.after(fresh);
        dock.undock('ck');
        expect(stale.isConnected).toBe(false);
        expect(document.querySelectorAll('#ck_block')).toHaveLength(1);
        expect(
            [...document.getElementById('extensions_settings2')!.childNodes].some((node) => node.nodeType === 8),
        ).toBe(false);
    });

    it('leaves a node the owner moved back by itself and forgets it', async () => {
        dock.dock(BLOCK, slot);
        const node = document.getElementById('ck_block')!;
        document.getElementById('extensions_settings')!.appendChild(node);
        await flush();
        expect(events).toEqual([{ id: 'ck', event: 'taken' }]);
        expect(dock.ids()).toEqual([]);
        dock.undock('ck');
        expect(document.querySelector('#extensions_settings > #ck_block')).toBe(node);
        expect(childIds('#extensions_settings2')).toEqual(['first', 'qvink_block', 'last']);
    });

    it('does not bring back a node the owner moved elsewhere (e.g. its own pop-out)', () => {
        dock.dock(BLOCK, slot);
        const node = document.getElementById('ck_block')!;
        const popout = document.createElement('div');
        document.body.appendChild(popout);
        popout.appendChild(node);
        expect(dock.undock('ck')).toBe(false);
        expect(node.parentElement).toBe(popout);
        expect(childIds('#extensions_settings2')).toEqual(['first', 'qvink_block', 'last']);
    });

    it('re-docking into another slot returns the node first', () => {
        dock.dock(BLOCK, slot);
        const other = document.getElementById('slot2')!;
        expect(dock.dock(BLOCK, other)).toBe('docked');
        expect(other.firstElementChild?.id).toBe('ck_block');
        expect(childIds('#extensions_settings2')).toEqual(['first', '#comment', 'qvink_block', 'last']);
        dock.undockAll();
        expect(childIds('#extensions_settings2')).toEqual(['first', 'ck_block', 'qvink_block', 'last']);
    });
});
