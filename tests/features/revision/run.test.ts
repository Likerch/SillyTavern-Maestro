import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DossierApi } from '../../../src/features/dossier/api';
import type { RevisionRun } from '../../../src/features/revision/api';
import {
    answer,
    change,
    createRevision,
    createRevisionTestApp,
    entity,
    memory,
    message,
    seedAnna,
    signal,
} from './helpers';
import type { RevisionParts, RevisionTestApp } from './helpers';

let env: RevisionTestApp;
let parts: RevisionParts;

beforeEach(() => {
    env = createRevisionTestApp();
    parts = createRevision(env);
});

afterEach(() => parts.dispose());

const userContent = (index = 0) => env.llm.requests[index]!.messages[1]!.content;

describe('the request', () => {
    it('is built from committed, cleaned messages, signals, memories, dossiers and the tag vocabulary', async () => {
        seedAnna(env);
        env.chat.length = 0;
        env.chat.push(
            message('Anna', 'Привет. Я Анна из Рима.'),
            message('User', 'Аня, покажи лист! !fullsheet Anna', true),
            message('Anna', '<BunnymoTags><Name:Anna>, <TRAIT:SHY>, <GENDER:FEMALE>, <SPECIES:HUMAN></BunnymoTags>'),
            message(
                'Anna',
                '```json\n{"characters": [{"name": "Anna"}]}\n```\nЯ теперь живу в Париже. <b>Навсегда.</b> [nai:img:abc]',
            ),
            { ...message('System', 'служебная заметка'), is_system: true },
            message('User', 'Здорово!', true),
            message('Anna', 'Черновик ответа'),
        );
        env.memories.set(3, memory('Anna moved to Paris.'));
        env.memories.set(5, { ...memory('excluded'), exclude: true });
        env.signals.pendingList = [signal('location.changed', 3, 'Anna'), signal('later', 6)];
        await parts.service.execute('manual');

        const request = env.llm.requests[0]!;
        expect(request).toMatchObject({ task: 'revision', temperature: 0, schema: { name: 'maestro_revision' } });
        expect(request.messages[0]!.content).toContain('untrusted story data');
        const user = userContent();
        expect(user).toContain('Messages #0–#5.');
        expect(user).toContain('#0 Anna: Привет. Я Анна из Рима.');
        expect(user).toContain('Я теперь живу в Париже. Навсегда.');
        expect(user).toContain('#5 User: Здорово!');
        for (const gone of [
            '"characters"',
            '[nai:img',
            '<b>',
            '!fullsheet',
            '<BunnymoTags>',
            'служебная',
            'Черновик',
        ]) {
            expect(user).not.toContain(gone);
        }
        expect(user).toContain('## Anna (character; also: Аня)');
        expect(user).toContain('CK tags: <GENDER:FEMALE> <DERE:TSUNDERE> <TRAIT:SHY> <INTJ-U>');
        expect(user).toContain('Appearance: hair: long black hair; eyes: green eyes');
        expect(user).toContain('Anna is a painter. Anna lives in Rome.');
        expect(user).toContain('<vocabulary>');
        expect(user).toContain('TRAIT: BRAVE, SHY');
        expect(user).toContain('#3 location.changed (Anna)');
        expect(user).not.toContain('later');
        expect(user).toContain('#3: Anna moved to Paris.');
        expect(user).not.toContain('excluded');
    });

    it('takes the dossier from the dossier module when it is on', async () => {
        seedAnna(env);
        const build = vi.fn(async (id: string) => ({
            entityId: id,
            name: 'Anna',
            kind: 'character',
            builtAt: 0,
            findings: [],
            sections: [
                { kind: 'lore' as const, title: 'Anna', text: 'Base text.' },
                { kind: 'canon' as const, title: 'Anna', text: 'Canon text first.' },
                { kind: 'tags' as const, title: 'Tags', text: '<TRAIT:BRAVE> <INTJ-H>' },
                {
                    kind: 'nai' as const,
                    title: 'Passport',
                    text: '',
                    fields: { 'slot.hair': 'short red hair', 'slot.style': 'x' },
                },
                {
                    kind: 'place' as const,
                    title: 'Place',
                    text: '',
                    fields: { 'state.condition': 'ruined', aliases: 'x' },
                },
            ],
        }));
        env.modules.apis.set('dossier', { build } as unknown as DossierApi);
        await parts.service.execute('manual');
        const user = userContent();
        expect(build).toHaveBeenCalledWith('character:anna');
        expect(user).toContain('Canon:\nCanon text first.\nBase text.');
        expect(user).toContain('CK tags: <TRAIT:BRAVE> <INTJ-H>');
        expect(user).toContain('Appearance: hair: short red hair');
        expect(user).toContain('State: condition: ruined');
    });

    it('works without a world model (no dossiers) and without Qvink', async () => {
        env.modules.apis.delete('world');
        Object.assign(env.app.adapters.qvink as unknown as Record<string, unknown>, { present: () => false });
        env.memories.set(3, memory('never read'));
        await parts.service.execute('manual');
        expect(userContent()).toContain('(no known entities)');
        expect(userContent()).not.toContain('never read');
    });
});

