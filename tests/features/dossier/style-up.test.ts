// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAutonomy } from '../../../src/core/autonomy';
import { buildTagDictionary, checkTags, entriesWithUid, tagVocabulary } from '../../../src/domain/bunnymo-mode-tags';
import type { Dictionary } from '../../../src/domain/bunnymo-mode-tags';
import type { BunnyMoModeApi, TagDictionary, TagValidation } from '../../../src/features/bunnymoMode/api';
import { canonModule } from '../../../src/features/canon';
import type { CanonApi } from '../../../src/features/canon/api';
import { ProtectedBookError } from '../../../src/features/dossier/actions';
import { defaultDossierSettings } from '../../../src/features/dossier/settings';
import { DossierSources } from '../../../src/features/dossier/sources';
import {
    DossierStyleUp,
    PROMOTE_KIND,
    STYLE_UP_KIND,
    STYLE_UP_PART_TARGET,
    STYLE_UP_TARGET,
    STYLE_UP_TASK,
    isPromotePayload,
    isStyleUpPayload,
} from '../../../src/features/dossier/style-up';
import type { StyleUpPayload, StyleUpPlan } from '../../../src/features/dossier/style-up';
import type { LorePassport, LorePassportsApi } from '../../../src/features/lorePassports/api';
import type { Place } from '../../../src/features/places/api';
import type { AutonomyLevel, Decision, Proposal } from '../../../src/shared/contracts';
import { LYRA_ID, MIRA_FORMS, MIRA_ID, STYLE_UP_PACK, miraScene } from './fixtures';
import { FakePlaces, createDossierEnv, passport, place, startModule, wi } from './helpers';
import type { Dict, DossierEnv } from './helpers';

let env: DossierEnv;
let stops: (() => Promise<void>)[];

beforeEach(() => {
    env = createDossierEnv();
    stops = [];
});

afterEach(async () => {
    for (const stop of stops.reverse()) await stop();
});

const ARCHIVE_ANSWER = {
    tags: [
        { category: 'SPECIES', value: 'HUMAN' },
        { category: 'GENDER', value: 'female' },
        { category: 'DERE', value: 'KUUDERE' },
        { category: 'TRAIT', value: 'STOIC' },
        { category: 'SPECIES', value: 'DRAGON' },
        { category: 'TRAIT', value: 'холодная' },
        { category: 'GENRE', value: 'BLANK' },
        { category: 'LING', value: 'BLUNT' },
    ],
    mbti: 'INTJ-U',
    linguistics: 'Short, cold sentences.',
};

function dictionary(): Dictionary {
    env.world.book('Pack', STYLE_UP_PACK);
    const data = env.world.books.get('Pack');
    return buildTagDictionary({
        books: [{ name: 'Pack', core: false, entries: entriesWithUid(data) }],
        archives: [],
        builtAt: 1,
    });
}

/** The BunnyMo mode's dictionary and tag check over the test pack; `reject` makes its check refuse tags. */
function exposeBunnymo(reject: string[] = []): { validated: string[][] } {
    const dict = dictionary();
    const validated: string[][] = [];
    const api: Partial<BunnyMoModeApi> = {
        dictionary: async (): Promise<TagDictionary> => dict,
        validateTags: async (tags) => {
            validated.push([...tags]);
            return checkTags(tags, tagVocabulary(dict)).map((check): TagValidation =>
                reject.includes(check.tag) ? { tag: check.tag, ok: false, reason: 'noPack' } : { ...check },
            );
        },
    };
    env.modules.expose('bunnymoMode', api);
    return { validated };
}

function withGenerator(
    result: (input: Dict) => Promise<unknown> = async (input) =>
        passport({ id: 'main', name: String(input.name), slots: { hair: 'red braid', face: 'scar on cheek' } }),
): Dict[] {
    const calls: Dict[] = [];
    Object.assign(env.app.adapters.nai as unknown as Dict, {
        generatePassport: async (input: Dict) => {
            calls.push(input);
            return result(input);
        },
    });
    return calls;
}

