// M25 «Механики», ready-made mechanics (plan M25 п. 2; plan-2 §6 п. 12–13): health and stamina, magic with mana and
// schools, faction reputation, money, skills with checks, relationship scales; and survival (hunger, thirst, fatigue
// over story time), sanity, inventory and trade, combat, social scales (sympathy, trust, attraction). Display names
// and word bands follow the UI language; rules, prompt names, levels and options are English (they go to the model).
// Default tracking (plan M25 п. 4): numbers of characters that move every scene (health, stamina, mana) are DES stats;
// fights and survival move by rules and the service block / time; everything else is the background parse.
// Visibility (plan-2 §6.А, В21): every template «Игровой» (game) except the relationships and social scales, which are
// «Книжный» (book: words, no numbers).
// Skills (plan-2 §6 п. 13): 0–10 and `1d20 + skill` against a difficulty (12 normal, 7 easy, 17 hard, 22 very hard):
// every point is +5 %, an untrained person makes a normal task 45 % of the time, a professional (6) 75 %, a master (8)
// 85 %; a hard task separates them (20 % / 50 % / 60 %). The old 0–20 with mod() vs 12 moved only ±25 % over the whole
// scale. Spellcasting is a check of the arcana skill against 12 that costs mana: 10 when it works, half when it fails.
// Pure: no DOM, no SillyTavern.
import { cloneDef, uniqueId } from './mechanics-defs';
import type {
    AttributeDef,
    CheckDef,
    MechanicDef,
    MechanicScope,
    MechanicTemplate,
    StatusSpec,
} from './mechanics-defs';
import type { WordLevel } from './mechanics-visibility';

type Locale = 'en' | 'ru';
type Built = Omit<MechanicDef, 'id' | 'scope'>;

const pick = (locale: Locale, en: string, ru: string): string => (locale === 'ru' ? ru : en);

/** Signs of the common numbers on the play surfaces («❤ 80 → 65» under a reply, the HUD). */
const SIGNS: Readonly<Record<string, string>> = {
    health: '❤',
    hp: '❤',
    stamina: '⚡',
    mana: '🔷',
    coins: '🪙',
    hunger: '🍖',
    thirst: '💧',
    fatigue: '💤',
    sanity: '🧠',
    armor: '🛡',
};

function numberAttr(
    locale: Locale,
    id: string,
    en: string,
    ru: string,
    options: Partial<AttributeDef> = {},
): AttributeDef {
    const sign = SIGNS[id];
    return {
        id,
        name: pick(locale, en, ru),
        promptName: en,
        kind: 'number',
        ...(sign ? { icon: sign } : {}),
        ...options,
    };
}

function status(
    locale: Locale,
    id: string,
    en: string,
    ru: string,
    options: Omit<StatusSpec, 'name' | 'id' | 'promptName'> = {},
): StatusSpec {
    return { name: pick(locale, en, ru), id, promptName: en, ...options };
}

/** Word bands for the player: English for the model, the UI language for the display. */
function words(locale: Locale, bands: [number | string, string, string][]): WordLevel[] {
    return bands.map(([edge, en, ru]) => {
        const band: WordLevel = { label: en };
        if (typeof edge === 'number') band.upTo = edge;
        else band.level = edge;
        if (locale === 'ru') band.display = ru;
        return band;
    });
}

function template(id: string, build: (locale: Locale) => Built): MechanicTemplate {
    return {
        id,
        titleKey: `m25.def.template.${id}`,
        descriptionKey: `m25.def.template.${id}.hint`,
        build: (locale) => ({ ...build(locale), template: id }),
    };
}

