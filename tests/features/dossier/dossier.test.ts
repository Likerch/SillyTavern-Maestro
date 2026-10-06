// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonModule } from '../../../src/features/canon';
import type { CanonApi } from '../../../src/features/canon/api';
import { DossierActions, ProtectedBookError } from '../../../src/features/dossier/actions';
import type { ActionPayload } from '../../../src/features/dossier/actions';
import type { DossierApi, DossierFinding, DossierSection } from '../../../src/features/dossier/api';
import { compareSources } from '../../../src/features/dossier/compare';
import { defaultDossierSettings } from '../../../src/features/dossier/settings';
import { DossierSources } from '../../../src/features/dossier/sources';
import type { Entity, EntityIdentity } from '../../../src/features/world/api';
import { message } from '../../helpers/st-mock';
import { ARCHIVE_CONTENT, LYRA_FORMS_KEY, LYRA_ID, lyraScene, personaScene } from './fixtures';
import {
    FakePlaces,
    FakeWorldModel,
    createDossierEnv,
    passport,
    place,
    settle,
    startDossier,
    startModule,
    wi,
} from './helpers';
import type { DossierEnv } from './helpers';

let env: DossierEnv;
let stops: (() => Promise<void>)[];

beforeEach(() => {
    env = createDossierEnv();
    stops = [];
});

afterEach(async () => {
    for (const stop of stops.reverse()) await stop();
});

async function start(options: { canon?: boolean } = {}): Promise<DossierApi> {
    if (options.canon) {
        const canon = await startModule(env, canonModule);
        stops.push(() => canon.stop());
    }
    const started = await startDossier(env);
    stops.push(() => started.stop());
    return env.modules.api<DossierApi>('dossier')!;
}

function sectionOf(sections: DossierSection[], kind: DossierSection['kind'], title?: string): DossierSection {
    const found = sections.find((item) => item.kind === kind && (title === undefined || item.title.includes(title)));
    if (!found) throw new Error(`no ${kind} section ${title ?? ''}: ${sections.map((item) => item.title).join(' | ')}`);
    return found;
}

function actions(): { sources: DossierSources; actions: DossierActions } {
    const sources = new DossierSources(env.app, defaultDossierSettings, env.log);
    return { sources, actions: new DossierActions(env.app, sources, env.log) };
}

