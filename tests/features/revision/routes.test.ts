import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RevisionChange } from '../../../src/features/revision/api';
import { isRevisionPayload, ROUTED_KINDS, TARGETS } from '../../../src/features/revision/routes';
import type { Planned, RevisionPayload } from '../../../src/features/revision/routes';
import type { Proposal } from '../../../src/shared/contracts';
import { ARCHIVE_CONTENT, CANON_BOOK, createRevision, createRevisionTestApp, entity, place, seedAnna } from './helpers';
import type { RevisionParts, RevisionTestApp } from './helpers';

let env: RevisionTestApp;
let parts: RevisionParts;

beforeEach(() => {
    env = createRevisionTestApp();
    parts = createRevision(env);
});

afterEach(() => parts.dispose());

function known(fields: Partial<RevisionChange> = {}): RevisionChange {
    return {
        id: 'c1',
        class: 'known',
        entityName: 'Anna',
        target: 'canon.fact',
        value: 'Anna now lives in Paris.',
        evidence: 'Я теперь живу в Париже.',
        sourceMessage: 3,
        confidence: 0.9,
        ...fields,
    };
}

function ok(planned: Planned): Extract<Planned, { ok: true }> {
    if (!planned.ok) throw new Error(`rejected: ${planned.rejection.code} ${planned.rejection.detail ?? ''}`);
    return planned;
}

function rejected(planned: Planned): string {
    return planned.ok ? 'ok' : planned.rejection.code;
}

const payloadOf = (planned: Planned) => ok(planned).proposal.payload;

async function applyPlanned(planned: Planned, value?: string): Promise<void> {
    const proposal = ok(planned).proposal;
    await proposal.apply(value === undefined ? proposal.payload : { ...proposal.payload, value });
}

describe('installation', () => {
    it('registers an Inbox applier per routed kind and the undo handlers', () => {
        expect([...env.inboxRec.appliers.keys()].sort()).toEqual([...ROUTED_KINDS].sort());
        for (const target of Object.values(TARGETS)) expect(env.journal.handlers.has(target)).toBe(true);
        parts.dispose();
        expect(env.inboxRec.appliers.size).toBe(0);
        parts = createRevision(env);
    });

    it('stored cards are applied from their payload after a reload', async () => {
        const anna = seedAnna(env);
        const planned = await parts.routes.plan(known({ before: 'Anna lives in Rome.' }), anna);
        const stored = JSON.parse(JSON.stringify(payloadOf(planned))) as unknown;
        const applier = env.inboxRec.appliers.get('canon.fact')!;
        expect(await applier.valid!(stored)).toBe(true);
        await applier.apply(stored);
        expect(env.canon.overrideOf('World', 1)?.entry.content).toBe('Anna is a painter. Anna now lives in Paris.');
        expect(await applier.valid!(stored)).toBe(false);
        await expect(applier.apply({ op: 'fact' })).rejects.toThrow('bad revision card');
        expect(isRevisionPayload(null)).toBe(false);
    });
});