const health = template('health', (locale) => ({
    name: pick(locale, 'Health and stamina', 'Здоровье и выносливость'),
    promptName: 'Health and stamina',
    summary: 'Health and stamina of the characters, 0–100.',
    rules: [
        'Health (0–100) drops with wounds, poison and illness and slowly comes back with rest and treatment: a light wound costs about 5–15, a serious one 20–40.',
        'Stamina (0–100) drops with running, fighting, carrying weight and sleepless nights, and returns with food and rest.',
        'At 0 health a character falls unconscious; at 0 stamina a character is exhausted and can barely move.',
        'Show low values in the narration (pain, trembling hands, ragged breathing) instead of naming numbers.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'health', 'Health', 'Здоровье', {
            min: 0,
            max: 100,
            initial: 100,
            events: [{ id: 'unconscious', when: { op: '<=', value: 0 }, text: '{holder} falls unconscious.' }],
        }),
        numberAttr(locale, 'stamina', 'Stamina', 'Выносливость', {
            min: 0,
            max: 100,
            initial: 100,
            events: [
                { id: 'exhausted', when: { op: '<=', value: 0 }, text: '{holder} is exhausted and can barely move.' },
            ],
        }),
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [],
    tracking: 'desStats',
    visibility: { preset: 'game' },
    statuses: [
        status(locale, 'poisoned', 'poisoned', 'Отравлен', {
            duration: { turns: 3 },
            modifiers: { checks: -2 },
            text: 'nausea and weakness',
        }),
        status(locale, 'bleeding', 'bleeding', 'Кровотечение', { duration: { turns: 3 }, modifiers: { checks: -1 } }),
        status(locale, 'broken_arm', 'broken arm', 'Сломана рука', {
            duration: { minutes: 20160 },
            modifiers: { checks: -3 },
        }),
    ],
}));

const magic = template('magic', (locale) => ({
    name: pick(locale, 'Magic', 'Магия'),
    promptName: 'Magic',
    summary: 'Spellcasting powered by mana; every mage knows one or more schools of magic.',
    rules: [
        'Casting a spell costs mana: a minor spell 5–10, a strong one 20–40, a great working 50 or more. Without enough mana a spell fails or hurts the caster.',
        'Mana (0–100) returns slowly with rest and meditation, about 10 per hour of rest.',
        'A mage can only cast spells of the schools they know; learning a new school takes long study.',
        'When a spell is cast under pressure, a spellcasting check decides whether it works (d20 + arcana against 12); Maestro takes its mana cost: 10 when it works, 5 when it fails. Spend more mana for stronger spells yourself.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'mana', 'Mana', 'Мана', {
            min: 0,
            max: 100,
            initial: 100,
            events: [
                { id: 'drained', when: { op: '<=', value: 0 }, text: '{holder} has no mana left and cannot cast.' },
            ],
        }),
        {
            id: 'schools',
            name: pick(locale, 'Schools', 'Школы магии'),
            promptName: 'Schools of magic',
            kind: 'list',
            options: ['fire', 'water', 'air', 'earth', 'light', 'shadow', 'healing', 'illusion'],
            multi: true,
            initial: [],
        },
        numberAttr(locale, 'arcana', 'Arcana', 'Магическое искусство', {
            min: 0,
            max: 10,
            initial: 2,
            tracking: 'background',
            growth: { perUse: 0.2, cap: 8 },
        }),
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [
        {
            id: 'spellcasting',
            name: pick(locale, 'Spellcasting', 'Заклинание'),
            promptName: 'Spellcasting',
            dice: '1d20+@arcana',
            difficulty: 12,
            triggers: ['заклин', 'колдую', 'колдов', 'наколд', 'spell', 'casting', 'cast a'],
            effects: [
                { on: 'success', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 10 }] },
                { on: 'failure', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 5 }] },
                {
                    on: 'fumble',
                    changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 5 }],
                    text: 'the spell backfires on the caster',
                },
            ],
        },
    ],
    tracking: 'desStats',
    visibility: { preset: 'game' },
}));

const REPUTATION_LEVELS = ['hostile', 'unfriendly', 'neutral', 'friendly', 'honored', 'revered'];

