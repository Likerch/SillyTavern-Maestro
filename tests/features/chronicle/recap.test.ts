// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECAP_INJECTION, RECAP_PANEL_CLASS, RECAP_TASK } from '../../../src/features/chronicle/recap';
import { createChronicleTestApp, createServices, reply, settle, storedDoc, userMessage } from './helpers';
import type { ChronicleTestApp, Services } from './helpers';

const HOUR = 3_600_000;

let t: ChronicleTestApp;
let s: Services;

/** A chat whose last message was sent `hoursAgo` hours ago, with Qvink memories: two long-term, three short-term. */
function chatFrom(hoursAgo: number, russian = false): void {
    const at = Date.now() - hoursAgo * HOUR;
    const say = russian ? 'Они пошли дальше.' : 'They went on.';
    t.mock.chat.push(
        reply(say, { memory: 'Alice met Bob in the tavern.', remember: true, include: 'long' }),
        userMessage(say),
        reply(say, { memory: 'Alice swore to find the ring.', remember: true, include: 'long' }),
        userMessage(say),
        reply(say, { memory: 'They left for the forest.', include: 'short' }),
        userMessage(say),
        reply(say, { memory: 'It got dark.', include: 'short' }),
        reply(say, { memory: 'Bob lit a fire.', include: 'short' }),
    );
    t.mock.chat.forEach((message, index) => {
        message.send_date = new Date(at - (t.mock.chat.length - index) * 60_000).toISOString();
    });
}

