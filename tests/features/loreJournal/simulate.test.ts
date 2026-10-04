import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredJournal } from '../../../src/domain/lore-journal';
import { LORE_DOC_KIND, loreJournalModule } from '../../../src/features/loreJournal';
import type { LoreJournalApi } from '../../../src/features/loreJournal/api';
import { changeChat, createLoreApp, finishReply, settle, startGeneration } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { finalList, scanPayloads, wiEntry } from '../../helpers/lore-fixtures';
import type { LoopSpec } from '../../helpers/lore-fixtures';
import { message } from '../../helpers/st-mock';

const anna = wiEntry('World', 1, { comment: 'Anna', key: ['Anna'], content: 'Anna lives in the Silver Tower.' });
const tower = wiEntry('World', 2, { comment: 'Tower', key: ['silver tower'], content: 'The tower is tall.' });
const rules = wiEntry('Core', 3, { comment: 'Rules', constant: true, content: 'Write well.' });
const huge = wiEntry('World', 4, { comment: 'Huge', key: ['tower'], content: 'x'.repeat(50) });
const LOOPS: LoopSpec[] = [{ activated: [anna, rules] }, { current: 2, activated: [tower], cut: [huge] }];

async function until(check: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await settle(5);
}

interface CheckCall {
    chat: string[];
    maxContext: number;
    isDryRun: boolean;
    scanData: Record<string, unknown>;
}

