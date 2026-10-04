import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTIONS } from '../../../src/domain/quality-types';
import { basicChat, createQualityStand, defect, message, settle, sleep } from './helpers';
import type { QualityStand } from './helpers';
import { fakeChecks, FAKE_BOUNDARY_RULES } from './fake-checks';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
});

afterEach(async () => {
    await env.stop();
});

describe('verdict flow', () => {
    it('a clean reply gets an ok verdict, reply:ok and no badge', async () => {
        const service = env.start();
        await env.reply(2);
        expect(fakeChecks.calls).toHaveLength(1);
        const verdict = service.verdict(2);
        expect(verdict).toMatchObject({ messageIndex: 2, swipeId: 0, ok: true, defects: [], action: 'none' });
        expect(env.bus['reply:ok']).toEqual([{ messageIndex: 2 }]);
        expect(env.badges).toHaveLength(0);
        expect(service.stats().every((row) => row.detected === 0)).toBe(true);
    });

    it('builds the input: cleaned history, names, language, DES together, boundary rules', async () => {
        env.des.present = true;
        env.chat[0]!.mes = '```json\n{"infoBox":"x"}\n```\nHello, traveller.';
        env.start();
        await env.reply(2);
        const input = fakeChecks.calls[0]!;
        expect(input.reply).toMatchObject({ index: 2, isUser: false, name: 'Anna' });
        expect(input.history.map((item) => item.index)).toEqual([0, 1]);
        expect(input.history[0]!.text).toBe('Hello, traveller.');
        expect(input.userName).toBe('User');
        expect(input.charName).toBe('Anna');
        expect(input.language).toBe('en');
        expect(input.desTogether).toBe(true);
        expect(input.boundary).toEqual([{ id: 'minors', patterns: FAKE_BOUNDARY_RULES[0]!.patterns }]);
    });

    it('expects Russian under the DES-RU language lock unless the chat is clearly English', async () => {
        env.desru.present = true;
        env.desru.settings = { modules: { bunnymo: { enabled: true, languageLock: true } } };
        env.chat[1]!.mes = 'Я вхожу и оглядываю комнату, где пахнет дымом и старым деревом.';
        env.start();
        await env.reply(2);
        expect(fakeChecks.calls[0]!.language).toBe('ru');
    });

    it('skips quiet replies, first messages, sheets, picture posts and group chats', async () => {
        env.start();
        await env.reply(2, 'quiet');
        await env.reply(0, 'first_message');
        await env.reply(1, 'normal');
        env.chat[2]!.extra = { maestro: { sheet: true } };
        await env.reply(2);
        env.chat[2]!.extra = { nai_studio: { prompt: 'x' } };
        await env.reply(2);
        env.chat[2]!.extra = {};
        env.chat[1]!.mes = '!fullsheet Anna';
        await env.reply(2);
        env.chat[1]!.mes = 'Hi';
        (env.app.host as unknown as { group: boolean }).group = true;
        await env.reply(2);
        expect(fakeChecks.calls).toHaveLength(0);
    });

    it('a notify defect gets the two badges, counts as detected and blocks reply:ok', async () => {
        env.defects(defect('userSpeech', { quote: 'I said yes' }));
        const service = env.start();
        await env.reply(2);
        const verdict = service.verdict(2)!;
        expect(verdict.ok).toBe(false);
        expect(verdict.action).toBe('notified');
        expect(verdict.defects[0]).toMatchObject({ kind: 'userSpeech', status: 'notified', quote: 'I said yes' });
        expect(env.badges.map((item) => item.badge.id)).toEqual(['maestro-qc-2', 'maestro-qc-2-ok']);
        expect(env.badges[0]!.badge.text).toContain('speaking for you');
        expect(env.badges[0]!.badge.action?.label).toBe('Redo');
        expect(env.badges[1]!.badge.action?.label).toBe('Not a defect');
        expect(env.bus['reply:ok']).toBeUndefined();
        expect(service.stats().find((row) => row.kind === 'userSpeech')!.detected).toBe(1);
    });

    it('kinds switched off are dropped', async () => {
        env.settings.actions.repetition = 'off';
        env.defects(defect('repetition'));
        const service = env.start();
        await env.reply(2);
        expect(service.verdict(2)).toMatchObject({ ok: true, defects: [] });
    });

    it('checks a reply once per text: a second reply:ready reuses the verdict', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        await env.reply(2);
        expect(fakeChecks.calls).toHaveLength(1);
        expect(service.stats().find((row) => row.kind === 'refusal')!.detected).toBe(1);
    });

    it('check() re-runs the checks and only notifies', async () => {
        env.core.autonomy['quality.refusal'] = 'auto';
        const service = env.start();
        await env.reply(2);
        env.defects(defect('refusal'));
        const verdict = await service.check(2);
        expect(verdict.defects[0]!.status).toBe('notified');
        expect(env.st.swipes).toHaveLength(0);
        expect((await service.check(1)).defects).toEqual([]);
    });
});

