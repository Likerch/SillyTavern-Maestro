// @vitest-environment happy-dom
// M25 under the replies (plan-2 §6.А п.2): the change line in each attribute's view (numbers, words, statuses), hidden
// and secret values never shown, «Отменить» for the line and for one change, roll cards with their consequences and
// «Отменить бросок», threshold events, and the status block under the latest reply only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
