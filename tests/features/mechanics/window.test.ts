// @vitest-environment happy-dom
// M25 «Механики» window (plan-2 §6.А п.5): values with hidden ones behind «Подсмотреть» and «Раскрыть», HUD pins,
// resets that ask first, rolls with advantage and against another character; the fight; conditions and items with
// trade; the history with undo of a change and of a roll and hidden rolls only as a count; the dossier's section.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { combatSection, logSection, peopleSection } from '../../../src/features/mechanics/view-play';
import { DES_WRAPPER_ID, MechanicStrip, STRIP_ID, stateSection } from '../../../src/features/mechanics/widgets';
import { ambushDef, createPlayEnv, feelingsDef, settlePlay, vitalsDef } from './helpers-play';
import type { PlayEnv } from './helpers-play';
import { faces } from './helpers-checks';

let env: PlayEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    env?.stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

async function setup(
    render: (env: PlayEnv) => (container: HTMLElement) => void | Unsubscribe,
    options: Parameters<typeof createPlayEnv>[0] = {},
): Promise<void> {
    env = await createPlayEnv({ locale: 'ru', ...options });
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = render(env)(container);
    await settlePlay(env);
}

function buttonIn(root: ParentNode, label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label || node.title === label,
    );
    if (!found) throw new Error(`no button ${label}`);
    return found;
}

async function click(node: HTMLElement): Promise<void> {
    node.click();
    await settlePlay(env);
}

function choose(node: HTMLSelectElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('change'));
}

function type(node: HTMLInputElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('input'));
}

const holderIn = (card: string, holder: string) => {
    const node = [...container.querySelectorAll<HTMLElement>('.maestro-m25-mechanic')]
        .find((item) => item.querySelector('.maestro-card-title')?.textContent === card)
        ?.querySelector<HTMLElement>(`[data-holder="${holder}"]`);
    if (!node) throw new Error(`no ${card}/${holder}`);
    return node;
};