describe('entities without the world model', () => {
    it('lists the persona, the card character, DES characters and places', async () => {
        lyraScene(env);
        env.n.desKnown = ['Лира', 'Мара', 'Алекс'];
        env.modules.expose('places', new FakePlaces([place({ id: 'tavern', name: 'Таверна' })]));
        const { sources } = actions();
        const { entities, worldOn } = sources.entities();
        expect(worldOn).toBe(false);
        expect(entities.map((entity) => entity.id)).toEqual([
            'persona:алекс',
            'character:лира',
            'character:мара',
            'place:tavern',
        ]);
        const lyra = entities.find((entity) => entity.id === LYRA_ID)!;
        expect(lyra.aliases).toEqual(['Lyra', 'Лисичка']);
        expect(lyra.forms).toContain('Лирой');
        expect(lyra.present).toBe(true);
        expect(lyra.sources[0]).toMatchObject({ kind: 'card', avatar: 'lyra.png' });
        expect(sources.resolve('Лисичка')?.id).toBe(LYRA_ID);
        expect(sources.resolve('лирой')?.id).toBe(LYRA_ID);
        expect(sources.resolve('')).toBeUndefined();
    });

    it('builds the card character from every store', async () => {
        lyraScene(env);
        const api = await start();
        const dossier = await api.build(LYRA_ID);
        expect(dossier).toMatchObject({ entityId: LYRA_ID, name: 'Лира', kind: 'character' });
        const kinds = dossier.sections.map((item) => item.kind);
        expect(kinds).toEqual(['des', 'lore', 'ck', 'tags', 'nai', 'forms', 'qvink', 'rag', 'sheet']);
        const sections = dossier.sections;

        const des = sectionOf(sections, 'des');
        expect(des.text).toBe('Лира — травница из леса.');
        expect(des.fields).toMatchObject({
            emoji: '🧝',
            color: '#aabbcc',
            aliases: 'Lyra, Лисичка',
            relationship: 'Friendly',
            relationshipOverride: 'Близкая подруга',
            portraitPrompt: 'silver hair, elf',
            'stat.Health': '80',
            'detail.appearance': 'серебряные волосы',
        });
        expect(des.messageIndex).toBe(1);

        const lore = sectionOf(sections, 'lore');
        expect(lore.title).toBe('Lyra');
        expect(lore.text).toBe('Lyra is an elf with long silver hair.');
        expect(lore.source).toMatchObject({ kind: 'lore.entry', world: 'World', uid: 1 });
        expect(sections.some((item) => item.text === 'Pack text.')).toBe(false);

        const archive = sectionOf(sections, 'ck');
        expect(archive.fields).toMatchObject({ name: 'Лира', book: 'Archives', mbti: 'INFP · healthy' });
        expect(archive.text).toBe('<Linguistics>Говорит тихо.</Linguistics>');
        expect(sectionOf(sections, 'tags').fields).toMatchObject({
            'tag.SPECIES': 'ELF',
            'tag.GENRE': 'FANTASY',
            'tag.MBTI': 'INFP-H',
        });

        const nai = sectionOf(sections, 'nai');
        expect(nai.text).toBe('short black hair, green eyes\nOn the card: long silver hair, green eyes');
        expect(nai.fields).toMatchObject({
            id: 'p1',
            level: 'card',
            owner: 'Лира',
            chatOverride: 'hair',
            'slot.hair': 'short black hair',
            'base.slot.hair': 'long silver hair',
            edit: 'NAI Studio → passport manager',
        });
        expect(nai.source).toMatchObject({ kind: 'nai.passport', passportId: 'p1', avatar: 'lyra.png' });

        expect(sectionOf(sections, 'forms').text).toBe('Лира, Лиры, Лире, Лиру, Лирой, Lyra, Лисичка, Лисички');
        expect(sectionOf(sections, 'forms').fields?.formsKey).toBe(LYRA_FORMS_KEY);

        const memories = sectionOf(sections, 'qvink');
        expect(memories.text).toBe('#1 ★ Лира нашла травы.\n#3 Алекс спорил с Лирой.');
        expect(memories.messageIndex).toBe(3);

        expect(sectionOf(sections, 'rag')).toMatchObject({
            text: 'CarrotKernel RAG is on.',
            fields: { 'rag.carrotkernel_char_лира': 'лира' },
        });
        const sheet = sectionOf(sections, 'sheet');
        expect(sheet.messageIndex).toBe(3);
        expect(sheet.fields).toMatchObject({ command: '!fullsheet' });
    });

    it('keeps the last 10 memories besides the long-term ones and notes a disabled RAG', async () => {
        lyraScene(env);
        while (env.mock.chat.length < 25) env.mock.chat.push(message('…', { name: 'Лира' }));
        for (let index = 10; index < 25; index++) {
            env.n.memories.set(index, {
                memory: `Лира шаг ${index}`,
                remember: false,
                exclude: false,
                include: null,
                lagging: false,
                edited: false,
            });
        }
        env.n.ckSettings = { rag: { enabled: false } };
        const api = await start();
        const sections = (await api.build(LYRA_ID)).sections;
        const lines = sectionOf(sections, 'qvink').text.split('\n');
        expect(lines).toHaveLength(11);
        expect(lines[0]).toBe('#1 ★ Лира нашла травы.');
        expect(lines[1]).toBe('#15 Лира шаг 15');
        expect(sectionOf(sections, 'rag').text).toBe('CarrotKernel RAG is off.');
    });

    it('shows the canon override next to the base entry and canon additions', async () => {
        lyraScene(env);
        const api = await start({ canon: true });
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        await canon.put({
            entry: { content: 'Lyra cut her hair short.' },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world: 'World', uid: 1, contentHash: '' },
            },
        });
        await canon.put({
            entry: { comment: 'Lyra scar', key: ['Lyra'], content: 'Lyra has a scar.' },
            meta: { kind: 'addition', status: 'provisional', origin: 'living' },
        });
        const sections = (await api.build(LYRA_ID)).sections;
        expect(sectionOf(sections, 'lore').fields?.canon).toBe('overridden in this chat');
        const override = sectionOf(sections, 'canon', 'Canon of this chat');
        expect(override.text).toBe('Lyra cut her hair short.');
        expect(override.source?.kind).toBe('canon.entry');
        expect(override.fields?.overrides).toBe('content');
        const addition = sectionOf(sections, 'canon', 'Canon: Lyra scar');
        expect(addition.fields).toMatchObject({ status: 'provisional', origin: 'living' });
    });

    it('builds a persona dossier', async () => {
        personaScene(env);
        const api = await start();
        const dossier = await api.build('persona:алекс');
        const persona = sectionOf(dossier.sections, 'persona');
        expect(persona.text).toBe('Алекс — наёмник со шрамом через бровь.');
        expect(persona.fields).toMatchObject({
            avatar: 'alex.png',
            lorebook: 'Persona Book',
            lorebookEntries: 'Alex past',
            color: '#123456',
            pronouns: 'he/him',
        });
        expect(persona.source).toMatchObject({ kind: 'persona', world: 'Persona Book' });
        const nai = sectionOf(dossier.sections, 'nai');
        expect(nai.text).toBe('black hair');
        expect(nai.fields?.level).toBe('persona');
        expect(dossier.findings).toEqual([]);
        env.n.naiSettings = {};
        expect((await api.check('persona:алекс')).map((item) => item.kind)).toEqual(['missingPassport']);
    });

    it('builds a place dossier with nesting, visits, its passport and the missing description', async () => {
        const places = new FakePlaces([
            place({ id: 'city', name: 'Город' }),
            place({
                id: 'tavern',
                name: 'Таверна',
                aliases: ['Трактир'],
                parent: 'city',
                passportId: 'loc1',
                background: 'Дымная таверна у ворот.',
                state: { time: 'night' },
                visits: [{ from: 1, to: 3, present: ['Лира'], storyDate: '1 мая', events: ['драка'] }],
            }),
            place({ id: 'cellar', name: 'Погреб', parent: 'tavern' }),
        ]);
        env.modules.expose('places', places);
        env.n.naiPresent = true;
        env.n.passports.set(0, [passport({ id: 'loc1', kind: 'location', name: 'Tavern', tags: 'tavern, indoors' })]);
        Object.assign(env.mock.context as unknown as Record<string, unknown>, {
            characters: [{ name: 'Лира', avatar: 'lyra.png', data: { extensions: {} } }],
        });
        const api = await start();
        const dossier = await api.build('place:tavern');
        const info = sectionOf(dossier.sections, 'place');
        expect(info.fields).toMatchObject({
            aliases: 'Трактир',
            path: 'Город → Таверна',
            children: 'Погреб',
            visits: '1',
            'state.time': 'night',
            passport: 'loc1',
        });
        expect(info.text).toContain('Дымная таверна у ворот.');
        expect(info.text).toContain('#1–#3 (1 мая): Лира — драка');
        expect(sectionOf(dossier.sections, 'nai').text).toBe('tavern, indoors');
        const [finding] = dossier.findings;
        expect(finding).toMatchObject({
            kind: 'missingEntry',
            fix: { payload: { op: 'placeEntry', placeId: 'tavern' } },
        });

        env.autonomy.levels.set('dossier.fix', 'auto');
        const decision = await actions().actions.fix(finding!);
        expect(decision).toBe('applied');
        expect(places.ensured).toEqual(['tavern']);
        expect(await actions().actions.fix(finding!)).toBe('skipped');
    });

    it('rejects unknown entities', async () => {
        const api = await start();
        await expect(api.build('character:никто')).rejects.toThrow('Unknown entity');
    });
});