async function setup(options: { reject?: string[]; generator?: boolean } = {}) {
    const scene = miraScene(env);
    const canon = await startModule(env, canonModule);
    stops.push(() => canon.stop());
    const bunny = exposeBunnymo(options.reject);
    const generated = options.generator === false ? [] : withGenerator();
    env.llm.result = { ok: true, data: ARCHIVE_ANSWER, costUsd: 0.0009 };
    const sources = new DossierSources(env.app, defaultDossierSettings, env.log);
    const styleUp = new DossierStyleUp(env.app, sources, env.log);
    const offs = styleUp.install();
    stops.push(async () => offs.forEach((off) => off()));
    return { ...scene, ...bunny, generated, sources, styleUp, canon: env.modules.api<CanonApi>('canon')! };
}

async function factsOf(sources: DossierSources, id = MIRA_ID) {
    const entity = sources.entity(id);
    if (!entity) throw new Error(`no entity ${id}`);
    return sources.facts(entity);
}

function part<K extends StyleUpPlan['parts'][number]['part']>(plan: StyleUpPlan, kind: K) {
    const found = plan.parts.find((item) => item.part === kind);
    if (!found) throw new Error(`no part ${kind}: ${plan.hints.map((hint) => hint.key).join(', ')}`);
    return found as Extract<StyleUpPlan['parts'][number], { part: K }>;
}

function partRecords() {
    return env.journal.records.filter((record) =>
        record.changes.some((change) => change.target === STYLE_UP_PART_TARGET),
    );
}

