// @vitest-environment happy-dom
// M25 under the replies (plan-2 §6.А п.2): the change line in each attribute's view (numbers, words, statuses), hidden
// and secret values never shown, «Отменить» for the line and for one change, roll cards with their consequences
// (experience as «+10 опыта»), whom the roll was aimed at and «Отменить бросок», threshold events, and the status block
// under the latest reply only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicsPlayStrip, PLAY_STRIP_ORDER, PLAY_STRIP_PROVIDER } from '../../../src/features/mechanics/play-strip';
import type { StripItem } from '../../../src/shared/contracts';
import { ambushDef, createPlayEnv, feelingsDef, settlePlay, vitalsDef } from './helpers-play';
import type { PlayEnv } from './helpers-play';
import { faces } from './helpers-checks';

let env: PlayEnv;
let strip: MechanicsPlayStrip;

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    strip?.dispose();
    env?.stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

async function setup(options: Parameters<typeof createPlayEnv>[0] = {}): Promise<void> {
    env = await createPlayEnv({ locale: 'ru', ...options });
    strip = new MechanicsPlayStrip({ app: env.app, log: env.app.log }, env.api);
    strip.install();
}

/** Changes the block of reply `index` brings (tracked: shown under that reply). */
async function block(index: number): Promise<void> {
    await env.state.apply([
        { mechanicId: 'vitals', holder: 'Kai', attribute: 'hp', value: 65, source: 'block', messageIndex: index },
        { mechanicId: 'vitals', holder: 'Kai', attribute: 'mana', value: 25, source: 'block', messageIndex: index },
        {
            mechanicId: 'feelings',
            holder: 'Kai',
            attribute: 'attitude',
            value: 'warm',
            source: 'block',
            messageIndex: index,
        },
        { mechanicId: 'feelings', holder: 'Kai', attribute: 'trust', value: 10, source: 'block', messageIndex: index },
        { mechanicId: 'feelings', holder: 'Kai', attribute: 'grudge', value: 5, source: 'block', messageIndex: index },
    ]);
    await env.state.applyOps!([
        {
            kind: 'status',
            op: 'add',
            mechanicId: 'vitals',
            holder: 'Kai',
            status: { name: 'Отравлен', duration: { turns: 3 } },
            source: 'block',
            messageIndex: index,
        },
    ]);
    await settlePlay(env);
}

function byKind(items: StripItem[], kind: StripItem['kind']): StripItem[] {
    return items.filter((item) => item.kind === kind);
}

function body(item: StripItem): HTMLElement {
    const box = document.createElement('div');
    document.body.appendChild(box);
    item.body?.(box);
    return box;
}

