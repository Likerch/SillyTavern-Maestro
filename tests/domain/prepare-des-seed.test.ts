// «Персонажи в DES» (M37, release 1.18): what DES asks for, the detail keys DES reads, the strict schema of the seed
// task, reading the answer, the record as DES stores it, the stance → relationship mapping and greeting ↔ swipe indexes.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EMOJI,
    DES_SEED_SCHEMA_NAME,
    MOON_PHASES,
    OFF_SCENE_MARKER,
    WEATHER_KEYWORDS,
    buildDesSeedMessages,
    cleanEmoji,
    clockOf,
    composeDesSeed,
    desDetailKey,
    desSeedSchema,
    desStartExample,
    detailProp,
    greetingSwipes,
    isEmptyRecord,
    nullRecord,
    readDesSeedAnswer,
    readDesSeedConfig,
    readRecord,
    recordNames,
    relationshipConflicts,
    relationshipValence,
    sameRecord,
    sceneFieldProp,
    seedLanguage,
    seedNames,
    seedSwipe,
    seedsAnything,
    shownSwipe,
    stanceRelationship,
    statProp,
    swipeOfGreeting,
    swipePiece,
    swipeTexts,
} from '../../src/domain/prepare-des-seed';
import type { DesSeedConfig, SeedCast, SeedInput } from '../../src/domain/prepare-des-seed';

type Dict = Record<string, unknown>;

/** DES 2.6's live settings as the user's server has them: Russian fields and relationships, DES-RU's fieldKeys. */
function desSettings(patch: Dict = {}): Dict {
    return {
        enabled: true,
        showInfoBox: true,
        showCharacterThoughts: true,
        showQuests: false,
        trackerConfig: {
            infoBox: {
                widgets: {
                    date: { enabled: true, format: 'Day, Month' },
                    weather: { enabled: true },
                    temperature: { enabled: true, unit: 'C' },
                    time: { enabled: true },
                    location: { enabled: true },
                    recentEvents: { enabled: true },
                    moonPhase: { enabled: false },
                    tension: { enabled: true },
                },
                customFields: [
                    { name: 'Smell (what the air carries)', enabled: true, description: 'What it smells of' },
                    { name: 'Запах', enabled: true, description: 'Cyrillic: dropped by DES' },
                    { name: 'Danger', enabled: true, type: 'number', min: 0, max: 5, description: 'Danger 0-5' },
                    { name: 'Off', enabled: false },
                ],
            },
            presentCharacters: {
                relationships: { enabled: true },
                relationshipFields: ['Друг', 'Враг', 'Нейтральный', 'Возлюбленный'],
                customFields: [
                    { id: 'appearance', name: 'Внешность', enabled: true, description: 'Как выглядит' },
                    { id: 'demeanor', name: 'Поведение', enabled: true, description: 'Как держится' },
                    { id: 'outfit', name: 'Одежда', enabled: true, description: 'Во что одет' },
                    { id: 'x', name: 'Hidden', enabled: false },
                ],
                thoughts: { enabled: true, description: 'Мысли от первого лица' },
                characterStats: {
                    enabled: true,
                    customStats: [
                        { id: 'trust', name: 'Trust', enabled: true },
                        { id: 'health', name: 'Health', enabled: true },
                        { id: 'off', name: 'Arousal', enabled: false },
                    ],
                },
            },
        },
        ...patch,
    };
}

function member(name: string, patch: Partial<SeedCast> = {}): SeedCast {
    return {
        name,
        present: true,
        role: '',
        appearance: '',
        personality: '',
        outfit: '',
        relation: '',
        doing: '',
        goal: '',
        mood: '',
        stats: [],
        ...patch,
    };
}

function input(patch: Partial<SeedInput> = {}): SeedInput {
    return {
        greeting: 0,
        text: 'Дождь барабанит по ставням таверны «Солёный якорь». Томас протирает кружки.',
        language: 'ru',
        persona: 'Кай',
        scene: { place: 'Солёный якорь', date: 'День 1', time: 'вечер', situation: 'Kai meets Tomas.' },
        cast: [
            member('Томас', { outfit: 'a leather apron', stance: { value: 2, label: 'Дружелюбен', reason: 'гость' } }),
            member('Вера', { stats: [{ name: 'Trust', value: 40 }] }),
            member('Мартин', { present: false, role: 'Archivist' }),
        ],
        ...patch,
    };
}