describe('«Оформить»: the plan', () => {
    it('finds what a new NPC lacks and plans every store', async () => {
        const { sources, styleUp, generated } = await setup();
        const facts = await factsOf(sources);
        expect(await styleUp.gaps(facts)).toEqual({ kind: 'character', missing: ['canon', 'archive', 'passport'] });
        const plan = await styleUp.plan(facts);
        expect(plan).toMatchObject({ entityId: MIRA_ID, name: 'Мира', kind: 'character', costUsd: 0.0009 });
        expect(plan.parts.map((item) => item.part)).toEqual(['canon', 'archive', 'passport']);

        const canon = part(plan, 'canon');
        expect(canon.keys).toEqual(MIRA_FORMS);
        expect(canon.content).toBe('Character: Мира\nAppearance: рыжая коса, шрам на щеке\nPersonality: холодная');
        expect(canon.fields).toEqual({
            name: 'Мира',
            appearance: 'рыжая коса, шрам на щеке',
            personality: 'холодная',
        });

        const archive = part(plan, 'archive');
        expect(archive).toMatchObject({ book: 'Archives', books: ['Archives'], create: false, name: 'Мира' });
        expect(archive.keys).toEqual(['Мира']);
        expect(archive.tags).toEqual([
            '<SPECIES:HUMAN>',
            '<GENDER:FEMALE>',
            '<DERE:KUUDERE>',
            '<TRAIT:STOIC>',
            '<LING:BLUNT>',
            '<INTJ-U>',
        ]);
        expect(archive.content).toBe(
            '<BunnymoTags><Name:Мира> <PHYSICAL><SPECIES:HUMAN>, <GENDER:FEMALE></PHYSICAL> ' +
                '<PERSONALITY><DERE:KUUDERE>, <INTJ-U>, <TRAIT:STOIC></PERSONALITY></BunnymoTags>\n' +
                '<Linguistics>Character uses <LING:BLUNT>. Short, cold sentences.</Linguistics>',
        );
        expect(archive.rejected).toEqual([
            { tag: '<SPECIES:DRAGON>', reason: 'unknownValue' },
            { tag: '<TRAIT:холодная>', reason: 'cyrillic' },
            { tag: '<GENRE:BLANK>', reason: 'placeholder' },
        ]);

        const request = env.llm.requests[0]!;
        expect(request.task).toBe(STYLE_UP_TASK);
        expect(request.schema?.name).toBe('bunnymo_archive');
        expect(request.messages[1]?.content).toContain('Scene tracker appearance: рыжая коса');
        expect(request.messages[1]?.content).toContain('SPECIES: HUMAN');

        const nai = part(plan, 'passport');
        expect(nai.passport).toMatchObject({ kind: 'character', name: 'Мира', slots: { hair: 'red braid' } });
        expect(nai.passport.id).toBe(`maestro-${plan.planId}`);
        expect(generated[0]).toMatchObject({ name: 'Мира', kind: 'character' });
        expect(String(generated[0]?.description)).toContain('Appearance: рыжая коса');
        expect(plan.hints).toEqual([]);
    });

    it('lets the BunnyMo mode’s own check drop tags before anything is written', async () => {
        const { sources, styleUp, validated } = await setup({ reject: ['<TRAIT:STOIC>'] });
        const plan = await styleUp.plan(await factsOf(sources));
        const archive = part(plan, 'archive');
        expect(validated[0]).toContain('<TRAIT:STOIC>');
        expect(archive.tags).not.toContain('<TRAIT:STOIC>');
        expect(archive.rejected.at(-1)).toEqual({ tag: '<TRAIT:STOIC>', reason: 'noPack' });
    });

    it('explains every archive that cannot be prepared', async () => {
        const { sources, styleUp } = await setup({
            reject: [
                '<SPECIES:HUMAN>',
                '<GENDER:FEMALE>',
                '<DERE:KUUDERE>',
                '<TRAIT:STOIC>',
                '<LING:BLUNT>',
                '<INTJ-U>',
            ],
        });
        const facts = await factsOf(sources);
        const keys = async () =>
            (await styleUp.plan(facts)).hints.filter((hint) => hint.part === 'archive').map((hint) => hint.key);
        expect(await keys()).toEqual(['archiveRejected', 'archiveEmpty']);
        env.llm.result = { ok: true, text: 'no json at all' };
        expect(await keys()).toEqual(['archiveParse']);
        env.llm.result = { ok: false, error: 'breaker-open' };
        expect(await keys()).toEqual(['archiveFailed']);
        env.cost.capped = true;
        expect(await keys()).toEqual(['archiveCap']);
        env.cost.capped = false;
        env.llm.ready = false;
        expect(await keys()).toEqual(['archiveNoProfile']);
        env.llm.ready = true;
        env.modules.expose('bunnymoMode', {
            dictionary: async () => ({ builtAt: 0, categories: [], tags: [] }),
            validateTags: async () => [],
        });
        expect(await keys()).toEqual(['archiveNoPacks']);
        env.modules.apis.delete('bunnymoMode');
        expect(await keys()).toEqual(['archiveNoBunnymo']);
    });

    it('offers to create «Maestro · архив» when no CK repository can take the archive (P13)', async () => {
        const { sources, styleUp } = await setup();
        env.n.ckRepos = ['Pack'];
        const plan = await styleUp.plan(await factsOf(sources));
        expect(part(plan, 'archive')).toMatchObject({ book: 'Maestro · архив', books: [], create: true });
        expect(plan.hints).toEqual([
            { part: 'archive', key: 'archiveBunnyRepo', params: { book: 'Pack' } },
            { part: 'archive', key: 'archiveNewBook', params: { book: 'Maestro · архив' } },
        ]);
        expect(styleUp.hintText(plan.hints[0]!)).toContain('BunnyMo book');
    });

    it('takes books with the role «CK archive» and lets the user choose', async () => {
        const { sources, styleUp } = await setup();
        env.world.book('Old archives', [wi(1, { comment: 'x', key: ['x'], content: 'x' })]);
        env.modules.expose('bookRoles', {
            all: () => [
                { book: 'Old archives', role: 'ck.archive' },
                { book: 'Pack', role: 'ck.archive' },
            ],
            roleOf: () => undefined,
        });
        env.n.bunnyBooks = { core: [], packs: ['Pack'], archives: [] };
        expect(await styleUp.archiveBooks()).toEqual({
            books: ['Archives', 'Old archives'],
            create: null,
            skipped: ['Pack'],
        });
        const plan = await styleUp.plan(await factsOf(sources));
        const payload = styleUp.payloadOf(plan, { book: 'Old archives', parts: ['archive'] });
        expect(payload.parts).toHaveLength(1);
        expect(payload.parts[0]).toMatchObject({ part: 'archive', book: 'Old archives', create: false });
        expect(styleUp.payloadOf(plan, { book: 'Pack' }).parts[1]).toMatchObject({ book: 'Archives' });
    });

    it('only hints at the passport when NAI Studio writes it itself or cannot generate one', async () => {
        const { sources, styleUp } = await setup({ generator: false });
        const facts = await factsOf(sources);
        let plan = await styleUp.plan(facts);
        expect(plan.parts.map((item) => item.part)).toEqual(['canon', 'archive']);
        expect(plan.hints).toEqual([{ part: 'passport', key: 'passportManual' }]);

        env.n.naiSettings = { des: { enabled: true, autoPassports: true } };
        plan = await styleUp.plan(facts);
        expect(plan.hints).toEqual([{ part: 'passport', key: 'passportAuto', params: { name: 'Мира' } }]);
        expect(styleUp.hintText(plan.hints[0]!)).toContain('NAI Studio writes a passport for Мира itself');

        env.n.naiSettings = { des: { enabled: true, autoPassports: false } };
        withGenerator(async () => {
            throw new Error('NovelAI is down');
        });
        plan = await styleUp.plan(facts);
        expect(plan.hints).toEqual([{ part: 'passport', key: 'passportFailed', params: { error: 'NovelAI is down' } }]);
        withGenerator(async () => null);
        expect((await styleUp.plan(facts)).hints[0]?.key).toBe('passportFailed');
    });

    it('needs an open chat and skips characters that already have everything', async () => {
        const { sources, styleUp } = await setup();
        expect(await styleUp.gaps(await factsOf(sources, LYRA_ID))).toBeNull();
        const lyra = await styleUp.plan(await factsOf(sources, LYRA_ID));
        expect(lyra.parts).toEqual([]);
        const facts = await factsOf(sources);
        env.mock.chatId = undefined as unknown as string;
        const plan = await styleUp.plan(facts);
        expect(plan.parts).toEqual([]);
        expect(plan.hints[0]?.key).toBe('noChat');
    });
});

