import { describe, expect, it } from 'vitest';
import { WORLD_KINDS } from '../../../src/domain/world-names';
import { WORLD_STRINGS } from '../../../src/features/world/strings';

const SOURCE_KINDS = [
    'card',
    'persona',
    'des.character',
    'des.alias',
    'chat.alias',
    'lore.entry',
    'canon.entry',
    'ck.archive',
    'nai.passport',
    'qvink.memory',
    'place',
];

describe('M7 world strings', () => {
    it('have the same keys in English and Russian, none empty', () => {
        expect(Object.keys(WORLD_STRINGS.ru).sort()).toEqual(Object.keys(WORLD_STRINGS.en).sort());
        for (const [key, text] of Object.entries(WORLD_STRINGS.ru)) expect(text, key).not.toBe('');
    });

    it('use their own prefix and cover every kind, source and reason', () => {
        const keys = Object.keys(WORLD_STRINGS.en);
        expect(keys.every((key) => /^(m7w\.|kind\.world\.|target\.world-)/.test(key))).toBe(true);
        for (const kind of WORLD_KINDS) expect(keys).toContain(`m7w.kind.${kind}`);
        for (const source of SOURCE_KINDS) expect(keys).toContain(`m7w.source.${source}`);
        for (const reason of ['sharedName', 'sharedAlias', 'firstName', 'anchors']) {
            expect(keys).toContain(`m7w.reason.${reason}`);
        }
    });
});
