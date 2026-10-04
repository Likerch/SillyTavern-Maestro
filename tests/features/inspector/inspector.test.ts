import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECTOR_DOC_KIND, inspectorModule } from '../../../src/features/inspector';
import type { InspectorApi, InspectorRecord } from '../../../src/features/inspector/api';
import { loreJournalModule } from '../../../src/features/loreJournal';
import { changeChat, createLoreApp, finishReply, settle, startGeneration } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { finalList, scanPayloads, wiEntry } from '../../helpers/lore-fixtures';
import type { LoopSpec } from '../../helpers/lore-fixtures';
import { QVINK_MEMORY, installPromptManager, installSlots, promptMessages } from '../../helpers/lore-prompt';

const anna = wiEntry('World', 1, { comment: 'Anna', key: ['Anna'], content: 'Anna lives in the Silver Tower.' });
const tower = wiEntry('World', 2, { key: ['tower'], content: 'The tower is tall.', position: 4 });
const LOOPS: LoopSpec[] = [{ activated: [anna] }, { current: 2, activated: [tower] }];
const COUNTS = {
    start_chat: 0,
    main: 300,
    worldInfoBefore: 120,
    chatHistory: 900,
    dooms_tracker: 80,
    charDescription: 50,
};

const tokens = (text: string): number => Math.ceil(text.length / 4);

async function until(check: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await settle(5);
}

function byId(record: InspectorRecord | undefined): Record<string, number> {
    return Object.fromEntries((record?.sources ?? []).map((source) => [source.id, source.tokens]));
}