describe('canon.fact', () => {
    it('replaces the outdated statement through a canon override of the description entry', async () => {
        const anna = seedAnna(env);
        const planned = ok(await parts.routes.plan(known({ before: 'Anna lives in Rome.' }), anna));
        expect(planned.level).toBe('inbox');
        expect(planned.forceInbox).toBe(false);
        const proposal = planned.proposal;
        expect(proposal).toMatchObject({
            module: 'M8',
            kind: 'canon.fact',
            sourceMessage: 3,
            title: 'Anna: something changed',
        });
        // No Russian sentence from the model here: the English value is the fallback; the details say where it goes.
        expect(proposal.description).toBe(
            'Anna now lives in Paris.\nI will update the old statement in the chat canon.',
        );
        expect(proposal.details).toContain('Entry: Anna');
        expect(proposal.details).toContain('Replaces: Anna lives in Rome.');
        expect(proposal.changes).toEqual([
            {
                target: TARGETS.canon,
                ref: { world: 'World', uid: 1, created: true },
                before: 'Anna is a painter. Anna lives in Rome.',
                after: 'Anna is a painter. Anna now lives in Paris.',
            },
        ]);
        expect(proposal.payload).toMatchObject({
            entityName: 'Anna',
            editable: true,
            evidence: 'Я теперь живу в Париже.',
            confidence: 0.9,
        });
        expect(await proposal.stillValid!()).toBe(true);
        await proposal.apply(proposal.payload);
        const override = env.canon.overrideOf('World', 1)!;
        expect(override.meta).toMatchObject({
            kind: 'override',
            origin: 'revision',
            fields: ['content'],
            sourceMessage: 3,
        });
        expect(env.world.entry('World', 1)!.content).toBe('Anna is a painter. Anna lives in Rome.');
        expect(await proposal.stillValid!()).toBe(false);
        // Undo removes the override it created.
        await env.journal.record({ module: 'M8', kind: 'canon.fact', summary: 'x', changes: proposal.changes });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.canon.overrideOf('World', 1)).toBeUndefined();
    });

    it("says it in the model's Russian words; the English canon text waits in the details", async () => {
        const anna = seedAnna(env);
        const proposal = ok(
            await parts.routes.plan(known({ russian: 'Анна переехала в Париж.', before: 'Anna lives in Rome.' }), anna),
        ).proposal;
        expect(proposal.description).toBe(
            'Анна переехала в Париж.\nI will update the old statement in the chat canon.',
        );
        expect(proposal.details).toContain('Canon text (English): Anna now lives in Paris.');
        expect(proposal.payload).toMatchObject({ russian: 'Анна переехала в Париж.' });
    });

    it('appends to an existing override and restores it on undo', async () => {
        const anna = seedAnna(env);
        await env.canon.put({
            entry: { key: ['Anna', 'Аня'] },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world: 'World', uid: 1, contentHash: '' },
                fields: ['key'],
            },
        });
        const proposal = ok(await parts.routes.plan(known(), anna)).proposal;
        expect(proposal.description).toBe('Anna now lives in Paris.\nI will write it into the chat canon.');
        await proposal.apply(proposal.payload);
        const override = env.canon.overrideOf('World', 1)!;
        expect(override.meta.fields).toEqual(['key', 'content']);
        expect(override.entry).toEqual({
            key: ['Anna', 'Аня'],
            content: 'Anna is a painter. Anna lives in Rome.\n\nAnna now lives in Paris.',
        });
        await env.journal.record({ module: 'M8', kind: 'canon.fact', summary: 'x', changes: proposal.changes });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.canon.overrideOf('World', 1)!.entry.content).toBe('Anna is a painter. Anna lives in Rome.');
    });

    it('writes an edited value, after the same checks', async () => {
        const anna = seedAnna(env);
        const planned = await parts.routes.plan(known({ before: 'Anna lives in Rome.' }), anna);
        await expect(applyPlanned(planned, 'Аня живёт в Париже.')).rejects.toThrow('canon text must be English');
        await applyPlanned(planned, 'Anna lives in Paris with her sister.');
        expect(env.canon.overrideOf('World', 1)!.entry.content).toBe(
            'Anna is a painter. Anna lives in Paris with her sister.',
        );
    });

    it('updates the canon item of an entity that only lives in the canon, or adds one', async () => {
        await env.canon.put({
            entry: { key: ['Boris'], comment: 'Boris', content: 'Boris is a smith.' },
            meta: { kind: 'addition', status: 'active', origin: 'user', type: 'character' },
        });
        const boris = entity({
            name: 'Boris',
            sources: [{ kind: 'canon.entry', ref: `${CANON_BOOK}#100`, label: 'Boris', world: CANON_BOOK, uid: 100 }],
        });
        const planned = await parts.routes.plan(known({ entityName: 'Boris', value: 'Boris lost his hammer.' }), boris);
        expect(ok(planned).proposal.changes[0]!.ref).toEqual({ itemUid: 100 });
        await applyPlanned(planned);
        expect(env.canon.items[0]!.entry.content).toBe('Boris is a smith.\n\nBoris lost his hammer.');

        const vera = entity({ name: 'Вера', aliases: ['Vera', 'Верочка', '/(broken/i'] });
        const added = ok(await parts.routes.plan(known({ entityName: 'Вера', value: 'Vera is a nurse.' }), vera));
        expect(added.proposal.changes[0]!.ref).toEqual({ addition: 'Вера' });
        expect(await added.proposal.stillValid!()).toBe(true);
        await added.proposal.apply(added.proposal.payload);
        const item = env.canon.items.find((candidate) => candidate.entry.comment === 'Вера')!;
        expect(item.entry).toMatchObject({ key: ['Вера', 'Верау', 'Vera', 'Верочка'], content: 'Vera is a nurse.' });
        expect(item.meta).toMatchObject({ kind: 'addition', origin: 'revision', type: 'character', sourceMessage: 3 });
        expect(await added.proposal.stillValid!()).toBe(false);
        // A second fact about her goes into the same item.
        expect(
            ok(await parts.routes.plan(known({ entityName: 'Вера', value: 'Vera is kind.' }), vera)).proposal
                .changes[0]!.ref,
        ).toEqual({
            itemUid: item.uid,
        });
        await env.journal.record({ module: 'M8', kind: 'canon.fact', summary: 'x', changes: added.proposal.changes });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.canon.items.some((candidate) => candidate.entry.comment === 'Вера')).toBe(false);
    });

    it('writes about a place into its description entry', async () => {
        env.world.book('Places', [{ uid: 3, key: ['Rome'], comment: 'Rome', content: 'Rome is old.' }]);
        env.places.places.push(place({ id: 'rome', name: 'Rome', entry: { world: 'Places', uid: 3 } }));
        const rome = entity({
            id: 'place:rome',
            name: 'Rome',
            kind: 'place',
            sources: [{ kind: 'place', ref: 'rome', label: 'Rome' }],
        });
        const planned = ok(await parts.routes.plan(known({ entityName: 'Rome', value: 'Rome is flooded.' }), rome));
        expect(planned.proposal.changes[0]!.ref).toEqual({ world: 'Places', uid: 3, created: true });
    });

    it('never writes BunnyMo books or CK archives as prose; refuses bad text', async () => {
        const anna = seedAnna(env);
        expect(rejected(await parts.routes.plan(known({ value: 'Anna is a painter.' }), anna))).toBe('noChange');
        env.modules.apis.set('bookRoles', {
            roleOf: (book: string) => (book === 'World' ? { readOnly: true } : undefined),
        });
        const planned = ok(await parts.routes.plan(known(), anna));
        // The protected book and the archive are skipped: a canon addition is proposed instead.
        expect(planned.proposal.changes[0]!.ref).toEqual({ addition: 'Anna' });
        expect(rejected(await parts.routes.plan(known({ value: 'Аня живёт в Париже.' }), anna))).toBe('notEnglish');
        expect(rejected(await parts.routes.plan(known(), undefined))).toBe('unknownEntity');
        env.modules.apis.delete('canon');
        expect(rejected(await parts.routes.plan(known(), anna))).toBe('noTarget');
    });

    it('a conflict found by the rules forces the Inbox and says so (no model call)', async () => {
        const anna = seedAnna(env);
        env.contradictions.quickResult = [
            { label: 'Anna', statement: 'x', conflicting: 'Anna is a painter.', kind: 'negation', confidence: 0.8 },
        ];
        const planned = ok(await parts.routes.plan(known({ value: 'Anna has never painted.' }), anna));
        expect(planned.forceInbox).toBe(true);
        // The card names what it disagrees with; the English canon line itself waits in the details.
        expect(planned.proposal.description).toContain('This disagrees with what is already known: Anna.');
        expect(planned.proposal.description).not.toContain('Anna is a painter.');
        expect(planned.proposal.details).toContain('Contradiction: Anna: «Anna is a painter.»');
        expect(env.contradictions.quickInputs[0]).toEqual({
            statement: 'Anna has never painted.',
            entities: ['Anna'],
            against: [{ label: 'Anna', text: 'Anna is a painter. Anna lives in Rome.' }],
        });
        expect(env.contradictions.inputs).toEqual([]);
        // A replacing fact is checked against the canon without the statement it replaces.
        env.contradictions.quickResult = [];
        expect(ok(await parts.routes.plan(known({ before: 'Anna lives in Rome.' }), anna)).forceInbox).toBe(false);
        expect(env.contradictions.quickInputs[1]!.against[0]!.text).toBe('Anna is a painter.');
        // With the Inbox level the card is the user's check: the model is not asked.
        expect(env.contradictions.inputs).toEqual([]);
    });

    it('asks the model only when the fact would go in by itself', async () => {
        const anna = seedAnna(env);
        env.autonomy.levels.set('canon.fact', 'auto');
        env.contradictions.result = {
            clean: false,
            askedAi: true,
            contradictions: [
                { label: 'Anna', statement: 'x', conflicting: 'Anna is a painter.', kind: 'ai', confidence: 0.7 },
            ],
            costUsd: 0.0005,
        };
        const planned = ok(await parts.routes.plan(known({ value: 'Anna has never painted.' }), anna));
        expect(env.contradictions.inputs).toHaveLength(1);
        expect(planned.forceInbox).toBe(true);
        expect(planned.costUsd).toBe(0.0005);
        env.contradictions.result = { clean: true, askedAi: false, contradictions: [], costUsd: 0 };
        expect(ok(await parts.routes.plan(known(), anna)).forceInbox).toBe(false);
    });

    it('an unanswered or failing model check keeps the fact in the Inbox', async () => {
        const anna = seedAnna(env);
        env.autonomy.levels.set('canon.fact', 'auto');
        env.contradictions.check = () => new Promise(() => {});
        const slow = ok(await parts.routes.plan(known(), anna));
        expect(slow.forceInbox).toBe(true);
        expect(slow.proposal.description).toContain('The contradiction check did not answer');
        env.contradictions.check = async () => {
            throw new Error('down');
        };
        expect(ok(await parts.routes.plan(known(), anna)).forceInbox).toBe(true);
    });

    it('through the service: the conflicting card goes to the Inbox, never through autonomy', async () => {
        seedAnna(env);
        env.contradictions.result = {
            clean: false,
            askedAi: false,
            contradictions: [{ label: 'Anna', statement: 'x', conflicting: 'y', kind: 'name', confidence: 1 }],
            costUsd: 0,
        };
        env.autonomy.levels.set('canon.fact', 'auto');
        env.llm.script = [
            {
                ok: true,
                data: {
                    changes: [
                        {
                            class: 'known',
                            entity: 'Anna',
                            target: 'canon.fact',
                            field: '',
                            value: 'Anna is a sculptor.',
                            before: '',
                            evidence: 'x',
                            sourceMessage: 3,
                            confidence: 0.9,
                        },
                    ],
                },
            },
        ];
        await parts.service.execute('manual');
        expect(env.inboxRec.added.map((proposal) => proposal.kind)).toEqual(['canon.fact']);
        expect(env.autonomy.proposals).toEqual([]);
        expect(env.canon.puts).toEqual([]);
    });

    it('broken rules do not block the proposal', async () => {
        const anna = seedAnna(env);
        env.contradictions.quick = () => {
            throw new Error('down');
        };
        expect(ok(await parts.routes.plan(known(), anna)).forceInbox).toBe(false);
    });
});