describe('values in the window', () => {
    const state = (play: PlayEnv) => stateSection(play.deps, play.defs, play.state, play.checks, play.api);

    it('keeps hidden values behind «Подсмотреть» and «Раскрыть», secret ones out', async () => {
        await setup(state);
        const kai = () => holderIn('Чувства', 'Kai');
        expect(kai().querySelector('[data-attribute="trust"] .maestro-m25-unknown')?.textContent).toBe('???');
        expect(kai().querySelector('[data-attribute="grudge"]')).toBeNull();
        // A «book» value shows how the player reads it next to the editor.
        expect(kai().querySelector('[data-attribute="attitude"] .maestro-m25-words')?.textContent).toBe('«ровно»');

        env.ui.confirmAnswer = false;
        await click(buttonIn(kai(), 'Подсмотреть'));
        expect(kai().querySelector('[data-attribute="trust"] input')).toBeNull();
        env.ui.confirmAnswer = true;
        await click(buttonIn(kai(), 'Подсмотреть'));
        expect(env.ui.confirms.at(-1)?.title).toBe('Подсмотреть скрытое?');
        expect(kai().querySelector<HTMLInputElement>('[data-attribute="trust"] input')?.value).toBe('50');
        expect(env.api.isRevealed('feelings', 'Kai', 'trust')).toBe(false);

        await click(buttonIn(kai(), 'Раскрыть'));
        expect(env.api.isRevealed('feelings', 'Kai', 'trust')).toBe(true);
        expect(buttonIn(kai(), 'Снова скрыть')).toBeDefined();
    });

    it('pins values and characters to the HUD', async () => {
        await setup(state);
        const pin = holderIn('Жизнь', 'Алекс').querySelector<HTMLButtonElement>(
            '[data-attribute="hp"] .maestro-m25-pin',
        )!;
        expect(pin.getAttribute('aria-pressed')).toBe('true');
        await click(pin);
        expect(env.settings.hudAttrs).toEqual(['vitals.mana', 'vitals.coins']);
        expect(env.notified).toContain('modules.mechanics.hudAttrs');
        await click(
            holderIn('Жизнь', 'Алекс').querySelector<HTMLButtonElement>('[data-attribute="hp"] .maestro-m25-pin')!,
        );
        expect(env.settings.hudAttrs).toEqual([]);
        // Characters other than the user's: «В HUD».
        expect(holderIn('Жизнь', 'Алекс').querySelector('.maestro-m25-hud-holder-toggle')).toBeNull();
        await click(holderIn('Жизнь', 'Kai').querySelector<HTMLButtonElement>('.maestro-m25-hud-holder-toggle')!);
        expect(env.settings.hudHolders).toEqual(['Kai']);
        await click(holderIn('Жизнь', 'Kai').querySelector<HTMLButtonElement>('.maestro-m25-hud-holder-toggle')!);
        expect(env.settings.hudHolders).toEqual([]);
    });

    it('resets a mechanic or one holder after asking', async () => {
        await setup(state);
        await env.api.set('vitals', 'Kai', 'hp', 10);
        await env.api.set('vitals', 'Алекс', 'hp', 20);
        await settlePlay(env);
        await click(holderIn('Жизнь', 'Kai').querySelector<HTMLButtonElement>('.maestro-m25-reset-holder')!);
        expect(env.ui.confirms.at(-1)?.body).toContain('Kai');
        expect(env.api.value('vitals', 'Kai', 'hp')).toBe(80);
        expect(env.api.value('vitals', 'Алекс', 'hp')).toBe(20);
        env.ui.confirmAnswer = false;
        await click(container.querySelector<HTMLButtonElement>('.maestro-m25-reset')!);
        expect(env.api.value('vitals', 'Алекс', 'hp')).toBe(20);
        env.ui.confirmAnswer = true;
        await click(container.querySelector<HTMLButtonElement>('.maestro-m25-reset')!);
        expect(env.api.value('vitals', 'Алекс', 'hp')).toBe(80);
        expect(env.ui.notices.at(-1)?.text).toMatch(/Сброшено/);
    });

    it('rolls with advantage against another character', async () => {
        await setup(state, { rng: faces(20, 12, 5, 9) });
        const card = [...container.querySelectorAll<HTMLElement>('.maestro-m25-mechanic')].find(
            (item) => item.querySelector('.maestro-card-title')?.textContent === 'Жизнь',
        )!;
        const selects = card.querySelectorAll<HTMLSelectElement>('.maestro-m25-roll select');
        choose(selects[1]!, 'Алекс');
        choose(card.querySelector<HTMLSelectElement>('select[aria-label="Преимущество"]')!, 'adv');
        choose(card.querySelector<HTMLSelectElement>('select[aria-label="Против"]')!, 'Kai');
        await click(card.querySelector<HTMLButtonElement>('.maestro-m25-roll-button')!);
        expect(env.api.checks()[0]).toMatchObject({ holder: 'Алекс', mode: 'adv', vs: { holder: 'Kai' } });
    });
});

describe('the fight', () => {
    it('starts, moves on, takes an enemy and ends', async () => {
        await setup((play) => combatSection(play.deps, play.api), {
            defs: [vitalsDef({ combat: {} }), feelingsDef()],
        });
        expect(container.textContent).toContain('Сейчас боя нет');
        type(container.querySelector<HTMLInputElement>('input[aria-label="Противники"]')!, 'Волк');
        await click(buttonIn(container, 'Начать бой'));
        expect(env.api.combat()?.active).toBe(true);
        expect(container.textContent).toContain('Бой · раунд 1');
        expect(container.querySelector('[data-holder="Волк"]')?.textContent).toContain('противник');
        const first = env.api.combat()!.current;
        await click(buttonIn(container, 'Следующий ход'));
        expect(env.api.combat()!.current).not.toBe(first);
        type(container.querySelector<HTMLInputElement>('input[aria-label="Новый противник"]')!, 'Бандит');
        await click(buttonIn(container, 'Добавить противника'));
        expect(env.api.combat()!.order.map((item) => item.holder)).toContain('Бандит');
        await click(buttonIn(container, 'Закончить бой'));
        expect(env.api.combat()?.active ?? false).toBe(false);
    });

    it('stays away while no mechanic runs fights', async () => {
        await setup((play) => combatSection(play.deps, play.api));
        expect(container.textContent).toBe('');
    });
});