describe('the change line', () => {
    it('says what changed in each view and never a hidden or secret value', async () => {
        await setup();
        const reply = env.pushReply();
        await block(reply);
        const provider = strip.provider();
        expect(provider).toMatchObject({ id: PLAY_STRIP_PROVIDER, order: PLAY_STRIP_ORDER });
        const [line] = byKind(provider.items(reply), 'change');
        expect(line?.text).toBe('Kai: ❤ 80 → 65 · 🔷 40 → 25 · Отношение: ровно → тепло · + Отравлен (3 хода)');
        expect(line?.text).not.toContain('Доверие');
        expect(line?.text).not.toContain('Обида');
        // Nothing under another message.
        expect(provider.items(reply + 1)).toEqual([]);
        // Revealed, the hidden value shows from then on; the secret one never.
        await env.api.reveal('feelings', 'Kai', 'trust');
        await settlePlay(env);
        const again = byKind(strip.items(reply), 'change')[0]!;
        expect(again.text).toContain('Доверие');
        expect(again.text).not.toContain('Обида');
    });

    it('takes the whole line back, or one change from its details', async () => {
        await setup();
        const reply = env.pushReply();
        await block(reply);
        const line = byKind(strip.items(reply), 'change')[0]!;
        const details = body(line);
        expect(details.querySelectorAll('.maestro-m25-change-item')).toHaveLength(4);
        details.querySelector<HTMLButtonElement>('[data-change] .maestro-m25-undo-one')!.click();
        await settlePlay(env);
        expect(env.api.value('vitals', 'Kai', 'hp')).toBe(80);
        expect(env.api.value('vitals', 'Kai', 'mana')).toBe(25);

        await byKind(strip.items(reply), 'change')[0]!.actions![0]!.run();
        await settlePlay(env);
        expect(env.api.value('vitals', 'Kai', 'mana')).toBe(40);
        expect(env.api.value('feelings', 'Kai', 'attitude')).toBe('neutral');
        expect(env.api.statuses('Kai')[0]?.statuses ?? []).toEqual([]);
        expect(byKind(strip.items(reply), 'change')).toEqual([]);
    });

    it('offers «Пересчитать» under a story reply (1.26) and says how it went', async () => {
        await setup();
        const reply = env.pushReply();
        await block(reply);
        const retrack = vi.fn(async (index: number) => index === reply);
        env.api.retrack = retrack;
        const details = body(byKind(strip.items(reply), 'change')[0]!);
        const button = details.querySelector<HTMLButtonElement>('.maestro-m25-recount')!;
        expect(button.textContent).toBe('Пересчитать');
        // Not one of the change rows.
        expect(details.querySelectorAll('.maestro-m25-change-item')).toHaveLength(4);
        button.click();
        await settlePlay(env);
        expect(retrack).toHaveBeenCalledWith(reply);
        expect(env.ui.notices.at(-1)?.text).toBe(`Ответ #${reply}: механики пересчитаны.`);
        retrack.mockResolvedValueOnce(false);
        button.click();
        await settlePlay(env);
        expect(env.ui.notices.at(-1)?.options).toMatchObject({ level: 'warn' });
        expect(env.ui.notices.at(-1)?.text).toContain(`Не получилось пересчитать ответ #${reply}`);
        // Under the user's own message: no button.
        const own = await env.sendUser('Колдую.');
        await env.state.apply([
            { mechanicId: 'vitals', holder: 'Kai', attribute: 'hp', value: 60, source: 'check', messageIndex: own },
        ]);
        await settlePlay(env);
        const mine = body(byKind(strip.items(own), 'change')[0]!);
        expect(mine.querySelector('.maestro-m25-recount')).toBeNull();
    });

    it('tells the listeners which message to repaint', async () => {
        await setup();
        const reply = env.pushReply();
        const calls: (number[] | undefined)[] = [];
        strip.provider().onChange((indexes) => calls.push(indexes));
        await block(reply);
        expect(calls).toContainEqual([reply]);
    });
});