describe('the judge', () => {
    const answer = (verdicts: { id: number; defect: boolean; instruction?: string }[], tooAgreeable = false) => ({
        ok: true,
        data: {
            verdicts: verdicts.map((item) => ({ quote: '', instruction: '', ...item })),
            tooAgreeable,
        },
        costUsd: 0.0002,
    });

    it('is not asked when every rule is sure', async () => {
        env.defects(defect('userSpeech', { confidence: 0.95 }));
        env.start();
        await env.reply(2);
        expect(env.llm.requests).toHaveLength(0);
    });

    it('is asked on suspicion with a strict schema and its confirmation keeps the defect', async () => {
        env.defects(defect('refusal', { confidence: 0.5 }), defect('repetition', { confidence: 0.95 }));
        env.llm.respond = () => answer([{ id: 1, defect: true, instruction: 'Keep playing Anna.' }]);
        const service = env.start();
        await env.reply(2);
        expect(env.llm.requests).toHaveLength(1);
        const request = env.llm.requests[0]!;
        expect(request.task).toBe('quality.judge');
        expect(request.schema?.name).toBe('quality_judge');
        expect(request.messages[1]!.content).toContain('<reply>');
        expect(request.messages[1]!.content).toContain('1. refusal');
        const verdict = service.verdict(2)!;
        expect(verdict.judged).toBe(true);
        expect(verdict.costUsd).toBeCloseTo(0.0002);
        const refusal = verdict.defects.find((item) => item.kind === 'refusal')!;
        expect(refusal.suspected).toBeUndefined();
        expect(refusal.confidence).toBeGreaterThanOrEqual(0.9);
        expect(refusal.fix?.instruction).toBe('Keep playing Anna.');
    });

    it('a denied suspicion disappears; tooAgreeable adds softening', async () => {
        env.defects(defect('moralizing', { confidence: 0.6 }));
        env.llm.respond = () => answer([{ id: 1, defect: false }], true);
        const service = env.start();
        await env.reply(2);
        const kinds = service.verdict(2)!.defects.map((item) => item.kind);
        expect(kinds).toEqual(['softening']);
    });

    it('without an answer (failure, timeout) the suspicion stays as «possible»; weak ones are dropped', async () => {
        env.defects(defect('refusal', { confidence: 0.6 }), defect('repetition', { confidence: 0.3 }));
        env.llm.respond = () => new Promise(() => {});
        const service = env.start({ judgeMs: 40 });
        await env.reply(2);
        const verdict = service.verdict(2)!;
        expect(verdict.judged).toBe(false);
        expect(verdict.defects).toHaveLength(1);
        expect(verdict.defects[0]).toMatchObject({ kind: 'refusal', suspected: true, status: 'notified' });
        expect(env.badges[0]!.badge.text).toContain('Possible defect');
    });

    it('is skipped in «Экономный», when switched off, outside the leader tab or without a profile', async () => {
        env.defects(defect('refusal', { confidence: 0.6 }));
        const service = env.start();
        env.core.mode = 'economy';
        await env.reply(2);
        env.core.mode = 'balanced';
        env.settings.judge = false;
        await service.check(2);
        env.settings.judge = true;
        env.leader.value = false;
        await service.check(2);
        env.leader.value = true;
        env.llm.available = false;
        await service.check(2);
        expect(env.llm.requests).toHaveLength(0);
        expect(service.verdict(2)!.defects[0]!.suspected).toBe(true);
    });
});

describe('economy mode', () => {
    it('turns every «auto» into a notice', async () => {
        env.core.mode = 'economy';
        env.defects(defect('junk', { quote: '<|im_end|>' }));
        env.chat[2]!.mes = 'Anna smiled. <|im_end|>';
        const service = env.start();
        await env.reply(2);
        expect(service.verdict(2)!.defects[0]!.status).toBe('notified');
        expect(env.chat[2]!.mes).toContain('<|im_end|>');
        expect(env.autonomy.decisions).toHaveLength(0);
    });
});