describe('DES seed: what DES asks for', () => {
    it('reads the fields, keys, relationships, stats, thoughts and widgets of the live config', () => {
        const config = readDesSeedConfig(desSettings());
        expect(config.infoBox).toBe(true);
        expect(config.characters).toBe(true);
        expect(config.quests).toBe(false);
        expect(config.fields.map((field) => [field.name, field.key, field.outfit])).toEqual([
            ['Внешность', 'Внешность', false],
            ['Поведение', 'Поведение', false],
            ['Одежда', 'Одежда', true],
        ]);
        expect(config.relationships).toEqual(['Друг', 'Враг', 'Нейтральный', 'Возлюбленный']);
        expect(config.stats).toEqual(['Trust', 'Health']);
        expect(config.thoughts).toBe('Мысли от первого лица');
        expect(config.dateFormat).toBe('Day, Month');
        expect(config).toMatchObject({ weather: true, temperature: 'C', moonPhase: false, tension: true });
        // Latin custom scene fields by DES's key (parenthesis cut); Cyrillic and switched-off ones are dropped.
        expect(config.sceneFields.map((field) => [field.key, field.kind])).toEqual([
            ['smell', 'text'],
            ['danger', 'number'],
        ]);
        expect(config.sceneFields[1]).toMatchObject({ min: 0, max: 5 });
        expect(seedsAnything(config)).toBe(true);
    });

    it("falls back to DES's defaults and honours switched-off parts", () => {
        const plain = readDesSeedConfig({});
        expect(plain.fields.map((field) => field.key)).toEqual(['appearance', 'demeanor']);
        expect(plain.relationships).toEqual(['Lover', 'Friend', 'Ally', 'Enemy', 'Neutral']);
        expect(plain.stats).toEqual([]);
        expect(plain.thoughts).toBeNull();
        expect(plain.temperature).toBeNull();
        const off = readDesSeedConfig(
            desSettings({
                showInfoBox: false,
                showCharacterThoughts: false,
                customCharacterThoughtsPrompt: 'Own words',
                trackerConfig: {
                    presentCharacters: {
                        relationships: { enabled: false },
                        thoughts: { enabled: true },
                        customFields: [],
                    },
                    infoBox: { widgets: { temperature: { enabled: true, unit: 'F' } } },
                },
            }),
        );
        expect(off.relationships).toEqual([]);
        expect(off.thoughts).toBe('Own words');
        expect(off.temperature).toBe('F');
        expect(off.fields).toEqual([]);
        expect(seedsAnything(off)).toBe(false);
    });

    it('keys details as DES reads them: the whole name in snake_case, the name itself when Cyrillic', () => {
        expect(desDetailKey('Appearance')).toBe('appearance');
        expect(desDetailKey('Status Effects (up to 3)')).toBe('status_effects_up_to_3');
        expect(desDetailKey('  Внешность ')).toBe('Внешность');
    });
});

describe('DES seed: language, weather and time', () => {
    it('tells the story language by the script', () => {
        expect(seedLanguage('Дождь барабанит по ставням, Tom.')).toBe('ru');
        expect(seedLanguage('Rain drums on the shutters.')).toBe('en');
        expect(seedLanguage('')).toBe('en');
    });

    it('reads clock times and words of the day', () => {
        expect(clockOf('19:40')).toBe('19:40');
        expect(clockOf('7.05 утра')).toBe('07:05');
        expect(clockOf('3 PM')).toBe('15:00');
        expect(clockOf('12 am')).toBe('00:00');
        expect(clockOf('вечер')).toBe('19:00');
        expect(clockOf('Рассвет')).toBe('06:00');
        expect(clockOf('late night')).toBe('23:00');
        expect(clockOf('полдень')).toBe('12:00');
        expect(clockOf('днём')).toBe('13:00');
        expect(clockOf('25:99')).toBeNull();
        expect(clockOf('потом')).toBeNull();
        expect(clockOf('  ')).toBeNull();
    });

    it('keeps the keyword lists of both languages', () => {
        expect(WEATHER_KEYWORDS.ru).toContain('дождь');
        expect(WEATHER_KEYWORDS.en).toContain('rain');
    });
});

