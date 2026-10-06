// @vitest-environment happy-dom
// M25 narrator messages (plan-2 §6.А п.3; В22: off by default): after the user's message renders, the rolls of the turn
// go into the chat as a narrator line — kept out of the prompt unless the mechanic gives it to the model — never twice,
// never for a re-render, never for a mechanic whose place is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MechanicsNarrator, NARRATOR_EXTRA, SYSTEM_AVATAR } from '../../../src/features/mechanics/narrator';
import { createPlayEnv, feelingsDef, settlePlay, vitalsDef } from './helpers-play';
import type { PlayEnv } from './helpers-play';
import { faces } from './helpers-checks';

let env: PlayEnv;
let narrator: MechanicsNarrator;
let rendered: STChatMessage[];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    narrator?.dispose();
    env?.stop();
    vi.useRealTimers();
});

async function setup(on: boolean, toModel = false): Promise<void> {
    const vitals = vitalsDef({
        ...(on ? { visibility: { preset: 'game', places: { narrator: true } } } : {}),
        ...(toModel ? { narratorToModel: true } : {}),
    });
    env = await createPlayEnv({ locale: 'ru', rng: faces(20, 3, 15), defs: [vitals, feelingsDef()] });
    rendered = [];
    (env.mock.context as unknown as { addOneMessage: (message: STChatMessage) => void }).addOneMessage = (message) =>
        rendered.push(message);
    narrator = new MechanicsNarrator({ app: env.app, log: env.app.log }, env.api, { waitMs: 100 });
    narrator.install();
}

/** The user sends a message: MESSAGE_SENT, then ST renders it (and awaits the listeners). */
async function send(text = 'Колдую.'): Promise<number> {
    const index = await env.sendUser(text);
    const done = env.mock.eventSource.emit('user_message_rendered', index);
    await settlePlay(env, 300);
    await done;
    return index;
}

describe('narrator messages', () => {
    it('stay off while no mechanic has the place on', async () => {
        await setup(false);
        env.pushReply();
        await env.api.roll('vitals', 'spell', 'Kai');
        const index = await send();
        expect(env.mock.chat).toHaveLength(index + 1);
        expect(rendered).toEqual([]);
    });

    it('tell the rolls of the turn after the user’s message, out of the prompt by default', async () => {
        await setup(true);
        env.pushReply();
        await env.api.roll('vitals', 'spell', 'Kai');
        const index = await send();
        const line = env.mock.chat[index + 1]!;
        expect(line).toMatchObject({
            name: 'Рассказчик',
            is_user: false,
            is_system: true,
            force_avatar: SYSTEM_AVATAR,
            mes: '🎲 Заклинание (Kai): 3 против 10 — провал · 🔷 40 → 30',
        });
        expect(line.extra).toMatchObject({ type: 'narrator', [NARRATOR_EXTRA]: { rolls: [env.api.checks()[0]!.id] } });
        expect(rendered).toEqual([line]);

        // A re-render of the same message (chat load) tells nothing again.
        await env.mock.eventSource.emit('user_message_rendered', index);
        expect(env.mock.chat).toHaveLength(index + 2);
    });

    it('go to the model when the mechanic says so, and never repeat a told roll', async () => {
        await setup(true, true);
        env.pushReply();
        await env.api.roll('vitals', 'spell', 'Kai');
        const first = await send();
        expect(env.mock.chat[first + 1]).toMatchObject({ is_system: false, extra: { type: 'narrator' } });
        env.pushReply();
        const second = await send('Жду.');
        // Nothing new to tell: the roll of the first turn was told already.
        expect(env.mock.chat).toHaveLength(second + 1);
    });
});
