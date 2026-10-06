import { describe, expect, it } from 'vitest';
import {
    normalizeWearRecord,
    observeWear,
    revertWear,
    sameWearing,
    wearingLine,
} from '../../src/domain/wardrobe-current';
import type { WearObservation } from '../../src/domain/wardrobe-current';
import { emptyWardrobeDoc, normalizeWardrobeDoc, pushDropped } from '../../src/domain/wardrobe-doc';

const seen = (wording: string, extra: Partial<WearObservation> = {}): WearObservation => ({
    name: 'Офелия',
    wording,
    tags: 'silk dress',
    undress: '',
    source: 'appearance',
    ...extra,
});
const at = (index: number, extra: Record<string, unknown> = {}) => ({
    key: 'p-1',
    passportId: 'p-1',
    index,
    swipe: 0,
    now: 1000 + index,
    ...extra,
});

describe('sameWearing', () => {
    it('is the same clothing in other words, not another undressing', () => {
        expect(
            sameWearing({ wording: 'в шёлковом платье', undress: '' }, { wording: 'шёлковое платье', undress: '' }),
        ).toBe(true);
        expect(
            sameWearing({ wording: 'Шёлковое платье', undress: '' }, { wording: 'шёлковое  платье', undress: '' }),
        ).toBe(true);
        expect(
            sameWearing({ wording: 'кожаная куртка', undress: '' }, { wording: 'шёлковое платье', undress: '' }),
        ).toBe(false);
        expect(sameWearing({ wording: 'обнажена', undress: 'naked' }, { wording: 'обнажена', undress: '' })).toBe(
            false,
        );
    });
});

describe('observeWear', () => {
    it('counts the same clothing per committed turn and starts over on other clothing', () => {
        const first = observeWear(undefined, seen('в шёлковом платье'), at(4));
        expect(first).toMatchObject({
            key: 'p-1',
            name: 'Офелия',
            wording: 'в шёлковом платье',
            outfit: null,
            since: 4,
            seen: 4,
            turns: 1,
            present: true,
        });
        expect(first.prior).toBeUndefined();
        const again = observeWear(
            { ...first, outfit: 'Шёлковое платье', applied: 'Шёлковое платье' },
            seen('шёлковое платье'),
            at(6),
        );
        expect(again).toMatchObject({
            wording: 'шёлковое платье',
            since: 4,
            seen: 6,
            turns: 2,
            outfit: 'Шёлковое платье',
        });
        expect(again.applied).toBe('Шёлковое платье');
        expect(again.prior).toMatchObject({ seen: 4, turns: 1 });
        // The same turn read twice does not count twice.
        expect(observeWear(again, seen('шёлковое платье'), at(6)).turns).toBe(2);
        const other = observeWear(again, seen('кожаная куртка', { tags: 'leather jacket' }), at(8, { swipe: 1 }));
        expect(other).toMatchObject({ wording: 'кожаная куртка', since: 8, swipe: 1, turns: 1, outfit: null });
        expect(other.applied).toBeUndefined();
        expect(other.prior).toMatchObject({ wording: 'шёлковое платье', seen: 6 });
        expect((other.prior as Record<string, unknown> | undefined)?.prior).toBeUndefined();
    });

    it('marks the persona and keeps the name when the observation has none', () => {
        const record = observeWear(undefined, seen('плащ', { name: '' }), at(1, { key: 'persona', persona: true }));
        expect(record).toMatchObject({ key: 'persona', persona: true, name: '' });
        expect(observeWear({ ...record, name: 'Кай' }, seen('плащ', { name: '' }), at(2)).name).toBe('Кай');
    });
});

describe('revertWear', () => {
    it('takes back what a swiped or deleted reply changed', () => {
        const first = observeWear(undefined, seen('в шёлковом платье'), at(4));
        const second = observeWear(first, seen('кожаная куртка'), at(6));
        expect(revertWear(second, 8)).toBe(second);
        expect(revertWear(second, 6)).toMatchObject({ wording: 'в шёлковом платье', seen: 4 });
        expect(revertWear(first, 4)).toBeNull();
        expect(revertWear(second, 2)).toBeNull();
    });
});

