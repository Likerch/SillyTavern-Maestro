// M25 «Механики», ready-made mechanics (plan M25 п. 2): health and stamina, magic with mana and schools, faction
// reputation, money, skills with checks, relationship scales. Display names follow the UI language; rules, prompt
// names, levels and options are English (they go to the model). Default tracking (plan M25 п. 4): numbers of
// characters that move every scene (health, stamina, mana) are DES stats; everything else — money, reputation,
// relationships, and skills, which rarely change and would crowd DES's tracker — is the background parse.
// Pure: no DOM, no SillyTavern.
import { cloneDef, uniqueId } from './mechanics-defs';
import type { AttributeDef, CheckDef, MechanicDef, MechanicScope, MechanicTemplate } from './mechanics-defs';

type Locale = 'en' | 'ru';
type Built = Omit<MechanicDef, 'id' | 'scope'>;

const pick = (locale: Locale, en: string, ru: string): string => (locale === 'ru' ? ru : en);

function numberAttr(
    locale: Locale,
    id: string,
    en: string,
    ru: string,
    options: Partial<AttributeDef> = {},
): AttributeDef {
    return { id, name: pick(locale, en, ru), promptName: en, kind: 'number', ...options };
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
}));

const magic = template('magic', (locale) => ({
    name: pick(locale, 'Magic', 'Магия'),
    promptName: 'Magic',
    summary: 'Spellcasting powered by mana; every mage knows one or more schools of magic.',
    rules: [
        'Casting a spell costs mana: a minor spell 5–10, a strong one 20–40, a great working 50 or more. Without enough mana a spell fails or hurts the caster.',
        'Mana (0–100) returns slowly with rest and meditation, about 10 per hour of rest.',
        'A mage can only cast spells of the schools they know; learning a new school takes long study.',
        'When a spell is cast under pressure, a spellcasting check decides whether it works (roll under the current mana).',
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
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [
        {
            id: 'spellcasting',
            name: pick(locale, 'Spellcasting', 'Заклинание'),
            promptName: 'Spellcasting',
            dice: '1d100<=@mana',
            difficulty: null,
            triggers: ['заклин', 'колдую', 'колдов', 'наколд', 'spell', 'casting', 'cast a'],
        },
    ],
    tracking: 'desStats',
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
}));

function skillCheck(locale: Locale, id: string, en: string, ru: string, triggers: string[]): CheckDef {
    return { id, name: pick(locale, en, ru), promptName: en, dice: `1d20+mod(@${id})`, difficulty: 12, triggers };
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
    summary: 'Skills of the characters from 0 to 20 (10 is average); risky actions are decided by d20 checks.',
    rules: [
        'Skills go from 0 to 20: 10 is an ordinary person, 15 a trained professional, 20 the best in the land.',
        "When the user's character tries something risky that a skill covers, Maestro rolls a check (d20 + skill modifier against 12) and reports the result: follow it, a failure really fails.",
        "A skill grows by 1 only after long practice or a teacher's lessons, never within one scene.",
    ].join('\n'),
    attributes: SKILLS.map(([id, en, ru]) => numberAttr(locale, id, en, ru, { min: 0, max: 20, initial: 10 })),
    holders: { kind: 'characters', includePersona: true },
    checks: SKILLS.map(([id, en, ru, triggers]) => skillCheck(locale, id, en, ru, triggers)),
    tracking: 'background',
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
}));

/** Every template, in the order of the picker. */
export const MECHANIC_TEMPLATES: readonly MechanicTemplate[] = [
    health,
    magic,
    reputation,
    money,
    skills,
    relationships,
];

export function templateById(id: string): MechanicTemplate | null {
    return MECHANIC_TEMPLATES.find((item) => item.id === id) ?? null;
}

/**
 * An unsaved definition from a template: a fresh copy with a readable id unique among `takenIds` (the template's id,
 * else `<id>_2`…) and the given scope.
 */
export function defFromTemplate(
    item: MechanicTemplate,
    locale: Locale,
    scope: MechanicScope,
    takenIds: Iterable<string>,
): MechanicDef {
    const built = cloneDef(item.build(locale));
    return { ...built, id: uniqueId(item.id, takenIds), scope: cloneDef(scope), template: item.id };
}