describe('finish reason', () => {
    it('reads finish_reason of the main generate response', async () => {
        env.start();
        await env.generate('normal');
        const init: RequestInit = { method: 'POST', body: '{"stream":true}' };
        const url = '/api/backends/chat-completions/generate';
        for (const hook of env.fetchHooks.before) hook.fn(url, init);
        const body =
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"finish_reason":"length"}]}\n\n';
        for (const hook of env.fetchHooks.after) hook.fn(url, new Response(body), init);
        await env.end();
        await env.reply(2);
        expect(fakeChecks.calls[0]!.finishReason).toBe('length');
    });
});

describe('invalidation', () => {
    it('a swipe drops the verdict and the badges; a delete drops the later verdicts too', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        expect(service.verdict(2)).toBeDefined();
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'swiped' });
        expect(service.verdict(2)).toBeUndefined();
        expect(env.badges.every((item) => item.removed)).toBe(true);
        expect(service.history()[0]).toMatchObject({ messageIndex: 2 });

        await env.reply(2);
        expect(service.verdict(2)).toBeDefined();
        await env.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted' });
        expect(service.verdict(2)).toBeUndefined();
    });

    it('an edit drops the verdict; a chat change loads that chat’s verdicts', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        expect(service.verdict(2)).toBeUndefined();
        await env.reply(2);
        await sleep(600);
        expect(env.stand.chat.doc<{ verdicts: unknown[] }>('chat-1', 'quality')?.verdicts.length).toBeGreaterThan(0);
        env.stand.mock.chatId = 'chat-2';
        await env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        await settle(10);
        expect(service.verdict(2)).toBeUndefined();
        env.stand.mock.chatId = 'chat-1';
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await settle(10);
        expect(service.verdict(2)).toBeDefined();
        expect(env.badges.filter((item) => !item.removed).length).toBe(2);
    });
});

describe('settings and boundary', () => {
    it('starts from DEFAULT_ACTIONS and the default boundary rules', () => {
        expect(env.settings.actions).toEqual(DEFAULT_ACTIONS);
        const service = env.start();
        expect(service.boundary()).toEqual(FAKE_BOUNDARY_RULES);
        expect(service.boundary()).not.toBe(env.settings.boundary);
    });

    it('setBoundary keeps valid rules with unique ids; disabled rules are not checked', async () => {
        const service = env.start();
        await service.setBoundary([
            { id: 'a', title: 'A', patterns: [' x ', ''], enabled: true },
            { id: 'a', title: 'dup', patterns: ['y'], enabled: true },
            { id: 'b', title: 'B', patterns: ['z'], enabled: false },
            { title: 'no id' } as never,
        ]);
        expect(service.boundary()).toEqual([
            { id: 'a', title: 'A', patterns: ['x'], enabled: true },
            { id: 'b', title: 'B', patterns: ['z'], enabled: false },
        ]);
        await env.reply(2);
        expect(fakeChecks.calls[0]!.boundary).toEqual([{ id: 'a', patterns: ['x'] }]);
    });

    it('the boundary kind is never automatic and never promoted', async () => {
        const service = env.start();
        expect(env.autonomy.never.has('quality.boundary')).toBe(true);
        env.core.autonomy['quality.boundary'] = 'auto';
        expect(service.action('boundary')).toBe('notify');
        service.setAction('boundary', 'auto');
        expect(env.settings.actions.boundary).toBe('notify');
    });

    it('setAction writes the slice and the autonomy level', () => {
        const service = env.start();
        service.setAction('refusal', 'auto');
        expect(env.settings.actions.refusal).toBe('auto');
        expect(env.core.autonomy['quality.refusal']).toBe('auto');
        expect(service.action('refusal')).toBe('auto');
        env.core.mode = 'economy';
        expect(service.action('refusal')).toBe('notify');
        expect(service.configuredAction('refusal')).toBe('auto');
    });

    it('test() runs the free checks over a text with the given rules and acts on nothing', () => {
        env.defects(defect('boundary', { by: 'mine' }));
        const service = env.start();
        const found = service.test('Some text', [{ id: 'mine', title: 'Mine', patterns: ['text'], enabled: true }]);
        expect(found.map((item) => item.kind)).toEqual(['boundary']);
        expect(fakeChecks.calls[0]!.reply.text).toBe('Some text');
        expect(fakeChecks.calls[0]!.boundary).toEqual([{ id: 'mine', patterns: ['text'] }]);
        expect(env.badges).toHaveLength(0);
        expect(service.verdict(2)).toBeUndefined();
    });
});

describe('stats', () => {
    it('are written to the stats file', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        await service.statsStore.flush();
        const file = env.files.get('maestro-quality-stats.json') as { stats: Record<string, { detected: number }> };
        expect(file.stats.refusal!.detected).toBe(1);
    });
});

it('message() helper keeps swipes for the tests', () => {
    expect(message('x').mes).toBe('x');
});
