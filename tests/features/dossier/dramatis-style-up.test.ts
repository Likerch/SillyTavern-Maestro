// @vitest-environment happy-dom
// «Оформить» with tags given by Dramatis (release 1.17, MAESTRO_API.styleUp): a CK archive with exactly the tags that
// pass the BunnyMo mode's check — no model call — proposed as one «Оформить» card; packs untouched (P13).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTagDictionary, checkTags, entriesWithUid, tagVocabulary } from '../../../src/domain/bunnymo-mode-tags';
import type { BunnyMoModeApi, TagDictionary, TagValidation } from '../../../src/features/bunnymoMode/api';
import { canonModule } from '../../../src/features/canon';
import { defaultDossierSettings } from '../../../src/features/dossier/settings';
import { DossierSources } from '../../../src/features/dossier/sources';
import { DossierStyleUp, STYLE_UP_KIND, archiveTagOf } from '../../../src/features/dossier/style-up';
import type { StyleUpPayload } from '../../../src/features/dossier/style-up';
import type { Proposal } from '../../../src/shared/contracts';
import { STYLE_UP_PACK, miraScene } from './fixtures';
import { createDossierEnv, startModule } from './helpers';
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

function exposeBunnymo(): void {
    env.world.book('Pack', STYLE_UP_PACK);
    const dict = buildTagDictionary({
        books: [{ name: 'Pack', core: false, entries: entriesWithUid(env.world.books.get('Pack')) }],
        archives: [],
        builtAt: 1,
    });
    const api: Partial<BunnyMoModeApi> = {
        dictionary: async (): Promise<TagDictionary> => dict,
        validateTags: async (tags) =>
            checkTags(tags, tagVocabulary(dict)).map((check): TagValidation => ({ ...check })),
    };
    env.modules.expose('bunnymoMode', api);
}

async function setup(): Promise<DossierStyleUp> {
    miraScene(env);
    const canon = await startModule(env, canonModule);
    stops.push(() => canon.stop());
    exposeBunnymo();
    const styleUp = new DossierStyleUp(env.app, new DossierSources(env.app, defaultDossierSettings, env.log), env.log);
    const offs = styleUp.install();
    stops.push(async () => offs.forEach((off) => off()));
    return styleUp;
}

const TAGS = [
    '<SPECIES:HUMAN>',
    '<DERE:KUUDERE>',
    '<INTJ-U>',
    '<SPECIES:DRAGON>',
    '<LING:BLUNT>',
    '<DEPRESSION>',
    'junk',
];

describe('«Оформить» with Dramatis’s tags', () => {
    it('reads tags as the archive writes them', () => {
        expect(archiveTagOf('<SPECIES:elf>')).toEqual({ category: 'SPECIES', value: 'ELF' });
        expect(archiveTagOf('<infp-h>')).toEqual({ type: 'INFP', variant: 'H' });
        expect(archiveTagOf('<MBTI:ENTJ-U>')).toEqual({ type: 'ENTJ', variant: 'U' });
        expect(archiveTagOf('<MBTI:nope>')).toBeNull();
        expect(archiveTagOf('<DEPRESSION>')).toBeNull();
        expect(archiveTagOf('trait stoic')).toBeNull();
    });

    it('proposes one card with an archive of exactly the tags the packs know, without the model', async () => {
        const styleUp = await setup();
        expect(await styleUp.archiveWithTags('Мира', TAGS)).toBe(true);
        expect(env.llm.requests).toEqual([]);
        const proposal = env.autonomy.proposals.at(-1) as Proposal<StyleUpPayload>;
        expect(proposal.kind).toBe(STYLE_UP_KIND);
        expect(proposal.payload.parts).toHaveLength(1);
        const archive = proposal.payload.parts[0]!;
        expect(archive).toMatchObject({
            part: 'archive',
            book: 'Archives',
            create: false,
            name: 'Мира',
            keys: ['Мира'],
        });
        if (archive.part !== 'archive') throw new Error('not an archive');
        expect(archive.tags).toEqual(['<SPECIES:HUMAN>', '<DERE:KUUDERE>', '<LING:BLUNT>', '<INTJ-U>']);
        expect(archive.content).toBe(
            '<BunnymoTags><Name:Мира> <PHYSICAL><SPECIES:HUMAN></PHYSICAL> ' +
                '<PERSONALITY><DERE:KUUDERE>, <INTJ-U></PERSONALITY></BunnymoTags>\n' +
                '<Linguistics>Character uses <LING:BLUNT>.</Linguistics>',
        );
        expect(archive.rejected.map((item) => item.tag)).toEqual(['<SPECIES:DRAGON>', '<DEPRESSION>', 'junk']);
        // The tags Dramatis offered that the packs do not know are technical: «Подробнее».
        expect(proposal.details).toContain('<SPECIES:DRAGON>, <DEPRESSION>, junk');
        expect(proposal.description).not.toContain('DRAGON');
    });

    it('writes the archive into the CK repository when autonomy applies it', async () => {
        const styleUp = await setup();
        env.autonomy.levels.set(STYLE_UP_KIND, 'auto');
        expect(await styleUp.archiveWithTags('Мира', ['<SPECIES:HUMAN>', '<TRAIT:STOIC>'])).toBe(true);
        const written = Object.values(env.world.entries('Archives')).find(
            (entry) => entry.comment === 'Мира Character Archive',
        );
        expect(String(written?.content)).toBe(
            '<BunnymoTags><Name:Мира> <PHYSICAL><SPECIES:HUMAN></PHYSICAL> <PERSONALITY><TRAIT:STOIC></PERSONALITY></BunnymoTags>',
        );
        // The pack is untouched (P13).
        expect(env.world.saves.some((save) => save.name === 'Pack')).toBe(false);
    });

    it('says false when it cannot: an archive exists, nothing passes, no BunnyMo mode, no chat', async () => {
        const styleUp = await setup();
        expect(await styleUp.archiveWithTags('Лира', ['<SPECIES:HUMAN>'])).toBe(false);
        expect(await styleUp.archiveWithTags('Мира', ['<SPECIES:DRAGON>', 'junk'])).toBe(false);
        expect(await styleUp.archiveWithTags('Мира', [])).toBe(false);
        expect(await styleUp.archiveWithTags('  ', ['<SPECIES:HUMAN>'])).toBe(false);
        env.modules.apis.delete('bunnymoMode');
        expect(await styleUp.archiveWithTags('Мира', ['<SPECIES:HUMAN>'])).toBe(false);
        exposeBunnymo();
        env.mock.chatId = undefined;
        expect(await styleUp.archiveWithTags('Мира', ['<SPECIES:HUMAN>'])).toBe(false);
        expect(env.autonomy.proposals).toEqual([]);
    });

    it('works for a new name the world model does not know yet', async () => {
        const styleUp = await setup();
        expect(await styleUp.archiveWithTags('Bram', ['<SPECIES:HUMAN>'])).toBe(true);
        const proposal = env.autonomy.proposals.at(-1) as Proposal<StyleUpPayload>;
        expect(proposal.payload).toMatchObject({ entityId: 'character:bram', name: 'Bram' });
    });
});