describe('ck.tags', () => {
    const tags = (fields: Partial<RevisionChange> = {}) =>
        known({ target: 'ck.tags', value: '<DERE:DANDERE>, <INTJ-H>', before: '<Dere:TSUNDERE> <INTJ-U>', ...fields });

    it('proposes a clean final set from the dictionary through a canon override, then rescans CK', async () => {
        const anna = seedAnna(env);
        const planned = ok(await parts.routes.plan(tags(), anna));
        expect(env.bunnymo.validated).toEqual([['<DERE:DANDERE>', '<INTJ-H>']]);
        expect(planned.level).toBe('inbox');
        const change = planned.proposal.changes[0]!;
        expect(change.target).toBe(TARGETS.ck);
        expect(change.before).toBe(ARCHIVE_CONTENT);
        expect(change.after).toContain('<Name:Anna>');
        expect(change.after).toContain('<DERE:DANDERE>');
        expect(change.after).toContain('<INTJ-H>');
        expect(change.after).not.toContain('INTJ-U');
        expect(change.after).toContain('<Linguistics>Speaks softly.</Linguistics>');
        await applyPlanned(planned);
        expect(env.canon.overrideOf('Repo', 7)!.entry.content).toBe(change.after);
        expect(env.world.entry('Repo', 7)!.content).toBe(ARCHIVE_CONTENT);
        expect(env.ckScans).toEqual([['Repo']]);
        expect(await planned.proposal.stillValid!()).toBe(false);
        await env.journal.record({ module: 'M8', kind: 'ck.tags', summary: 'x', changes: planned.proposal.changes });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.canon.overrideOf('Repo', 7)).toBeUndefined();
    });

    it('rejects tags outside the dictionary, Russian, placeholders, transitions, name changes and stale olds', async () => {
        const anna = seedAnna(env);
        const code = async (fields: Partial<RevisionChange>) => rejected(await parts.routes.plan(tags(fields), anna));
        expect(await code({ value: '<TRAIT:HEROIC>', before: '' })).toBe('tag');
        expect(await code({ value: '<TRAIT:СМЕЛАЯ>', before: '' })).toBe('cyrillic');
        expect(await code({ value: '<GENRE:BLANK>', before: '' })).toBe('placeholder');
        expect(await code({ value: '<TRAIT:SHY → BRAVE>', before: '' })).toBe('transitional');
        expect(await code({ value: '<Name:Anya>', before: '' })).toBe('name');
        expect(await code({ value: 'brave', before: '' })).toBe('malformed');
        expect(await code({ value: '<TRAIT:BRAVE>', before: 'shy' })).toBe('malformed');
        expect(await code({ value: '<TRAIT:BRAVE>', before: '<TRAIT:BOLD>' })).toBe('beforeMissing');
        expect(await code({ value: '<TRAIT:SHY>', before: '' })).toBe('noChange');
        const planned = await parts.routes.plan(tags({ value: '<TRAIT:HEROIC>', before: '' }), anna);
        expect(planned.ok ? '' : planned.rejection.detail).toContain('<TRAIT:HEROIC>');
    });

    it('needs the dictionary, an archive and a writable book', async () => {
        const anna = seedAnna(env);
        env.modules.apis.set('bookRoles', {
            roleOf: (book: string) => (book === 'Repo' ? { readOnly: true } : undefined),
        });
        expect(rejected(await parts.routes.plan(tags(), anna))).toBe('protectedBook');
        expect(rejected(await parts.routes.plan(tags(), { ...anna, sources: [] }))).toBe('noTarget');
        env.modules.apis.delete('bunnymoMode');
        expect(rejected(await parts.routes.plan(tags(), anna))).toBe('noDictionary');
    });

    it('an edited tag list is checked against the dictionary again', async () => {
        const anna = seedAnna(env);
        const planned = await parts.routes.plan(tags(), anna);
        await expect(applyPlanned(planned, '<TRAIT:HEROIC>')).rejects.toThrow('tag not from the loaded packs');
        await applyPlanned(planned, '<DERE:DANDERE>');
        expect(env.canon.overrideOf('Repo', 7)!.entry.content).toContain('<DERE:DANDERE>');
    });
});