const reputation = template('reputation', (locale) => ({
    name: pick(locale, 'Faction reputation', 'Репутация у фракций'),
    promptName: 'Faction reputation',
    summary: "How each faction regards the user's character.",
    rules: [
        `Reputation with a faction goes ${REPUTATION_LEVELS.join(' → ')}.`,
        'Helping a faction, keeping promises and sharing its enemies raise it one step at a time; betrayal, crimes against its members and open support of its rivals lower it, a betrayal by two steps or more.',
        'Members of a faction treat the character according to its reputation: hostile ones attack or refuse to deal, revered ones offer help, secrets and rare goods.',
    ].join('\n'),
    attributes: [
        {
            id: 'standing',
            name: pick(locale, 'Reputation', 'Репутация'),
            promptName: 'Reputation',
            kind: 'scale',
            levels: [...REPUTATION_LEVELS],
            initial: 'neutral',
            events: [
                {
                    id: 'hostile',
                    when: { op: '=', value: 'hostile' },
                    text: "{holder} now treats the user's character as an enemy.",
                },
                {
                    id: 'revered',
                    when: { op: '=', value: 'revered' },
                    text: "{holder} now reveres the user's character.",
                },
            ],
        },
    ],
    holders: { kind: 'factions', names: [] },
    checks: [],
    tracking: 'background',
    visibility: { preset: 'game' },
}));

const money = template('money', (locale) => ({
    name: pick(locale, 'Money', 'Деньги'),
    promptName: 'Money',
    summary: "The user's character's purse, in coins.",
    rules: [
        'Prices: a meal 2–5 coins, a night at an inn 10, a horse 300, a sword 150, a bribe to a guard 20–50.',
        'Money is spent only when the character pays or loses it, and gained from work, trade, rewards and loot. The character cannot spend more than they have.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'coins', 'Coins', 'Монеты', {
            min: 0,
            initial: 50,
            events: [{ id: 'broke', when: { op: '<=', value: 0 }, text: '{holder} has run out of money.' }],
        }),
    ],
    holders: { kind: 'persona' },
    checks: [],
    tracking: 'background',
    visibility: { preset: 'game' },
}));

function skillCheck(locale: Locale, id: string, en: string, ru: string, triggers: string[]): CheckDef {
    return { id, name: pick(locale, en, ru), promptName: en, dice: `1d20+@${id}`, difficulty: 12, triggers };
}

const SKILLS: [string, string, string, string[]][] = [
    ['persuasion', 'Persuasion', 'Убеждение', ['убед', 'уговор', 'упраш', 'упрос', 'persuad', 'convinc']],
    ['deception', 'Deception', 'Обман', ['обман', 'солг', 'соврат', 'блеф', 'притвор', 'deceiv', 'bluff', 'lie to']],
    ['intimidation', 'Intimidation', 'Запугивание', ['запуг', 'угрож', 'устраш', 'intimidat', 'threaten']],
    ['stealth', 'Stealth', 'Скрытность', ['подкрад', 'прокрад', 'крадусь', 'незамет', 'спрят', 'sneak', 'stealth']],
    ['athletics', 'Athletics', 'Атлетика', ['карабк', 'взбира', 'перепрыг', 'переплыв', 'climb', 'jump', 'swim']],
    [
        'perception',
        'Perception',
        'Внимательность',
        ['осматр', 'огляд', 'прислуш', 'высматр', 'look around', 'listen', 'search'],
    ],
];

const skills = template('skills', (locale) => ({
    name: pick(locale, 'Skills', 'Навыки'),
    promptName: 'Skills',
    summary: 'Skills of the characters from 0 to 10; risky actions are decided by d20 + skill against a difficulty.',
    rules: [
        'Skills go from 0 to 10: 0 untrained, 2 an ordinary person, 4 trained, 6 a professional, 8 a master, 10 a legend.',
        'When a character tries something risky that a skill covers, Maestro rolls d20 + skill against 12 (easy 7, hard 17, very hard 22) and reports the result: follow it, a failure really fails.',
        'A skill grows a little with every successful use and faster with a teacher; never by more than 1 within one scene.',
    ].join('\n'),
    attributes: SKILLS.map(([id, en, ru]) =>
        numberAttr(locale, id, en, ru, { min: 0, max: 10, initial: 2, growth: { perUse: 0.2, cap: 8 } }),
    ),
    holders: { kind: 'characters', includePersona: true },
    checks: SKILLS.map(([id, en, ru, triggers]) => skillCheck(locale, id, en, ru, triggers)),
    tracking: 'background',
    visibility: { preset: 'game' },
}));

