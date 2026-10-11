// @vitest-environment happy-dom
// M12 cleaning rewrites a reply that DES has already laid out as speaker cards. The re-render is announced with
// MESSAGE_UPDATED, as ST's message editor does, so DES lays the cleaned text out again; without it the reply stayed
// plain until the user opened and closed the editor (1.21.1). MESSAGE_EDITED is never sent: Maestro's turn pipeline
// would read it as the player's own edit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicChat, createQualityStand, defect } from './helpers';
import type { QualityStand } from './helpers';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;
let calls: string[];

beforeEach(() => {
    env = createQualityStand();
    basicChat(env, 'Anna smiled.<|eot_id|>');
    calls = [];
    const ctx = env.stand.mock.context as unknown as Record<string, unknown>;
    const update = ctx.updateMessageBlock as (index: number) => void;
    ctx.updateMessageBlock = (index: number) => {
        update(index);
        calls.push(`render:${index}`);
    };
    for (const event of ['message_updated', 'message_edited']) {
        env.stand.mock.eventSource.on(event, (index) => {
            calls.push(`${event}:${String(index)}`);
        });
    }
    document.body.innerHTML = '<div id="chat"><div class="mes" mesid="2"><div class="mes_text"></div></div></div>';
});

afterEach(async () => {
    await env.stop();
});

describe('cleaning a reply on screen', () => {
    it('re-renders it with MESSAGE_UPDATED, and so does the undo', async () => {
        env.defects(defect('junk', { quote: '<|eot_id|>' }));
        env.start();
        await env.reply(2);
        expect(env.chat[2]!.mes).toBe('Anna smiled.');
        expect(calls).toEqual(['render:2', 'message_updated:2']);
        expect(env.st.saves).toBe(1);
        calls.length = 0;
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.chat[2]!.mes).toBe('Anna smiled.<|eot_id|>');
        expect(calls).toEqual(['render:2', 'message_updated:2']);
    });
});
