// M20 at CHAT_COMPLETION_PROMPT_READY: injection budgets (CK RAG, Qvink short-term, DES context), repeated facts with
// the user's consent (report → keep one source → drop the others on the fly → withdraw / undo), the P16 order check
// and the turn report.
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/domain/rules-lore';
import { CONSENT_TARGET } from '../../../src/features/architect/service';
import { switchChat } from '../../helpers/core-host';
import { book, entry } from '../../helpers/rules-wi';
import { EVENT_TYPES, message } from '../../helpers/st-mock';
import { architectSettings, runTurn, setPrompts, startArchitect, tick, trackerReply, userMessage } from './helpers';
import type { ArchitectTestApp } from './helpers';

type Msg = { role: string; content: unknown };

let app: ArchitectTestApp;

afterEach(async () => {
    await app?.stop();
});

async function start(): Promise<ArchitectTestApp> {
    app = await startArchitect({
        world: [{ id: 'character:anna', kind: 'character', name: 'Anna', roster: true, present: true }],
    });
    app.env.mock.chat = [userMessage('Hi.'), trackerReply('Anna waves.', ['Anna']), userMessage('Hello Anna.')];
    return app;
}

const NO_BOOKS = { books: [], chatText: '' };

function content(messages: Msg[], index: number): string {
    return String(messages[index]?.content);
}

describe('CK RAG budget', () => {
    const chunks = [
        '### Anna — Looks\nTags: elf\nAnna is tall. She has green eyes.',
        `### Anna — Past\n${'Anna grew up in the north. '.repeat(8).trim()}`,
        `### Bob — Looks\n${'Bob is short and loud. '.repeat(8).trim()}`,
    ];
    const rag = chunks.join('\n\n');

    it('drops whole chunks from the end in the prompt and leaves CK’s slot alone', async () => {
        await start();
        architectSettings(app).budgets.ckRag = estimateTokens(chunks[0]!.length) + 2;
        setPrompts(app, { carrotkernel_rag: { value: rag, position: 0 } });
        const messages: Msg[] = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: rag },
            { role: 'user', content: 'Hello Anna.' },
        ];
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(content(messages, 1)).toBe(chunks[0]);
        const slots = (app.env.mock.context as unknown as { extensionPrompts: Record<string, { value: string }> })
            .extensionPrompts;
        expect(slots.carrotkernel_rag!.value).toBe(rag);
        const report = app.api.lastReport()!;
        const row = report.budgets.find((item) => item.source === 'ckRag')!;
        expect(row.status).toBe('trimmed');
        expect(row.used).toBeLessThanOrEqual(row.limit);
        expect(row.cut).toBeGreaterThan(0);
        expect(report.trims).toEqual([
            { source: 'ckRag', key: 'carrotkernel_rag', before: estimateTokens(rag.length), after: row.used, units: 2 },
        ]);
        expect(report.effects?.find((effect) => effect.rule === 'ckRag')?.count).toBe(2);
    });

    it('removes a message the budget emptied and reports when the text is not in the prompt', async () => {
        await start();
        architectSettings(app).budgets.ckRag = 1;
        setPrompts(app, { carrotkernel_rag: { value: rag, position: 0 } });
        const messages: Msg[] = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: rag },
            { role: 'user', content: 'Hello.' },
        ];
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(messages.map((item) => item.content)).toEqual(['Main prompt.', 'Hello.']);

        const elsewhere: Msg[] = [{ role: 'user', content: 'No RAG here.' }];
        await runTurn(app, { ...NO_BOOKS, messages: elsewhere });
        expect(app.api.lastReport()!.budgets.find((item) => item.source === 'ckRag')?.status).toBe('notFound');
        expect(elsewhere[0]!.content).toBe('No RAG here.');
    });
});