describe('roll cards', () => {
    it('show the roll with its consequences and take them back', async () => {
        await setup({ rng: faces(20, 3) });
        env.pushReply();
        await env.api.roll('vitals', 'spell', 'Kai');
        const index = await env.sendUser('Колдую.');
        await settlePlay(env);
        const [card] = byKind(strip.items(index), 'roll');
        expect(card?.text).toBe('Заклинание (Kai): 3 против 10 — провал · 🔷 40 → 30');
        const box = body(card!);
        expect([...box.querySelectorAll('.maestro-m25-die')].map((node) => node.textContent)).toEqual(['3']);
        expect(box.textContent).toContain('Последствия: 🔷 40 → 30');
        expect(box.querySelector('details')?.textContent).toContain('Spell check');
        // The consequence is the card's: not repeated on a change line.
        expect(byKind(strip.items(index), 'change')).toEqual([]);

        await card!.actions![0]!.run();
        await settlePlay(env);
        expect(env.api.value('vitals', 'Kai', 'mana')).toBe(40);
        const after = byKind(strip.items(index), 'roll')[0]!;
        expect(after.text).toContain('— отменён');
        expect(after.actions).toBeUndefined();
    });

    it('say what the outcome means; an attempt without the means shows why instead of dice (1.27)', async () => {
        const def = vitalsDef();
        def.checks[0]!.requires = [{ attr: 'mana', min: 40 }];
        await setup({ defs: [def], rng: faces(20, 10) });
        env.pushReply();
        // 10 vs 10: made it by nothing.
        await env.api.roll('vitals', 'spell', 'Kai');
        const first = await env.sendUser('Колдую.');
        await settlePlay(env);
        const [close] = byKind(strip.items(first), 'roll');
        expect(body(close!).querySelector('.maestro-m25-roll-meaning')?.textContent).toBe('Еле-еле получилось');

        // The spell cost 5: mana 40 → 35, under what the spell needs.
        env.pushReply();
        await env.api.roll('vitals', 'spell', 'Kai');
        const second = await env.sendUser('Колдую ещё раз.');
        await settlePlay(env);
        const [card] = byKind(strip.items(second), 'roll');
        expect(card?.text).toBe('Заклинание (Kai): невозможно — Мана 35, нужно 40');
        const box = body(card!);
        expect(box.querySelector('.maestro-m25-die')).toBeNull();
        expect(box.querySelector('.maestro-m25-roll-meaning')).toBeNull();
        expect(box.querySelector('details')?.textContent).toContain('not possible — mana 35, needs 40');
        expect(card?.actions).toBeUndefined();
    });

    it('show whom a roll was aimed at and the experience it gave', async () => {
        const study: MechanicDef = {
            id: 'study',
            name: 'Учёба',
            summary: '',
            rules: 'Sparring.',
            attributes: [
                { id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'number', min: 0, initial: 10 },
                { id: 'xp', name: 'Опыт', promptName: 'Experience', kind: 'number', min: 0, initial: 0 },
                { id: 'level', name: 'Уровень', promptName: 'Level', kind: 'number', min: 1, initial: 1 },
            ],
            holders: { kind: 'characters', includePersona: true },
            checks: [
                {
                    id: 'spar',
                    name: 'Спарринг',
                    promptName: 'Spar',
                    dice: '1d20',
                    difficulty: 10,
                    triggers: ['спарр'],
                    effects: [{ on: 'success', changes: [{ who: 'target', attr: 'hp', op: 'sub', value: 2 }] }],
                },
            ],
            tracking: 'manual',
            scope: { kind: 'global' },
            progression: { xp: 'xp', level: 'level', thresholds: [10], awards: { success: 10 } },
        };
        await setup({ defs: [study], rng: faces(20, 15) });
        env.pushReply();
        const index = await env.sendUser('Спаррингую с Kai.');
        await settlePlay(env);
        const [card] = byKind(strip.items(index), 'roll');
        expect(card?.text).toContain('Спарринг (Алекс → Kai): 15 против 10 — успех');
        expect(card?.text).toContain('+10 опыта');
        expect(card?.text).toContain('Kai: ');
        expect(env.api.value('study', 'Kai', 'hp')).toBe(8);
        expect(env.api.value('study', 'Алекс', 'level')).toBe(2);
        const box = body(card!);
        expect(box.querySelector('.maestro-m25-roll-target')?.textContent).toBe('Цель: Kai');
        expect(box.textContent).toContain('+10 опыта');
        expect(box.querySelector('details')?.textContent).toContain('Spar check (Алекс) against Kai');
    });

    it('never show a secret roll', async () => {
        await setup({ defs: [vitalsDef(), ambushDef()] });
        env.pushReply();
        await env.api.roll('ambush', 'ambush', 'Алекс');
        const index = await env.sendUser();
        await settlePlay(env);
        expect(env.api.rollsOf(index)).toHaveLength(1);
        expect(byKind(strip.items(index), 'roll')).toEqual([]);
    });
});

describe('events and the status block', () => {
    it('tells a threshold event in words', async () => {
        await setup();
        const reply = env.pushReply();
        await env.state.apply([
            { mechanicId: 'vitals', holder: 'Kai', attribute: 'mana', value: 0, source: 'block', messageIndex: reply },
        ]);
        await settlePlay(env);
        const [event] = strip.items(reply).filter((item) => item.icon === 'fa-bolt');
        expect(event?.text).toBe('Kai · Мана: 0 и меньше — сработало событие');
        expect(body(event!).textContent).toContain('Kai has no mana left.');
    });

    it('shows the state of the scene under the latest reply only, when the place is on', async () => {
        await setup();
        const first = env.pushReply();
        env.mock.chat.push({ ...env.mock.chat[first]!, is_user: true, name: 'Алекс', mes: 'Дальше' });
        const last = env.pushReply();
        expect(strip.items(last).some((item) => item.id === 'status-block')).toBe(false);

        env.defs.defs = [vitalsDef({ visibility: { preset: 'game', places: { statusBlock: true } } }), feelingsDef()];
        env.defs.emit();
        await settlePlay(env);
        const [item] = strip.items(last).filter((entry) => entry.id === 'status-block');
        expect(item?.text).toContain('После хода:');
        expect(item?.text).toContain('Алекс ❤ 80/100');
        expect(strip.items(first).some((entry) => entry.id === 'status-block')).toBe(false);
        const table = body(item!);
        expect([...table.querySelectorAll('tr')].map((row) => row.getAttribute('data-holder'))).toEqual([
            'Алекс',
            'Kai',
        ]);
        expect(table.querySelector('[data-holder="Kai"]')?.textContent).toContain('80/100');
    });
});
