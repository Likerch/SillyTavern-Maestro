// @vitest-environment happy-dom
// M25 widgets: the pult section (values, inline edits through state.apply, recent changes, the roll picker and
// results, events) and the strip after DES's portrait bar (attached, re-attached when DES rebuilds or moves its bar,
// collapsible, gone with the setting and on dispose).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FiredEvent } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import {
    DES_WRAPPER_ID,
    MechanicStrip,
    STRIP_ID,
    WIDGETS_STYLE_ID,
    meter,
    stateSection,
} from '../../../src/features/mechanics/widgets';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { changeChat, createChecksEnv, faces, magicDef, socialDef, tick } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

let ctx: ChecksEnv;
let checks: MechanicChecks;
let container: HTMLElement;
let cleanup: void | Unsubscribe;
let strip: MechanicStrip | null = null;

afterEach(() => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    strip?.dispose();
    strip = null;
    checks?.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

async function setup(): Promise<void> {
    ctx = createChecksEnv();
    ctx.state.scene = { social: ['Kai', 'Elizabeth'], magic: ['Kai'] };
    checks = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng: faces(20, 14, 14, 14), saveMs: 0 });
    checks.install();
    await checks.ready();
}

async function render(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = stateSection(ctx.deps, ctx.defs, ctx.state, checks)(container);
}

const text = () => container.textContent ?? '';

function cardOf(title: string): HTMLElement {
    const card = [...container.querySelectorAll<HTMLElement>('.maestro-card')].find(
        (node) => node.querySelector('.maestro-card-title')?.textContent === title,
    );
    if (!card) throw new Error(`no card ${title}`);
    return card;
}

function attr(card: HTMLElement, holder: string, attribute: string): HTMLElement {
    const row = card.querySelector<HTMLElement>(`[data-holder="${holder}"] [data-attribute="${attribute}"]`);
    if (!row) throw new Error(`no ${holder}.${attribute}`);
    return row;
}

function change(node: HTMLInputElement | HTMLSelectElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('change'));
}