describe('DES seed: relationships', () => {
    it('places labels on the stance ladder', () => {
        expect(relationshipValence('Враг')).toBe(-3);
        expect(relationshipValence('Hostile')).toBe(-2);
        expect(relationshipValence('Недоверие')).toBe(-1);
        expect(relationshipValence('Unfriendly')).toBe(-1);
        expect(relationshipValence('Нейтральный')).toBe(0);
        expect(relationshipValence('Расположен')).toBe(1);
        expect(relationshipValence('Friend')).toBe(2);
        expect(relationshipValence('Союзник')).toBe(3);
        expect(relationshipValence('Возлюбленный')).toBe('romantic');
        expect(relationshipValence('Наставник')).toBeNull();
        expect(relationshipValence(' ')).toBeNull();
    });

    it('maps a stance to the nearest option, calmer on a tie, never a romantic one', () => {
        const ru = ['Друг', 'Враг', 'Нейтральный', 'Возлюбленный'];
        expect(stanceRelationship(3, ru)).toBe('Друг');
        expect(stanceRelationship(2, ru)).toBe('Друг');
        expect(stanceRelationship(1, ru)).toBe('Нейтральный');
        expect(stanceRelationship(0, ru)).toBe('Нейтральный');
        expect(stanceRelationship(-1, ru)).toBe('Нейтральный');
        expect(stanceRelationship(-2, ru)).toBe('Враг');
        expect(stanceRelationship(-7, ru)).toBe('Враг');
        const en = ['Lover', 'Friend', 'Ally', 'Enemy', 'Neutral'];
        expect(stanceRelationship(3, en)).toBe('Ally');
        expect(stanceRelationship(Number.NaN, en)).toBeUndefined();
        expect(stanceRelationship(1, ['Наставник', 'Возлюбленный'])).toBeUndefined();
    });

    it('tells a label that says the opposite of the stance', () => {
        expect(relationshipConflicts('Враг', 2)).toBe(true);
        expect(relationshipConflicts('Друг', -2)).toBe(true);
        expect(relationshipConflicts('Друг', 2)).toBe(false);
        expect(relationshipConflicts('Возлюбленный', -2)).toBe(true);
        expect(relationshipConflicts('Возлюбленный', 0)).toBe(false);
        expect(relationshipConflicts('Наставник', -3)).toBe(false);
    });
});

describe('DES seed: greetings and swipes', () => {
    const greetings = [
        'Дождь барабанит по ставням таверны, {{user}} входит внутрь, Томас поднимает голову.',
        'Рассвет над Серебряной Гаванью встаёт серый и солёный, {{user}} спускается к причалам.',
        'Ночь в архиве гильдии картографов, одна лампа и пыль над раскрытыми реестрами.',
    ];

    it('lines swipes up with greetings: aligned, shifted for an empty first message, else by text', () => {
        expect(greetingSwipes({ swipes: greetings, swipe_id: 1 }, greetings)).toEqual([0, 1, 2]);
        expect(greetingSwipes({ swipes: greetings.slice(1) }, ['', ...greetings.slice(1)])).toEqual([1, 2]);
        const texts = [
            greetings[2]!.replace('{{user}}', 'Кай'),
            greetings[0]!.replace('{{user}}', 'Кай'),
            'Чужой текст',
        ];
        expect(greetingSwipes({ swipes: texts }, greetings)).toEqual([2, 0, undefined]);
        expect(greetingSwipes({ mes: greetings[0] }, [greetings[0]!])).toEqual([0]);
        // Greetings too short to tell by text take their place in the card's order.
        expect(
            greetingSwipes({ swipes: ['Привет.', greetings[0], 'Пока.'] }, ['Привет.', greetings[0]!, 'Пока.']),
        ).toEqual([0, 1, 2]);
        expect(greetingSwipes({ swipes: ['Привет.'] }, ['Привет.', 'Пока.'])).toEqual([undefined]);
        expect(swipeOfGreeting({ swipes: greetings }, greetings, 2)).toBe(2);
        expect(swipeOfGreeting({ swipes: greetings }, greetings, 5)).toBeUndefined();
    });

    it('finds a stored seed again by its text, else by its index', () => {
        expect(swipeTexts({ mes: 'один' })).toEqual(['один']);
        expect(shownSwipe({ swipe_id: 2 })).toBe(2);
        expect(shownSwipe({})).toBe(0);
        const piece = swipePiece(greetings[1]!);
        expect(piece.length).toBeGreaterThan(20);
        expect(seedSwipe({ swipes: [greetings[2], greetings[1]] }, { swipe: 1, piece })).toBe(1);
        expect(seedSwipe({ swipes: [greetings[2]] }, { swipe: 0, piece })).toBeUndefined();
        expect(seedSwipe({ swipes: ['a', 'b'] }, { swipe: 1, piece: '' })).toBe(1);
        expect(seedSwipe({ swipes: ['a'] }, { swipe: 3, piece: '' })).toBeUndefined();
    });
});

