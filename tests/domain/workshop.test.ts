// M42 «Служебный режим» (ex-«Мастерская»), pure helpers: which card is a service card, the default tags and their
// migration, which prompt slots stay, how the others are cut out of the outgoing messages, which lorebooks stay.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_WORKSHOP_TAGS,
    cutTexts,
    filterLore,
    keepsSlot,
    migrateWorkshopTags,
    normalizeTagName,
    parseTagList,
    slotsToCut,
    workshopTagOf,
} from '../../src/domain/workshop';

const TAGS = [
    { id: 't1', name: 'Fantasy' },
    { id: 't2', name: 'Мастерская' },
    { id: 't3', name: '#Workshop ' },
];

describe('workshop tags', () => {
    it('compares names without case, «ё», a leading # and extra spaces', () => {
        expect(normalizeTagName('  #Мастерская ')).toBe('мастерская');
        expect(normalizeTagName('Ёлка  Зелёная')).toBe('елка зеленая');
    });

    it('finds the first workshop tag of a card, or null', () => {
        expect(workshopTagOf(['t1', 't2'], TAGS, ['мастерская'])).toEqual({ id: 't2', name: 'Мастерская' });
        expect(workshopTagOf(['t3'], TAGS, ['мастерская', 'workshop'])).toEqual({ id: 't3', name: '#Workshop ' });
        expect(workshopTagOf(['t1'], TAGS, ['мастерская'])).toBeNull();
        expect(workshopTagOf(undefined, TAGS, ['мастерская'])).toBeNull();
        expect(workshopTagOf(['t2'], undefined, ['мастерская'])).toBeNull();
        expect(workshopTagOf(['t2'], TAGS, [' ', ''])).toBeNull();
        // A tag id the tag list no longer has (deleted tag) does not count.
        expect(workshopTagOf(['gone'], TAGS, ['мастерская'])).toBeNull();
    });

    it('reads the setting: lines or commas, each name once', () => {
        expect(parseTagList('мастерская\nWorkshop, мастерская;  помощник ,,')).toEqual([
            'мастерская',
            'Workshop',
            'помощник',
        ]);
        expect(parseTagList('  ')).toEqual([]);
    });

    it('defaults to «служебная» first; the old names still count', () => {
        expect(DEFAULT_WORKSHOP_TAGS).toEqual(['служебная', 'мастерская', 'workshop']);
        expect(workshopTagOf(['t2'], TAGS, DEFAULT_WORKSHOP_TAGS)).toEqual({ id: 't2', name: 'Мастерская' });
        expect(workshopTagOf(['t3'], TAGS, DEFAULT_WORKSHOP_TAGS)).toEqual({ id: 't3', name: '#Workshop ' });
    });

    it('turns the old default list (any order or case) into the new one and leaves a list of one’s own', () => {
        expect(migrateWorkshopTags(['мастерская', 'workshop'])).toEqual(['служебная', 'мастерская', 'workshop']);
        expect(migrateWorkshopTags(['Workshop', ' Мастерская'])).toEqual(['служебная', 'мастерская', 'workshop']);
        expect(migrateWorkshopTags(['мастерская'])).toEqual(['мастерская']);
        expect(migrateWorkshopTags(['мастерская', 'workshop', 'помощник'])).toEqual([
            'мастерская',
            'workshop',
            'помощник',
        ]);
        expect(migrateWorkshopTags(['служебная', 'мастерская', 'workshop'])).toEqual(DEFAULT_WORKSHOP_TAGS);
    });
});

