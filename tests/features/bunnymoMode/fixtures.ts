// Small excerpts of real BunnyMo V3.0 books (SillyTavern-DES-RU/vendor/BunnyMo, commit 7a61c9f): titles, keys and
// flags as shipped, entry texts cut to their first lines. Enough for the classifiers (3+ core entries, 3+ tagged pack
// entries) and for the cases the BunnyMo mode cares about: MBTI v1/V2 version conflict, merged/split Species
// duplicate, BSM-5 + CoT Lenses pairing, section headers and guide notes, archives with orphans.
export type Dict = Record<string, unknown>;

export const CORE = '✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V3.0';
export const CORE_OLD = '✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V2.8';
export const MBTI_V2 = '--BunnMBTI-Pack V2';
export const MBTI_V1 = '--BunnMBTI-Pack v1';
export const DERE = '--BunnDere-Pack V2';
export const SPECIES = '--BunnyCo-Pack v1';
export const SPECIES_A = '---A The Classics';
export const BSM = '--BSM-5 V1';
export const COT = '--BSM5 CoT Lenses V1';
export const ARCHIVES = 'Characters';

function entry(uid: number, fields: Dict): Dict {
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        selective: true,
        disable: false,
        order: 100,
        position: 1,
        depth: 4,
        role: null,
        excludeRecursion: false,
        ...fields,
    };
}

export function coreEntries(): Dict[] {
    return [
        entry(2, {
            key: ['!fullsheet'],
            comment: '👤FULL CHARACTER SHEET FORMAT 👤',
            content:
                '# 🎯**TAG SYNTHESIS**🎯\n\n<BunnymoTags><Name:NAME>, <GENRE:BLANK> <PHYSICAL> <SPECIES:BLANK>, <GENDER:BLANK>, <AGE:BLANK>, <BUILD:BLANK>,</PHYSICAL> <PERSONALITY><Dere:BLANK>, <XXXX-U/H>, <TRAIT:BLANK>, <ATTACHMENT:BLANK>, <DECISION:BLANK>, <MASK:BLANK>, </PERSONALITY> <NSFW><ORIENTATION:BLANK>, <KINK:BLANK>,</NSFW> <HEALTH><BSM:BLANK>, <MED:BLANK>,</HEALTH> </BunnymoTags>',
            position: 4,
            depth: 0,
            role: 1,
        }),
        entry(3, {
            key: ['!quicksheet'],
            comment: '👤QUICK CHARACTER SHEET FORMAT 👤 (Lighter)',
            content: 'Quick sheet.',
        }),
        entry(20, {
            key: ['!dere', '<DERE_SYSTEM>'],
            comment: '🌸 Master - Dere System',
            content: '<BunnymoTags:🌸 Master - Dere System>\nDere archetypes…\n</BunnymoTags:🌸 Master - Dere System>',
        }),
        entry(41, { key: ['/^/'], comment: '💉 Master - Medicine Check', content: 'Medicine check.' }),
        entry(44, {
            key: ['NAME HERE'],
            comment:
                'EMPTY Auto-Tag Injection - RENAME AND REKEY THIS TO WHATEVER CHARACTERS TAGS OR SHEET YOU ARE PUTTING IN. ',
            content:
                '<BunnymoTags><Name:NAME>, <GENRE:BLANK> <PHYSICAL> <SPECIES:BLANK>, <HAIR:BLANK>,</PHYSICAL> <PERSONALITY><CONFLICT:BLANK>, <FLIRTING:BLANK>, </PERSONALITY> </BunnymoTags>',
            disable: true,
        }),
        entry(74, {
            key: ['<ATTACHMENT:'],
            comment: '🐰 HawThorne Link — Core (Badge)',
            content: '{{setvar::bmo_core::1}}',
        }),
    ];
}

/** V2.8 had no HawThorne links, Medicine Check, !physheet or !updatesheet. */
export function oldCoreEntries(): Dict[] {
    return [
        entry(2, { key: ['!fullsheet'], comment: '👤FULL CHARACTER SHEET FORMAT 👤', content: 'Full sheet.' }),
        entry(3, { key: ['!quicksheet'], comment: '👤QUICK CHARACTER SHEET FORMAT 👤', content: 'Quick sheet.' }),
        entry(20, { key: ['!dere'], comment: '🌸 Master - Dere System', content: 'Dere archetypes…' }),
        entry(64, { key: ['/^/'], comment: '⚙️AUTO-FILTRATION: LINGUISTICS', content: 'Linguistics filter.' }),
    ];
}