function panel(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.${RECAP_PANEL_CLASS}`);
}

beforeEach(() => {
    document.body.innerHTML =
        '<div id="sheld"><div id="chat"></div><div id="form_sheld"><div id="send_form"></div></div></div>';
    t = createChronicleTestApp();
    s = createServices(t);
});

afterEach(() => {
    s.stop();
    vi.useRealTimers();
});

describe('M9 «Previously in the story…»: the absence timer', () => {
    it('shows the free recap above the input after a long break, once', async () => {
        chatFrom(13);
        await s.recap.check();
        const node = panel();
        expect(node?.parentElement?.id).toBe('form_sheld');
        expect(node?.nextElementSibling?.id).toBe('send_form');
        expect(node?.textContent).toContain('Previously in the story…');
        expect(node?.querySelector('.maestro-m9-recap-text')?.textContent).toBe(
            [
                'Remembered:',
                '• Alice met Bob in the tavern.',
                '• Alice swore to find the ring.',
                '',
                'Lately:',
                '• They left for the forest.',
                '• It got dark.',
                '• Bob lit a fire.',
            ].join('\n'),
        );
        const doc = await storedDoc(t);
        expect(doc.recap).toMatchObject({ source: 'memory', text: expect.stringContaining('Remembered:') });
        const shownAt = (doc.recap as { shownAt: number }).shownAt;
        expect(Date.now() - shownAt).toBeLessThan(5000);
        // Again (tab return): not shown twice.
        node?.remove();
        await s.recap.check();
        expect(panel()).toBeNull();
        // Another tab or device (fresh services, the stamp comes from the chat file): not shown either.
        s.stop();
        s = createServices(t);
        await s.recap.check();
        expect(panel()).toBeNull();
    });

    it('stays quiet after a short break, in a short chat, without material, or when switched off', async () => {
        chatFrom(2);
        await s.recap.check();
        expect(panel()).toBeNull();

        t.mock.chat.splice(0);
        chatFrom(13);
        t.slice().recap.target = 'off';
        await s.recap.check();
        expect(panel()).toBeNull();
        t.slice().recap.target = 'user';
        t.qvink.present = false;
        await s.recap.check();
        expect(panel()).toBeNull();
        t.qvink.present = true;
        t.mock.chat.splice(3);
        await s.recap.check();
        expect(panel()).toBeNull();
        expect((await storedDoc(t)).recap).toBeNull();
    });

    it('lets only the leader tab show it, and checks again when this tab becomes the leader', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        chatFrom(13);
        t.leader.value = false;
        await s.recap.check();
        expect(panel()).toBeNull();
        t.leader.value = true;
        for (const listener of t.leader.listeners) listener(true);
        await vi.advanceTimersByTimeAsync(600);
        vi.useRealTimers();
        await settle(30);
        expect(panel()).not.toBeNull();
    });

    it('checks on chat open and when the tab comes back', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const check = vi.spyOn(s.recap, 'check').mockResolvedValue();
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(500);
        expect(check).toHaveBeenCalledTimes(1);
        await t.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await vi.advanceTimersByTimeAsync(3000);
        expect(check).toHaveBeenCalledTimes(2);
        s.recap.start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(check).toHaveBeenCalledTimes(3);
    });

    it('goes away when closed, when a message is sent and when the chat changes', async () => {
        chatFrom(13);
        await s.recap.check();
        panel()?.querySelector<HTMLButtonElement>('.maestro-m9-recap-close')?.click();
        expect(panel()).toBeNull();
        await s.recap.recapNow();
        expect(panel()).not.toBeNull();
        await t.mock.eventSource.emit('message_sent', 5);
        expect(panel()).toBeNull();
        await s.recap.recapNow();
        const open = [...(panel()?.querySelectorAll('button') ?? [])].find((node) => node.textContent === 'Chronicle');
        open?.click();
        expect(t.ui.opened).toEqual(['chronicle']);
        expect(panel()).toBeNull();
        await s.recap.recapNow();
        await t.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        expect(panel()).toBeNull();
    });

    it('falls back to a notice when ST’s input bar is not there', async () => {
        document.body.innerHTML = '';
        chatFrom(13);
        await s.recap.check();
        expect(t.ui.notices[0]?.text).toContain('Previously in the story…\nRemembered:');
        expect(t.ui.notices[0]?.options).toMatchObject({ urgent: true });
        t.ui.notices[0]?.options?.action?.run();
        expect(t.ui.opened).toEqual(['chronicle']);
    });
});

describe('M9 «Previously in the story…»: prompt and sources', () => {
    it('also goes into the next real generation, once, near the end of the prompt', async () => {
        chatFrom(13);
        t.slice().recap.target = 'userAndPrompt';
        await s.recap.check();
        await t.ephemeral.run({ quiet: true });
        expect(t.ephemeral.injections.size).toBe(0);
        await t.ephemeral.run({ sheetCommand: '!fullsheet' });
        expect(t.ephemeral.injections.size).toBe(0);
        await t.ephemeral.run();
        expect(t.ephemeral.injections.get(RECAP_INJECTION)).toMatchObject({ position: 1, depth: 1, role: 0 });
        expect(t.ephemeral.injections.get(RECAP_INJECTION)?.text).toMatch(
            /^\[Previously in the story — the user returns after a break:\nRemembered:/,
        );
        await t.ephemeral.run();
        expect(t.ephemeral.injections.size).toBe(0);
    });

    it('drops the prompt part when the chat changes', async () => {
        chatFrom(13);
        t.slice().recap.target = 'userAndPrompt';
        await s.recap.check();
        await t.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await t.ephemeral.run();
        expect(t.ephemeral.injections.size).toBe(0);
    });

    it('asks the background model through a task, in the chat language', async () => {
        chatFrom(13, true);
        t.slice().recap.source = 'ai';
        t.llm.answer = { ok: true, text: '<think>x</think>Алиса и Боб встретились в таверне.' };
        await s.recap.check();
        expect(panel()).toBeNull();
        expect(t.tasks.queued).toEqual([
            expect.objectContaining({ kind: RECAP_TASK, dedupeKey: 'chat-1', chatId: 'chat-1', ttlMs: 30 * 60_000 }),
        ]);
        await t.tasks.runLatest(RECAP_TASK);
        expect(t.llm.requests[0]).toMatchObject({ task: RECAP_TASK, maxTokens: 400 });
        expect(t.llm.requests[0]?.messages[0]?.content).toContain('Write in natural Russian');
        expect(t.llm.requests[0]?.messages[1]?.content).toContain('Long-term memories (oldest first):');
        expect(panel()?.querySelector('.maestro-m9-recap-text')?.textContent).toBe(
            'Алиса и Боб встретились в таверне.',
        );
        expect((await storedDoc(t)).recap).toMatchObject({ source: 'ai', text: 'Алиса и Боб встретились в таверне.' });
    });

    it('falls back to the free recap when the model fails or is unavailable', async () => {
        chatFrom(13);
        t.slice().recap.source = 'ai';
        t.llm.answer = { ok: false, error: 'boom' };
        await s.recap.check();
        await t.tasks.runLatest(RECAP_TASK);
        expect(panel()?.textContent).toContain('Remembered:');
        // Unavailable: no task, the free recap right away.
        panel()?.remove();
        t.mock.chat.splice(0);
        await s.store.mutate((doc) => {
            doc.recap = null;
            return true;
        });
        chatFrom(13);
        t.llm.isAvailable = false;
        await s.recap.check();
        expect(t.tasks.queued).toHaveLength(1);
        expect(panel()?.textContent).toContain('Remembered:');
    });

    it('«Show now» ignores the timer and the target, and says so when there is nothing to tell', async () => {
        expect(await s.recap.recapNow()).toBe('');
        t.mock.chat.push(userMessage());
        expect(await s.recap.recapNow()).toBe('');
        expect(t.ui.notices.at(-1)?.text).toBe('Nothing to recap yet: no memories and no chapters.');
        chatFrom(1);
        t.slice().recap.target = 'off';
        const text = await s.recap.recapNow();
        expect(text).toContain('Remembered:');
        expect(panel()).not.toBeNull();
        expect((await storedDoc(t)).recap).toMatchObject({ source: 'memory', text });
        t.slice().recap.source = 'ai';
        t.llm.answer = { ok: true, text: 'Short recap.' };
        expect(await s.recap.recapNow()).toBe('Short recap.');
    });

    it('uses recent chronicle chapters too', async () => {
        chatFrom(13);
        await t.canon.put({
            entry: { comment: 'Chronicle: Alice — Tavern (#1–3)', content: 'Chapter: Alice — Tavern', key: ['Alice'] },
            meta: {
                kind: 'addition',
                status: 'active',
                origin: 'chronicle',
                type: 'chapter',
                typeFields: { name: 'Alice — Tavern', events: '- Alice danced.\n- Bob cheered.' },
                chronicle: {
                    id: 'ch-1',
                    from: 1,
                    to: 3,
                    indexes: [1, 3],
                    participants: [],
                    primary: null,
                    place: null,
                },
            } as never,
        });
        const text = await s.recap.recapNow();
        expect(text.startsWith('Chronicle:\n• Alice — Tavern: Alice danced. Bob cheered.')).toBe(true);
    });
});
