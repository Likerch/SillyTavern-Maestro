// Starting scenes of the preparation domain: one per greeting of the card — their ids, the migration of 1.15 plans
// (one scene), the merge of scenes read in several parts, what the active one brings (outfits, the type of its first
// scene, the canon note of the start) and the fallbacks to the characters' outfits and the direction's type.
import { describe, expect, it } from 'vitest';
import {
    START_NOTE_TITLE,
    characterNamed,
    outfitAtStart,
    sceneFirstScene,
    sceneOutfits,
    selectItems,
    startNoteDraft,
} from '../../src/domain/prepare-apply';
import { mergeItems, sameItem } from '../../src/domain/prepare-merge';
import {
    SINGLE_SECTIONS,
    emptyData,
    isFirstScene,
    itemIdOf,
    migrateScenes,
    sceneGreeting,
    sceneId,
} from '../../src/domain/prepare-plan';
import type {
    AnyPrepareItem,
    PrepareDataMap,
    PrepareItem,
    PrepareKind,
    SceneData,
} from '../../src/domain/prepare-plan';

function item<K extends PrepareKind>(
    kind: K,
    data: Partial<PrepareDataMap[K]>,
    extra: Partial<AnyPrepareItem> = {},
): AnyPrepareItem {
    const full = { ...emptyData(kind), ...data } as PrepareDataMap[K];
    return {
        id: itemIdOf(kind, full),
        kind,
        data: full,
        russian: '',
        sources: [],
        scope: 'chat',
        ...extra,
    } as AnyPrepareItem;
}

function scene(data: Partial<SceneData>, extra: Partial<AnyPrepareItem> = {}): PrepareItem<'scene'> {
    return item('scene', data, extra) as PrepareItem<'scene'>;
}

const PLAN: AnyPrepareItem[] = [
    item('character', {
        name: 'Элизабет',
        english: 'Elizabeth',
        forms: ['Лиза'],
        outfit: 'A travel dress.',
        present: true,
    }),
    item('character', { name: 'Вера', english: 'Vera', outfit: 'A watch coat.' }),
    item('character', { name: 'Кай', persona: true, outfit: 'Mail.', present: true }),
    item('direction', { genre: 'Mystery', firstScene: 'dialogue' }),
];

describe('prepare scenes: ids and the plan', () => {
    it('makes one item per greeting', () => {
        expect(SINGLE_SECTIONS.has('scene')).toBe(false);
        expect(itemIdOf('scene', { ...emptyData('scene'), greeting: 2 })).toBe('scene:2');
        expect(sceneId(0)).toBe('scene:0');
        expect(sceneGreeting(scene({ greeting: 3 }))).toBe(3);
        expect(sceneGreeting(item('world', {}))).toBe(0);
        expect(isFirstScene('drama')).toBe(true);
        expect(isFirstScene('brawl')).toBe(false);
        expect(sameItem(scene({ greeting: 1, place: 'A' }), scene({ greeting: 1, place: 'B' }))).toBe(true);
        expect(sameItem(scene({ greeting: 1 }), scene({ greeting: 2 }))).toBe(false);
    });

    it('migrates the single scene of a 1.15 plan to the greeting the chat opened with', () => {
        const old = {
            id: 'scene',
            kind: 'scene',
            data: { place: 'Таверна', date: 'День 1', time: 'вечер', present: ['Вера', 7], situation: 'Rain.' },
            russian: 'Дождливый вечер.',
            sources: ['card.greeting'],
            scope: 'chat',
        } as unknown as AnyPrepareItem;
        const current = scene({ greeting: 1, place: 'Рынок', firstScene: 'social' });
        const broken = {
            ...scene({ greeting: 4 }),
            data: { greeting: 4, outfits: [{ name: 'Вера', wearing: 'Coat.' }, { name: '' }], firstScene: 'brawl' },
        } as unknown as AnyPrepareItem;
        const [migrated, kept, repaired, other] = migrateScenes([old, current, broken, PLAN[0]!], 2);
        expect(migrated).toMatchObject({
            id: 'scene:2',
            russian: 'Дождливый вечер.',
            data: {
                greeting: 2,
                place: 'Таверна',
                present: ['Вера'],
                situation: 'Rain.',
                outfits: [],
                firstScene: '',
            },
        });
        expect(kept).toEqual(current);
        expect(repaired).toMatchObject({
            id: 'scene:4',
            data: { place: '', outfits: [{ name: 'Вера', wearing: 'Coat.' }], firstScene: '' },
        });
        expect(other).toBe(PLAN[0]);
    });

    it('merges a scene read in two parts by its greeting and orders the scenes by greeting', () => {
        const merged = mergeItems([
            [
                scene(
                    {
                        greeting: 2,
                        place: 'Архив',
                        present: ['Мартин'],
                        outfits: [{ name: 'Мартин', wearing: 'A robe.' }],
                        situation: 'Night.',
                    },
                    { sources: ['greeting:2'] },
                ),
                scene({ greeting: 0, place: 'Таверна' }),
            ],
            [
                scene(
                    {
                        greeting: 2,
                        place: 'Archive',
                        present: ['Вера'],
                        outfits: [
                            { name: 'мартин', wearing: 'Spectacles.' },
                            { name: 'Вера', wearing: 'A coat.' },
                        ],
                        firstScene: 'drama',
                    },
                    { sources: ['book:W#1'], russian: 'Ночь в архиве.' },
                ),
            ],
        ]);
        expect(merged.map((row) => row.id)).toEqual(['scene:0', 'scene:2']);
        const archive = merged[1] as PrepareItem<'scene'>;
        expect(archive.data).toMatchObject({
            place: 'Архив',
            present: ['Мартин', 'Вера'],
            situation: 'Night.',
            firstScene: 'drama',
            outfits: [
                { name: 'Мартин', wearing: 'A robe. Spectacles.' },
                { name: 'Вера', wearing: 'A coat.' },
            ],
        });
        expect(archive.sources).toEqual(['greeting:2', 'book:W#1']);
        expect(archive.russian).toBe('Ночь в архиве.');
        // 'all' takes every scene.
        expect(selectItems(merged, 'all', 'chat').map((row) => row.id)).toEqual(['scene:0', 'scene:2']);
    });
});