const MBTI_HEADER = entry(0, {
    comment: '₍ᐢ •͈ ̫ •͈ ᐢ₎♡  🥕  BUNNYMO — MBTI TAGPACK (LIBRARY)  🥕  ♡ ₍ᐢ •͈ ̫ •͈ ᐢ₎\n(Read Me!)',
    content: '₍ᐢ •͈ ̫ •͈ ᐢ₎♡  🥕  BUNNYMO — MBTI TAGPACK (LIBRARY)\n🐰 What this is',
    excludeRecursion: true,
});

export function mbtiV2(): Dict[] {
    return [
        { ...MBTI_HEADER },
        entry(2, {
            key: ['<ISTJ-H>', 'trait Healthy ISTJ', 'Healthy Logistician'],
            comment: 'ISTJ (Healthy) - The Logistician',
            content:
                "**CORE ESSENCE:** *\"I'll do what's right, even when it's hard, because someone has to.\"*\n\n**NED STARK**",
            depth: 5,
            excludeRecursion: true,
        }),
        entry(29, {
            key: ['<INTJ-H>', 'trait Healthy INTJ', 'Healthy Architect'],
            comment: 'INTJ (Healthy) - The Architect',
            content:
                '**CORE ESSENCE:** *"I see a future worth building."*\n\n**TYRION LANNISTER** - The quiet planner who thinks three steps ahead',
            position: 4,
            depth: 0,
            role: 0,
        }),
        entry(33, {
            key: ['<INTJ-U>', 'trait Unhealthy INTJ', 'Unhealthy Architect'],
            comment: 'INTJ (Unhealthy) - The Cynic',
            content:
                '**CORE ESSENCE:** *"Everyone else is too stupid to see what\'s obviously coming."*\n\n**SEVERUS SNAPE**',
            position: 4,
            depth: 0,
            role: 0,
        }),
        entry(35, {
            key: ['<ENTJ-U>', 'trait Unhealthy ENTJ', 'Unhealthy Commander'],
            comment: 'ENTJ (Unhealthy) - The Controlling Perfectionist',
            content: '**CORE ESSENCE:** *"If you can\'t do it right, get out of my way."*\n\n**MIRANDA PRIESTLY**',
            position: 4,
            depth: 0,
            role: 0,
        }),
    ];
}

export function mbtiV1(): Dict[] {
    return [
        { ...MBTI_HEADER },
        entry(2, {
            key: ['<ISTJ-H>', 'trait Healthy ISTJ', 'Healthy Logistician'],
            comment: 'ISTJ (Healthy) - The Logistician',
            content:
                "**CORE ESSENCE:** *\"I'll do what's right, even when it's hard, because someone has to.\"*\n\n**NED STARK**",
            depth: 5,
            excludeRecursion: true,
        }),
        entry(20, {
            key: ['<INTJ-H>', 'trait Healthy INTJ', 'Healthy Architect'],
            comment: 'INTJ (Healthy) - The Architect',
            content:
                '**CORE ESSENCE:** *"I see a future worth building."*\n\n**TYRION LANNISTER** - The strategic mind who sees three moves ahead',
            depth: 5,
            excludeRecursion: true,
        }),
        entry(21, {
            key: ['<INTJ-U>', 'trait Unhealthy INTJ', 'Unhealthy Architect'],
            comment: 'INTJ (Unhealthy) - The Schemer',
            content:
                '**CORE ESSENCE:** *"Everyone else is too stupid to see what\'s obviously coming."*\n\n**TYWIN LANNISTER**',
            depth: 5,
            excludeRecursion: true,
        }),
        entry(25, {
            key: ['<ENTJ-U>', 'trait Unhealthy ENTJ', 'Unhealthy Commander'],
            comment: 'ENTJ (Unhealthy) - The Tyrant',
            content: '**CORE ESSENCE:** *"If you can\'t keep up, you\'re dead weight."*\n\n**MIRANDA PRIESTLY**',
            depth: 5,
        }),
    ];
}