describe('with the world model', () => {
    it('takes entities and sources from it and uses its mentions', async () => {
        lyraScene(env);
        env.world.book('Extra', [wi(9, { comment: 'Lyra secret', key: ['tea'], content: 'Lyra hides a letter.' })]);
        env.n.memories.set(4, {
            memory: 'Сильвия ушла.',
            remember: false,
            exclude: false,
            include: null,
            lagging: false,
            edited: false,
        });
        const entity: Entity = {
            id: LYRA_ID,
            kind: 'character',
            name: 'Лира',
            aliases: ['Lyra'],
            forms: ['Лира', 'Сильвия'],
            sources: [{ kind: 'lore.entry', ref: 'Extra#9', world: 'Extra', uid: 9, label: 'Lyra secret' }],
            present: true,
        };
        const world = new FakeWorldModel([entity]);
        env.modules.expose('world', world);
        const api = await start();
        const dossier = await api.build(LYRA_ID);
        expect(sectionOf(dossier.sections, 'lore', 'Lyra secret').text).toBe('Lyra hides a letter.');
        expect(sectionOf(dossier.sections, 'lore', 'Lyra').source?.world).toBeDefined();
        expect(sectionOf(dossier.sections, 'qvink').text).toContain('#4 Сильвия ушла.');
        expect(sectionOf(dossier.sections, 'forms').text).toBe('Лира, Сильвия');
        const { sources } = actions();
        expect(sources.entities().worldOn).toBe(true);
        expect(sources.resolve('Lyra')?.id).toBe(LYRA_ID);
    });
});