describe('nai.appearance', () => {
    const look = (fields: Partial<RevisionChange> = {}) =>
        known({ target: 'nai.appearance', field: 'hair', value: 'short black hair, bob cut', ...fields });

    it('writes a permanent slot of the chat passport through NAI Studio', async () => {
        const anna = seedAnna(env);
        const planned = ok(await parts.routes.plan(look(), anna));
        expect(planned.proposal.changes).toEqual([
            {
                target: TARGETS.passport,
                ref: { id: 'p1', slot: 'hair', owner: { avatar: 'Alice.png' } },
                before: 'long black hair',
                after: 'short black hair, bob cut',
            },
        ]);
        expect(planned.proposal.title).toBe('Anna: appearance (hair)');
        await applyPlanned(planned);
        expect(env.nai.saved[0]).toMatchObject({ scope: 'chat', target: { avatar: 'Alice.png' } });
        expect(env.nai.saved[0]!.passport.slots).toEqual({ hair: 'short black hair, bob cut', eyes: 'green eyes' });
        expect(await planned.proposal.stillValid!()).toBe(false);
        await env.journal.record({
            module: 'M8',
            kind: 'nai.appearance',
            summary: 'x',
            changes: planned.proposal.changes,
        });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.nai.getPassport('p1')!.slots.hair).toBe('long black hair');
    });

    it('rejects other slots, Russian, upper case and explicit anatomy', async () => {
        const anna = seedAnna(env);
        const code = async (fields: Partial<RevisionChange>) => rejected(await parts.routes.plan(look(fields), anna));
        expect(await code({ field: 'clothing' })).toBe('slot');
        expect(await code({ field: undefined })).toBe('slot');
        expect(await code({ value: 'короткие волосы' })).toBe('cyrillic');
        expect(await code({ value: 'Short Hair' })).toBe('uppercase');
        expect(await code({ field: 'body', value: 'slim, nipples' })).toBe('anatomy');
        expect(await code({ value: 'long black hair' })).toBe('noChange');
        expect(rejected(await parts.routes.plan(look(), { ...anna, sources: [] }))).toBe('noTarget');
        env.nai.passportsById.clear();
        expect(await code({})).toBe('noTarget');
        await expect(applyPlanned(await parts.routes.plan(look(), seedAnna(env)), 'Upper Case')).rejects.toThrow(
            'lower case',
        );
    });

    it('persona passports are saved for the persona', async () => {
        const anna = seedAnna(env);
        const persona = {
            ...anna,
            sources: [{ kind: 'nai.passport' as const, ref: 'persona#p1', label: 'Me', passportId: 'p1' }],
        };
        await applyPlanned(await parts.routes.plan(look(), persona));
        expect(env.nai.saved[0]!.target).toEqual({ persona: true });
    });
});