describe('conditions and items', () => {
    const people = (play: PlayEnv) => peopleSection(play.deps, play.api);
    const card = (holder: string) => {
        const node = [...container.querySelectorAll<HTMLElement>('.maestro-m25-person')].find(
            (item) => item.querySelector('.maestro-card-title')?.textContent === holder,
        );
        if (!node) throw new Error(`no ${holder}`);
        return node;
    };

    it('puts conditions on from the catalogue or by name and takes them off', async () => {
        await setup(people);
        expect(
            [...container.querySelectorAll('.maestro-m25-person .maestro-card-title')].map((n) => n.textContent),
        ).toEqual(['Алекс', 'Kai']);
        choose(card('Kai').querySelector<HTMLSelectElement>('select[aria-label="Состояние"]')!, '0');
        await click(buttonIn(card('Kai'), 'Наложить'));
        expect(card('Kai').querySelector('[data-status]')?.textContent).toContain('3 хода');
        choose(card('Kai').querySelector<HTMLSelectElement>('select[aria-label="Состояние"]')!, '');
        type(
            card('Kai').querySelector<HTMLInputElement>('input[aria-label="Состояние, например «Отравлен»"]')!,
            'Устал',
        );
        type(card('Kai').querySelector<HTMLInputElement>('input[aria-label="Часов"]')!, '2');
        await click(buttonIn(card('Kai'), 'Наложить'));
        expect(card('Kai').textContent).toContain('Устал');
        expect(card('Kai').textContent).toContain('2 ч');
        await click(card('Kai').querySelector<HTMLButtonElement>('.maestro-m25-status-remove')!);
        expect(env.api.statuses('Kai')[0]?.statuses.map((item) => item.name)).toEqual(['Устал']);
    });

    it('gives, equips, takes, buys and sells against the money', async () => {
        await setup(people);
        const alex = () => card('Алекс');
        expect(alex().querySelector('.maestro-card-subtitle')?.textContent).toBe('🪙 30');
        type(alex().querySelector<HTMLInputElement>('input[aria-label="Вещь"]')!, 'нож');
        type(alex().querySelector<HTMLInputElement>('input[aria-label="Сколько"]')!, '2');
        await click(buttonIn(alex(), 'Дать'));
        expect(alex().querySelector('[data-item="нож"]')?.textContent).toContain('нож ×2');
        choose(alex().querySelector<HTMLSelectElement>('[data-item="нож"] select')!, 'hand');
        await settlePlay(env);
        expect(env.api.items('Алекс')[0]?.items[0]?.equipped).toBe('hand');
        await click(buttonIn(alex().querySelector('[data-item="нож"]')!, 'Забрать одну'));
        expect(env.api.items('Алекс')[0]?.items[0]?.qty).toBe(1);

        type(alex().querySelector<HTMLInputElement>('input[aria-label="Вещь"]')!, 'зелье');
        type(alex().querySelector<HTMLInputElement>('input[aria-label="Цена за штуку"]')!, '10');
        await click(buttonIn(alex(), 'Купить'));
        expect(env.api.value('vitals', 'Алекс', 'coins')).toBe(20);
        await click(buttonIn(alex().querySelector('[data-item="зелье"]')!, 'Продать одну'));
        expect(env.api.value('vitals', 'Алекс', 'coins')).toBe(25);
        type(alex().querySelector<HTMLInputElement>('input[aria-label="Вещь"]')!, 'замок');
        type(alex().querySelector<HTMLInputElement>('input[aria-label="Цена за штуку"]')!, '1000');
        await click(buttonIn(alex(), 'Купить'));
        expect(env.ui.notices.at(-1)?.text).toBe('Не куплено: не хватает денег.');
    });
});