describe('Qvink and DES budgets', () => {
    it('trims the oldest short-term memories in the prompt and never the long-term ones', async () => {
        await start();
        const memories = ['Anna met Bob at the gate.', 'They crossed the river at night.', 'A storm broke the bridge.'];
        app.env.mock.chat = [
            message('one', { extra: { qvink_memory: { memory: memories[0], include: 'short' } } }),
            message('two', { extra: { qvink_memory: { memory: memories[1], include: 'short' } } }),
            message('three', { extra: { qvink_memory: { memory: memories[2], include: 'short' } } }),
            userMessage('Go on.'),
        ];
        const short = `[Following is a list of recent events]:\n* ${memories.join('\n* ')}\n`;
        const long = `[Following is a list of events that occurred in the past]:\n* ${'A very old memory. '.repeat(20)}\n`;
        architectSettings(app).budgets.qvink = estimateTokens(short.length) - 5;
        setPrompts(app, {
            qvink_memory_short: { value: short, position: 1, depth: 2 },
            qvink_memory_long: { value: long, position: 1, depth: 2 },
        });
        // ST trims in-chat injections and glues the ones of one depth and role.
        const messages: Msg[] = [
            { role: 'system', content: 'Main.' },
            { role: 'system', content: `${long.trim()}\n${short.trim()}` },
            { role: 'user', content: 'Go on.' },
        ];
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(content(messages, 1)).toBe(
            `${long.trim()}\n[Following is a list of recent events]:\n* ${memories[1]}\n* ${memories[2]}`,
        );
        expect(app.api.lastReport()!.trims?.[0]).toMatchObject({ source: 'qvink', units: 1 });
    });

    it('trims by sentences when the memories are not in the text', async () => {
        await start();
        const short = '[Recent]:\nFirst thing happened here. Second thing happened there. Third thing now.';
        architectSettings(app).budgets.qvink = estimateTokens('[Recent]:\nThird thing now.'.length) + 1;
        setPrompts(app, { qvink_memory_short: { value: short, position: 1, depth: 1 } });
        const messages: Msg[] = [{ role: 'system', content: short }];
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(content(messages, 0)).toBe('[Recent]:\nThird thing now.');
    });

    it('shortens only DES’s context block, oldest sentences first, keeping its tags', async () => {
        await start();
        const context = '<context>\nOld one happened. Old two happened. The newest thing.\n</context>';
        const instructions = `Tracker format: ${'Follow the JSON format. '.repeat(40)}`;
        const settings = architectSettings(app);
        settings.budgets.des = estimateTokens('<context>\nThe newest thing.\n</context>'.length) + 1;
        setPrompts(app, {
            'dooms-tracker-context': { value: context, position: 1, depth: 1 },
            'dooms-tracker-inject': { value: instructions, position: 1, depth: 0 },
        });
        const messages: Msg[] = [
            { role: 'system', content: context },
            { role: 'user', content: `Hi\n${instructions.trim()}` },
        ];
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(content(messages, 0)).toBe('<context>\nThe newest thing.\n</context>');
        expect(content(messages, 1)).toBe(`Hi\n${instructions.trim()}`);
    });

    it('reports sources of later stages and empty slots', async () => {
        await start();
        const settings = architectSettings(app);
        settings.budgets.voices = 300;
        settings.budgets.ckRag = 300;
        await runTurn(app, { ...NO_BOOKS, messages: [{ role: 'user', content: 'Hi' }] });
        const rows = app.api.lastReport()!.budgets;
        expect(rows.map((row) => row.source)).toEqual([
            'lore',
            'ckRag',
            'qvink',
            'des',
            'voices',
            'mechanics',
            'director',
        ]);
        expect(rows.find((row) => row.source === 'voices')?.status).toBe('noSource');
        expect(rows.find((row) => row.source === 'director')?.status).toBe('off');
        expect(rows.find((row) => row.source === 'ckRag')?.status).toBe('empty');
        expect(rows.find((row) => row.source === 'lore')?.status).toBe('off');
    });
});

describe('dry runs and quiet prompts', () => {
    it('ignores dry runs and trims quiet prompts without a report', async () => {
        await start();
        architectSettings(app).budgets.des = 5;
        const context = '<context>\nOld one happened here. Old two happened there. New.\n</context>';
        setPrompts(app, { 'dooms-tracker-context': { value: context, position: 1, depth: 1 } });
        const dry: Msg[] = [{ role: 'system', content: context }];
        await app.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, { chat: dry, dryRun: true });
        expect(content(dry, 0)).toBe(context);
        const quiet: Msg[] = [{ role: 'system', content: context }];
        await app.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, { chat: quiet, dryRun: false });
        await tick();
        expect(content(quiet, 0)).not.toBe(context);
        expect(app.api.lastReport()).toBeNull();
    });
});