describe('chat.alias and des.alias', () => {
    it('a nickname goes to the alias map and the entry keys, by itself', async () => {
        const anna = seedAnna(env);
        const planned = ok(await parts.routes.plan(known({ target: 'chat.alias', value: 'Анечка' }), anna));
        expect(planned.level).toBe('auto');
        expect(planned.proposal.changes).toEqual([
            {
                target: TARGETS.alias,
                ref: { alias: 'Анечка' },
                before: null,
                after: { alias: 'Анечка', entity: 'Anna' },
            },
            {
                target: TARGETS.keys,
                ref: { world: 'World', uid: 1, created: true },
                before: ['Anna', 'Анна'],
                after: ['Anna', 'Анна', 'Анечка', 'Анечкау'],
            },
        ]);
        await applyPlanned(planned);
        expect(env.worldModel.aliases).toEqual({ Анечка: 'character:anna' });
        expect(env.canon.overrideOf('World', 1)!.entry.key).toEqual(['Anna', 'Анна', 'Анечка', 'Анечкау']);
        expect(await planned.proposal.stillValid!()).toBe(false);
        await env.journal.record({ module: 'M8', kind: 'chat.alias', summary: 'x', changes: planned.proposal.changes });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.worldModel.aliases).toEqual({});
        expect(env.canon.overrideOf('World', 1)!.entry.key).toEqual(['Anna', 'Анна']);
    });

    it('through autonomy the auto level applies it right away', async () => {
        seedAnna(env);
        env.llm.script = [
            {
                ok: true,
                data: {
                    changes: [
                        {
                            class: 'known',
                            entity: 'Anna',
                            target: 'chat.alias',
                            field: '',
                            value: 'Нюра',
                            before: '',
                            evidence: 'x',
                            sourceMessage: 3,
                            confidence: 0.9,
                        },
                    ],
                },
            },
        ];
        await parts.service.execute('manual');
        expect(env.worldModel.aliases).toEqual({ Нюра: 'character:anna' });
        expect(env.journal.records.map((record) => record.kind)).toEqual(['chat.alias']);
    });

    it('refuses known names, aliases of others and bad nicknames', async () => {
        const anna = seedAnna(env);
        const code = async (value: string) =>
            rejected(await parts.routes.plan(known({ target: 'chat.alias', value }), anna));
        expect(await code('Аня')).toBe('noChange');
        env.worldModel.aliases['Малышка'] = 'character:bob';
        expect(await code('Малышка')).toBe('duplicate');
        expect(await code('<b>')).toBe('malformed');
        env.modules.apis.delete('world');
        expect(await code('Нюра')).toBe('noTarget');
    });

    it('without an entry the alias still goes to the map', async () => {
        const bob = entity({ name: 'Bob' });
        const planned = ok(
            await parts.routes.plan(known({ entityName: 'Bob', target: 'chat.alias', value: 'Bobby' }), bob),
        );
        expect(planned.proposal.changes).toHaveLength(1);
        expect(planned.proposal.description).toBe(
            'The story calls Bob «Bobby». I will remember the nickname in this chat.',
        );
        expect(planned.proposal.appliedNotice?.text).toBe('Remembered a nickname: Bob — «Bobby»');
        expect(planned.proposal.appliedNotice?.groupText?.(2)).toBe('Remembered 2 nicknames');
        await applyPlanned(planned, 'Bobster');
        expect(env.worldModel.aliases).toEqual({ Bobster: 'character:bob' });
        await expect(applyPlanned(planned, '')).rejects.toThrow('empty value');
    });

    it('a new canonical name is only a note for DES, always in the Inbox', async () => {
        const anna = seedAnna(env);
        const planned = ok(await parts.routes.plan(known({ target: 'des.alias', value: 'Lady Anna' }), anna));
        expect(planned.forceInbox).toBe(true);
        expect(planned.proposal.payload).toMatchObject({ op: 'note', editable: false });
        expect(planned.proposal.description).toContain('add the new name in the DES Character Workshop');
        await applyPlanned(planned);
        expect(env.ui.notices.map((notice) => notice.text)).toEqual([planned.proposal.description]);
        expect(rejected(await parts.routes.plan(known({ target: 'des.alias', value: 'BLANK' }), anna))).toBe(
            'placeholder',
        );
    });
});