const ATTITUDE_LEVELS = ['hostile', 'cold', 'neutral', 'warm', 'close', 'devoted'];

const relationships = template('relationships', (locale) => ({
    name: pick(locale, 'Relationships', 'Отношения'),
    promptName: 'Relationships',
    summary: "How each character feels about the user's character.",
    rules: [
        `A character's attitude toward the user's character goes ${ATTITUDE_LEVELS.join(' → ')}.`,
        'It moves one step at a time and only for a reason the story shows: help, kindness, shared danger and kept promises raise it; insults, lies, betrayal and cruelty lower it.',
        "Characters act according to their attitude: a cold one keeps distance, a close one trusts and confides, a devoted one takes risks for the user's character.",
    ].join('\n'),
    attributes: [
        {
            id: 'attitude',
            name: pick(locale, 'Attitude', 'Отношение'),
            promptName: "Attitude toward the user's character",
            kind: 'scale',
            levels: [...ATTITUDE_LEVELS],
            initial: 'neutral',
            events: [
                {
                    id: 'hostile',
                    when: { op: '=', value: 'hostile' },
                    text: "{holder} has turned hostile toward the user's character.",
                },
                {
                    id: 'devoted',
                    when: { op: '=', value: 'devoted' },
                    text: "{holder} is now devoted to the user's character.",
                },
            ],
        },
    ],
    holders: { kind: 'characters' },
    checks: [],
    tracking: 'background',
    visibility: {
        preset: 'book',
        words: words(locale, [
            ['hostile', 'hostile', 'враждебно'],
            ['cold', 'cold', 'холодно'],
            ['neutral', 'neutral', 'ровно'],
            ['warm', 'warm', 'тепло'],
            ['close', 'close', 'близко'],
            ['devoted', 'devoted', 'предан'],
        ]),
    },
}));

const survival = template('survival', (locale) => ({
    name: pick(locale, 'Survival', 'Выживание'),
    promptName: 'Survival',
    summary:
        "Hunger, thirst and fatigue of the user's character, 0 (fine) to 100 (at the limit); they grow with story time.",
    rules: [
        'Hunger, thirst and fatigue go from 0 (fed, watered, rested) to 100 (starving, parched, collapsing). Maestro raises them as story time passes: hunger about 4 and thirst about 6 per hour, fatigue 5 per waking hour; sleep lowers fatigue by 15 per hour.',
        'A meal lowers hunger by 30–60, a drink lowers thirst by 30–60, a short rest lowers fatigue by 10–20; report these when they happen.',
        'Above 80 the character suffers: weakness, headache, slow thinking. Show it in the narration.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'hunger', 'Hunger', 'Голод', {
            min: 0,
            max: 100,
            initial: 10,
            events: [
                {
                    id: 'starving',
                    when: { op: '>=', value: 80 },
                    text: '{holder} is starving.',
                    actions: [
                        {
                            who: 'actor',
                            attr: 'status',
                            op: 'push',
                            value: 'starving',
                            status: {
                                name: pick(locale, 'Starving', 'Голодает'),
                                promptName: 'starving',
                                modifiers: { checks: -2 },
                            },
                        },
                    ],
                },
                {
                    id: 'fed',
                    when: { op: '<=', value: 50 },
                    text: '',
                    actions: [{ who: 'actor', attr: 'status', op: 'pull', value: 'starving' }],
                },
            ],
        }),
        numberAttr(locale, 'thirst', 'Thirst', 'Жажда', {
            min: 0,
            max: 100,
            initial: 10,
            events: [
                {
                    id: 'parched',
                    when: { op: '>=', value: 80 },
                    text: '{holder} is parched with thirst.',
                    actions: [
                        {
                            who: 'actor',
                            attr: 'status',
                            op: 'push',
                            value: 'parched',
                            status: {
                                name: pick(locale, 'Parched', 'Мучает жажда'),
                                promptName: 'parched',
                                modifiers: { checks: -2 },
                            },
                        },
                    ],
                },
                {
                    id: 'watered',
                    when: { op: '<=', value: 50 },
                    text: '',
                    actions: [{ who: 'actor', attr: 'status', op: 'pull', value: 'parched' }],
                },
            ],
        }),
        numberAttr(locale, 'fatigue', 'Fatigue', 'Усталость', {
            min: 0,
            max: 100,
            initial: 0,
            events: [
                { id: 'collapsing', when: { op: '>=', value: 90 }, text: '{holder} can barely stay on their feet.' },
            ],
        }),
    ],
    holders: { kind: 'persona' },
    checks: [],
    tracking: 'background',
    visibility: { preset: 'game' },
    statuses: [],
    time: [
        { attr: 'hunger', amount: 4, per: 'hour' },
        { attr: 'thirst', amount: 6, per: 'hour' },
        { attr: 'fatigue', amount: 5, per: 'hour', when: 'awake' },
        { attr: 'fatigue', amount: -15, per: 'hour', when: 'rest' },
    ],
}));

