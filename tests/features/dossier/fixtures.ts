// The «Лира» scene used by the dossier tests: a card character with a lorebook entry, a CK archive, a NAI passport
// with a chat-level override, DES roster/aliases/tracker/Workshop data, DES-RU forms, Qvink memories, CK RAG and a
// marked !fullsheet reply; plus a persona.
import { message } from '../../helpers/st-mock';
import { FakeNaiApi, desRuApi, passport, setCharacters, tracker, wi } from './helpers';
import type { Dict, DossierEnv } from './helpers';

export const LYRA_ID = 'character:лира';
export const LYRA_FORMS = ['Лира', 'Лиры', 'Лире', 'Лиру', 'Лирой'];
export const LYRA_FORMS_KEY = '/(?<![\\p{L}\\p{N}_])лир(?:а|ы|е|у|ой)/iu';

export const ARCHIVE_CONTENT =
    '<BunnymoTags><Name:Лира>, <SPECIES:ELF>, <GENRE:FANTASY>, <INFP-H></BunnymoTags>\n<Linguistics>Говорит тихо.</Linguistics>';

export function lyraScene(env: DossierEnv): { nai: FakeNaiApi } {
    const ctx = env.mock.context as unknown as Dict;
    ctx.name1 = 'Алекс';
    setCharacters(env, [
        {
            name: 'Лира',
            avatar: 'lyra.png',
            description: 'Лира — эльфийка с длинными серебряными волосами.',
            data: { extensions: {} },
        },
    ]);
    env.world.book('World', [
        wi(1, { comment: 'Lyra', key: ['Лира', 'Lyra'], content: 'Lyra is an elf with long silver hair.' }),
        wi(2, { comment: 'Tavern', key: ['таверна'], content: 'A tavern.' }),
    ]);
    env.world.book('Archives', [wi(5, { comment: 'Лира Character Archive', key: ['Лира'], content: ARCHIVE_CONTENT })]);
    env.world.book('Pack', [
        wi(1, { comment: 'Elf', key: ['<SPECIES:ELF>'], content: 'Elves are graceful.' }),
        wi(2, { comment: 'Fantasy', key: ['<GENRE:FANTASY>'], content: 'Fantasy genre.' }),
        wi(3, { comment: 'INFP', key: ['<INFP-H>'], content: 'INFP healthy.' }),
        wi(4, { comment: 'Лира in pack', key: ['Лира'], content: 'Pack text.' }),
    ]);
    const n = env.n;
    n.bunnyActive = ['World', 'Pack'];
    n.bunnyBooks = { core: [], packs: ['Pack'], archives: ['Archives'] };
    n.ckPresent = true;
    n.ckRepos = ['Archives'];
    n.ckSettings = {
        rag: {
            enabled: true,
            collectionMetadata: { carrotkernel_char_лира: { characterName: 'Лира', keywords: ['лира'] } },
        },
    };
    n.desKnown = ['Лира'];
    n.desAliases = { Лира: ['Lyra', 'Лисичка'] };
    n.desSettings = {
        characterAppearance: { Лира: 'silver hair, elf' },
        characterInjection: { Лира: { description: 'Лира — травница из леса.' } },
        characterRelationships: { Лира: 'Близкая подруга' },
    };
    n.trackers.set(
        1,
        tracker([
            {
                name: 'Лира',
                emoji: '🧝',
                color: '#aabbcc',
                relationship: 'Friendly',
                details: { appearance: 'серебряные волосы', demeanor: 'спокойная' },
                stats: [{ name: 'Health', value: 80 }],
            },
        ]),
    );
    n.desruApi = desRuApi({ Лира: LYRA_FORMS, Лисичка: ['Лисичка', 'Лисички'] }, () => LYRA_FORMS_KEY);
    n.qvinkPresent = true;
    n.memories.set(1, {
        memory: 'Лира нашла травы.',
        remember: true,
        exclude: false,
        include: 'long',
        lagging: false,
        edited: false,
    });
    n.memories.set(3, {
        memory: 'Алекс спорил с Лирой.',
        remember: false,
        exclude: false,
        include: 'short',
        lagging: false,
        edited: false,
    });
    n.memories.set(4, {
        memory: 'Дождь над городом.',
        remember: false,
        exclude: false,
        include: 'short',
        lagging: false,
        edited: false,
    });
    n.naiPresent = true;
    n.passports.set(0, [
        passport({ id: 'p1', aliases: ['Lyra'], slots: { hair: 'long silver hair', eyes: 'green eyes' } }),
        passport({ id: 'w1', kind: 'world', name: 'Forest', tags: 'forest' }),
    ]);
    // NAI Studio 0.10: the chat overrides the card's hair.
    env.mock.chatMetadata = {
        nai_studio: {
            passports: { overrides: { p1: { owner: 'lyra.png', slots: { hair: 'short black hair' } } }, extra: [] },
        },
    };
    const nai = new FakeNaiApi(n, () => env.mock.chatMetadata);
    n.naiApi = nai;
    env.mock.chat = [
        message('Привет', { is_user: true, name: 'Алекс' }),
        message('Лира улыбается.', { name: 'Лира' }),
        message('!fullsheet Лира', {
            is_user: true,
            name: 'Алекс',
            extra: { maestro: { sheet: { command: 'fullsheet', target: 'Лира', part: 'command' } } },
        }),
        message('## SECTION 1/2\n<BunnymoTags><Name:Лира>, <SPECIES:ELF></BunnymoTags>', {
            name: 'Лира',
            extra: { maestro: { sheet: { command: 'fullsheet', target: 'Лира', part: 'reply' } } },
        }),
        message('Дождь.', { name: 'Лира' }),
    ];
    return { nai };
}