describe('M1 «Что если» and key attribution', () => {
    let stand: LoreTestApp;
    let api: LoreJournalApi;
    let stop: () => Promise<void>;
    let calls: CheckCall[];
    let seenProbability: unknown[];
    let seenSimulating: boolean[];
    let seenSuspended: string[][];

    beforeEach(async () => {
        stand = createLoreApp();
        stand.mock.chat.push(
            message('Hi', { is_user: true, name: 'User' }),
            message('Hello', { name: 'Anna' }),
            message('note', { is_system: true, name: 'System' }),
            message('Tell me about Anna', { is_user: true, name: 'User' }),
        );
        calls = [];
        seenProbability = [];
        seenSimulating = [];
        seenSuspended = [];
        stand.worldInfo.checkWorldInfo = async (
            chat: string[],
            maxContext: number,
            isDryRun: boolean,
            scanData: Record<string, unknown>,
        ) => {
            calls.push({ chat, maxContext, isDryRun, scanData });
            const lists = {
                globalLore: [{ ...anna }, { ...tower, useProbability: true, probability: 10 }],
                characterLore: [],
                chatLore: [],
                personaLore: [{ ...rules }],
            };
            await stand.emit('WORLDINFO_ENTRIES_LOADED', lists);
            seenProbability = lists.globalLore.map((entry) => entry.useProbability);
            seenSimulating.push(api.simulating());
            seenSuspended.push(api.suspendedRules());
            for (const payload of scanPayloads(LOOPS)) await stand.emit('WORLDINFO_SCAN_DONE', payload);
            return { allActivatedEntries: new Set(finalList(LOOPS)) };
        };
        const started = await stand.start(loreJournalModule);
        stop = started.stop;
        api = stand.app.modules.api<LoreJournalApi>('loreJournal')!;
    });

    afterEach(async () => {
        await stop();
    });

    it('runs a deterministic dry scan the way Generate builds it', async () => {
        let transformed: unknown = null;
        const record = await api.simulate({
            suspendRules: ['rule-1'],
            transform: (lists) => {
                transformed = lists.personaLore.length;
            },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.isDryRun).toBe(true);
        expect(calls[0]?.maxContext).toBe(4000);
        expect(calls[0]?.chat).toEqual(['User: Tell me about Anna', 'Anna: Hello', 'User: Hi']);
        expect(calls[0]?.scanData).toMatchObject({
            characterDescription: 'A ranger of the north.',
            personaDescription: 'A traveller.',
            scenario: 'The forest road.',
            trigger: 'normal',
        });
        expect(seenProbability).toEqual([false, false]);
        expect(seenSimulating).toEqual([true]);
        expect(seenSuspended).toEqual([['rule-1']]);
        expect(transformed).toBe(1);
        expect(api.simulating()).toBe(false);
        expect(api.suspendedRules()).toEqual([]);
        expect(record).toMatchObject({ messageIndex: -1, simulated: true, generationType: 'simulate' });
        expect(record.activations.map((row) => [row.uid, row.cut ?? false])).toEqual([
            [1, false],
            [3, false],
            [2, false],
            [4, true],
        ]);
        // Simulations are not turns.
        expect(stand.chat.doc<StoredJournal>('chat-1', LORE_DOC_KIND)?.records ?? []).toEqual([]);
        expect(stand.chat.puts).toEqual([]);
        expect(api.turns()).toEqual([]);
    });

    it('keeps probabilities when asked and honours ST settings and regex scripts', async () => {
        stand.worldInfo.world_info_include_names = false;
        stand.caps.add('st.regex');
        stand.app.host.modules.regexEngine = async () => ({
            getRegexedString: (text: string, placement: number) => (placement === 1 ? text.toUpperCase() : text),
        });
        delete stand.script.getMaxPromptTokens;
        await api.simulate({ deterministic: false });
        expect(calls[0]?.chat).toEqual(['TELL ME ABOUT ANNA', 'Hello', 'HI']);
        expect(calls[0]?.maxContext).toBe(8192);
        expect(seenProbability).toEqual([true, true]);
    });

    it('refuses while a generation runs, without world-info.js, or twice at once', async () => {
        stand.generation = { type: 'normal', dryRun: false, quiet: false };
        await expect(api.simulate()).rejects.toThrow(/generation/);
        stand.generation = null;
        const first = api.simulate();
        await expect(api.simulate()).rejects.toThrow(/already running/);
        await first;
        delete stand.worldInfo.checkWorldInfo;
        await expect(api.simulate()).rejects.toThrow(/checkWorldInfo/);
    });

    it('attributes keys of the last turn from memory and stores them', async () => {
        await startGeneration(stand);
        for (const payload of scanPayloads(LOOPS)) await stand.emit('WORLDINFO_SCAN_DONE', payload);
        await stand.emit('WORLD_INFO_ACTIVATED', finalList(LOOPS));
        stand.mock.chat.push(message('Anna smiles.', { name: 'Anna' }));
        await finishReply(stand, 4);
        await until(() => api.turns().length > 0);
        const record = api.last()!;
        expect(record.activations.every((row) => row.key === undefined)).toBe(true);

        const keyed = await api.attributeKeys(record);
        const keys = Object.fromEntries(keyed.activations.map((row) => [row.uid, row.key]));
        expect(keys).toEqual({ 1: 'Anna', 3: '', 2: 'silver tower', 4: 'tower' });
        const doc = stand.chat.doc<StoredJournal>('chat-1', LORE_DOC_KIND)!;
        expect(doc.records[0]?.a.map((tuple) => tuple[14])).toEqual(['Anna', '', 'silver tower', 'tower']);
        expect(api.last()?.activations[0]?.key).toBe('Anna');
        // Already attributed keys are kept.
        expect((await api.attributeKeys(api.last()!)).activations[0]?.key).toBe('Anna');
    });

    it('attributes keys of older turns from the books', async () => {
        await startGeneration(stand, 'continue');
        for (const payload of scanPayloads([{ activated: [anna, rules] }]))
            await stand.emit('WORLDINFO_SCAN_DONE', payload);
        await finishReply(stand, 3, 'continue');
        await until(() => api.turns().length > 0);
        // A chat switch forgets the in-memory scan: the books are read instead.
        await changeChat(stand, 'chat-2');
        await changeChat(stand, 'chat-1');
        stand.books.set('World', {
            entries: {
                1: { uid: 1, key: ['{{char}}'], content: 'Anna lives here.', scanDepth: 1, matchScenario: true },
                5: { uid: 5, key: ['x'] },
                junk: 'no' as unknown as Record<string, unknown>,
            },
        });
        stand.ctx.substituteParams = (text: string) => text.replace('{{char}}', 'Anna');
        const record = api.last()!;
        const keyed = await api.attributeKeys(record);
        // 'continue' scans the continued message too (index 3: "Tell me about Anna").
        expect(keyed.activations.map((row) => [row.uid, row.key])).toEqual([
            [1, '{{char}}'],
            [3, ''],
        ]);
    });

    it('attributes keys of a simulation without storing them', async () => {
        const record = await api.simulate();
        const keyed = await api.attributeKeys(record);
        expect(keyed.activations.find((row) => row.uid === 1)?.key).toBe('');
        expect(stand.chat.puts).toEqual([]);
    });
});