describe('M2 inspector', () => {
    let stand: LoreTestApp;
    let api: InspectorApi;
    const stops: (() => Promise<void>)[] = [];

    async function startInspector(withJournal: boolean): Promise<void> {
        if (withJournal) stops.push((await stand.start(loreJournalModule)).stop);
        stops.push((await stand.start(inspectorModule)).stop);
        api = stand.app.modules.api<InspectorApi>('inspector')!;
        await settle(10);
    }

    async function playTurn(index: number, options: { scan?: boolean; type?: string } = {}): Promise<void> {
        await startGeneration(stand, options.type);
        if (options.scan) {
            for (const payload of scanPayloads(LOOPS)) await stand.emit('WORLDINFO_SCAN_DONE', payload);
            await stand.emit('WORLD_INFO_ACTIVATED', finalList(LOOPS));
        }
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await finishReply(stand, index, options.type);
        await until(() => api.turns().some((record) => record.messageIndex === index));
    }

    beforeEach(() => {
        stand = createLoreApp();
        installPromptManager(stand, { ...COUNTS });
        installSlots(stand);
    });

    afterEach(async () => {
        vi.useRealTimers();
        for (const stop of stops.splice(0).reverse()) await stop();
    });

    it('reconstructs the weights of a real turn without the lore journal', async () => {
        await startInspector(false);
        await playTurn(3);
        const record = api.last()!;
        const qvink = tokens(QVINK_MEMORY);
        const depthLore = tokens('The tower is tall.');
        const depthRule = tokens('Stay in voice now.');
        expect(record).toMatchObject({
            messageIndex: 3,
            generationType: 'normal',
            messages: 3,
            totalTokens: 1450,
            exact: true,
            loreByBook: false,
        });
        expect(record.chars.user).toBeGreaterThan(0);
        expect(byId(record)).toEqual({
            'preset:main': 300,
            'card:charDescription': 50,
            'ext:des': 80,
            'ext:qvink': qvink,
            'preset:depthRule': depthRule,
            'lore:': 120 + depthLore,
            history: 900 - qvink - depthLore - depthRule,
        });
        expect(record.sources.find((source) => source.id === 'preset:main')?.name).toBe('Main');
        expect(stand.chat.doc<{ records: InspectorRecord[] }>('chat-1', INSPECTOR_DOC_KIND)?.records).toHaveLength(1);
    });

    it('splits lore by book with the lore journal on', async () => {
        await startInspector(true);
        await playTurn(3, { scan: true });
        const record = api.last()!;
        expect(record.loreByBook).toBe(true);
        const sources = byId(record);
        expect(sources['lore:World']).toBe(tokens(String(anna.content)) + tokens(String(tower.content)));
        expect(sources['preset:worldInfoFormat']).toBe(120 - tokens(String(anna.content)));
        expect(sources['lore:']).toBeUndefined();
    });

    it('waits for the lore journal record and gives up after a while', async () => {
        await startInspector(false);
        // A journal that never reports this turn.
        stand.app.modules.expose('loreJournal', { last: () => undefined, onTurn: () => () => {} });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await startGeneration(stand);
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await stand.app.bus.emit('reply:ready', { messageIndex: 3, type: 'normal' });
        await settle(50);
        expect(api.turns()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(6000);
        await settle(50);
        expect(api.last()?.loreByBook).toBe(false);
    });

    it('uses an empty lore record when no book is active', async () => {
        await startInspector(true);
        await playTurn(3);
        expect(api.last()?.loreByBook).toBe(true);
        expect(byId(api.last())['lore:']).toBeUndefined();
    });

    it('drops a captured prompt when the reply comes long after the generation ended', async () => {
        await startInspector(false);
        await startGeneration(stand);
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await stand.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        await finishReply(stand, 3);
        expect(api.turns()).toEqual([]);
        // Impersonation is not a turn.
        vi.restoreAllMocks();
        await startGeneration(stand, 'impersonate');
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await finishReply(stand, 3);
        expect(api.turns()).toEqual([]);
    });

    it('records only real generations', async () => {
        await startInspector(false);
        // No generation: a PROMPT_READY from generateRaw of another extension.
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await finishReply(stand, 1);
        // Prompt Manager dry run.
        await stand.emit('GENERATION_STARTED', 'normal', {}, true);
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: true });
        await finishReply(stand, 1);
        // Quiet generation.
        await stand.emit('GENERATION_STARTED', 'quiet', {}, false);
        await stand.app.bus.emit('generation:before', { type: 'quiet', dryRun: false, quiet: true });
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await finishReply(stand, 1);
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', 'junk');
        expect(api.turns()).toEqual([]);
    });

    it('estimates without Prompt Manager counts', async () => {
        stand.caps.delete('st.oai.promptManager');
        await startInspector(false);
        await playTurn(2);
        const record = api.last()!;
        const total = promptMessages().reduce((sum, item) => sum + tokens(item.content), 0);
        expect(record.exact).toBe(false);
        expect(record.totalTokens).toBe(total);
        expect(byId(record)['ext:des']).toBe(tokens('Tracker: Anna is present.'));
        expect(byId(record)['preset:depthRule']).toBeUndefined();
    });

    it('keeps a rolling list per chat and forgets deleted messages', async () => {
        await startInspector(false);
        const seen: InspectorRecord[] = [];
        const off = api.onTurn((record) => seen.push(record));
        await playTurn(3);
        await playTurn(5, { type: 'swipe' });
        await playTurn(5, { type: 'regenerate' });
        expect(api.turns().map((record) => [record.messageIndex, record.generationType])).toEqual([
            [3, 'normal'],
            [5, 'regenerate'],
        ]);
        expect(api.turns(1)).toHaveLength(1);
        expect(api.turns(0)).toEqual([]);
        expect(seen).toHaveLength(3);
        off();

        stand.mock.chat.length = 0;
        for (let i = 0; i < 4; i++)
            stand.mock.chat.push({ name: 'x', is_user: false, is_system: false, send_date: '', mes: '' });
        await stand.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'deleted' });
        await settle(20);
        expect(api.turns().map((record) => record.messageIndex)).toEqual([3]);

        await changeChat(stand, 'chat-2');
        expect(api.turns()).toEqual([]);
        expect(api.last()).toBeUndefined();
        await changeChat(stand, 'chat-1');
        expect(api.turns()).toHaveLength(1);
    });

    it('trims to the configured number of turns and survives broken counts', async () => {
        stops.push((await stand.start(inspectorModule, { keepTurns: 1 })).stop);
        api = stand.app.modules.api<InspectorApi>('inspector')!;
        await settle(10);
        await playTurn(1);
        (stand.openai.promptManager as { tokenHandler: unknown }).tokenHandler = {
            getCounts: () => {
                throw new Error('broken');
            },
        };
        (stand.openai.promptManager as { getPromptOrderForCharacter: unknown }).getPromptOrderForCharacter = () => {
            throw new Error('broken');
        };
        await playTurn(3);
        expect(api.turns().map((record) => [record.messageIndex, record.exact])).toEqual([[3, false]]);
    });

    it('releases everything when stopped', async () => {
        await startInspector(false);
        for (const stop of stops.splice(0).reverse()) await stop();
        expect(stand.listenerCount('CHAT_COMPLETION_PROMPT_READY')).toBe(0);
        expect(stand.listenerCount('GENERATION_STARTED')).toBe(0);
        expect(stand.tabs).toHaveLength(0);
        expect(stand.styles.has('maestro-m2')).toBe(false);
    });
});