describe('repeated facts', () => {
    const SCAR = 'Anna has an old scar across her left cheek from the war.';
    const SHORT = `[Following is a list of recent events]:\n* ${SCAR}\n* They left the town together at dawn.\n`;
    const books = () => [
        book('World', [entry(1, { comment: 'Notes', key: ['scar'], content: `Anna is a mage. ${SCAR}` })]),
    ];
    const prompt = (): Msg[] => [
        { role: 'system', content: 'Main.' },
        { role: 'system', content: `World info: Anna is a mage. ${SCAR}` },
        { role: 'system', content: SHORT.trim() },
        { role: 'user', content: 'Tell me about the scar.' },
    ];

    async function turn(): Promise<Msg[]> {
        setPrompts(app, { qvink_memory_short: { value: SHORT, position: 1, depth: 2 } });
        const messages = prompt();
        await runTurn(app, { books: books(), chatText: 'scar', messages });
        return messages;
    }

    it('reports the fact first and changes nothing', async () => {
        await start();
        const messages = await turn();
        const facts = app.api.duplicates();
        expect(facts).toHaveLength(1);
        expect(facts[0]).toMatchObject({ text: SCAR, keep: null });
        expect(facts[0]!.sources.map((source) => [source.owner, source.ref])).toEqual([
            ['lore', 'World#1'],
            ['qvink', 'qvink_memory_short'],
        ]);
        expect(app.api.lastReport()?.duplicates).toHaveLength(1);
        expect(content(messages, 2)).toBe(SHORT.trim());
    });

    it('keeps one source by consent and drops the lore copy on the next scans', async () => {
        await start();
        await turn();
        const fact = app.api.duplicates()[0]!;
        await app.api.keepSource(fact.id, 'qvink_memory_short');
        const doc = app.store.doc<{ consents: { keep: string }[] }>('chat-1', 'architect');
        expect(doc?.consents.map((item) => item.keep)).toEqual(['qvink_memory_short']);
        const record = app.env.journal.records.at(-1)!;
        expect(record.changes[0]!.target).toBe(CONSENT_TARGET);

        const messages = await turn();
        // The scan copy lost the sentence: the activated entry (what WI puts into the prompt) no longer has it.
        const report = app.api.lastReport()!;
        expect(report.dropped).toEqual([
            { duplicateId: fact.id, owner: 'lore', ref: 'World#1', tokens: estimateTokens(SCAR.length) },
        ]);
        expect(report.effects?.find((effect) => effect.rule === 'dedup')?.count).toBe(1);
        expect(content(messages, 2)).toBe(SHORT.trim());
        const listed = app.api.duplicates();
        expect(listed).toHaveLength(1);
        expect(listed[0]!.keep).toBe('qvink_memory_short');
        // With the search off, consented facts stay listed (the consent can still be withdrawn).
        architectSettings(app).duplicates.detect = false;
        await turn();
        expect(app.api.duplicates().map((item) => item.keep)).toEqual(['qvink_memory_short']);
    });

    it('keeps the lore copy and drops the sentence from the injection, then withdraws and undoes', async () => {
        await start();
        await turn();
        const fact = app.api.duplicates()[0]!;
        await app.api.keepSource(fact.id, 'lore');
        let messages = await turn();
        expect(content(messages, 2)).toBe(
            '[Following is a list of recent events]:\n* They left the town together at dawn.',
        );
        expect(app.api.lastReport()!.dropped?.[0]).toMatchObject({ owner: 'qvink', ref: 'qvink_memory_short' });

        await app.api.keepSource(fact.id, null);
        messages = await turn();
        expect(content(messages, 2)).toBe(SHORT.trim());
        expect(app.api.duplicates()[0]!.keep).toBeNull();

        // Undo of the withdrawal brings the consent back.
        const withdrawal = app.env.journal.records.at(-1)!;
        expect(await app.env.journal.undo(withdrawal.id)).toBe(true);
        messages = await turn();
        expect(content(messages, 2)).toBe(
            '[Following is a list of recent events]:\n* They left the town together at dawn.',
        );
    });

    it('ignores unknown facts and sources, and stops looking when switched off', async () => {
        await start();
        await turn();
        await app.api.keepSource('missing', 'lore');
        await app.api.keepSource(app.api.duplicates()[0]!.id, 'nobody');
        expect(app.store.doc('chat-1', 'architect')).toMatchObject({ consents: [] });
        architectSettings(app).duplicates.detect = false;
        await turn();
        expect(app.api.lastReport()?.duplicates).toEqual([]);
    });

    it('keeps consents per chat', async () => {
        await start();
        await turn();
        await app.api.keepSource(app.api.duplicates()[0]!.id, 'qvink');
        await switchChat(app.env.mock, 'chat-2');
        await app.env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        await tick();
        expect(app.api.duplicates()).toEqual([]);
        expect(app.api.lastReport()).toBeNull();
        const messages = await turn();
        expect(content(messages, 2)).toBe(SHORT.trim());
        expect(app.api.duplicates()[0]!.keep).toBeNull();
    });
});

