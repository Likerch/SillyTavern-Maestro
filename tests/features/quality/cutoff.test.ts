import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicChat, createQualityStand, sleep } from './helpers';
import type { QualityStand } from './helpers';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
});

afterEach(async () => {
    await env.stop();
});

async function stream(...chunks: string[]): Promise<void> {
    let text = '';
    for (const chunk of chunks) {
        text += chunk;
        await env.stand.emit('STREAM_TOKEN_RECEIVED', text);
    }
}

describe('early cutoff', () => {
    it('stops the stream on a junk token and swipes the partial reply once', async () => {
        const service = env.start();
        await env.generate('normal');
        await stream('Anna smiled', ' and said', ' <｜begin▁of▁sentence｜>', 'more');
        expect(env.st.stops).toBe(1);
        env.chat[2]!.mes = 'Anna smiled and said <｜begin▁of▁sentence｜>';
        await env.end(true);
        await env.reply(2);
        await sleep(20);
        const verdict = service.verdict(2)!;
        expect(verdict.action).toBe('swiped');
        expect(verdict.defects[0]).toMatchObject({ kind: 'junk', by: 'cutoff', quote: '<｜begin▁of▁sentence｜>' });
        expect(env.st.swipes).toHaveLength(1);
        expect(env.metrics.autoSwipes).toBe(1);
        expect(service.swipeBudget()).toBe(false);
    });

    it('finds a token split across chunks', async () => {
        env.start();
        await env.generate('swipe');
        await stream('Text <|im_', 'start|>assistant');
        expect(env.st.stops).toBe(1);
        await env.end(true);
    });

    it('is not armed for «notify» junk, «Экономный», switched off, a continue or a used auto-swipe', async () => {
        const service = env.start();
        env.settings.actions.junk = 'notify';
        await env.generate('normal');
        await stream('x <|eot_id|>');
        await env.end();
        env.settings.actions.junk = 'auto';

        env.core.mode = 'economy';
        await env.generate('normal');
        await stream('x <|eot_id|>');
        await env.end();
        env.core.mode = 'balanced';

        env.settings.earlyCutoff = false;
        await env.generate('normal');
        await stream('x <|eot_id|>');
        await env.end();
        env.settings.earlyCutoff = true;

        await env.generate('continue');
        await stream('x <|eot_id|>');
        await env.end();

        await env.generate('normal', { quiet: true });
        await stream('x <|eot_id|>');

        (service as unknown as { autoSwipedTurn: number; turn: number }).autoSwipedTurn = (
            service as unknown as { turn: number }
        ).turn;
        await env.generate('normal');
        await stream('x <|eot_id|>');
        await env.end();
        expect(env.st.stops).toBe(0);
    });

    it('a clean stream is never stopped', async () => {
        env.start();
        await env.generate('normal');
        await stream('Anna [smiled]', ' <b>warmly</b>.', ' {"infoBox": 1}');
        await env.end();
        expect(env.st.stops).toBe(0);
    });
});