describe('other stories (plan-2 §9)', () => {
    const MARA_ID = 'character:мара';
    const pending = [
        {
            kind: 'ck.archive' as const,
            ref: 'Archives#7',
            label: 'Мара',
            world: 'Archives',
            uid: 7,
            scope: 'global' as const,
            key: 'ck:Archives#мара',
        },
        {
            kind: 'nai.passport' as const,
            ref: 'lyra.png#npc1',
            label: 'Мара',
            passportId: 'npc1',
            avatar: 'lyra.png',
            scope: 'card' as const,
            key: 'nai:lyra.png#npc1',
        },
        { kind: 'des.workshop' as const, ref: 'Мара', label: 'Мара', scope: 'global' as const, key: 'des:мара' },
    ];

    class IdentityWorld extends FakeWorldModel {
        readonly calls: unknown[][] = [];
        identity(id: string): EntityIdentity | undefined {
            return id === MARA_ID ? { ofCard: false, shared: [], pending, apart: [] } : undefined;
        }
        foreignRefs(): string[] {
            return ['Archives#7', 'World#3'];
        }
        async sameAs(id: string, keys?: string[]): Promise<void> {
            this.calls.push(['sameAs', id, keys]);
        }
        async different(id: string, keys?: string[]): Promise<void> {
            this.calls.push(['different', id, keys]);
        }
    }

    function maraScene(): IdentityWorld {
        lyraScene(env);
        env.n.desKnown = ['Лира', 'Мара'];
        env.n.desSettings = { ...env.n.desSettings, characterAppearance: { Мара: 'red hair, green dress' } };
        env.world.book('Archives', [
            wi(5, { comment: 'Лира Character Archive', key: ['Лира'], content: ARCHIVE_CONTENT }),
            wi(7, {
                comment: 'x',
                key: ['Мара'],
                content: '<BunnymoTags><Name:Мара>, <SPECIES:VAMPIRE></BunnymoTags>',
            }),
        ]);
        env.world.book('World', [
            wi(1, { comment: 'Lyra', key: ['Лира', 'Lyra'], content: 'Lyra is an elf with long silver hair.' }),
            wi(3, { comment: 'Old Мара', key: ['Мара'], content: 'Мара of another story.' }),
        ]);
        env.n.passports.set(0, [passport({ id: 'npc1', name: 'Мара', slots: { hair: 'red hair' } })]);
        const world = new IdentityWorld([
            {
                id: MARA_ID,
                kind: 'character',
                name: 'Мара',
                aliases: [],
                forms: [],
                sources: [{ kind: 'des.character', ref: 'Мара', label: 'Мара', scope: 'chat' }],
            },
        ]);
        env.modules.expose('world', world);
        return world;
    }

    it('a namesake’s archive, card passport, entries and DES Workshop data stay out of the dossier', async () => {
        maraScene();
        const api = await start();
        const dossier = await api.build(MARA_ID);
        const kinds = dossier.sections.map((item) => item.kind);
        expect(kinds).not.toContain('ck');
        expect(kinds).not.toContain('nai');
        expect(kinds).not.toContain('lore');
        expect(dossier.sections.some((item) => item.text.includes('another story'))).toBe(false);
        expect(sectionOf(dossier.sections, 'des').fields?.portraitPrompt).toBeUndefined();
        const other = dossier.findings.filter((item) => item.kind === 'otherStory');
        expect(other.map((item) => item.text)).toEqual([
            'Мара is known in other stories too: character and way of speaking from the sheet in «Archives»; ' +
                'looks and outfits from the passport of the card «lyra»; portrait and description from DES. ' +
                'Until you decide, that data is not used here.',
            'If Мара here is another character, the old data never shows up here.',
        ]);
        expect(other.map((item) => item.fix?.payload)).toEqual([
            { op: 'sameAs', entityId: MARA_ID, keys: ['ck:Archives#мара', 'nai:lyra.png#npc1', 'des:мара'] },
            { op: 'apart', entityId: MARA_ID, keys: ['ck:Archives#мара', 'nai:lyra.png#npc1', 'des:мара'] },
        ]);
    });

    it('«It is the same one» and «It is another character» go to the world model at once', async () => {
        const world = maraScene();
        const api = await start();
        const [same, apart] = (await api.check(MARA_ID)).filter((item) => item.kind === 'otherStory');
        expect(await actions().actions.fix(same!)).toBe('applied');
        expect(await actions().actions.fix(apart!)).toBe('applied');
        expect(world.calls).toEqual([
            ['sameAs', MARA_ID, ['ck:Archives#мара', 'nai:lyra.png#npc1', 'des:мара']],
            ['different', MARA_ID, ['ck:Archives#мара', 'nai:lyra.png#npc1', 'des:мара']],
        ]);
    });

    it('data from outside used for a character of this chat can be declared another one’s', async () => {
        const world = maraScene();
        world.identity = (id: string) =>
            id === MARA_ID
                ? { ofCard: false, shared: pending.slice(0, 1), pending: [], apart: pending.slice(1) }
                : undefined;
        const api = await start();
        const findings = await api.check(MARA_ID);
        expect(findings.filter((item) => item.kind === 'otherStory').map((item) => item.fix?.label)).toEqual([
            'It is the same one',
        ]);
        const shared = findings.find((item) => item.kind === 'sharedStory')!;
        expect(shared.text).toBe(
            'For Мара Maestro also uses data from outside this chat: character and way of speaking from the sheet in «Archives».',
        );
        expect(shared.fix).toEqual({
            label: 'It is another character',
            payload: { op: 'apart', entityId: MARA_ID, keys: ['ck:Archives#мара'] },
        });
    });
});

describe('structural checks', () => {
    it('reports an alias that is no key and missing case forms, with fixes', async () => {
        lyraScene(env);
        const api = await start();
        const findings = await api.check(LYRA_ID);
        expect(findings.map((item) => item.kind)).toEqual(['aliasNotKey', 'formsMissing']);
        const [alias, forms] = findings as [DossierFinding, DossierFinding];
        expect(alias.text).toContain('«Лисичка»');
        expect(alias.fix).toEqual({
            label: 'Add «Лисичка» as a key',
            payload: { op: 'addKeys', world: 'World', uid: 1, keys: ['Лисичка'] },
        });
        expect(alias.sources.map((source) => source.kind)).toEqual(['lore.entry', 'des.character']);
        expect(forms.fix?.payload).toEqual({ op: 'addKeys', world: 'World', uid: 1, keys: [LYRA_FORMS_KEY] });
        expect((await api.build(LYRA_ID)).findings).toHaveLength(2);
    });

    it('reports a DES character without entry, passport and archive, and differing names', async () => {
        lyraScene(env);
        env.n.desKnown = ['Лира', 'Мара'];
        env.n.desAliases = { Мара: ['Mara'] };
        env.world.book('Archives', [
            wi(5, {
                comment: 'x',
                key: ['Мара'],
                content: '<BunnymoTags><Name:Mara_Vane>, <SPECIES:HUMAN></BunnymoTags>',
            }),
        ]);
        env.n.passports.set(0, [passport({ id: 'p2', name: 'Marra', aliases: ['Мара'] })]);
        const api = await start();
        // Plan-2 §9: Мара is not the card's — a repo archive and an NPC passport of the card with her name may be a
        // namesake's of another story, so they are not hers here (before, they were taken by the bare name).
        expect((await api.check('character:мара')).map((item) => item.kind)).toEqual([
            'missingEntry',
            'missingPassport',
            'missingArchive',
        ]);
        // Once the card itself names her, they are hers.
        const card = (env.mock.context as unknown as { characters: STCharacter[] }).characters[0]!;
        card.description = `${card.description ?? ''} Её ученица — Мара.`;
        const kinds = (await api.check('character:мара')).map((item) => item.kind);
        expect(kinds).toEqual(['missingEntry', 'nameMismatch']);
        env.n.passports.set(0, []);
        env.world.book('Archives', []);
        const again = await api.check('character:мара');
        expect(again.map((item) => item.kind)).toEqual(['missingEntry', 'missingPassport', 'missingArchive']);
    });

    it('offers a DES alias note for a differing name', async () => {
        lyraScene(env);
        env.world.book('Archives', [
            wi(5, { comment: 'x', key: ['Лира'], content: ARCHIVE_CONTENT.replace('Лира', 'Lira Moon') }),
        ]);
        const api = await start();
        const mismatch = (await api.check(LYRA_ID)).find((item) => item.kind === 'nameMismatch')!;
        expect(mismatch.fix?.payload).toEqual({ op: 'desAlias', canonical: 'Лира', alias: 'Lira Moon' });
        expect(await actions().actions.fix(mismatch)).toBe('queued');
        expect(env.inbox2.added.map((card) => card.kind)).toEqual(['dossier.note']);
        expect(env.inbox2.added[0]?.description).toContain('DES owns aliases');
    });
});

