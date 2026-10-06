import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { medicModule } from '../../../src/features/medic';
import { REPAIR_KIND, TRACKER_TARGET } from '../../../src/features/medic/tracker-repair';
import { message } from '../../helpers/st-mock';
import { createFeatureEnv, flush, withTracker } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

const MODEL_ANSWER = JSON.stringify({
    infoBox: { location: { value: 'Tavern' } },
    characters: [{ name: 'Anna', details: { appearance: 'red hair' } }],
});

let env: FeatureEnv;
let stop: () => Promise<void>;

function lastSwipe(index = 1): Record<string, unknown> | undefined {
    const swipes = env.mock.chat[index]?.extra?.dooms_tracker_swipes as Record<string, Record<string, unknown>>;
    return swipes?.['0'];
}

async function reply(index = env.mock.chat.length - 1, type = 'normal'): Promise<void> {
    await env.app.bus.emit('reply:ready', { messageIndex: index, type });
    await flush();
}

beforeEach(async () => {
    env = await createFeatureEnv();
    env.mock.chat.push(message('Hello there', { is_user: true }), message('The tavern is warm.'));
    env.llm.request.mockResolvedValue({ ok: true, text: MODEL_ANSWER });
    env.mock.context.substituteParams = (text: string) => text.replace('{{persona}}', 'the hero');
    stop = await env.start(medicModule);
});

afterEach(async () => {
    await stop();
});