export function personaScene(env: DossierEnv): void {
    const ctx = env.mock.context as unknown as Dict;
    ctx.name1 = 'Алекс';
    ctx.powerUserSettings = {
        persona_description: 'Алекс — наёмник со шрамом через бровь.',
        persona_description_lorebook: 'Persona Book',
    };
    env.world.book('Persona Book', [wi(1, { comment: 'Alex past', key: ['Алекс'], content: 'Alex was a soldier.' })]);
    env.host.modules.load = async (path: string) => (path.includes('personas') ? { user_avatar: 'alex.png' } : {});
    env.n.naiPresent = true;
    env.n.naiSettings = {
        scene: {
            personaPassports: { 'alex.png': { id: 'pp', kind: 'character', name: '', slots: { hair: 'black hair' } } },
        },
    };
    env.n.desSettings = { userCharacters: { Алекс: { color: '#123456', pronouns: 'he/him' } } };
}

/* ------------------------------------------------------------------ «Оформить» (M7 п. 6) */

export const MIRA_ID = 'character:мира';
export const MIRA_FORMS = ['Мира', 'Миры', 'Мире', 'Миру', 'Мирой'];

/** Pack entries the BunnyMo dictionary of the «Оформить» tests is built from. */
export const STYLE_UP_PACK = [
    wi(11, { comment: 'Human', key: ['<SPECIES:HUMAN>'], content: 'Humans.' }),
    wi(12, { comment: 'Kuudere', key: ['<DERE:KUUDERE>'], content: 'Cool.' }),
    wi(13, { comment: 'Stoic', key: ['<TRAIT:STOIC>'], content: 'Stoic.' }),
    wi(14, { comment: 'Blunt', key: ['<LING:BLUNT>'], content: 'Blunt speech.' }),
    wi(15, { comment: 'INTJ-U', key: ['<INTJ-U>'], content: 'The schemer.' }),
];

/**
 * The «Лира» scene plus a new NPC «Мира» known only to DES (roster and the newest tracker): no lorebook entry, no
 * CK archive, no NAI passport. NAI Studio's API keeps the chat's own passports in `extra` like NAI Studio does.
 */
export function miraScene(env: DossierEnv): { nai: FakeNaiApi } {
    const { nai } = lyraScene(env);
    const n = env.n;
    n.desKnown = ['Лира', 'Мира'];
    n.trackers.set(
        4,
        tracker([
            { name: 'Лира', details: { appearance: 'серебряные волосы' } },
            {
                name: 'Мира',
                details: { appearance: 'рыжая коса, шрам на щеке', demeanor: 'холодная', thoughts: 'скучно' },
            },
        ]),
    );
    n.desruApi = desRuApi({ Лира: LYRA_FORMS, Лисичка: ['Лисичка', 'Лисички'], Мира: MIRA_FORMS }, () => null);
    const store = () => ((env.mock.chatMetadata.nai_studio as Dict).passports as { extra: Dict[] }).extra;
    const save = nai.savePassport.bind(nai);
    nai.savePassport = async (passport, scope, target) => {
        if (scope === 'chat' && !target && !nai.getPassport(passport.id)) {
            nai.saved.push({ passport: structuredClone(passport), scope });
            store().push(structuredClone(passport) as unknown as Dict);
            return;
        }
        await save(passport, scope, target);
    };
    const clear = nai.clearChatOverride.bind(nai);
    nai.clearChatOverride = async (id) => {
        const extra = store();
        const index = extra.findIndex((item) => item.id === id);
        if (index >= 0) extra.splice(index, 1);
        await clear(id);
    };
    return { nai };
}