describe('the answer', () => {
    it('routes the changes, stores the run, consumes the signals and moves the revised mark', async () => {
        seedAnna(env);
        const runs: RevisionRun[] = [];
        parts.service.api().onRun((run) => runs.push(run));
        env.llm.script = [answer(change({ before: 'Anna lives in Rome.' }))];
        const run = (await parts.service.execute('signals'))!;
        expect(run).toMatchObject({ reason: 'signals', fromMessage: 0, toMessage: 4, costUsd: 0.002, rejected: [] });
        expect(run.changes).toHaveLength(1);
        expect(env.autonomy.proposals.map((proposal) => proposal.kind)).toEqual(['canon.fact']);
        expect(env.signals.consumed).toEqual([4]);
        expect(runs.map((item) => item.id)).toEqual([run.id]);
        expect(
            parts.service
                .api()
                .runs()
                .map((item) => item.id),
        ).toEqual([run.id]);
        // Nothing new since: an automatic run does nothing, a manual one says so.
        expect(await parts.service.execute('interval')).toBeNull();
        expect((await parts.service.execute('manual'))!.error).toBe('empty');
        expect(env.llm.requests).toHaveLength(1);
        // The next run starts after the revised messages.
        env.chat.push(message('User', 'Ещё?', true));
        await parts.service.execute('manual');
        expect(userContent(1)).toContain('Messages #5–#6.');
    });

    it('splits the batch when the answer was cut off', async () => {
        seedAnna(env);
        env.llm.script = [
            { ok: false, error: 'parse', text: '{"changes": [{"class": "known", "entity": "Anna", "val' },
            answer(change({ sourceMessage: 2 })),
            answer(change({ target: 'chronicle.event', value: 'Anna cut her hair.', sourceMessage: 4 })),
        ];
        const run = (await parts.service.execute('manual'))!;
        expect(env.llm.requests).toHaveLength(3);
        expect(userContent(1)).toContain('Messages #0–#2.');
        expect(userContent(2)).toContain('Messages #3–#4.');
        expect(run.error).toBeUndefined();
        expect(run.changes.map((item) => item.target)).toEqual(['canon.fact', 'chronicle.event']);
        expect(run.costUsd).toBeCloseTo(0.004);
    });

    it('does not apply a partial result: one failed half fails the run', async () => {
        seedAnna(env);
        env.llm.script = [
            { ok: false, error: 'parse', text: '{"changes": [' },
            answer(change()),
            { ok: false, refusal: true, error: 'refusal' },
        ];
        const run = (await parts.service.execute('signals'))!;
        expect(run.error).toBe('refusal');
        expect(run.changes).toEqual([]);
        expect(env.autonomy.proposals).toEqual([]);
        expect(env.signals.consumed).toEqual([]);
        expect(parts.service.api().runs()[0]!.error).toBe('refusal');
    });

    it('retries once on invalid JSON, then gives up', async () => {
        seedAnna(env);
        env.llm.script = [{ ok: false, error: 'parse', text: 'Sure! Here are the changes.' }, answer(change())];
        expect((await parts.service.execute('manual'))!.changes).toHaveLength(1);
        expect(env.llm.requests).toHaveLength(2);

        env.chat.push(message('User', 'ещё', true));
        env.llm.script = [
            { ok: true, data: { wrong: true } },
            { ok: false, error: 'parse', text: 'nope' },
        ];
        const failed = (await parts.service.execute('manual'))!;
        expect(failed.error).toBe('parse');
        expect(env.llm.requests).toHaveLength(4);
        expect(env.signals.consumed).toEqual([4]);
    });

    it('records transport errors and refusals', async () => {
        env.llm.script = [{ ok: false, error: 'cap' }];
        expect((await parts.service.execute('manual'))!.error).toBe('cap');
        env.llm.script = [{ ok: false, refusal: true, error: 'refusal' }];
        expect((await parts.service.execute('manual'))!.error).toBe('refusal');
        env.llm.script = [{ ok: false }];
        expect((await parts.service.execute('manual'))!.error).toBe('failed');
    });
});