const sanity = template('sanity', (locale) => ({
    name: pick(locale, 'Sanity', 'Рассудок'),
    promptName: 'Sanity',
    summary: 'How much horror the characters can take before their minds give way, 0–100.',
    rules: [
        'Sanity (0–100) drops when a character meets the unnatural, the monstrous or the unbearable: Maestro rolls a sanity check (d100 under the current sanity) and takes 1 point on a success, 1d6 on a failure.',
        'Below 30 the character is unsettled: jumpy, distracted, sees things. At 0 the mind breaks for a while.',
        'Rest and safety bring back about a point a day.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'sanity', 'Sanity', 'Рассудок', {
            min: 0,
            max: 100,
            initial: 70,
            events: [
                {
                    id: 'unsettled',
                    when: { op: '<=', value: 30 },
                    text: '{holder} is badly shaken and starts seeing things.',
                    actions: [
                        {
                            who: 'actor',
                            attr: 'status',
                            op: 'push',
                            value: 'unsettled',
                            status: {
                                name: pick(locale, 'Unsettled', 'Не в себе'),
                                promptName: 'unsettled',
                                modifiers: { checks: -1 },
                            },
                        },
                    ],
                },
                {
                    id: 'steady',
                    when: { op: '>=', value: 50 },
                    text: '',
                    actions: [{ who: 'actor', attr: 'status', op: 'pull', value: 'unsettled' }],
                },
                { id: 'broken', when: { op: '<=', value: 0 }, text: "{holder}'s mind breaks." },
            ],
        }),
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [
        {
            id: 'sanity_check',
            name: pick(locale, 'Sanity check', 'Проверка рассудка'),
            promptName: 'Sanity',
            dice: '1d100<=@sanity',
            difficulty: null,
            triggers: ['ужас', 'кошмар', 'жуть', 'horror', 'terrif', 'nightmare'],
            effects: [
                { on: 'success', changes: [{ who: 'actor', attr: 'sanity', op: 'sub', value: 1 }] },
                { on: 'failure', changes: [{ who: 'actor', attr: 'sanity', op: 'sub', value: '1d6' }] },
                { on: 'fumble', changes: [{ who: 'actor', attr: 'sanity', op: 'sub', value: '1d6' }] },
            ],
        },
    ],
    tracking: 'background',
    visibility: { preset: 'game' },
    statuses: [],
    time: [{ attr: 'sanity', amount: 1, per: 'day', when: 'rest' }],
}));