describe('chronicle.event and places.state', () => {
    it('hands an important moment to the chronicle', async () => {
        const planned = ok(
            await parts.routes.plan(known({ target: 'chronicle.event', value: 'Anna swore an oath.' }), undefined),
        );
        expect(planned.level).toBe('auto');
        await applyPlanned(planned);
        expect(env.busSignals).toEqual([
            expect.objectContaining({
                kind: 'memory.important',
                messageIndex: 3,
                entity: 'Anna',
                data: { messageIndex: 3, reason: 'Anna swore an oath.', source: 'revision' },
            }),
        ]);
        expect(
            rejected(await parts.routes.plan(known({ target: 'chronicle.event', value: 'Клятва.' }), undefined)),
        ).toBe('notEnglish');
    });

    it('updates the state of a known place, and undoes it', async () => {
        env.places.places.push(place({ id: 'tavern', name: 'Tavern', aliases: ['Таверна'], state: { owner: 'Bob' } }));
        const planned = ok(
            await parts.routes.plan(
                known({ target: 'places.state', entityName: 'Таверна', field: 'Condition!', value: 'burned down' }),
                undefined,
            ),
        );
        expect(planned.proposal.payload).toMatchObject({
            entityName: 'Tavern',
            field: 'condition',
            key: 'condition',
            before: '',
        });
        await applyPlanned(planned);
        expect(env.places.get('tavern')!.state).toEqual({ owner: 'Bob', condition: 'burned down' });
        expect(await planned.proposal.stillValid!()).toBe(false);
        await env.journal.record({
            module: 'M8',
            kind: 'places.state',
            summary: 'x',
            changes: planned.proposal.changes,
        });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.places.get('tavern')!.state).toEqual({ owner: 'Bob' });
    });

    it('rejects unknown places and missing registries', async () => {
        expect(
            rejected(await parts.routes.plan(known({ target: 'places.state', entityName: 'Nowhere' }), undefined)),
        ).toBe('unknownPlace');
        env.places.places.push(place({ id: 'tavern', name: 'Tavern', state: { condition: 'ruined' } }));
        expect(
            rejected(
                await parts.routes.plan(
                    known({ target: 'places.state', entityName: 'Tavern', value: 'ruined' }),
                    undefined,
                ),
            ),
        ).toBe('noChange');
        env.modules.apis.delete('places');
        expect(
            rejected(await parts.routes.plan(known({ target: 'places.state', entityName: 'Tavern' }), undefined)),
        ).toBe('noTarget');
    });
});