describe('fixes', () => {
    it('adds the alias as a key through the chat canon and undoes it', async () => {
        lyraScene(env);
        const api = await start({ canon: true });
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        const [alias] = await api.check(LYRA_ID);
        const { actions: act } = actions();
        expect(await act.fix(alias!)).toBe('queued');
        const proposal = env.autonomy.proposals.at(-1)!;
        expect(proposal).toMatchObject({ module: 'M7', kind: 'dossier.fix' });
        expect(proposal.payload).toMatchObject({
            op: 'canonOverride',
            fields: { key: ['Лира', 'Lyra', 'Лисичка'] },
            before: { key: ['Лира', 'Lyra'] },
            created: true,
        });

        env.autonomy.levels.set('dossier.fix', 'auto');
        expect(await act.fix(alias!)).toBe('applied');
        const [item] = await canon.list({ kind: 'override' });
        expect(item?.entry.key).toEqual(['Лира', 'Lyra', 'Лисичка']);
        expect(item?.meta.fields).toEqual(['key']);
        expect(env.world.entry('World', 1)?.key).toEqual(['Лира', 'Lyra']);
        // The new key «Лисичка» has case forms of its own now.
        const after = await api.check(LYRA_ID);
        expect(after.map((finding) => finding.kind)).toEqual(['formsMissing', 'formsMissing']);
        expect(after[1]?.text).toContain('«Лисичка»');
        expect(await act.fix(alias!)).toBe('skipped');

        const record = env.journal.records.find((entry) => entry.kind === 'dossier.fix')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(await canon.list({ kind: 'override' })).toEqual([]);
    });

    it('merges into an existing override and keeps its overridden content', async () => {
        lyraScene(env);
        const api = await start({ canon: true });
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        await canon.put({
            entry: { content: 'Lyra cut her hair short.' },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world: 'World', uid: 1, contentHash: '' },
                fields: ['content'],
            },
        });
        env.autonomy.levels.set('dossier.fix', 'auto');
        const [alias] = await api.check(LYRA_ID);
        expect(await actions().actions.fix(alias!)).toBe('applied');
        const [item] = await canon.list({ kind: 'override' });
        expect(item?.meta.fields).toEqual(['content', 'key']);
        expect(item?.entry.content).toBe('Lyra cut her hair short.');
        expect(item?.entry.key).toEqual(['Лира', 'Lyra', 'Лисичка']);
        const record = env.journal.records.find((entry) => entry.kind === 'dossier.fix')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        const [restored] = await canon.list({ kind: 'override' });
        expect(restored?.entry.key).toEqual(['Лира', 'Lyra']);
        expect(restored?.entry.content).toBe('Lyra cut her hair short.');
    });

    it('patches the base book without the canon (never auto) and undoes it', async () => {
        lyraScene(env);
        const api = await start();
        const [alias] = await api.check(LYRA_ID);
        const { actions: act } = actions();
        env.autonomy.levels.set('dossier.fixFile', 'auto');
        expect(await act.fix(alias!)).toBe('applied');
        expect(env.autonomy.proposals.at(-1)?.kind).toBe('dossier.fixFile');
        expect(env.world.entry('World', 1)?.key).toEqual(['Лира', 'Lyra', 'Лисичка']);
        const record = env.journal.records.find((entry) => entry.kind === 'dossier.fixFile')!;
        expect(record.changes[0]).toMatchObject({ target: 'dossier-entry', before: { key: ['Лира', 'Lyra'] } });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.world.entry('World', 1)?.key).toEqual(['Лира', 'Lyra']);
    });

    it('refuses BunnyMo books (P13) at check, fix, spread and write', async () => {
        lyraScene(env);
        const entity: Entity = {
            id: LYRA_ID,
            kind: 'character',
            name: 'Лира',
            aliases: [],
            forms: [],
            sources: [{ kind: 'lore.entry', ref: 'Pack#4', world: 'Pack', uid: 4, label: 'Лира in pack' }],
        };
        env.modules.expose('world', new FakeWorldModel([entity]));
        env.n.bunnyActive = [];
        const api = await start({ canon: true });
        const dossier = await api.build(LYRA_ID);
        expect(sectionOf(dossier.sections, 'lore').fields?.protected).toBe('BunnyMo book (read-only)');
        const alias = dossier.findings.find((item) => item.kind === 'aliasNotKey')!;
        expect(alias.fix).toBeUndefined();
        expect(alias.text).toContain('P13');
        expect(dossier.findings.some((item) => item.kind === 'formsMissing')).toBe(false);

        const { actions: act } = actions();
        const forged: DossierFinding = {
            ...alias,
            fix: { label: 'x', payload: { op: 'addKeys', world: 'Pack', uid: 4, keys: ['Лисичка'] } },
        };
        await expect(act.fix(forged)).rejects.toBeInstanceOf(ProtectedBookError);
        expect(env.autonomy.proposals).toHaveLength(0);
        const count = await api.spread({
            entityId: LYRA_ID,
            field: 'alias',
            value: 'Лиса',
            targets: [entity.sources[0]!],
        });
        expect(count).toBe(0);
        const write: ActionPayload = {
            op: 'baseKeys',
            world: 'Pack',
            uid: 4,
            before: ['Лира'],
            after: ['Лира', 'Лиса'],
        };
        await expect(act.apply(write)).rejects.toBeInstanceOf(ProtectedBookError);
        await expect(
            act.apply({
                op: 'canonOverride',
                world: 'Pack',
                uid: 4,
                fields: { key: ['x'] },
                before: {},
                created: true,
            }),
        ).rejects.toBeInstanceOf(ProtectedBookError);
        expect(await act.stillValid(write)).toBe(false);
        expect(env.world.entry('Pack', 4)?.key).toEqual(['Лира']);
    });
});