const trade = template('trade', (locale) => ({
    name: pick(locale, 'Inventory and trade', 'Инвентарь и торговля'),
    promptName: 'Inventory and trade',
    summary: "What the user's character carries and the money to trade with.",
    rules: [
        'The inventory lists what the character carries; things are gained, bought, used up, sold and given away only when the story shows it.',
        'Prices: bread 1 coin, a meal 3, a torch 1, rope 2, a healing potion 25, a dagger 20, a sword 150, a horse 300. Selling gets about half the price.',
        'The character cannot pay more than they have.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'coins', 'Coins', 'Монеты', {
            min: 0,
            initial: 50,
            events: [{ id: 'broke', when: { op: '<=', value: 0 }, text: '{holder} has run out of money.' }],
        }),
    ],
    holders: { kind: 'persona' },
    checks: [],
    tracking: 'background',
    visibility: { preset: 'game' },
    inventory: { money: 'coins' },
}));

const combat = template('combat', (locale) => ({
    name: pick(locale, 'Combat', 'Бой'),
    promptName: 'Combat',
    summary: 'Fights in rounds: hit points, armor, attack and agility; Maestro rolls initiative, attacks and defense.',
    rules: [
        'A fight goes in rounds, one round per reply, in the turn order Maestro gives. Hit points (HP) drop with wounds; at 0 HP a fighter is down and out of the fight.',
        "An attack is d20 + attack against the defender's d20 + agility (or against 12); a hit deals 1d6 + attack damage, a critical 2d6 more. Armor soaks part of every wound: tell the damage after armor in the narration.",
        'Do not decide hits yourself when a roll is due: ask for it with roll: Attack <who> vs <target>.Defense.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'hp', 'HP', 'Здоровье в бою', {
            min: 0,
            max: 30,
            initial: 20,
            events: [
                {
                    id: 'down',
                    when: { op: '<=', value: 0 },
                    text: '{holder} is down.',
                    actions: [{ who: 'actor', attr: 'combat', op: 'pull', value: '' }],
                },
            ],
        }),
        numberAttr(locale, 'armor', 'Armor', 'Броня', { min: 0, max: 10, initial: 1 }),
        numberAttr(locale, 'attack', 'Attack', 'Атака', { min: 0, max: 10, initial: 2 }),
        numberAttr(locale, 'agility', 'Agility', 'Ловкость', { min: 0, max: 10, initial: 2 }),
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [
        {
            id: 'initiative',
            name: pick(locale, 'Initiative', 'Инициатива'),
            promptName: 'Initiative',
            dice: '1d20+@agility',
            difficulty: null,
            triggers: [],
        },
        {
            id: 'attack',
            name: pick(locale, 'Attack', 'Атака'),
            promptName: 'Attack',
            dice: '1d20+@attack',
            difficulty: 12,
            triggers: ['атак', 'удар', 'бью', 'рублю', 'стреля', 'attack', 'strike', 'stab', 'shoot'],
            effects: [
                { on: 'success', changes: [{ who: 'target', attr: 'hp', op: 'sub', value: 'max(1, 1d6 + @attack)' }] },
                { on: 'critical', changes: [{ who: 'target', attr: 'hp', op: 'sub', value: '2d6' }] },
                {
                    on: 'fumble',
                    changes: [
                        {
                            who: 'actor',
                            attr: 'status',
                            op: 'push',
                            value: 'off_balance',
                            status: {
                                name: pick(locale, 'Off balance', 'Потерял равновесие'),
                                promptName: 'off balance',
                                duration: { turns: 1 },
                                modifiers: { checks: -2 },
                            },
                        },
                    ],
                },
            ],
        },
        {
            id: 'defense',
            name: pick(locale, 'Defense', 'Защита'),
            promptName: 'Defense',
            dice: '1d20+@agility',
            difficulty: 12,
            triggers: ['уворач', 'парир', 'блокир', 'dodge', 'parry', 'block'],
        },
    ],
    tracking: 'block',
    visibility: { preset: 'game' },
    statuses: [
        status(locale, 'stunned', 'stunned', 'Оглушён', { duration: { turns: 1 }, modifiers: { checks: -5 } }),
        status(locale, 'prone', 'prone', 'Сбит с ног', { duration: { turns: 1 }, modifiers: { 'check:defense': -2 } }),
        status(locale, 'bleeding', 'bleeding', 'Кровотечение', { duration: { turns: 3 }, modifiers: { checks: -1 } }),
    ],
    combat: { initiative: 'initiative', enemy: { hp: 12, armor: 1, attack: 2, agility: 2 } },
}));