describe('DES seed: the schema and the messages', () => {
    const config = readDesSeedConfig(desSettings());

    it('builds a strict schema from the live config: cast names, options, fields, stats, widgets', () => {
        const schema = desSeedSchema(config, input())!;
        expect(schema.name).toBe(DES_SEED_SCHEMA_NAME);
        const root = schema.schema as Dict;
        expect(root.required).toEqual(['characters', 'scene']);
        const item = ((root.properties as Dict).characters as Dict).items as Dict;
        const props = item.properties as Dict;
        expect((props.name as Dict).enum).toEqual(['Томас', 'Вера', 'Мартин']);
        expect((props.relationship as Dict).enum).toEqual(config.relationships);
        expect(Object.keys((props.details as Dict).properties as Dict)).toEqual(['f1', 'f2', 'f3']);
        expect(((props.details as Dict).properties as Dict).f3).toMatchObject({ description: 'Одежда: Во что одет' });
        expect(Object.keys((props.stats as Dict).properties as Dict)).toEqual([statProp(0), statProp(1)]);
        expect(item.additionalProperties).toBe(false);
        const scene = (root.properties as Dict).scene as Dict;
        const sceneProps = scene.properties as Dict;
        expect((sceneProps.weather as Dict).enum).toEqual(WEATHER_KEYWORDS.ru);
        expect(sceneProps).toHaveProperty('temperature');
        expect(sceneProps).toHaveProperty('tension');
        expect(sceneProps).not.toHaveProperty('moon_phase');
        expect(sceneProps[sceneFieldProp(1)]).toMatchObject({ type: 'number' });
        expect(scene.required).toEqual(Object.keys(sceneProps));
    });

    it('asks for nothing when DES shows nothing or there is nobody to name', () => {
        const off = readDesSeedConfig(desSettings({ showInfoBox: false, showCharacterThoughts: false }));
        expect(desSeedSchema(off, input())).toBeNull();
        const scene = desSeedSchema(config, input({ cast: [] }))!;
        expect(Object.keys((scene.schema as Dict).properties as Dict)).toEqual(['scene']);
        const extras = readDesSeedConfig(
            desSettings({
                doomCounter: { enabled: true },
                trackerConfig: {
                    infoBox: {
                        widgets: {
                            moonPhase: { enabled: true },
                            timeSinceRest: { enabled: true },
                            conditions: { enabled: true },
                            terrain: { enabled: true },
                        },
                        customFields: [
                            { name: 'Mood', enabled: true, type: 'enum', options: ['Calm', 'Grim'] },
                            { name: 'Open', enabled: true, type: 'boolean' },
                            { name: 'Clues', enabled: true, type: 'list' },
                            { name: 'Progress', enabled: true, type: 'progress' },
                            { name: 'Note', enabled: true, type: 'enum' },
                        ],
                    },
                },
            }),
        );
        const props = ((desSeedSchema(extras, input())!.schema as Dict).properties as Dict).scene as Dict;
        const scenes = props.properties as Dict;
        expect((scenes.moon_phase as Dict).enum).toEqual([...MOON_PHASES]);
        expect(scenes).toHaveProperty('doom_tension');
        expect(scenes.c1).toMatchObject({ enum: ['Calm', 'Grim'] });
        expect(scenes.c2).toMatchObject({ type: 'boolean' });
        expect(scenes.c3).toMatchObject({ type: 'array' });
        expect(scenes.c4).toMatchObject({ type: 'number' });
        expect(scenes.c5).toMatchObject({ type: 'string' });
    });

    it('writes the task: the greeting as data, the cast with what it wears and the stance, the rules', () => {
        const messages = buildDesSeedMessages(input(), config);
        expect(messages.map((item) => item.role)).toEqual(['system', 'user']);
        const user = messages[1]!.content;
        expect(user).toContain('Story language: Russian');
        expect(user).toContain('<opening_message>\nДождь барабанит');
        expect(user).toContain('- Томас — present.');
        expect(user).toContain('Wears now: a leather apron.');
        expect(user).toContain('Stance toward Кай: Дружелюбен (+2 of -3..+3) — гость.');
        expect(user).toContain('DES stats: Trust 40.');
        expect(user).toContain('- Мартин — not in this scene. Role: Archivist.');
        expect(user).toContain('"Одежда": exactly what is given as "Wears now"');
        expect(user).toContain('Do not soften or censor anyone');
        expect(user).toContain('Thoughts: first person');
        expect(
            buildDesSeedMessages(input({ scene: { place: '', date: '', time: '', situation: '' } }), config)[1]!
                .content,
        ).toContain('(nothing prepared)');
        expect(seedNames(input({ cast: [member('Вера'), member('вера'), member(' ')] }))).toEqual(['Вера']);
    });
});