describe('AI comparison', () => {
    async function prepare(): Promise<DossierApi> {
        lyraScene(env);
        return start();
    }

    it('runs as a background task with a strict schema and returns findings with sources', async () => {
        const api = await prepare();
        env.llm.result = {
            ok: true,
            data: {
                findings: [
                    {
                        kind: 'appearance',
                        a: 'S1',
                        b: 'S4',
                        quoteA: 'длинными серебряными волосами',
                        quoteB: 'short black hair',
                        summary: 'Hair length and colour differ',
                    },
                    { kind: 'appearance', a: 'S1', b: 'S99', quoteA: 'x', quoteB: 'y', summary: 'bad id' },
                ],
            },
            costUsd: 0.0021,
        };
        const pending = api.compareWithAi(LYRA_ID);
        const twice = api.compareWithAi(LYRA_ID);
        await settle();
        expect(env.tasks.queued).toHaveLength(1);
        expect(env.tasks.queued[0]).toMatchObject({ kind: 'dossier.compare', dedupeKey: LYRA_ID });
        await env.tasks.runLatest('dossier.compare');
        const findings = await pending;
        expect(await twice).toEqual(findings);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ kind: 'appearanceMismatch', severity: 'warn' });
        expect(findings[0]?.text).toContain('Hair length and colour differ');
        expect(findings[0]?.sources.map((source) => source.kind)).toEqual(['card', 'nai.passport']);
        const request = env.llm.requests[0]!;
        expect(request.task).toBe('dossier.compare');
        expect(request.schema?.name).toBe('dossier_compare');
        expect(request.messages[0]?.content).toContain('contradictions');
        expect(request.messages[1]?.content).toContain('[S1] character card: Лира');
        expect(request.messages[1]?.content).toContain('short black hair');

        const dossier = await api.build(LYRA_ID);
        expect(dossier.findings.map((item) => item.kind)).toContain('appearanceMismatch');
    });

    it('rejects malformed answers, refusals and runs it cannot do', async () => {
        const api = await prepare();
        env.llm.result = { ok: true, data: 'certainly not json' };
        const malformed = api.compareWithAi(LYRA_ID);
        await settle();
        await env.tasks.runLatest('dossier.compare');
        await expect(malformed).rejects.toMatchObject({ code: 'parse' });

        env.llm.result = { ok: false, refusal: true, error: 'refusal' };
        const refused = api.compareWithAi(LYRA_ID);
        await settle();
        await env.tasks.runLatest('dossier.compare');
        await expect(refused).rejects.toMatchObject({ code: 'refusal' });

        env.llm.result = { ok: false, error: 'cap' };
        const capped = api.compareWithAi(LYRA_ID);
        await settle();
        await env.tasks.runLatest('dossier.compare');
        await expect(capped).rejects.toThrow('daily cap');

        const queued = env.tasks.queued.length;
        env.leader.value = false;
        await expect(api.compareWithAi(LYRA_ID)).rejects.toMatchObject({ code: 'notLeader' });
        env.leader.value = true;
        env.cost.capped = true;
        await expect(api.compareWithAi(LYRA_ID)).rejects.toMatchObject({ code: 'cap' });
        env.cost.capped = false;
        env.llm.ready = false;
        await expect(api.compareWithAi(LYRA_ID)).rejects.toMatchObject({ code: 'noProfile' });
        expect(env.tasks.queued).toHaveLength(queued);
    });

    it('does not call the model with fewer than two texts', async () => {
        const api = await start();
        Object.assign(env.mock.context as unknown as Record<string, unknown>, { name1: 'Алекс' });
        const pending = api.compareWithAi('persona:алекс');
        await settle();
        await env.tasks.runLatest('dossier.compare');
        expect(await pending).toEqual([]);
        expect(env.llm.requests).toHaveLength(0);
    });

    it('collects the texts of every store for the comparison', async () => {
        lyraScene(env);
        const { sources } = actions();
        const facts = await sources.facts(sources.entity(LYRA_ID)!);
        expect(compareSources(facts).map((item) => item.store)).toEqual([
            'character card',
            'lorebook entry',
            'CarrotKernel archive',
            'NAI image passport (tags)',
            'scene tracker (current scene)',
            'portrait prompt',
            'workshop description',
        ]);
    });
});

