// @vitest-environment happy-dom
// The mechanics service block is stripped from a reply and the reply re-rendered (1.21.1): on arrival and on the
// player's edit ST announces the message itself (CHARACTER_MESSAGE_RENDERED / MESSAGE_UPDATED follow), so Maestro
// stays quiet there; a leftover taken at reply:ready or at the commit comes after DES laid the reply out, so that
// re-render is announced with MESSAGE_UPDATED and DES lays it out again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMechanicsEnv, magicDef, reply, userMessage } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

let env: MechanicsEnv;
let updated: number[];

const STORY = 'Кай поднял руку, и пламя вспыхнуло.';

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.defs.defs = [magicDef()];
    await env.start();
    updated = [];
    env.mock.eventSource.on('message_updated', (index) => {
        updated.push(Number(index));
    });
    document.body.innerHTML = `<div id="chat">${[0, 1, 2, 3]
        .map((i) => `<div class="mes" mesid="${i}"><div class="mes_text"></div></div>`)
        .join('')}</div>`;
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

describe('re-rendering after the block is stripped', () => {
    it('is quiet on arrival and on an edit, announced at reply:ready and at the commit', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`);
        expect(env.rerendered).toEqual([index]);
        env.mock.chat[index]!.mes = `${STORY}\n<mechanics>\nKai.mana = 5\n</mechanics>`;
        await env.mock.eventSource.emit('message_edited', index);
        expect(env.rerendered).toEqual([index, index]);
        expect(updated).toEqual([]);

        env.mock.chat.push(reply(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`));
        await env.app.bus.emit('reply:ready', { messageIndex: 1, type: 'normal' });
        expect(env.mock.chat[1]!.mes).toBe(STORY);
        await vi.advanceTimersByTimeAsync(0);
        expect(updated).toEqual([1]);

        env.mock.chat.push(userMessage(), reply(`${STORY}\n<mechanics>\nKai.mana: -2\n</mechanics>`));
        await env.commit(3);
        expect(env.mock.chat[3]!.mes).toBe(STORY);
        expect(updated).toEqual([1, 3]);
    });
});