describe('prepare scenes: what the active one brings', () => {
    it('takes the scene’s own outfits (scenes win), never the player’s', () => {
        const start = scene({
            greeting: 1,
            present: ['Вера'],
            outfits: [
                { name: 'Лиза', wearing: 'A green cloak.' },
                { name: 'Кай', wearing: 'Chain mail.' },
                { name: 'Томас', wearing: 'An apron.' },
                { name: 'Элизабет', wearing: 'Again.' },
                { name: 'Вера', wearing: '  ' },
            ],
        });
        expect(sceneOutfits(start.data, PLAN)).toEqual([
            { name: 'Элизабет', english: 'Elizabeth', wearing: 'A green cloak.' },
            { name: 'Томас', english: '', wearing: 'An apron.' },
        ]);
        expect(characterNamed(PLAN, 'лиза')?.data.name).toBe('Элизабет');
        expect(characterNamed(PLAN, ' ')).toBeUndefined();
    });

    it('falls back to the outfits of the characters present and to the direction’s type', () => {
        const start = scene({ greeting: 0, present: ['Vera'] });
        expect(sceneOutfits(start.data, PLAN)).toEqual([
            { name: 'Элизабет', english: 'Elizabeth', wearing: 'A travel dress.' },
            { name: 'Вера', english: 'Vera', wearing: 'A watch coat.' },
        ]);
        expect(sceneFirstScene(start.data, PLAN)).toBe('dialogue');
        expect(sceneFirstScene({ ...start.data, firstScene: 'combat' }, PLAN)).toBe('combat');
        expect(sceneFirstScene(start.data, [])).toBe('');
    });

    it('dresses a character for the start shown: the scene’s outfit, else their own', () => {
        const elizabeth = PLAN[0] as PrepareItem<'character'>;
        const vera = PLAN[1] as PrepareItem<'character'>;
        const start = scene({ greeting: 1, outfits: [{ name: 'Elizabeth', wearing: 'Riding clothes.' }] });
        expect(outfitAtStart(elizabeth, start.data, PLAN)).toBe('Riding clothes.');
        expect(outfitAtStart(vera, start.data, PLAN)).toBe('A watch coat.');
        expect(outfitAtStart(elizabeth, null, PLAN)).toBe('A travel dress.');
    });

    it('writes the canon note of the start in English', () => {
        const note = startNoteDraft({
            ...emptyData('scene'),
            greeting: 1,
            place: 'Серебряная Гавань',
            date: 'День 1',
            time: 'рассвет',
            present: ['Вера'],
            situation: 'Vera shows the empty hold.',
        })!;
        expect(note.title).toBe(START_NOTE_TITLE);
        expect(note.type).toBe('note');
        expect(note.content).toBe(
            'Note: Story start\nText:\nWhen: День 1, рассвет\nWhere: Серебряная Гавань\nPresent: Вера\nSituation: Vera shows the empty hold.',
        );
        expect(note.keys).toEqual(['story start', 'начало истории', 'Серебряная Гавань']);
        expect(startNoteDraft(emptyData('scene'))).toBeNull();
    });
});