describe('tracker repair after a reply (together mode)', () => {
    it('asks the model with DES prompt and stores the tracker like DES does', async () => {
        await reply();

        expect(env.llm.request).toHaveBeenCalledTimes(1);
        const request = env.llm.request.mock.calls[0]![0];
        expect(request.task).toBe(REPAIR_KIND);
        expect(request.messages[0]).toEqual({ role: 'system', content: 'Tracker for the hero' });

        const stored = lastSwipe();
        expect(stored?.infoBox).toBe('{"location":{"value":"Tavern"}}');
        expect(typeof stored?.characterThoughts).toBe('string');
        expect(stored?.quests).toBeNull();
        expect(env.des.state.lastGeneratedData.infoBox).toBe('{"location":{"value":"Tavern"}}');
        // committedTrackerData already had content: left for DES to commit on the next send.
        expect(env.des.state.committedTrackerData.infoBox).toBe('{"location":"old"}');
        expect(env.des.saveChatData).toHaveBeenCalledWith({ immediate: true });
        expect(env.des.renders).toHaveBeenCalledWith('infoBox');
        expect(env.des.renders).toHaveBeenCalledWith('json:1');

        await env.journal.load();
        const record = env.journal.list({ module: 'M3' })[0];
        expect(record?.kind).toBe(REPAIR_KIND);
        expect(record?.changes[0]?.target).toBe(TRACKER_TARGET);
        // Announced once by autonomy (appliedNotice, grouped per turn), with an undo action.
        const done = env.ui.notices.filter((notice) => notice.text === 'Restored the DES tracker of reply #2.');
        expect(done).toHaveLength(1);
        expect(done[0]!.options?.group).toBe(REPAIR_KIND);
        expect(done[0]!.options?.groupText?.(3)).toBe('Restored the DES tracker of 3 replies');
        expect(done[0]!.options?.action).toBeDefined();
    });

    it('repairs on request for M12 and reports a tracker that is already there', async () => {
        const api = env.app.modules.api<{ repairTracker(index: number): Promise<boolean> }>('medic')!;
        expect(await api.repairTracker(1)).toBe(true);
        expect(env.llm.request).toHaveBeenCalledTimes(1);
        expect(lastSwipe()?.infoBox).toBe('{"location":{"value":"Tavern"}}');
        expect(await api.repairTracker(1)).toBe(true);
        expect(env.llm.request).toHaveBeenCalledTimes(1);
    });

    it('commits the first tracker of a chat, as updateRPGData does', async () => {
        env.des.state.committedTrackerData = { quests: null, infoBox: null, characterThoughts: null };
        await reply();
        expect(env.des.state.committedTrackerData.infoBox).toBe('{"location":{"value":"Tavern"}}');
    });

    it('can be undone from the journal', async () => {
        await reply();
        await env.journal.load();
        const record = env.journal.list({ module: 'M3' })[0]!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(lastSwipe()).toBeUndefined();
        expect(env.des.state.lastGeneratedData.infoBox).toBe('{"location":"old"}');
    });

    it('refuses to undo after the tracker changed again', async () => {
        await reply();
        await env.journal.load();
        const record = env.journal.list({ module: 'M3' })[0]!;
        withTracker(env.mock.chat[1]!, { quests: null, infoBox: '{"location":"elsewhere"}', characterThoughts: null });
        expect(await env.journal.undo(record.id)).toBe(false);
    });

    it('leaves replies with a tracker, sheets and greetings alone', async () => {
        withTracker(env.mock.chat[1]!, { quests: null, infoBox: '{"location":"x"}', characterThoughts: null });
        await reply();
        env.mock.chat.push(message('!fullsheet Anna', { is_user: true }), message('Sheet text'));
        await reply();
        env.mock.chat.push(message('A scene', { extra: { maestro: { sheet: true } } }));
        await reply();
        await reply(env.mock.chat.length - 1, 'first_message');
        expect(env.llm.request).not.toHaveBeenCalled();
    });

    it('does nothing when DES is not in together mode or shows no section', async () => {
        env.adapters.des.mode = 'separate';
        await reply();
        env.adapters.des.mode = 'together';
        env.adapters.des.settings = { showInfoBox: false, showCharacterThoughts: false, showQuests: false };
        await reply();
        expect(env.llm.request).not.toHaveBeenCalled();
    });

    it('respects the off switch and the autonomy level', async () => {
        env.settings.module<{ trackerRepair: boolean }>('medic').trackerRepair = false;
        await reply();
        env.settings.module<{ trackerRepair: boolean }>('medic').trackerRepair = true;
        env.settings.core().autonomy[REPAIR_KIND] = 'off';
        await reply();
        expect(env.llm.request).not.toHaveBeenCalled();
    });

    it('queues an Inbox card at level inbox and applies it on accept', async () => {
        env.settings.core().autonomy[REPAIR_KIND] = 'inbox';
        await reply();
        expect(lastSwipe()).toBeUndefined();
        await env.inbox.load();
        const card = env.inbox.list().find((item) => item.kind === REPAIR_KIND);
        expect(card).toBeDefined();
        expect(await env.inbox.accept(card!.id)).toBe(true);
        expect(lastSwipe()?.infoBox).toBe('{"location":{"value":"Tavern"}}');
    });

    it('drops the repair when the reply was edited meanwhile', async () => {
        env.settings.core().autonomy[REPAIR_KIND] = 'inbox';
        await reply();
        env.mock.chat[1]!.mes = 'Edited reply';
        await env.inbox.load();
        const card = env.inbox.list().find((item) => item.kind === REPAIR_KIND)!;
        expect(await env.inbox.accept(card.id)).toBe(false);
        expect(lastSwipe()).toBeUndefined();
    });

    it('reports a blocked repair with a «Fix» action that runs it', async () => {
        env.adapters.des.workshopOpen = true;
        await reply();
        expect(env.llm.request).not.toHaveBeenCalled();
        const notice = env.ui.notices.find((item) => item.options?.action);
        expect(notice?.text).toContain('Workshop');
        expect(notice?.options?.importance).toBe('important');
        env.adapters.des.workshopOpen = false;
        notice!.options!.action!.run();
        await flush();
        expect(lastSwipe()?.infoBox).toBe('{"location":{"value":"Tavern"}}');
        await env.journal.load();
        expect(env.journal.list({ module: 'M3' })).toHaveLength(1);
        // A direct reply to his click: always shown.
        expect(env.ui.notices.at(-1)).toMatchObject({
            text: 'Restored the DES tracker of reply #2.',
            options: { importance: 'urgent' },
        });
    });

    it('reports model failures and unreadable answers', async () => {
        env.llm.request.mockResolvedValueOnce({ ok: false, error: 'boom' });
        await reply();
        env.llm.request.mockResolvedValueOnce({ ok: true, text: 'no json here' });
        await reply();
        env.llm.request.mockResolvedValueOnce({ ok: false, error: 'cap' });
        await reply();
        const texts = env.ui.notices.map((notice) => notice.text);
        expect(texts.some((text) => text.includes('model request failed'))).toBe(true);
        expect(texts.some((text) => text.includes("could not read the model's answer"))).toBe(true);
        expect(texts.some((text) => text.includes('limit'))).toBe(true);
        expect(lastSwipe()).toBeUndefined();
    });

    it('waits while a generation runs and without a background profile', async () => {
        env.generation.current = { type: 'normal', dryRun: false, quiet: false };
        await reply();
        env.generation.current = null;
        env.llm.available.mockReturnValue(false);
        await reply();
        expect(env.llm.request).not.toHaveBeenCalled();
        expect(env.ui.notices.filter((notice) => notice.options?.action)).toHaveLength(2);
    });

    it('falls back to a compact prompt without DES prompt builder', async () => {
        env.des.drop('src/systems/generation/promptBuilder.js');
        withTracker(env.mock.chat[0]!, {});
        env.mock.chat.unshift(message('Earlier'));
        withTracker(env.mock.chat[0]!, { quests: null, infoBox: '{"location":"Gate"}', characterThoughts: null });
        await reply();
        const messages = env.llm.request.mock.calls[0]![0].messages;
        expect(messages.at(-1)?.content).toContain('"location": "Gate"');
        expect(lastSwipe(2)?.infoBox).toBe('{"location":{"value":"Tavern"}}');
    });

    it('cannot repair without DES modules', async () => {
        env.des.drop('src/core/state.js');
        await reply();
        expect(env.llm.request).not.toHaveBeenCalled();
        expect(env.ui.notices.some((notice) => notice.text.includes('modules could not be loaded'))).toBe(true);
    });

    it('warns about raw NAI markers, empty field keys and damaged JSON', async () => {
        env.adapters.nai.present = true;
        env.mock.chat[1]!.mes = 'Text <img data-nai=\'{"p":1}\'>';
        withTracker(env.mock.chat[1]!, {
            quests: null,
            infoBox: null,
            characterThoughts: JSON.stringify([{ name: 'A', details: { '': 'x' } }]),
        });
        await reply();
        env.mock.chat.push(message('Next', { is_user: true }), message('```json\n{"infoBox": broken}\n```'));
        env.llm.request.mockResolvedValue({ ok: false, error: 'x' });
        await reply();
        const texts = env.ui.notices.map((notice) => notice.text);
        expect(texts).toContain('The pictures of reply #2 were not drawn: NAI Studio left its markers unprocessed.');
        expect(texts.some((text) => text.includes('Russian field names vanished'))).toBe(true);
        expect(texts.some((text) => text.includes('Doctor'))).toBe(true);
        // Plain words only: no raw markup in the notices.
        expect(texts.some((text) => text.includes('<img'))).toBe(false);
    });
});