describe('«Оформить»: the proposal and applying it', () => {
    async function planned() {
        const ctx = await setup();
        const plan = await ctx.styleUp.plan(await factsOf(ctx.sources));
        return { ...ctx, plan };
    }

    it('sends one Inbox card with every part’s before and after', async () => {
        const { styleUp, plan } = await planned();
        expect(await styleUp.propose(plan)).toBe('queued');
        const proposal = env.autonomy.proposals.at(-1) as Proposal<StyleUpPayload>;
        expect(proposal.kind).toBe(STYLE_UP_KIND);
        expect(proposal.title).toBe('Style up Мира');
        expect(proposal.description).toContain('• Chat canon entry «Мира» (5 keys)');
        expect(proposal.description).toContain('• CarrotKernel archive in «Archives» (6 tags)');
        expect(proposal.description).toContain('• NAI passport of Мира for this chat');
        expect(proposal.changes.map((change) => change.ref.part)).toEqual(['canon', 'archive', 'passport']);
        expect(proposal.changes.every((change) => change.target === STYLE_UP_TARGET && change.before === null)).toBe(
            true,
        );
        expect(proposal.changes[1]?.after).toMatchObject({ book: 'Archives', keys: ['Мира'] });
        expect(proposal.changes[2]?.after).toMatchObject({ name: 'Мира', tags: expect.stringContaining('red braid') });
        expect(isStyleUpPayload(proposal.payload)).toBe(true);
        expect(JSON.parse(JSON.stringify(proposal.payload))).toEqual(proposal.payload);
        expect(await styleUp.propose(plan, { parts: [] })).toBe('skipped');
    });

    it('writes each part at once and journals each part on its own', async () => {
        const { styleUp, plan, nai, canon } = await planned();
        const scans: string[][] = [];
        Object.assign(env.app.adapters.ck as unknown as Dict, {
            kernel: () => ({ scanSelectedLorebooks: (names: string[]) => void scans.push(names) }),
        });
        env.autonomy.levels.set(STYLE_UP_KIND, 'auto');
        expect(await styleUp.propose(plan)).toBe('applied');

        const item = (await canon.list({ kind: 'addition' })).find((candidate) => candidate.entry.comment === 'Мира')!;
        expect(item.entry.key).toEqual(MIRA_FORMS);
        expect(item.meta).toMatchObject({ kind: 'addition', status: 'active', origin: 'entity', type: 'character' });
        const stored = env.world.entry(canon.bookName(), item.uid)!;
        expect((stored.extensions as Dict).maestro).toMatchObject({
            typeFields: { name: 'Мира', personality: 'холодная' },
        });

        const archive = Object.values(env.world.entries('Archives')).find(
            (entry) => entry.comment === 'Мира Character Archive',
        )!;
        expect(archive).toMatchObject({
            key: ['Мира'],
            position: 4,
            depth: 2,
            role: 0,
            order: 550,
            excludeRecursion: true,
        });
        expect(String(archive.content)).toContain('<Name:Мира>');
        expect(env.world.saves.at(-1)).toEqual({ name: 'Archives', immediately: true });
        expect(scans).toEqual([['Archives']]);

        expect(nai.saved.at(-1)).toMatchObject({ scope: 'chat', passport: { name: 'Мира' } });
        expect(nai.saved.at(-1)?.target).toBeUndefined();
        const passportId = nai.saved.at(-1)!.passport.id;
        expect(nai.getPassport(passportId)?.name).toBe('Мира');

        expect(partRecords().map((record) => record.summary)).toEqual([
            'Style up Мира: canon entry',
            'Style up Мира: CK archive in «Archives»',
            'Style up Мира: NAI passport of this chat',
        ]);
        const card = env.journal.records.find(
            (record) => record.kind === STYLE_UP_KIND && record.summary === 'Style up Мира',
        )!;
        expect(card.changes).toHaveLength(3);
        expect(styleUp.lastResult(MIRA_ID)?.outcomes).toEqual([
            { part: 'canon', ok: true },
            { part: 'archive', ok: true },
            { part: 'passport', ok: true },
        ]);

        // One part undone on its own.
        const archiveRecord = partRecords().find((record) => record.changes[0]?.ref.part === 'archive')!;
        expect(await env.journal.undo(archiveRecord.id)).toBe(true);
        expect(
            Object.values(env.world.entries('Archives')).some((entry) => entry.comment === 'Мира Character Archive'),
        ).toBe(false);
        expect((await canon.list({ kind: 'addition' })).some((candidate) => candidate.uid === item.uid)).toBe(true);

        // The card's record undoes what is left.
        expect(await env.journal.undo(card.id)).toBe(true);
        expect((await canon.list({ kind: 'addition' })).some((candidate) => candidate.uid === item.uid)).toBe(false);
        expect(nai.getPassport(passportId)).toBeNull();
        expect(partRecords().every((record) => record.undone)).toBe(true);
    });

    it('applies a stored card after a reload and refuses to undo a part changed since', async () => {
        const { styleUp, plan } = await planned();
        const payload = JSON.parse(JSON.stringify(styleUp.payloadOf(plan, { parts: ['archive'] }))) as unknown;
        const applier = env.inbox2.appliers.get(STYLE_UP_KIND)!;
        expect(await applier.valid?.(payload)).toBe(true);
        expect(await applier.valid?.({ op: 'nope' })).toBe(false);
        await expect(applier.apply({ op: 'nope' })).rejects.toThrow('bad dossier card');
        await applier.apply(payload);
        const [uid, archive] = Object.entries(env.world.entries('Archives')).find(
            ([, entry]) => entry.comment === 'Мира Character Archive',
        )!;
        await env.world.edit('Archives', Number(uid), { content: `${String(archive.content)} edited` });
        const record = partRecords()[0]!;
        expect(await env.journal.undo(record.id)).toBe(false);
        // A second copy of the same archive is refused.
        await expect(applier.apply(payload)).rejects.toThrow('already has an archive of Мира');
    });

    it('creates «Maestro · архив» with the role «CK archive» and says CK must be told', async () => {
        const { sources, styleUp } = await setup();
        env.n.ckRepos = [];
        const roles: [string, string][] = [];
        env.modules.expose('bookRoles', {
            all: () => [],
            roleOf: () => undefined,
            setRole: async (book: string, role: string) => void roles.push([book, role]),
        });
        const plan = await styleUp.plan(await factsOf(sources));
        const result = await styleUp.applyStyleUp(styleUp.payloadOf(plan, { parts: ['archive'] }));
        expect(env.world.books.has('Maestro · архив')).toBe(true);
        expect(env.world.listUpdates).toBeGreaterThan(0);
        expect(roles).toEqual([['Maestro · архив', 'ck.archive']]);
        expect(result.outcomes[0]).toMatchObject({
            part: 'archive',
            ok: true,
            note: expect.stringContaining('Character Repo'),
        });
        const record = partRecords()[0]!;
        expect(record.changes[0]?.ref).toMatchObject({ part: 'archive', book: 'Maestro · архив', createdBook: true });
    });

    it('never writes an archive into a BunnyMo book (P13)', async () => {
        const { styleUp, plan } = await planned();
        const payload = styleUp.payloadOf(plan, { parts: ['archive'] });
        const archivePart = payload.parts[0] as Extract<StyleUpPayload['parts'][number], { part: 'archive' }>;
        archivePart.book = 'Pack';
        const before = structuredClone(env.world.books.get('Pack'));
        await expect(styleUp.applyStyleUp(payload)).rejects.toBeInstanceOf(ProtectedBookError);
        expect(env.world.books.get('Pack')).toEqual(before);
        expect(styleUp.lastResult(MIRA_ID)?.outcomes[0]).toMatchObject({
            ok: false,
            error: expect.stringContaining('P13'),
        });
        expect(await styleUp.stillValid(payload)).toBe(false);
    });

    it('reports the parts that failed and keeps the ones written', async () => {
        const { styleUp, plan } = await planned();
        env.n.naiApi = undefined;
        const result = await styleUp.applyStyleUp(styleUp.payloadOf(plan));
        expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false]);
        expect(env.ui.notices.at(-1)).toMatchObject({ options: { level: 'warn' } });
        expect(env.ui.notices.at(-1)?.text).toContain('NAI passport: NAI Studio 0.10 or newer');
        expect(await styleUp.stillValid(styleUp.payloadOf(plan, { parts: ['passport'] }))).toBe(false);
    });
});