describe('prompt slots', () => {
    it('keeps SillyTavern’s own slots and cuts every extension’s', () => {
        for (const key of [
            'DEPTH_PROMPT',
            'DEPTH_PROMPT_2',
            'customDepthWI_4_0',
            'customWIOutlet_rules',
            '2_floating_prompt',
            '3_vectors',
            '4_vectors_data_bank',
            'QUIET_PROMPT',
            '__STORY_STRING__',
        ])
            expect(keepsSlot(key)).toBe(true);
        for (const key of [
            'dooms-tracker-inject',
            'nai_studio_markers',
            'maestro_director',
            'script_inject_carrot-consistency',
            '1_memory',
            'desru_bunnymo_language',
        ])
            expect(keepsSlot(key)).toBe(false);
    });

    it('lists only texts long enough to be found without chance matches', () => {
        expect(
            slotsToCut({
                'dooms-tracker-inject': { value: 'Attach the tracker JSON at the start of every reply.' },
                nai_studio_markers: { value: '   ' },
                maestro_short: { value: 'ok' },
                DEPTH_PROMPT: { value: 'The card’s own depth prompt stays here.' },
                broken: 'not a slot',
            }),
        ).toEqual([{ key: 'dooms-tracker-inject', value: 'Attach the tracker JSON at the start of every reply.' }]);
        expect(slotsToCut(undefined)).toEqual([]);
    });
});

describe('cutTexts', () => {
    const TRACKER = 'At the start of every reply attach the tracker JSON exactly as shown.';
    const MARKERS = '\nPlace 1 to 3 picture markers in the reply for {{char}}.\n';

    it('cuts texts glued into bigger messages, the macro form too, and drops messages left empty', () => {
        const messages: Record<string, unknown>[] = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'user', content: 'Hi' },
            { role: 'system', content: `${TRACKER}\n\nPlace 1 to 3 picture markers in the reply for Celestia.` },
            { role: 'system', content: `Author’s note stays.\n${TRACKER}` },
        ];
        const cut = cutTexts(
            messages,
            [
                { key: 'dooms-tracker-inject', value: TRACKER },
                { key: 'nai_studio_markers', value: MARKERS },
                { key: 'absent_slot', value: 'This text is nowhere in the prompt at all.' },
            ],
            (text) => text.replace('{{char}}', 'Celestia'),
        );
        expect(cut).toEqual(['dooms-tracker-inject', 'nai_studio_markers']);
        expect(messages).toEqual([
            { role: 'system', content: 'Main prompt.' },
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Author’s note stays.\n' },
        ]);
    });

    it('works on text parts and keeps a message that still holds an image', () => {
        const image = { type: 'image_url', image_url: { url: 'data:' } };
        const messages: Record<string, unknown>[] = [
            { role: 'user', content: [{ type: 'text', text: TRACKER }, image] },
            { role: 'system', content: [{ type: 'text', text: TRACKER }] },
        ];
        cutTexts(messages, [{ key: 'dooms-tracker-inject', value: TRACKER }]);
        expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }, image] }]);
    });

    it('folds the blank lines left behind', () => {
        const messages: Record<string, unknown>[] = [{ role: 'system', content: `A\n\n${TRACKER}\n\nB` }];
        cutTexts(messages, [{ key: 'k', value: TRACKER }]);
        expect(messages[0]!.content).toBe('A\n\nB');
    });
});

describe('filterLore', () => {
    function payload() {
        return {
            globalLore: [{ world: 'BunnyMo' }, { world: 'Архив персонажей' }],
            characterLore: [{ world: 'Card book' }],
            chatLore: [{ world: 'Chat book' }],
            personaLore: [{ world: 'Persona book' }],
        };
    }

    it('own: the card’s and the chat’s books stay, in the very arrays ST keeps using', () => {
        const data = payload();
        const characterLore = data.characterLore;
        expect(filterLore(data, 'own')).toBe(3);
        expect(data.globalLore).toEqual([]);
        expect(data.personaLore).toEqual([]);
        expect(data.characterLore).toBe(characterLore);
        expect(data.characterLore).toHaveLength(1);
        expect(data.chatLore).toHaveLength(1);
    });

    it('none drops everything, all drops nothing', () => {
        const none = payload();
        expect(filterLore(none, 'none')).toBe(5);
        expect([...none.globalLore, ...none.characterLore, ...none.chatLore, ...none.personaLore]).toEqual([]);
        const all = payload();
        expect(filterLore(all, 'all')).toBe(0);
        expect(all.globalLore).toHaveLength(2);
        expect(filterLore('not a payload', 'own')).toBe(0);
    });
});