describe('proposal mechanics', () => {
    it('a live proposal applies an edited payload passed by the Inbox', async () => {
        const anna = seedAnna(env);
        const proposal = ok(await parts.routes.plan(known({ before: 'Anna lives in Rome.' }), anna))
            .proposal as Proposal<RevisionPayload>;
        await proposal.apply({ ...proposal.payload, value: 'Anna lives in Lyon.' });
        expect(env.canon.overrideOf('World', 1)!.entry.content).toBe('Anna is a painter. Anna lives in Lyon.');
    });

    it('planning errors become a rejection', async () => {
        const anna = seedAnna(env);
        env.canon.list = async () => {
            throw new Error('boom');
        };
        env.canon.russianKeys = async () => {
            throw new Error('boom');
        };
        // canonItems swallows the error; russianKeys too: an addition with the bare name is proposed.
        const planned = ok(await parts.routes.plan(known({ entityName: 'Bob' }), entity({ name: 'Bob' })));
        expect((planned.proposal.payload as Extract<RevisionPayload, { op: 'fact' }>).dest).toMatchObject({
            kind: 'addition',
            keys: ['Bob'],
        });
        env.worldModel.chatAliases = () => {
            throw new Error('broken');
        };
        expect(await parts.routes.plan(known({ target: 'chat.alias', value: 'Нюра' }), anna)).toMatchObject({
            ok: false,
            rejection: { code: 'failed', detail: 'broken' },
        });
    });
});