describe('spread', () => {
    it('turns one edit into proposals for every target by its owner', async () => {
        const { nai } = lyraScene(env);
        const world = new FakeWorldModel([]);
        const api = await start({ canon: true });
        const dossier = await api.build(LYRA_ID);
        env.modules.expose('world', world);
        world.list = [{ id: LYRA_ID, kind: 'character', name: 'Лира', aliases: [], forms: [], sources: [] }];
        const targets = dossier.sections.map((item) => item.source).filter((source) => source !== undefined);
        targets.push({ kind: 'chat.alias', ref: LYRA_ID, label: 'chat' });
        const count = await api.spread({ entityId: LYRA_ID, field: 'alias', value: ' Лиса ', targets });
        expect(count).toBe(4);
        expect(env.autonomy.proposals.map((item) => (item.payload as ActionPayload).op)).toEqual([
            'canonOverride',
            'passport',
            'chatAlias',
        ]);
        expect(env.autonomy.proposals.every((item) => item.kind === 'dossier.spread')).toBe(true);
        expect(env.inbox2.added.map((card) => card.kind)).toEqual(['dossier.note']);
        expect(env.inbox2.added[0]?.title).toContain('«Лиса»');

        env.autonomy.levels.set('dossier.spread', 'auto');
        expect(await api.spread({ entityId: LYRA_ID, field: 'alias', value: 'Лиса', targets })).toBe(4);
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        const [override] = await canon.list({ kind: 'override' });
        expect(override?.entry.key).toEqual(['Лира', 'Lyra', 'Лиса']);
        expect(nai.saved).toHaveLength(1);
        expect(nai.saved[0]).toMatchObject({ scope: 'chat', target: { avatar: 'lyra.png' } });
        expect(nai.saved[0]?.passport).toMatchObject({
            id: 'p1',
            aliases: ['Lyra', 'Лиса'],
            slots: { hair: 'short black hair', eyes: 'green eyes' },
        });
        expect(world.chatAliases()).toEqual({ Лиса: LYRA_ID });
        const passportRecord = env.journal.records.find((entry) => entry.changes[0]?.target === 'dossier-passport')!;
        expect(await env.journal.undo(passportRecord.id)).toBe(true);
        expect(nai.saved.at(-1)?.passport.aliases).toEqual(['Lyra']);
        const record = env.journal.records.find((entry) => entry.changes[0]?.target === 'dossier-chat-alias')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(world.chatAliases()).toEqual({});
    });

    it('appends appearance to the lore through the canon and to the passport body slot', async () => {
        const { nai } = lyraScene(env);
        const api = await start({ canon: true });
        const dossier = await api.build(LYRA_ID);
        env.autonomy.levels.set('dossier.spread', 'auto');
        const lore = sectionOf(dossier.sections, 'lore').source!;
        const passportSource = sectionOf(dossier.sections, 'nai').source!;
        const count = await api.spread({
            entityId: LYRA_ID,
            field: 'appearance',
            value: 'scar on face',
            targets: [lore, passportSource],
        });
        expect(count).toBe(2);
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        const [override] = await canon.list({ kind: 'override' });
        expect(override?.entry.content).toBe('Lyra is an elf with long silver hair.\n\nAppearance: scar on face');
        expect(nai.saved[0]?.passport.slots).toEqual({
            hair: 'short black hair',
            eyes: 'green eyes',
            body: 'scar on face',
        });
        expect(
            await api.spread({ entityId: LYRA_ID, field: 'appearance', value: 'scar on face', targets: [lore] }),
        ).toBe(0);
        expect(await api.spread({ entityId: LYRA_ID, field: 'description', value: 'Healer.', targets: [lore] })).toBe(
            1,
        );
        expect((await canon.list({ kind: 'override' }))[0]?.entry.content).toBe('Healer.');
        const record = [...env.journal.records].reverse().find((entry) => entry.kind === 'dossier.spread')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect((await canon.list({ kind: 'override' }))[0]?.entry.content).toContain('Appearance: scar on face');
    });

    it('updates places and canon additions, and skips what cannot take the edit', async () => {
        lyraScene(env);
        const places = new FakePlaces([place({ id: 'tavern', name: 'Таверна' })]);
        env.modules.expose('places', places);
        const api = await start({ canon: true });
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        const uid = await canon.put({
            entry: { comment: 'Tavern lore', key: ['Таверна'], content: 'A tavern.' },
            meta: { kind: 'addition', status: 'active', origin: 'user' },
        });
        env.autonomy.levels.set('dossier.spread', 'auto');
        const placeSource = { kind: 'place' as const, ref: 'tavern', label: 'Таверна' };
        const canonSource = { kind: 'canon.entry' as const, ref: `x#${uid}`, label: 'Tavern lore', world: 'x', uid };
        expect(
            await api.spread({
                entityId: 'place:tavern',
                field: 'alias',
                value: 'Трактир',
                targets: [placeSource, canonSource],
            }),
        ).toBe(2);
        expect(places.get('tavern')?.aliases).toEqual(['Трактир']);
        expect((await canon.list({ kind: 'addition' }))[0]?.entry.key).toEqual(['Таверна', 'Трактир']);
        expect(
            await api.spread({ entityId: 'place:tavern', field: 'name', value: 'Корчма', targets: [placeSource] }),
        ).toBe(1);
        expect(places.get('tavern')?.name).toBe('Корчма');
        const record = [...env.journal.records]
            .reverse()
            .find((entry) => entry.changes[0]?.target === 'dossier-place')!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(places.get('tavern')?.name).toBe('Таверна');
        expect(
            await api.spread({
                entityId: 'place:tavern',
                field: 'appearance',
                value: 'x',
                targets: [
                    placeSource,
                    { kind: 'ck.archive', ref: 'a', label: 'a' },
                    { kind: 'des.character', ref: 'Лира', label: 'Лира' },
                ],
            }),
        ).toBe(0);
        expect(
            await api.spread({ entityId: 'place:tavern', field: 'alias', value: '  ', targets: [placeSource] }),
        ).toBe(0);
    });

    it('applies stored Inbox payloads after a reload', async () => {
        lyraScene(env);
        await start({ canon: true });
        expect([...env.inbox2.appliers.keys()].filter((kind) => kind.startsWith('dossier.')).sort()).toEqual([
            'dossier.fix',
            'dossier.fixFile',
            'dossier.note',
            'dossier.promoteToCard',
            'dossier.spread',
            'dossier.styleUp',
        ]);
        const applier = env.inbox2.appliers.get('dossier.fix')!;
        const payload: ActionPayload = {
            op: 'canonOverride',
            world: 'World',
            uid: 1,
            fields: { key: ['Лира', 'Lyra', 'Ли'] },
            before: { key: ['Лира', 'Lyra'] },
            created: true,
        };
        expect(await applier.valid?.(payload)).toBe(true);
        await applier.apply(payload);
        const canon = env.modules.api<Required<CanonApi>>('canon')!;
        expect((await canon.list({ kind: 'override' }))[0]?.entry.key).toEqual(['Лира', 'Lyra', 'Ли']);
        expect(await applier.valid?.(payload)).toBe(false);
        await expect(applier.apply({ nope: true })).rejects.toThrow('bad dossier card');
        await env.inbox2.appliers.get('dossier.note')!.apply({ op: 'note', text: 'Remember' });
        expect(env.ui.notices.at(-1)?.text).toBe('Remember');
    });
});

