import { describe, expect, it } from 'vitest';
import { LORE_TAG_ORDER } from '../../../src/domain/lore-journal';
import type { BookReasonId } from '../../../src/domain/lore-journal';
import { M2_STRINGS } from '../../../src/features/inspector';
import { M1_STRINGS } from '../../../src/features/loreJournal';

const REASONS: BookReasonId[] = [
    'global',
    'character',
    'characterExtra',
    'chat',
    'persona',
    'desCampaign',
    'desAutoLink',
    'ckConnector',
    'workshop',
    'canon',
];
const OWNERS = [
    'des',
    'ck',
    'qvink',
    'nai',
    'desru',
    'maestro',
    'wiOutlet',
    'wiDepth',
    'summary',
    'authorsNote',
    'card',
    'other',
];

describe('M1/M2 strings', () => {
    it('have the same keys in English and Russian', () => {
        for (const parts of [M1_STRINGS, M2_STRINGS]) {
            expect(Object.keys(parts.ru).sort()).toEqual(Object.keys(parts.en).sort());
            for (const [key, text] of Object.entries(parts.ru)) expect(text, key).not.toBe('');
        }
    });

    it('cover every tag, reason, position, role and slot owner', () => {
        const m1 = Object.keys(M1_STRINGS.en);
        for (const tag of LORE_TAG_ORDER) expect(m1).toContain(`m1.tag.${tag}`);
        for (const reason of REASONS) expect(m1).toContain(`m1.reason.${reason}`);
        for (let position = 0; position <= 7; position++) expect(m1).toContain(`m1.pos.${position}`);
        for (const role of [0, 1, 2]) expect(m1).toContain(`m1.role.${role}`);
        for (const cut of ['budget', 'maestro', 'other']) expect(m1).toContain(`m1.cut.${cut}`);
        const m2 = Object.keys(M2_STRINGS.en);
        for (const owner of OWNERS) expect(m2).toContain(`m2.owner.${owner}`);
        for (const group of ['preset', 'card', 'lore', 'history']) expect(m2).toContain(`m2.group.${group}`);
    });
});
