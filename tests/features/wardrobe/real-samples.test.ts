// The wardrobe on real DES wordings (plan-2 §4 п. 8): tests/fixtures-private/des-appearance.json is made from the
// user's own local chats by tools/extract-des-samples.mjs (names replaced) and is never in the repository. Without the
// file the suite is skipped.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fieldAspect } from '../../../src/domain/signals-diff';
import { russianOutfitName } from '../../../src/domain/wardrobe-names';
import { outfitTagList } from '../../../src/domain/wardrobe-tags';
import { bodyWords, clothingOf, mentionsClothing } from '../../../src/domain/wardrobe-wear';
import { wearOfDetails } from '../../../src/features/wardrobe';

interface Sample {
    field: string;
    text: string;
    character: string;
}

const FILE = fileURLToPath(new URL('../../fixtures-private/des-appearance.json', import.meta.url));
const samples: Sample[] | null = fs.existsSync(FILE)
    ? ((JSON.parse(fs.readFileSync(FILE, 'utf8')) as { samples?: Sample[] }).samples ?? [])
    : null;

/** Hair, eyes and skin said plainly (an independent check of the body lexicon). */
const PLAIN_BODY_RE =
    /(?<!\p{L})(?:волос\p{L}*|глаз\p{L}*|кудр\p{L}*|веснушк\p{L}*|шрам\p{L}*|кожа|кожи|коже|hair|eyes?|skin|freckles|scar)(?!\p{L})/iu;

describe.skipIf(!samples)('real DES samples', () => {
    const list = samples ?? [];
    const appearance = list.filter((sample) => fieldAspect(sample.field) === 'appearance');
    const withClothes = appearance.filter((sample) => mentionsClothing(sample.text));

    it('has appearance samples that speak of clothes', () => {
        expect(appearance.length).toBeGreaterThan(0);
        expect(withClothes.length).toBeGreaterThan(0);
    });

    it('cuts the clothing out of every appearance text that names a garment', () => {
        for (const sample of withClothes) {
            const found = clothingOf(sample.text);
            expect(found?.text, sample.text).toBeTruthy();
            const observation = wearOfDetails(sample.character, { [sample.field]: sample.text });
            expect(observation?.source, sample.text).toBe('appearance');
            expect(observation?.wording, sample.text).toBe(found?.text);
        }
    });

    it('lets no hair, eye or body word into the outfit text', () => {
        for (const sample of withClothes) {
            const text = clothingOf(sample.text)?.text ?? '';
            expect(bodyWords(text), `${sample.text} → ${text}`).toEqual([]);
            expect(PLAIN_BODY_RE.test(text), `${sample.text} → ${text}`).toBe(false);
        }
    });

    it('gives tags and a Russian name for every clothing text it cut out', () => {
        for (const sample of withClothes) {
            const text = clothingOf(sample.text)?.text ?? '';
            if (clothingOf(sample.text)?.undress) continue;
            const tags = outfitTagList(text);
            expect(tags.length, text).toBeGreaterThan(0);
            for (const tag of tags) expect(tag.tag, text).toMatch(/^[a-z0-9' -]+$/);
            expect(russianOutfitName(tags, text), text).toMatch(/^\p{Lu}/u);
        }
    });

    it('finds nothing to wear in the other fields (demeanor)', () => {
        for (const sample of list.filter((item) => !fieldAspect(item.field))) {
            expect(wearOfDetails(sample.character, { [sample.field]: sample.text }), sample.text).toBeNull();
        }
    });
});