const SOCIAL_WORDS: [number, string, string][] = [
    [15, 'none', 'нет'],
    [35, 'slight', 'слабая'],
    [60, 'moderate', 'заметная'],
    [85, 'strong', 'сильная'],
    [100, 'overwhelming', 'огромная'],
];

const social = template('social', (locale) => ({
    name: pick(locale, 'Social scales', 'Социальные шкалы'),
    promptName: 'Social scales',
    summary: "How much each character likes, trusts and is drawn to the user's character, 0–100.",
    rules: [
        "Sympathy (liking), trust and attraction of each character toward the user's character go from 0 to 100 and move by 5–15 for what the story shows: kindness, kept word, shared danger and charm raise them; rudeness, lies and coldness lower them.",
        'Trust falls fast and grows slowly; attraction moves only for characters who could feel it.',
        'Let the values show in behaviour, never as numbers.',
    ].join('\n'),
    attributes: [
        numberAttr(locale, 'sympathy', 'Sympathy', 'Симпатия', { min: 0, max: 100, initial: 40 }),
        numberAttr(locale, 'trust', 'Trust', 'Доверие', {
            min: 0,
            max: 100,
            initial: 30,
            events: [
                {
                    id: 'distrust',
                    when: { op: '<=', value: 10 },
                    text: "{holder} no longer trusts the user's character.",
                },
            ],
        }),
        numberAttr(locale, 'attraction', 'Attraction', 'Влечение', {
            min: 0,
            max: 100,
            initial: 10,
            events: [
                {
                    id: 'drawn',
                    when: { op: '>=', value: 80 },
                    text: "{holder} is strongly drawn to the user's character.",
                },
            ],
        }),
    ],
    holders: { kind: 'characters' },
    checks: [],
    tracking: 'background',
    visibility: { preset: 'book', words: words(locale, SOCIAL_WORDS) },
}));

/** Every template, in the order of the picker. */
export const MECHANIC_TEMPLATES: readonly MechanicTemplate[] = [
    health,
    magic,
    reputation,
    money,
    skills,
    relationships,
    survival,
    sanity,
    trade,
    combat,
    social,
];

export function templateById(id: string): MechanicTemplate | null {
    return MECHANIC_TEMPLATES.find((item) => item.id === id) ?? null;
}

/**
 * An unsaved definition from a template: a fresh copy with a readable id unique among `takenIds` (the template's id,
 * else `<id>_2`…) and the given scope. `factions`: names of the factions of the lore for a template whose holders are
 * factions (reputation).
 */
export function defFromTemplate(
    item: MechanicTemplate,
    locale: Locale,
    scope: MechanicScope,
    takenIds: Iterable<string>,
    options: { factions?: readonly string[] } = {},
): MechanicDef {
    const built = cloneDef(item.build(locale));
    if (built.holders.kind === 'factions' && !built.holders.names.length && options.factions?.length) {
        const names: string[] = [];
        for (const name of options.factions) {
            const clean = name.trim();
            if (clean && !names.some((known) => known.toLowerCase() === clean.toLowerCase())) names.push(clean);
        }
        built.holders = { kind: 'factions', names: names.slice(0, 20) };
    }
    return { ...built, id: uniqueId(item.id, takenIds), scope: cloneDef(scope), template: item.id };
}