describe('DES seed: the answer and the record', () => {
    const config = readDesSeedConfig(desSettings());

    function answer(): Dict {
        return {
            characters: [
                {
                    name: 'Томас',
                    present: true,
                    emoji: '🍺',
                    details: { f1: 'Седой, широкоплечий', f2: '[Ворчит]', f3: 'кожаный фартук' },
                    relationship: 'Враг',
                    stats: { s1: 55, s2: 90 },
                    thoughts: '(off-scene) Ещё один чужак.',
                },
                { name: 'Кай', present: true, emoji: '🗡️' },
                { name: 'Мартин', present: true, emoji: 'not an emoji', thoughts: 'Где же реестр?' },
                { name: 'Томас', present: true },
                { name: 'Незнакомец', present: true },
                'junk',
            ],
            scene: {
                date: 'День 1',
                time_start: '19:40',
                time_end: 'вечер',
                location: 'Таверна',
                recent_events: ['Кай вошёл', 'Томас насторожился', 'лишнее'],
                weather_emoji: '🌧️',
                weather: 'дождь',
                temperature: 6.6,
                tension: 'tense',
                c1: 'Эль и дым',
                c2: 9,
            },
        };
    }

    it('reads the answer: cast names only, never the player, options and keys by DES', () => {
        const read = readDesSeedAnswer(answer(), input(), config)!;
        expect(read.characters.map((item) => item.name)).toEqual(['Томас', 'Мартин']);
        const tom = read.characters[0]!;
        expect(tom.details).toEqual({
            Внешность: 'Седой, широкоплечий',
            Поведение: 'Ворчит',
            Одежда: 'кожаный фартук',
        });
        expect(tom.relationship).toBe('Враг');
        expect(tom.stats).toEqual({ Trust: 55, Health: 90 });
        expect(tom.thoughts).toBe('Ещё один чужак.');
        expect(read.characters[1]!.emoji).toBe(DEFAULT_EMOJI);
        expect(read.scene).toMatchObject({
            date: 'День 1',
            start: '19:40',
            end: '19:00',
            location: 'Таверна',
            events: ['Кай вошёл', 'Томас насторожился'],
            weather: 'дождь',
            weatherEmoji: '🌧️',
            temperature: 7,
            tension: 'Tense',
            fields: { smell: 'Эль и дым', danger: 5 },
        });
        expect(readDesSeedAnswer('nope', input(), config)).toBeNull();
    });

    it('composes the record: presence from the cast, stats from the mechanics, the stance over a contrary label', () => {
        const read = readDesSeedAnswer(answer(), input(), config)!;
        const seed = composeDesSeed(input(), config, read);
        expect(seed.present).toEqual(['Томас', 'Вера']);
        expect(seed.names).toEqual(['Томас', 'Вера', 'Мартин']);
        expect(seed.record.quests).toBeNull();
        const characters = JSON.parse(seed.record.characterThoughts!) as Dict[];
        expect(Array.isArray(characters)).toBe(true);
        const [tom, vera, martin] = characters as Dict[];
        expect(tom).toMatchObject({
            name: 'Томас',
            emoji: '🍺',
            details: { Внешность: 'Седой, широкоплечий', Одежда: 'кожаный фартук' },
            // The model said «Враг», Dramatis says +2: the stance wins.
            relationship: { status: 'Друг' },
            stats: [
                { name: 'Trust', value: 55 },
                { name: 'Health', value: 90 },
            ],
            thoughts: { content: 'Ещё один чужак.' },
        });
        // Left out by the model: a minimal entry; the mechanics' stat wins.
        expect(vera).toEqual({ name: 'Вера', emoji: DEFAULT_EMOJI, stats: [{ name: 'Trust', value: 40 }] });
        // Mentioned, not in the scene: DES-RU's marker.
        expect(martin).toMatchObject({ name: 'Мартин', thoughts: { content: `${OFF_SCENE_MARKER} Где же реестр?` } });
        const box = JSON.parse(seed.record.infoBox!) as Dict;
        expect(box).toEqual({
            date: { value: 'День 1' },
            time: { start: '19:40', end: '19:00' },
            location: { value: 'Солёный якорь' },
            weather: { emoji: '🌧️', forecast: 'дождь' },
            temperature: { value: 7, unit: 'C' },
            recentEvents: ['Кай вошёл', 'Томас насторожился'],
            tension: 'Tense',
            smell: 'Эль и дым',
            danger: 5,
        });
    });

    it('builds a record of names without an answer: emoji, the stance, stats, place, date and time', () => {
        const seed = composeDesSeed(input(), config, null);
        expect(JSON.parse(seed.record.characterThoughts!)).toEqual([
            { name: 'Томас', emoji: DEFAULT_EMOJI, relationship: { status: 'Друг' } },
            { name: 'Вера', emoji: DEFAULT_EMOJI, stats: [{ name: 'Trust', value: 40 }] },
        ]);
        expect(JSON.parse(seed.record.infoBox!)).toEqual({
            date: { value: 'День 1' },
            time: { start: '19:00', end: '19:00' },
            location: { value: 'Солёный якорь' },
        });
    });

    it('gives an English story the prepared outfit and drops off-scene people without thoughts', () => {
        const english = readDesSeedConfig(
            desSettings({
                trackerConfig: {
                    presentCharacters: {
                        customFields: [{ id: 'outfit', name: 'Outfit', enabled: true, description: 'Clothes' }],
                        thoughts: { enabled: false },
                    },
                },
            }),
        );
        const seed = composeDesSeed(
            input({
                language: 'en',
                cast: [member('Tom', { outfit: 'a leather apron' }), member('Ann', { present: false })],
            }),
            english,
            { characters: [{ name: 'Ann', present: false, emoji: '📜', details: {}, stats: {} }], scene: null },
        );
        expect(JSON.parse(seed.record.characterThoughts!)).toEqual([
            { name: 'Tom', emoji: DEFAULT_EMOJI, details: { outfit: 'a leather apron' } },
        ]);
        expect(seed.names).toEqual(['Tom']);
    });

    it('reads every widget DES may have on and puts it into the scene', () => {
        const full = readDesSeedConfig(
            desSettings({
                doomCounter: { enabled: true },
                trackerConfig: {
                    presentCharacters: { relationships: { enabled: false } },
                    infoBox: {
                        widgets: {
                            moonPhase: { enabled: true },
                            timeSinceRest: { enabled: true },
                            conditions: { enabled: true },
                            terrain: { enabled: true },
                            weather: { enabled: true },
                        },
                        customFields: [
                            { name: 'Mood', enabled: true, type: 'enum', options: ['Calm', 'Grim'] },
                            { name: 'Open', enabled: true, type: 'boolean' },
                            { name: 'Clues', enabled: true, type: 'list' },
                            { name: 'Progress', enabled: true, type: 'progress' },
                        ],
                    },
                },
            }),
        );
        const story = input({
            scene: { place: '', date: '', time: '', situation: '' },
            cast: [member('Вера', { stance: { value: -2, label: '', reason: '' } })],
        });
        expect(buildDesSeedMessages(story, full)[1]!.content).toContain('Stance toward Кай: -2 (-2 of -3..+3).');
        const read = readDesSeedAnswer(
            {
                characters: [{ name: 'Вера', present: true, emoji: '🛡️', relationship: 'Враг' }],
                scene: {
                    location: 'Причал',
                    weather: 'rain',
                    weather_emoji: 'x',
                    moon_phase: 'full moon',
                    time_since_rest: '6 часов',
                    conditions: 'Нет',
                    terrain: 'Каменный причал',
                    c1: 'grim',
                    c2: true,
                    c3: ['следы', ''],
                    c4: 140,
                    doom_tension: 14,
                },
            },
            story,
            full,
        )!;
        expect(read.characters[0]!.relationship).toBeUndefined();
        expect(read.scene).toMatchObject({
            weather: 'rain',
            weatherEmoji: '',
            moonPhase: 'Full Moon',
            timeSinceRest: '6 часов',
            conditions: 'None',
            terrain: 'Каменный причал',
            fields: { mood: 'Grim', open: true, clues: ['следы'], progress: 100 },
            doomTension: 10,
        });
        const box = JSON.parse(composeDesSeed(story, full, read).record.infoBox!) as Dict;
        expect(box).toEqual({
            location: { value: 'Причал' },
            weather: { forecast: 'rain' },
            moonPhase: 'Full Moon',
            timeSinceRest: '6 часов',
            conditions: 'None',
            terrain: 'Каменный причал',
            mood: 'Grim',
            open: true,
            clues: ['следы'],
            progress: 100,
            doomTension: 10,
        });
        expect(readDesSeedAnswer({ characters: [], scene: 'x' }, story, full)!.scene).toBeNull();
    });

    it('never lists the player and writes nothing DES does not show', () => {
        const off = readDesSeedConfig(desSettings({ showCharacterThoughts: false, showInfoBox: false }));
        const seed = composeDesSeed(input({ cast: [member('Кай'), member('Вера')] }), off, null);
        expect(seed.record).toEqual(nullRecord());
        const kai = composeDesSeed(input({ cast: [member('Кай')] }), readDesSeedConfig(desSettings()), null);
        expect(kai.present).toEqual([]);
        expect(kai.record.characterThoughts).toBeNull();
    });
});

