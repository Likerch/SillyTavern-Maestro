import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicChat, createQualityStand, defect, sleep } from './helpers';
import type { QualityStand } from './helpers';
import { fakeChecks } from './fake-checks';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
});

afterEach(async () => {
    await env.stop();
});

describe('NAI Studio gate registration', () => {
    it('is set at start and removed at stop', async () => {
        env.start();
        expect(env.nai.sets).toBe(1);
        expect(env.nai.gate).toBeTypeOf('function');
        await env.stop();
        expect(env.nai.offs).toBe(1);
        expect(env.nai.gate).toBeNull();
    });

    it('is set again when NAI Studio comes back', async () => {
        env.nai.available = false;
        const service = env.start();
        expect(env.nai.sets).toBe(0);
        expect(service.naiGateActive()).toBe(false);
        env.nai.available = true;
        await sleep(80);
        expect(env.nai.sets).toBe(1);
        // Switched off: NAI Studio drops the gate itself; back on: registered again.
        env.nai.available = false;
        await sleep(80);
        expect(service.naiGateActive()).toBe(false);
        env.nai.available = true;
        await sleep(80);
        expect(env.nai.sets).toBe(2);
        expect(service.naiGateActive()).toBe(true);
    });
});

describe('gate verdicts', () => {
    it('waits for the check of the reply in progress and says true when it is ok', async () => {
        const service = env.start();
        await env.generate('normal');
        await env.end();
        const answer = service.gate(2);
        let settled = false;
        void answer.then(() => (settled = true));
        await sleep(10);
        expect(settled).toBe(false);
        await env.reply(2);
        expect(await answer).toBe(true);
    });

    it('answers at once from a known verdict, and true for messages it does not check', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        expect(await service.gate(2)).toBe(true);
        expect(await service.gate(1)).toBe(true);
        expect(await service.gate(7)).toBe(true);
    });

    it('says false when the reply is redone by an auto-swipe or a continue', async () => {
        env.core.autonomy['quality.refusal'] = 'auto';
        env.defects(defect('refusal'));
        const service = env.start();
        await env.generate('normal');
        await env.end();
        const answer = service.gate(2);
        await env.reply(2);
        expect(await answer).toBe(false);
        expect(await service.gate(2)).toBe(false);
    });

    it('says false for a continue', async () => {
        env.core.autonomy['quality.truncated'] = 'auto';
        env.defects(defect('truncated'));
        const service = env.start();
        await env.generate('normal');
        await env.end();
        const answer = service.gate(2);
        await env.reply(2);
        expect(await answer).toBe(false);
    });

    it('says true after a cleaning', async () => {
        env.chat[2]!.mes = 'Anna smiled.<|eot_id|>';
        env.defects(defect('junk', { quote: '<|eot_id|>' }));
        const service = env.start();
        await env.generate('normal');
        await env.end();
        const answer = service.gate(2);
        await env.reply(2);
        expect(await answer).toBe(true);
        expect(env.chat[2]!.mes).toBe('Anna smiled.');
    });

    it('gives up after the hard timeout with true', async () => {
        env.defects(defect('refusal', { confidence: 0.5 }));
        env.llm.respond = () => new Promise(() => {});
        const service = env.start({ gateMs: 60, judgeMs: 5000 });
        await env.generate('normal');
        await env.end();
        const started = Date.now();
        const answer = service.gate(2);
        void env.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        expect(await answer).toBe(true);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('starts the check itself when reply:ready does not come', async () => {
        const service = env.start({ gateKickMs: 20 });
        await env.generate('normal');
        expect(await service.gate(2)).toBe(true);
        expect(fakeChecks.calls).toHaveLength(1);
        // The late reply:ready does not check again.
        await env.reply(2);
        expect(fakeChecks.calls).toHaveLength(1);
        await env.end();
    });

    it('a swipe or a delete while waiting says false; a generation without a reply releases with true', async () => {
        const service = env.start({ gateKickMs: 10_000 });
        await env.generate('normal');
        const swiped = service.gate(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'swiped' });
        expect(await swiped).toBe(false);
        const deleted = service.gate(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted' });
        expect(await deleted).toBe(false);
        const nothing = service.gate(2);
        await env.end();
        expect(await nothing).toBe(true);
    });

    it('in a group chat or after a chat change it never waits', async () => {
        const service = env.start({ gateKickMs: 10_000 });
        await env.generate('normal');
        const pending = service.gate(2);
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        expect(await pending).toBe(true);
        (env.app.host as unknown as { group: boolean }).group = true;
        expect(await service.gate(2)).toBe(true);
        await env.end();
    });

    it('is the gate NAI Studio got', async () => {
        env.defects(defect('refusal'));
        env.start();
        await env.reply(2);
        expect(await env.nai.gate!(2)).toBe(true);
    });
});