export function dereEntries(): Dict[] {
    return [
        entry(0, {
            key: ['<DERE_GUIDE_NOTE>', 'dere explanation', 'dere guide note', '!dere'],
            comment: '₍ᐢ •͈ ̫ •͈ ᐢ₎♡  🥕  BUNNYMO — DERE TAGPACK (LIBRARY)  🥕  ♡ ₍ᐢ •͈ ̫ •͈ ᐢ₎ — Read Me!',
            content: '☆彡 READ ME FIRST! This library is a cute meta-guide to emotional archetypes.',
        }),
        entry(1, {
            key: ['<SECTION_HEADER>', '<SECTION:💗 PURE DERE>'],
            comment: '💗 PURE DERE',
            content: "Open-heart archetypes (feelings on the sleeve). Tend to be 'Easy Mode's.",
        }),
        entry(14, {
            key: ['<KUUDERE>', '<DERE:KUUDERE>', '<KUU>', '<COLD_DERE>'],
            comment: '❄️😐 Kuudere — The Ice Mage',
            content: '**💾 CORE_ALGORITHM:** *"I fail to see how this concerns me."* [Emotional Distance Maximized]',
        }),
        entry(18, {
            key: ['<TSUNDERE>', '<DERE:TSUNDERE>', '<TSUN>', '<AGGRESSIVE_DERE>'],
            comment: '💢(>///<) Tsundere — The Defensive Fighter',
            content:
                '**💾 CORE_ALGORITHM:** *"I-It\'s not like I like you or anything, idiot!"* [Pride Defense System]',
        }),
    ];
}

const ELF = '🃏 ELF CARD\n\n★★☆☆☆ | Nature / Arcane\n\n[🏅] SIGNATURE CARD: Legolas, prince of arrows';
const DWARF = '[🏅] SIGNATURE CARD: Gimli, axe bearer of deep halls\n\n“And my axe.”';
const HUMAN = '🃏 HUMAN CARD\n☆☆☆☆☆ | Neutral/Adaptive\n[🏅] SIGNATURE CARD: Aragorn — ranger king of the West';

export function speciesEntries(): Dict[] {
    return [
        entry(1, {
            key: ['<ELF>', '<SPECIES:ELF>', '<ELVEN>', '<POINTY_EARS>'],
            comment: '🧝‍♀️ Elf — The Eternal Perfectionist',
            content: ELF,
        }),
        entry(2, {
            key: ['<DWARF>', '<SPECIES:DWARF>', '<DWARVEN>'],
            comment: '⛏️ Dwarf — The Honorable Drunkard',
            content: DWARF,
        }),
        entry(4, {
            key: ['<HUMAN>', '<SPECIES:HUMAN>', '<MANKIND>'],
            comment: '🏛️ Human — The Ambitious Upstart',
            content: HUMAN,
        }),
    ];
}

export function speciesSplitEntries(): Dict[] {
    return [
        entry(3, {
            key: ['<ELF>', '<SPECIES:ELF>', '<ELVEN>', '<POINTY_EARS>'],
            comment: '🧝‍♀️ Elf — The Eternal Perfectionist',
            content: ELF,
        }),
        entry(4, {
            key: ['<DWARF>', '<SPECIES:DWARF>', '<DWARVEN>', '<BEARD>'],
            comment: '⛏️ Dwarf — The Honorable Drunkard',
            content: DWARF,
        }),
        entry(6, {
            key: ['<HUMAN>', '<SPECIES:HUMAN>', '<MANKIND>', '<MORTAL>'],
            comment: '🏛️ Human — The Ambitious Upstart',
            content: HUMAN,
        }),
    ];
}