describe('change handling', () => {
    it('sends new things to the living canon as a fact.new signal', async () => {
        seedAnna(env);
        env.llm.script = [
            answer(
                change({
                    class: 'new',
                    entity: 'Golden Goose',
                    value: 'The Golden Goose is a tavern in Paris.',
                    evidence: '«Золотой гусь»',
                }),
            ),
        ];
        const run = (await parts.service.execute('manual'))!;
        expect(run.changes.map((item) => item.class)).toEqual(['new']);
        expect(env.busSignals).toEqual([
            expect.objectContaining({
                kind: 'fact.new',
                messageIndex: 3,
                entity: 'Golden Goose',
                data: {
                    name: 'Golden Goose',
                    quote: '«Золотой гусь»',
                    text: 'The Golden Goose is a tavern in Paris.',
                    sourceMessage: 3,
                    source: 'revision',
                },
            }),
        ]);
        expect(env.autonomy.proposals).toEqual([]);
    });

    it('uses the living canon intake when it has one', async () => {
        const propose = vi.fn(async () => {});
        env.modules.apis.set('livingCanon', { propose });
        env.llm.script = [answer(change({ class: 'new', entity: 'Golden Goose', value: 'A tavern.' }))];
        await parts.service.execute('manual');
        expect(propose).toHaveBeenCalledWith({
            name: 'Golden Goose',
            quote: 'Я теперь живу в Париже.',
            text: 'A tavern.',
            sourceMessage: 3,
        });
        expect(env.busSignals).toEqual([]);
    });

    it('parks later-stage things as deferred cards (folded, dismissable, dropped with their message)', async () => {
        const promise = change({
            target: 'deferred.promise',
            value: 'Anna promised to return by dawn.',
            sourceMessage: 3,
        });
        const outfit = change({ target: 'deferred.outfit', value: 'A red evening dress.', sourceMessage: 2 });
        env.llm.script = [answer(promise, outfit)];
        await parts.service.execute('manual');
        env.chat.push(message('User', 'ещё', true));
        env.llm.script = [answer({ ...promise, value: 'anna promised to return by dawn' })];
        await parts.service.execute('manual');
        const api = parts.service.api();
        expect(api.deferred().map((card) => [card.target, card.value])).toEqual([
            ['deferred.promise', 'Anna promised to return by dawn.'],
            ['deferred.outfit', 'A red evening dress.'],
        ]);
        await api.dismissDeferred!(api.deferred()[0]!.id);
        expect(api.deferred().map((card) => card.target)).toEqual(['deferred.outfit']);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(api.deferred()).toEqual([]);
    });

    it('routes promises and secrets to their owners when they run, else parks them', async () => {
        const intake = vi.fn(async () => 'p1');
        const intakeSecret = vi.fn(async () => null);
        env.modules.apis.set('calendar', { intake });
        env.modules.apis.set('knowledge', { intakeSecret });
        const promise = change({
            target: 'deferred.promise',
            value: 'Anna promised to return by dawn.',
            sourceMessage: 3,
        });
        const secret = change({
            target: 'deferred.secret',
            value: 'Anna is a spy; Kai does not know.',
            sourceMessage: 3,
        });
        env.llm.script = [answer(promise, secret)];
        await parts.service.execute('manual');
        expect(intake).toHaveBeenCalledWith(expect.objectContaining({ value: 'Anna promised to return by dawn.' }));
        expect(intakeSecret).toHaveBeenCalledTimes(1);
        // The calendar took the promise; the knowledge module refused the secret, which waits as a card.
        expect(
            parts.service
                .api()
                .deferred()
                .map((card) => card.target),
        ).toEqual(['deferred.secret']);
    });

    it('rejects unsure changes and unknown entities, with the reason', async () => {
        seedAnna(env);
        env.llm.script = [answer(change({ confidence: 0.3 }), change({ entity: 'Zed', value: 'Zed is tall.' }))];
        const run = (await parts.service.execute('manual'))!;
        expect(run.changes).toEqual([]);
        expect(run.rejected.map((item) => item.reason)).toEqual(['lowConfidence|0.30', 'unknownEntity|Zed']);
    });

    it('an important moment needs no known entity; a kind switched off is reported', async () => {
        seedAnna(env);
        env.autonomy.levels.set('canon.fact', 'off');
        env.llm.script = [
            answer(change({ target: 'chronicle.event', entity: 'Nobody', value: 'Anna swore an oath.' }), change()),
        ];
        const run = (await parts.service.execute('manual'))!;
        expect(run.changes.map((item) => item.target)).toEqual(['chronicle.event']);
        expect(run.rejected.map((item) => item.reason)).toEqual(['failed|skipped']);
        expect(env.busSignals.map((item) => item.kind)).toEqual(['memory.important']);
    });

    it('finds entities the world model does not resolve among the run entities', async () => {
        const anna = seedAnna(env);
        env.worldModel.resolve = () => undefined;
        expect(parts.sources.resolve('аня', [anna])?.id).toBe(anna.id);
        expect(parts.sources.resolve('Zed', [entity({ name: 'Bob' })])).toBeUndefined();
    });
});