describe('P16 order check and the report', () => {
    function prompt(note: string, tail: string[], noteAt: number): Msg[] {
        const messages: Msg[] = [
            { role: 'system', content: 'Main.' },
            ...tail.map((text, index) => ({
                role: index % 2 ? 'assistant' : 'user',
                content: text,
            })),
        ];
        messages.splice(noteAt, 0, { role: 'system', content: note });
        return messages;
    }

    it('reports a changing Maestro injection before unchanged messages', async () => {
        await start();
        setPrompts(app, { maestro_note: { value: 'Director: slow down.', position: 1, depth: 2 } });
        await runTurn(app, { ...NO_BOOKS, messages: prompt('Director: slow down.', ['u1', 'a1', 'u2'], 2) });
        expect(app.api.lastReport()?.order).toEqual([]);

        setPrompts(app, { maestro_note: { value: 'Director: a twist.', position: 1, depth: 4 } });
        await runTurn(app, { ...NO_BOOKS, messages: prompt('Director: a twist.', ['u1', 'a1', 'u2', 'a2', 'u3'], 2) });
        expect(app.api.lastReport()?.order).toEqual([
            { key: 'maestro_note', messageIndex: 2, stableAfter: 2, position: 1, depth: 4 },
        ]);

        setPrompts(app, { maestro_note: { value: 'Director: at the end.', position: 1, depth: 0 } });
        await runTurn(app, {
            ...NO_BOOKS,
            messages: prompt('Director: at the end.', ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4'], 8),
        });
        expect(app.api.lastReport()?.order).toEqual([]);
    });

    it('flags an injection in the prompt head without a previous request; the check can be off', async () => {
        await start();
        setPrompts(app, { maestro_head: { value: 'Volatile head.', position: 0 } });
        await runTurn(app, { ...NO_BOOKS, messages: prompt('Volatile head.', ['u1'], 1) });
        expect(app.api.lastReport()?.order?.[0]).toMatchObject({ key: 'maestro_head', stableAfter: 1 });
        architectSettings(app).cache.orderCheck = false;
        await runTurn(app, { ...NO_BOOKS, messages: prompt('Volatile head.', ['u1'], 1) });
        expect(app.api.lastReport()?.order).toEqual([]);
    });

    it('binds the report to the reply and keeps the recent ones', async () => {
        await start();
        const seen: number[] = [];
        const off = app.api.onReport((report) => seen.push(report.at));
        await runTurn(app, { ...NO_BOOKS, messages: [{ role: 'user', content: 'Hi' }] });
        await app.env.app.bus.emit('reply:ready', { messageIndex: 3, type: 'normal' });
        expect(app.api.lastReport()?.messageIndex).toBe(3);
        expect(app.api.lastReport()?.generationType).toBe('normal');
        await runTurn(app, { ...NO_BOOKS, messages: [{ role: 'user', content: 'Again' }] });
        off();
        await runTurn(app, { ...NO_BOOKS, messages: [{ role: 'user', content: 'Third' }] });
        expect(seen).toHaveLength(2);
        expect(app.api.reports?.()).toHaveLength(3);
    });

    it('lists and sets budgets', async () => {
        await start();
        await app.api.setBudget('lore', 1234.9);
        await app.api.setBudget('qvink', -5);
        await app.api.setBudget('nope' as never, 5);
        expect(app.api.budgets()).toEqual([
            { source: 'lore', tokens: 1234 },
            { source: 'ckRag', tokens: 0 },
            { source: 'qvink', tokens: 0 },
            { source: 'des', tokens: 0 },
            { source: 'voices', tokens: 0 },
            { source: 'mechanics', tokens: 0 },
            { source: 'director', tokens: 0 },
        ]);
    });
});