describe('module', () => {
    it('opens the dossier from the slash command and the API', async () => {
        lyraScene(env);
        const api = await start();
        const seen: (string | null)[] = [];
        api.onChange((id) => seen.push(id));
        const command = env.slash.find((item) => item.name === 'maestro-dossier')!;
        expect(await command.callback({}, 'Лисичка')).toBe('');
        expect(env.opened).toEqual(['dossier']);
        expect(seen).toEqual([LYRA_ID]);
        expect(await command.callback({}, 'Никто')).toBe('Nobody named «Никто» is known.');
        expect(await command.callback({}, '')).toBe('');
        expect(env.opened).toEqual(['dossier', 'dossier']);
        api.open('persona:алекс');
        expect(seen.at(-1)).toBe('persona:алекс');
    });

    it('refreshes the open dossier when NAI Studio saves passports', async () => {
        const { nai } = lyraScene(env);
        const api = await start();
        api.open(LYRA_ID);
        const seen: (string | null)[] = [];
        api.onChange((id) => seen.push(id));
        nai.emit('passportsSaved', { ids: ['p1'], scope: 'card', avatar: 'lyra.png' });
        expect(seen).toEqual([LYRA_ID]);
    });

    it('checks passport proposals against the passport this chat sees', async () => {
        const { nai } = lyraScene(env);
        await start();
        const applier = env.inbox2.appliers.get('dossier.spread')!;
        const payload: ActionPayload = {
            op: 'passport',
            id: 'p1',
            target: { avatar: 'lyra.png' },
            patch: { aliases: ['Lyra', 'Ли'] },
            before: { aliases: ['Lyra'], slots: { hair: 'short black hair' } },
        };
        expect(await applier.valid?.(payload)).toBe(true);
        await applier.apply(payload);
        expect(nai.saved[0]).toMatchObject({ scope: 'chat', target: { avatar: 'lyra.png' } });
        expect(await applier.valid?.(payload)).toBe(false);
        expect(await applier.valid?.({ ...payload, id: 'missing' })).toBe(false);
        env.n.naiApi = undefined;
        await expect(applier.apply(payload)).rejects.toThrow('NAI Studio 0.10');
    });

    it('leaves no trace when disabled', async () => {
        lyraScene(env);
        await start();
        expect(env.ui.tabs.map((tab) => tab.id)).toContain('dossier');
        expect(env.tasks.runners.has('dossier.compare')).toBe(true);
        expect(env.ui.styles.has('m7-dossier')).toBe(true);
        for (const stop of stops.splice(0).reverse()) await stop();
        expect(env.ui.tabs.map((tab) => tab.id)).not.toContain('dossier');
        expect(env.tasks.runners.has('dossier.compare')).toBe(false);
        expect(env.ui.styles.has('m7-dossier')).toBe(false);
        expect(env.inbox2.appliers.size).toBe(0);
        expect(env.slash).toHaveLength(0);
        expect(env.modules.api('dossier')).toBeUndefined();
    });
});