describe('normalizeWearRecord and the document', () => {
    it('repairs stored records and drops junk', () => {
        expect(normalizeWearRecord(null)).toBeNull();
        expect(normalizeWearRecord({ name: 'x' })).toBeNull();
        expect(
            normalizeWearRecord({
                key: 'p-1',
                undress: 'weird',
                source: 'odd',
                outfit: 5,
                turns: 0,
                applied: '',
                queued: 'X',
                persona: true,
                prior: { key: 'p-1', wording: 'old', outfit: 'A' },
            }),
        ).toMatchObject({
            key: 'p-1',
            undress: '',
            source: 'appearance',
            outfit: null,
            turns: 1,
            applied: '',
            queued: 'X',
            persona: true,
            prior: { key: 'p-1', wording: 'old', outfit: 'A' },
        });
        const doc = normalizeWardrobeDoc({
            current: { a: { key: 'p-1', wording: 'плащ', at: 2 }, b: 'junk' },
            dropped: [{ id: 'd1', reason: 'unknown', entityName: 'N', value: 'v' }, { id: 'd2', reason: 'odd' }, null],
            personaCheck: 7,
        });
        expect(Object.keys(doc.current)).toEqual(['p-1']);
        expect(doc.dropped).toMatchObject([{ id: 'd1', reason: 'unknown', sourceMessage: -1 }]);
        expect(doc.personaCheck).toBe(7);
        expect(emptyWardrobeDoc()).toMatchObject({ current: {}, dropped: [], personaCheck: -1 });
    });

    it('keeps the newest dropped cards once', () => {
        const doc = emptyWardrobeDoc();
        for (let i = 0; i < 60; i++) {
            pushDropped(doc, {
                id: `d${i}`,
                entityName: 'N',
                value: 'v',
                reason: 'noGarment',
                sourceMessage: i,
                at: i,
            });
        }
        pushDropped(doc, { id: 'd59', entityName: 'N', value: 'v', reason: 'removal', sourceMessage: 59, at: 99 });
        expect(doc.dropped).toHaveLength(50);
        expect(doc.dropped.at(-1)).toMatchObject({ id: 'd59', reason: 'removal' });
        expect(doc.dropped.filter((item) => item.id === 'd59')).toHaveLength(1);
    });
});

describe('wearingLine', () => {
    const header = '[Currently wearing — keep consistent unless the story changes it]';

    it('lists who wears what after the header', () => {
        expect(
            wearingLine(
                [
                    { name: 'Офелия', wording: 'Шёлковое платье, босиком.' },
                    { name: 'Кай', wording: 'кожаная куртка' },
                    { name: '', wording: 'x' },
                    { name: 'Вера', wording: '' },
                ],
                header,
                80,
            ),
        ).toBe(`${header} Офелия: шёлковое платье, босиком; Кай: кожаная куртка`);
        expect(wearingLine([], header, 80)).toBe('');
        expect(wearingLine([{ name: 'IN', wording: 'IN a robe' }], 'H', 80)).toBe('H IN: IN a robe');
    });

    it('stays within the budget: long wordings are cut at a comma, those that do not fit are left out', () => {
        const long =
            'белая блузка с кружевным воротником, чёрная юбка до колен, шерстяные чулки, туфли на каблуках, брошь';
        const line = wearingLine([{ name: 'Офелия', wording: long }], header, 80);
        expect(line).toBe(
            `${header} Офелия: белая блузка с кружевным воротником, чёрная юбка до колен, шерстяные чулки`,
        );
        const many = Array.from({ length: 10 }, (_, i) => ({
            name: `Персонаж ${i}`,
            wording: 'дорожный плащ и сапоги',
        }));
        const cut = wearingLine(many, header, 80);
        expect(cut.length).toBeLessThanOrEqual(240);
        expect(cut.split('; ').length).toBeLessThan(10);
        expect(wearingLine(many, header, 0)).toBe('');
    });
});