describe('«Оформить» for a place', () => {
    class CanonPlaces extends FakePlaces {
        constructor(
            places: Place[],
            private readonly canon: () => CanonApi,
        ) {
            super(places);
        }
        override async ensureEntry(id: string): Promise<{ world: string; uid: number }> {
            this.ensured.push(id);
            const target = this.get(id)!;
            if (target.entry) return target.entry;
            const canon = this.canon();
            const uid = await canon.put({
                entry: { comment: target.name, key: [target.name], content: `Place: ${target.name}\nDescription: ` },
                meta: { kind: 'addition', status: 'active', origin: 'entity', type: 'place' },
            });
            target.entry = { world: canon.bookName(), uid };
            return target.entry;
        }
    }

    function lorePassports(): LorePassportsApi & { generated: [string, number][]; removed: [string, number][] } {
        const store = new Map<string, LorePassport>();
        const api = {
            generated: [] as [string, number][],
            removed: [] as [string, number][],
            get: async (world: string, uid: number) => store.get(`${world}#${uid}`) ?? null,
            set: async () => {},
            remove: async (world: string, uid: number) => {
                api.removed.push([world, uid]);
                store.delete(`${world}#${uid}`);
            },
            generate: async (world: string, uid: number) => {
                api.generated.push([world, uid]);
                const passport: LorePassport = {
                    passport: { kind: 'location', name: 'Таверна', slots: { base: 'tavern interior, candles' } },
                    storage: 'entry',
                    generatedBy: 'model',
                    updatedAt: 1,
                };
                store.set(`${world}#${uid}`, passport);
                return passport;
            },
            forScene: () => [],
            onChange: () => () => {},
        };
        return api;
    }

    it('creates the description entry with what is known and its passport', async () => {
        const { sources, styleUp, canon } = await setup();
        const port = place({ id: 'port', name: 'Порт' });
        const tavern = place({
            id: 'tavern',
            name: 'Таверна',
            aliases: ['Кабак'],
            parent: 'port',
            background: 'Old tavern by the docks.',
            visits: [{ from: 1, to: 3, present: ['Мира'], events: [] }],
        });
        const places = new CanonPlaces([port, tavern], () => canon);
        env.modules.expose('places', places);
        const lore = lorePassports();
        env.modules.expose('lorePassports', lore);
        const facts = await factsOf(sources, 'place:tavern');
        expect(await styleUp.gaps(facts)).toEqual({ kind: 'place', missing: ['placeEntry', 'lorePassport'] });
        const plan = await styleUp.plan(facts);
        expect(plan).toMatchObject({ kind: 'place', name: 'Таверна' });
        const entryPart = part(plan, 'placeEntry');
        expect(entryPart.content).toBe(
            'Place: Таверна\nAliases: Кабак\nLocation: Порт\nDescription: Old tavern by the docks.\nInhabitants: Мира',
        );
        env.autonomy.levels.set(STYLE_UP_KIND, 'auto');
        expect(await styleUp.propose(plan)).toBe('applied');
        const entry = tavern.entry!;
        const item = (await canon.list()).find((candidate) => candidate.uid === entry.uid)!;
        expect(item.entry.content).toBe(entryPart.content);
        expect(item.entry.key).toEqual(['Таверна']);
        expect(lore.generated).toEqual([[entry.world, entry.uid]]);
        expect(await styleUp.gaps(await factsOf(sources, 'place:tavern'))).toBeNull();

        const card = env.journal.records.find((record) => record.summary === 'Style up the place Таверна')!;
        expect(await env.journal.undo(card.id)).toBe(true);
        expect(lore.removed).toEqual([[entry.world, entry.uid]]);
        expect((await canon.list()).some((candidate) => candidate.uid === entry.uid)).toBe(false);
    });

    it('links an existing description entry instead of rewriting it', async () => {
        const { sources, styleUp } = await setup();
        const tavern = place({ id: 'tavern', name: 'Таверна' });
        env.modules.expose('places', new FakePlaces([tavern]));
        env.modules.expose('lorePassports', lorePassports());
        const plan = await styleUp.plan(await factsOf(sources, 'place:tavern'));
        const result = await styleUp.applyStyleUp(plan.parts.length ? styleUp.payloadOf(plan) : (null as never));
        expect(result.outcomes[0]).toMatchObject({
            part: 'placeEntry',
            ok: true,
            note: expect.stringContaining('linked'),
        });
        expect(result.outcomes[1]).toMatchObject({ part: 'lorePassport', ok: true });
        expect(await styleUp.stillValid(styleUp.payloadOf(plan, { parts: ['placeEntry'] }))).toBe(false);
    });
});