export function bsmEntries(): Dict[] {
    return [
        entry(0, {
            key: ['<DEPRESSION>', '<MENTAL:DEPRESSION>', '<BSM:DEPRESSION>', '<MOOD:DEPRESSION>'],
            comment: '📋 BSM-5 — DEPRESSION',
            content: '📋 BSM-5 — DEPRESSION\nBSM-5 | Mood Disorders\n\n[S] — SUBJECTIVE',
        }),
        entry(1, {
            key: ['<BIPOLAR>', '<MENTAL:BIPOLAR>', '<BSM:BIPOLAR>', '<MOOD:BIPOLAR>'],
            comment: '📋 BSM-5 — BIPOLAR DISORDER',
            content: '📋 BSM-5 — BIPOLAR DISORDER\nBSM-5 | Mood Disorders',
        }),
        entry(2, {
            key: ['<GAD>', '<MENTAL:GAD>', '<BSM:GAD>', '<ANXIETY>', '<MENTAL:ANXIETY>'],
            comment: '📋 BSM-5 — GENERALISED ANXIETY DISORDER',
            content: '📋 BSM-5 — GENERALISED ANXIETY DISORDER\nBSM-5 | Anxiety Spectrum',
        }),
    ];
}

export function cotEntries(): Dict[] {
    return [
        entry(0, {
            key: ['<DEPRESSION>', '<MENTAL:DEPRESSION>', '<BSM:DEPRESSION>', '<MOOD:DEPRESSION>'],
            comment: '💊 CoT LENS — DEPRESSION',
            content:
                '💊 BSM-5 CoT — DEPRESSION\nWhen writing a character with depression, add the following to your chain of thought',
        }),
        entry(1, {
            key: ['<BIPOLAR>', '<MENTAL:BIPOLAR>', '<BSM:BIPOLAR>', '<MOOD:BIPOLAR>'],
            comment: '💊 CoT LENS — BIPOLAR DISORDER',
            content: '💊 BSM-5 CoT — BIPOLAR DISORDER\nWhen writing a character with bipolar disorder',
        }),
        entry(2, {
            key: ['<GAD>', '<MENTAL:GAD>', '<BSM:GAD>', '<ANXIETY>', '<MENTAL:ANXIETY>'],
            comment: '💊 CoT LENS — GAD',
            content: '💊 BSM-5 CoT — GENERALISED ANXIETY DISORDER\nWhen writing a character with GAD',
        }),
    ];
}

/** BunnyMo core #43 (the Egyptian royalty example), as a live CK archive. */
export const ATSU_CONTENT =
    '<BunnymoTags><Name:Atsu_Ibn_Oba_Al-Masri>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:HUMAN>, <GENDER:MALE>, <BUILD:Muscular>, <BUILD:Tall>, <SKIN:FAIR>, <HAIR:BLACK>, <STYLE:ANCIENT_EGYPTIAN_ROYALTY>,</PHYSICAL> <PERSONALITY><Dere:Sadodere>, <Dere:Oujidere>, <ENTJ-U>, <TRAIT:CRUEL>, <TRAIT:INTELLIGENT>, <TRAIT:POWERFUL>, <ATTACHMENT:FEARFUL_AVOIDANT>, <CONFLICT:COMPETITIVE>, <BOUNDARIES:RIGID>,<FLIRTING:AGGRESSIVE>, </PERSONALITY> <NSFW><ORIENTATION:PANSEXUAL>, <POWER:DOMINANT>, <CHEMISTRY:ANTAGONISTIC>, <JEALOUSY:POSSESSIVE>,</NSFW> </BunnymoTags>\n\n<Linguistics> Character uses <LING:COMMANDING> as his primary mode of speech, asserting authority and control. </linguistics>';

export const MIRA_CONTENT =
    '<BunnymoTags><Name:Мира>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:ELF>, <GENDER:FEMALE>,</PHYSICAL> <PERSONALITY><Dere:Kuudere>, <INTJ-U>, <TRAIT:STOIC>, <ATTACHMENT:SECURE>, </PERSONALITY> </BunnymoTags>\n<Linguistics> Mira speaks with <LING:FORMAL> precision. </Linguistics>\n\nShe keeps a diary in Elvish.';

export function archiveEntries(): Dict[] {
    return [
        entry(0, {
            key: ['Atsu', 'Pharaoh'],
            comment: 'Atsu Character Archive - Generated by Baby Bunny Mode',
            content: ATSU_CONTENT,
            position: 4,
            depth: 2,
            role: 2,
            order: 550,
        }),
        entry(1, { key: ['Мира'], comment: 'Мира', content: MIRA_CONTENT, position: 4, depth: 2, role: 2 }),
        entry(2, { key: ['tavern'], comment: 'The Tavern', content: 'A noisy tavern by the river.' }),
    ];
}
