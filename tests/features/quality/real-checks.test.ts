// The service with the real free checks (src/domain/quality-checks.ts), not the fake: a smoke test of the contract
// between the two halves of M12.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicChat, createQualityStand } from './helpers';
import type { QualityStand } from './helpers';

let env: QualityStand;

const TRACKER = '```json\n{"infoBox":"{\\"date\\":\\"1 May\\"}","characterThoughts":"[]"}\n```\n';

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
});

afterEach(async () => {
    await env.stop();
});

describe('with the real free checks', () => {
    it('a plain story reply passes', async () => {
        const service = env.start();
        await env.reply(2);
        expect(service.verdict(2)).toMatchObject({ ok: true, defects: [] });
    });

    it('a leaked service token is cleaned; the DES tracker block and the NAI placeholder stay', async () => {
        env.des.present = true;
        const text = `${TRACKER}Anna smiled and opened the door wide for the tired guest.<|im_end|>\n\n[nai:img:abc123]`;
        const reply = env.chat[2]!;
        reply.mes = text;
        reply.swipes = [text];
        const service = env.start();
        await env.reply(2);
        const verdict = service.verdict(2)!;
        const junk = verdict.defects.find((defect) => defect.kind === 'junk');
        expect(junk?.status).toBe('cleaned');
        expect(reply.mes.startsWith(TRACKER)).toBe(true);
        expect(reply.mes).toContain('[nai:img:abc123]');
        expect(reply.mes).not.toContain('<|im_end|>');
    });
});
