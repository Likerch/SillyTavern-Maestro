import { describe, expect, it } from 'vitest';
import { CANON_KINDS, CANON_ORIGINS, CANON_STATUSES } from '../../../src/domain/canon-book';
import { ROLE_IDS } from '../../../src/domain/roles-detect';
import { BOOK_ROLES_STRINGS } from '../../../src/features/bookRoles/strings';
import { CANON_STRINGS } from '../../../src/features/canon/strings';

describe('M6 and M35 roles strings', () => {
    it('have the same keys in English and Russian, none empty', () => {
        for (const parts of [CANON_STRINGS, BOOK_ROLES_STRINGS]) {
            expect(Object.keys(parts.ru).sort()).toEqual(Object.keys(parts.en).sort());
            for (const [key, text] of Object.entries(parts.ru)) expect(text, key).not.toBe('');
        }
    });

    it('use their own prefixes and cover every kind, status, origin and role', () => {
        const canon = Object.keys(CANON_STRINGS.en);
        expect(canon.every((key) => key.startsWith('m6.') || key.startsWith('kind.canon.'))).toBe(true);
        for (const kind of CANON_KINDS) {
            expect(canon).toContain(`m6.kind.${kind}`);
            expect(canon).toContain(`m6.group.${kind}`);
        }
        for (const status of CANON_STATUSES) expect(canon).toContain(`m6.status.${status}`);
        for (const origin of CANON_ORIGINS) expect(canon).toContain(`m6.origin.${origin}`);
        const roles = Object.keys(BOOK_ROLES_STRINGS.en);
        expect(roles.every((key) => key.startsWith('m35r.'))).toBe(true);
        for (const role of ROLE_IDS) expect(roles).toContain(`m35r.role.${role}`);
    });
});