describe('the pult section', () => {
    it('shows every mechanic on with the holders in the scene and their visible values', async () => {
        await setup();
        ctx.state.set('magic', 'Kai', 'mana', 12);
        ctx.state.set('magic', 'Kai', 'schools', ['fire']);
        await render();
        expect(container.querySelector('.maestro-section-title')?.textContent).toBe('Mechanics in the scene');
        const social = cardOf('Общение');
        expect([...social.querySelectorAll('[data-holder]')].map((node) => node.getAttribute('data-holder'))).toEqual([
            'Kai',
            'Elizabeth',
        ]);
        const magic = cardOf('Магия');
        const mana = attr(magic, 'Kai', 'mana');
        expect(mana.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('12');
        expect(mana.querySelector<HTMLElement>('.maestro-m25-meter-fill')?.style.width).toBe('40%');
        expect(mana.querySelector('input')?.value).toBe('12');
        expect(attr(magic, 'Kai', 'schools').querySelector('.maestro-m25-chip')?.textContent).toContain('fire');
        expect(attr(magic, 'Kai', 'rank').textContent).toContain('novice (1 of 3)');
        expect(magic.querySelector('[data-attribute="secret"]')).toBeNull();
        expect(text()).toContain('Recent changes');
        expect(text()).toContain('No changes yet.');
    });

    it('edits values inline as the user’s change', async () => {
        await setup();
        ctx.state.set('magic', 'Kai', 'schools', ['fire']);
        ctx.state.set('social', 'Elizabeth', 'charisma', 10);
        await render();
        const magic = cardOf('Магия');
        const social = cardOf('Общение');
        change(attr(social, 'Elizabeth', 'charisma').querySelector('input')!, '15');
        change(attr(magic, 'Kai', 'rank').querySelector('select')!, 'master');
        attr(magic, 'Kai', 'schools').querySelector<HTMLButtonElement>('.maestro-m25-chip button')!.click();
        await tick();
        change(attr(magic, 'Kai', 'schools').querySelector('select')!, 'water');
        change(attr(magic, 'Kai', 'element').querySelector('select')!, 'ice');
        change(attr(magic, 'Kai', 'element').querySelector('select')!, '');
        change(attr(magic, 'Kai', 'oath').querySelector('input')!, '  never lie  ');
        await tick();
        expect(
            ctx.state.applied.map((batch) => batch.map(({ holder, attribute, value }) => [holder, attribute, value])),
        ).toEqual([
            [['Elizabeth', 'charisma', 15]],
            [['Kai', 'rank', 'master']],
            [['Kai', 'schools', []]],
            [['Kai', 'schools', ['fire', 'water']]],
            [['Kai', 'element', ['ice']]],
            [['Kai', 'element', []]],
            [['Kai', 'oath', 'never lie']],
        ]);
        expect(ctx.state.applied.flat().every((item) => item.source === 'user' && item.messageIndex === -1)).toBe(true);
        await tick(150);
        const recent = cardOf('Общение').querySelector('.maestro-m25-change');
        expect(recent?.textContent).toContain('Elizabeth: Обаяние 10 → 15');
        expect(recent?.textContent).toContain('by hand');
        expect(cardOf('Магия').querySelectorAll('.maestro-m25-change')).toHaveLength(5);
    });

    it('reports a failed edit', async () => {
        await setup();
        ctx.state.failApply = true;
        await render();
        change(attr(cardOf('Общение'), 'Kai', 'charisma').querySelector('input')!, '12');
        await tick();
        expect(ctx.notices.at(-1)?.text).toBe('The value was not changed: state is busy');
    });

    it('rolls a check from the picker and lists the recent rolls', async () => {
        await setup();
        await render();
        const social = cardOf('Общение');
        const [checkSelect, holderSelect] = [...social.querySelectorAll<HTMLSelectElement>('.maestro-m25-roll select')];
        const difficulty = social.querySelector<HTMLInputElement>('.maestro-m25-difficulty')!;
        expect(difficulty.placeholder).toBe('15');
        expect(social.textContent).toContain('Default difficulty: 15');
        change(holderSelect!, 'Elizabeth');
        difficulty.value = '5';
        difficulty.dispatchEvent(new Event('input'));
        social.querySelector<HTMLButtonElement>('.maestro-m25-roll-button')!.click();
        await tick(150);
        expect(checks.checks()[0]).toMatchObject({ holder: 'Elizabeth', target: 5, by: 'user' });
        expect(ctx.notices.at(-1)).toEqual({ text: 'Rolled: Убеждение (Elizabeth): 14 vs 5 — success', urgent: true });
        const fresh = cardOf('Общение');
        expect(fresh.querySelector('.maestro-m25-result')?.textContent).toContain('Убеждение (Elizabeth): 14 vs 5');
        expect(fresh.querySelector('.maestro-m25-result')?.textContent).toContain('waits for the next reply');
        // The choice survives the redraw.
        expect(fresh.querySelectorAll<HTMLSelectElement>('.maestro-m25-roll select')[1]?.value).toBe('Elizabeth');

        change(fresh.querySelectorAll<HTMLSelectElement>('.maestro-m25-roll select')[0]!, 'stealth');
        expect(fresh.querySelector<HTMLInputElement>('.maestro-m25-difficulty')?.disabled).toBe(true);
        expect(fresh.textContent).toContain('Roll-under: the target is the value itself');
        void checkSelect;
    });

    it('a failed roll is reported', async () => {
        await setup();
        await render();
        ctx.state.scene = { social: [], magic: ['Kai'] };
        const social = cardOf('Общение');
        change(social.querySelectorAll<HTMLSelectElement>('.maestro-m25-roll select')[0]!, 'stealth');
        social.querySelector<HTMLButtonElement>('.maestro-m25-roll-button')!.click();
        await tick();
        expect(ctx.notices.at(-1)).toEqual({
            text: 'Nothing to roll against: no value of “Скрытность” for Kai.',
            urgent: true,
        });
    });

    it('shows fired events, waiting ones marked', async () => {
        await setup();
        const fired: FiredEvent = {
            mechanicId: 'magic',
            holder: 'Kai',
            attribute: 'mana',
            eventId: 'empty',
            text: 'Kai is out of mana.',
            messageIndex: 3,
            at: 9,
        };
        ctx.state.fired = [fired];
        ctx.state.pending = [fired];
        await render();
        const events = cardOf('Магия').querySelector('.maestro-m25-events');
        expect(events?.textContent).toContain('Kai is out of mana.');
        expect(events?.textContent).toContain('waits for the next reply');
        expect(cardOf('Общение').querySelector('.maestro-m25-events')).toBeNull();
    });

    it('explains an empty section and follows changes until cleaned up', async () => {
        await setup();
        ctx.defs.defs = [];
        await render();
        expect(text()).toContain('No mechanics are on in this chat.');
        ctx.defs.defs = [socialDef(), magicDef()];
        ctx.state.scene = {};
        ctx.defs.emit();
        await tick(150);
        expect(text()).toContain('Nobody with these values is in the scene.');
        await changeChat(ctx, undefined);
        await tick(150);
        expect(text()).toContain('No chat is open.');
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        await changeChat(ctx, 'chat-1');
        ctx.state.emit();
        await tick(150);
        expect(text()).toContain('No chat is open.');
    });
});

describe('the strip', () => {
    function desBar(parent: HTMLElement = document.body): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.id = DES_WRAPPER_ID;
        wrapper.appendChild(document.createElement('div')).id = 'dooms-pb-scroll';
        parent.appendChild(wrapper);
        return wrapper;
    }

    function formSheld(): HTMLElement {
        const form = document.createElement('div');
        form.id = 'form_sheld';
        const send = document.createElement('div');
        send.id = 'send_form';
        form.appendChild(send);
        document.body.appendChild(form);
        return form;
    }

    async function install(): Promise<MechanicStrip> {
        strip = new MechanicStrip(ctx.deps, ctx.defs, ctx.state);
        strip.install();
        return strip;
    }

    it('sits right after DES’s wrapper, outside it, with bars of the characters in the scene', async () => {
        await setup();
        const form = formSheld();
        const wrapper = desBar(form);
        form.appendChild(form.querySelector('#send_form')!);
        ctx.state.set('magic', 'Kai', 'mana', 12);
        await install();
        const node = document.getElementById(STRIP_ID);
        expect(node).not.toBeNull();
        expect(wrapper.nextElementSibling).toBe(node);
        expect(wrapper.contains(node)).toBe(false);
        expect(strip!.element()).toBe(node);
        expect(ctx.env.ui.styles.has(WIDGETS_STYLE_ID)).toBe(true);
        const kai = node!.querySelector('[data-holder="Kai"]');
        expect(kai?.textContent).toContain('Мана');
        expect(kai?.textContent).toContain('12/30');
        expect(kai?.textContent).toContain('Обаяние');
        expect(kai?.querySelectorAll('[role="meter"]').length).toBe(3);
        expect(node!.querySelector('[data-holder="Elizabeth"]')?.textContent).toContain('10/20');
        expect(node!.hidden).toBe(false);

        ctx.state.set('magic', 'Kai', 'mana', 3);
        ctx.state.emit();
        await tick(80);
        expect(node!.querySelector('[data-holder="Kai"]')?.textContent).toContain('3/30');
    });

    it('comes back when DES rebuilds or moves its bar', async () => {
        await setup();
        const form = formSheld();
        const first = desBar(form);
        await install();
        // Rebuilt in place.
        first.remove();
        const second = desBar(form);
        await tick();
        expect(second.nextElementSibling?.id).toBe(STRIP_ID);
        // Moved to the top of the page.
        const top = document.createElement('div');
        document.body.prepend(top);
        second.remove();
        const third = desBar(top);
        await tick();
        expect(third.nextElementSibling?.id).toBe(STRIP_ID);
        expect(document.querySelectorAll(`#${STRIP_ID}`)).toHaveLength(1);
    });

    it('waits for a bar that is not there yet', async () => {
        await setup();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        await install();
        expect(strip!.element()).toBeNull();
        const wrapper = desBar();
        vi.advanceTimersByTime(2000);
        expect(wrapper.nextElementSibling?.id).toBe(STRIP_ID);
    });

    it('collapses to one line and back', async () => {
        await setup();
        desBar();
        await install();
        const node = strip!.element()!;
        const toggle = node.querySelector<HTMLButtonElement>('.maestro-m25-strip-toggle')!;
        const collapsed = node.classList.contains('maestro-m25-strip-collapsed');
        toggle.click();
        expect(node.classList.contains('maestro-m25-strip-collapsed')).toBe(!collapsed);
        expect(node.querySelector('.maestro-m25-strip-toggle')?.getAttribute('aria-expanded')).toBe(
            collapsed ? 'true' : 'false',
        );
    });

    it('is hidden with nothing to show and follows the setting and the chat', async () => {
        await setup();
        desBar();
        ctx.defs.defs = [
            { ...magicDef(), holders: { kind: 'world' } },
            { ...socialDef(), attributes: socialDef().attributes.map((item) => ({ ...item, visible: false })) },
        ];
        await install();
        expect(strip!.element()?.hidden).toBe(true);
        ctx.defs.defs = [magicDef()];
        ctx.defs.emit();
        await tick(80);
        expect(strip!.element()?.hidden).toBe(false);

        ctx.settings.strip = false;
        ctx.env.settings.notify('modules.mechanics.strip');
        expect(document.getElementById(STRIP_ID)).toBeNull();
        ctx.settings.strip = true;
        ctx.env.settings.notify('modules.mechanics.strip');
        expect(document.getElementById(STRIP_ID)).not.toBeNull();

        await changeChat(ctx, undefined);
        expect(document.getElementById(STRIP_ID)).toBeNull();
    });

    it('leaves nothing behind when disposed', async () => {
        await setup();
        const form = formSheld();
        const wrapper = desBar(form);
        await install();
        strip!.dispose();
        strip!.dispose();
        expect(document.getElementById(STRIP_ID)).toBeNull();
        expect(ctx.env.ui.styles.has(WIDGETS_STYLE_ID)).toBe(false);
        wrapper.remove();
        desBar(form);
        await tick();
        expect(document.getElementById(STRIP_ID)).toBeNull();
        strip = null;
    });

    it('meters clamp their share', () => {
        expect(meter(50, 0, 10, 'x').querySelector<HTMLElement>('.maestro-m25-meter-fill')?.style.width).toBe('100%');
        expect(meter(-5, 0, 10, 'x').querySelector<HTMLElement>('.maestro-m25-meter-fill')?.style.width).toBe('0%');
    });
});