describe('the history', () => {
    const log = (play: PlayEnv) => logSection(play.deps, play.api);

    it('undoes a change and a roll; hidden rolls only as a count until «Подсмотреть»', async () => {
        await setup(log, { rng: faces(20, 3, 3), defs: [vitalsDef(), feelingsDef(), ambushDef()] });
        await env.api.set('vitals', 'Kai', 'hp', 30);
        await env.api.roll('vitals', 'spell', 'Kai');
        await env.api.roll('ambush', 'ambush', 'Алекс');
        await settlePlay(env);
        const changes = [...container.querySelectorAll<HTMLElement>('.maestro-m25-log-change')];
        expect(changes.map((row) => row.querySelector('span')?.textContent)).toEqual([
            'Kai: 🔷 40 → 30',
            'Kai: ❤ 80 → 30',
        ]);
        expect(container.querySelectorAll('.maestro-m25-log-roll')).toHaveLength(1);
        expect(container.querySelector('.maestro-m25-hidden-rolls')?.textContent).toContain('1');

        await click(changes[1]!.querySelector<HTMLButtonElement>('.maestro-m25-log-undo')!);
        expect(env.api.value('vitals', 'Kai', 'hp')).toBe(80);
        await click(container.querySelector<HTMLButtonElement>('.maestro-m25-log-undo-roll')!);
        expect(env.api.value('vitals', 'Kai', 'mana')).toBe(40);
        expect(container.querySelector('.maestro-m25-log-roll')?.textContent).toContain('отменён');

        await click(container.querySelector<HTMLButtonElement>('.maestro-m25-log-peek')!);
        expect(container.querySelectorAll('.maestro-m25-log-roll')).toHaveLength(2);
        expect(container.querySelector('.maestro-m25-hidden-rolls')).toBeNull();
    });
});

describe('the dossier section', () => {
    it('draws a character as the dossier may show him and follows the changes', async () => {
        await setup(() => () => undefined);
        const box = document.createElement('div');
        const off = env.api.renderHolder(box, 'Kai', 'dossier');
        expect(off).not.toBeNull();
        expect(box.querySelector('[data-mechanic="vitals"]')?.textContent).toContain('80/100');
        expect(box.querySelector('[data-mechanic="feelings"]')?.textContent).toContain('ровно');
        expect(box.textContent).not.toContain('Доверие');
        await env.api.set('vitals', 'Kai', 'hp', 50);
        await settlePlay(env);
        expect(box.querySelector('[data-mechanic="vitals"]')?.textContent).toContain('50/100');
        off?.();
        expect(box.children).toHaveLength(0);
        expect(env.api.renderHolder(document.createElement('div'), 'Никто', 'dossier')).toBeNull();
    });
});

describe('under the DES portraits', () => {
    it('puts the user’s character first, with the chosen values only, in their views', async () => {
        await setup(() => () => undefined);
        const wrapper = document.createElement('div');
        wrapper.id = DES_WRAPPER_ID;
        document.body.appendChild(wrapper);
        const strip = new MechanicStrip(env.deps, env.defs, env.state);
        strip.install();
        try {
            const node = () => document.getElementById(STRIP_ID)!;
            const holders = () =>
                [...node().querySelectorAll('[data-holder]')].map((item) => item.getAttribute('data-holder'));
            expect(holders()).toEqual(['Алекс', 'Kai']);
            expect(node().querySelector('[data-holder="Kai"]')?.textContent).toContain('80/100');
            // Book values never show here (their place is off); hidden ones neither.
            expect(node().textContent).not.toContain('Доверие');
            env.settings.desAttrs = ['vitals.mana'];
            env.settings.desPersona = false;
            env.app.settings.notify('modules.mechanics.desAttrs');
            await settlePlay(env);
            expect(holders()).toEqual(['Kai']);
            expect(node().textContent).toContain('40/40');
            expect(node().textContent).not.toContain('80/100');
        } finally {
            strip.dispose();
        }
    });
});