describe('DES seed: records', () => {
    it('reads, compares and tells empty records', () => {
        expect(readRecord({ quests: '', infoBox: '{}', characterThoughts: null })).toEqual({
            quests: null,
            infoBox: '{}',
            characterThoughts: null,
        });
        expect(readRecord('x')).toBeNull();
        expect(sameRecord({ infoBox: '{}' }, { infoBox: '{}', quests: null })).toBe(true);
        expect(sameRecord(null, undefined)).toBe(true);
        expect(sameRecord({ infoBox: '{}' }, null)).toBe(false);
        expect(isEmptyRecord(nullRecord())).toBe(true);
        expect(isEmptyRecord(undefined)).toBe(true);
        expect(isEmptyRecord({ characterThoughts: '[]' })).toBe(false);
    });

    it("shapes the opening tracker like DES's example block", () => {
        const record = {
            quests: '{"main":"None"}',
            infoBox: '{"location":{"value":"Таверна"}}',
            characterThoughts: '{"characters":[{"name":"Вера"}]}',
        };
        const example = desStartExample(record, { quests: false, infoBox: true, characters: true });
        expect(example.startsWith('```json\n')).toBe(true);
        expect(JSON.parse(example.slice(8, -4))).toEqual({
            infoBox: { location: { value: 'Таверна' } },
            characters: [{ name: 'Вера' }],
        });
        expect(desStartExample(record, { quests: true, infoBox: false, characters: false })).toContain('"quests"');
        expect(desStartExample(nullRecord(), { quests: true, infoBox: true, characters: true })).toBe('');
        expect(desStartExample({ infoBox: 'not json' }, { quests: true, infoBox: true, characters: true })).toBe('');
        expect(desStartExample(null, { quests: true, infoBox: true, characters: true })).toBe('');
    });

    it('lists the names of a record, the present ones when asked', () => {
        const record = {
            characterThoughts: JSON.stringify([
                { name: 'Вера', thoughts: { content: 'Тихо.' } },
                { name: 'Мартин', thoughts: { content: '(off-scene) В архиве.' } },
                { name: 'Томас', present: false },
                { name: 'вера' },
                { emoji: '?' },
            ]),
        };
        expect(recordNames(record)).toEqual(['Вера', 'Мартин', 'Томас']);
        expect(recordNames(record, { presentOnly: true })).toEqual(['Вера']);
        expect(recordNames({ characterThoughts: '{"characters":[{"name":"Ann"}]}' })).toEqual(['Ann']);
    });

    it('keeps an emoji only when it is one', () => {
        expect(cleanEmoji('🛡️')).toBe('🛡️');
        expect(cleanEmoji('shield')).toBe(DEFAULT_EMOJI);
        expect(cleanEmoji('')).toBe(DEFAULT_EMOJI);
        expect(cleanEmoji(5)).toBe(DEFAULT_EMOJI);
    });

    it('names schema properties in ASCII', () => {
        expect([detailProp(0), statProp(2), sceneFieldProp(1)]).toEqual(['f1', 's3', 'c2']);
    });
});

/** The config type is exported for the feature (a compile-time check that it stays readable). */
export type ConfigCheck = DesSeedConfig;