describe('«Повысить до книги карточки»', () => {
    async function withAddition() {
        const ctx = await setup();
        const lyra = (env.mock.context as unknown as { characters: STCharacter[] }).characters[0]!;
        lyra.data = { extensions: { world: 'World' } };
        const uid = await ctx.canon.put({
            entry: { comment: 'Мира', key: ['Мира'], content: 'Character: Мира\nRole: травница' },
            meta: { kind: 'addition', status: 'active', origin: 'entity', type: 'character' },
        });
        return { ...ctx, uid };
    }

    function realAutonomy(): { levels: (AutonomyLevel | Decision)[] } {
        const autonomy = createAutonomy({ settings: env.settings, journal: env.journal, log: env.log });
        autonomy.bind({ inbox: env.inbox2, ui: env.ui, i18n: env.app.i18n });
        env.app.autonomy = autonomy;
        return { levels: [] };
    }

    it('offers the canon addition for the card’s book and copies it after asking', async () => {
        realAutonomy();
        const { sources, uid, canon } = await withAddition();
        // A new instance: the real autonomy learns that promotion is never «auto».
        const styleUp = new DossierStyleUp(env.app, sources, env.log);
        styleUp.install();
        expect(env.app.autonomy.isNeverAuto?.(PROMOTE_KIND)).toBe(true);
        const info = await styleUp.info(await factsOf(sources));
        expect(info).toMatchObject({ cardBook: 'World', promotable: [uid] });

        env.ui.confirmAnswer = false;
        expect(await styleUp.promote(MIRA_ID, uid)).toBe('rejected');
        expect(env.ui.confirms.at(-1)?.title).toBe('Promote «Мира» to the card’s lorebook «World»?');
        expect(Object.values(env.world.entries('World')).some((entry) => entry.comment === 'Мира')).toBe(false);

        env.ui.confirmAnswer = true;
        expect(await styleUp.promote(MIRA_ID, uid)).toBe('applied');
        const copied = Object.values(env.world.entries('World')).find((entry) => entry.comment === 'Мира')!;
        expect(copied).toMatchObject({ key: ['Мира'], content: 'Character: Мира\nRole: травница', disable: false });
        expect(copied.extensions).toBeUndefined();
        expect((await canon.list()).some((item) => item.uid === uid)).toBe(false);
        expect(styleUp.lastResult(MIRA_ID)?.outcomes).toEqual([{ part: 'promote', ok: true }]);

        const record = env.journal.records.find(
            (item) => item.kind === PROMOTE_KIND && item.changes[0]?.target === STYLE_UP_TARGET,
        )!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(Object.values(env.world.entries('World')).some((entry) => entry.comment === 'Мира')).toBe(false);
        expect((await canon.list({ kind: 'addition' })).some((item) => item.entry.comment === 'Мира')).toBe(true);
    });

    it('refuses a BunnyMo book and a card without a book', async () => {
        const { styleUp, uid } = await withAddition();
        const lyra = (env.mock.context as unknown as { characters: STCharacter[] }).characters[0]!;
        lyra.data = { extensions: { world: 'Pack' } };
        await expect(styleUp.promote(MIRA_ID, uid)).rejects.toBeInstanceOf(ProtectedBookError);
        lyra.data = { extensions: {} };
        await expect(styleUp.promote(MIRA_ID, uid)).rejects.toThrow('The card has no lorebook of its own.');
        await expect(styleUp.promote(MIRA_ID, 999)).rejects.toThrow('The canon entry is gone.');
        expect(await styleUp.cardBook()).toBeNull();
    });

    it('applies a stored promotion card and checks it first', async () => {
        const { uid } = await withAddition();
        const applier = env.inbox2.appliers.get(PROMOTE_KIND)!;
        const payload = {
            op: 'promote',
            planId: 'pr-1',
            entityId: MIRA_ID,
            canonUid: uid,
            book: 'World',
            title: 'Мира',
        };
        expect(isPromotePayload(payload)).toBe(true);
        expect(await applier.valid?.(payload)).toBe(true);
        expect(await applier.valid?.({ ...payload, book: 'Pack' })).toBe(false);
        await applier.apply(payload);
        expect(Object.values(env.world.entries('World')).some((entry) => entry.comment === 'Мира')).toBe(true);
        expect(await applier.valid?.(payload)).toBe(false);
        await expect(applier.apply({ op: 'promote' })).rejects.toThrow('bad dossier card');
    });
});
