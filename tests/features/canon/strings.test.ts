import { describe, expect, it } from 'vitest';
import { describeChange } from '../../../src/core/labels';
import type { Labels } from '../../../src/core/labels';
import { CANON_KINDS, CANON_ORIGINS, CANON_STATUSES } from '../../../src/domain/canon-book';
import { ROLE_IDS } from '../../../src/domain/roles-detect';
import { BOOK_ROLES_STRINGS } from '../../../src/features/bookRoles/strings';
import { canonModule } from '../../../src/features/canon';
import { CANON_STRINGS, CANON_TARGETS } from '../../../src/features/canon/strings';
import type { I18n } from '../../../src/shared/contracts';

function i18nOf(lang: 'en' | 'ru'): I18n {
    const table = CANON_STRINGS[lang];
    return {
        t: (key, params) =>
            (table[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? '')),
        register: () => undefined,
        locale: () => lang,
    };
}

const labels: Labels = {
    register: () => () => undefined,
    target: (target) => CANON_TARGETS.find((spec) => spec.target === target),
    targets: () => [...CANON_TARGETS],
};

describe('canon titles', () => {
    it('shows the offscreen bookkeeping title in Russian, in the journal row too', () => {
        const ru = i18nOf('ru');
        expect(
            describeChange(
                { target: 'canon-entry', ref: {}, before: null, after: { comment: 'Offscreen: Мира', content: 'x' } },
                labels,
                ru,
            )?.rows,
        ).toEqual([{ label: 'Запись', kind: 'added', after: 'За кадром: Мира' }]);
    });
});

describe('M6 and M35 roles strings', () => {
    it('have the same keys in English and Russian, none empty', () => {
        for (const parts of [CANON_STRINGS, BOOK_ROLES_STRINGS]) {
            expect(Object.keys(parts.ru).sort()).toEqual(Object.keys(parts.en).sort());
            for (const [key, text] of Object.entries(parts.ru)) expect(text, key).not.toBe('');
        }
    });

    it('use their own prefixes and cover every kind, status, origin and role', () => {
        const canon = Object.keys(CANON_STRINGS.en);
        expect(
            canon.every(
                (key) => key.startsWith('m6.') || key.startsWith('kind.canon.') || key.startsWith('target.canon-'),
            ),
        ).toBe(true);
        for (const kind of CANON_KINDS) {
            expect(canon).toContain(`m6.kind.${kind}`);
            expect(canon).toContain(`m6.group.${kind}`);
        }
        for (const status of CANON_STATUSES) expect(canon).toContain(`m6.status.${status}`);
        for (const origin of CANON_ORIGINS) expect(canon).toContain(`m6.origin.${origin}`);
        const roles = Object.keys(BOOK_ROLES_STRINGS.en);
        expect(
            roles.every((key) => key.startsWith('m35r.') || key === 'kind.bookRoles.set' || key === 'target.book-role'),
        ).toBe(true);
        for (const role of ROLE_IDS) expect(roles).toContain(`m35r.role.${role}`);
    });

    it('names every journal kind and target in both languages', () => {
        expect(canonModule.targets).toBe(CANON_TARGETS);
        expect(CANON_TARGETS.map((spec) => spec.target)).toEqual(['canon-entry', 'canon-base-entry', 'canon-book']);
        const kinds = ['branchCopy', 'put', 'remove', 'status', 'promote', 'export'].map(
            (kind) => `kind.canon.${kind}`,
        );
        for (const key of [...kinds, ...CANON_TARGETS.map((spec) => `target.${spec.target}`)]) {
            expect(CANON_STRINGS.en[key], key).toBeTruthy();
            expect(CANON_STRINGS.ru[key], key).toBeTruthy();
        }
        for (const spec of CANON_TARGETS) {
            for (const field of Object.values(spec.fields ?? {})) {
                expect(CANON_STRINGS.en[field.labelKey], field.labelKey).toBeTruthy();
                expect(CANON_STRINGS.ru[field.labelKey], field.labelKey).toBeTruthy();
            }
        }
    });

    it('shows a canon entry by its title and state; text, keys and uid stay technical', () => {
        const entry = (status: string) => ({
            uid: 4,
            comment: 'Таверна',
            key: ['таверна'],
            content: 'The tavern burned down.',
            extensions: { maestro: { kind: 'addition', status, origin: 'revision' } },
        });
        const change = {
            target: 'canon-entry',
            ref: { book: 'b', uid: 4 },
            before: entry('active'),
            after: entry('archived'),
        };
        expect(describeChange(change, labels, i18nOf('ru'))).toEqual({
            label: 'Запись канона чата',
            rows: [{ label: 'Состояние', kind: 'changed', before: 'действует', after: 'в архиве' }],
        });
        const created = describeChange({ ...change, before: null }, labels, i18nOf('ru'));
        expect(created?.rows.map((row) => [row.label, row.after])).toEqual([
            ['Запись', 'Таверна'],
            ['Состояние', 'в архиве'],
        ]);
        expect(JSON.stringify(created)).not.toContain('burned');
        expect(
            describeChange(
                { target: 'canon-book', ref: { book: 'x' }, before: null, after: { created: true } },
                labels,
                i18nOf('ru'),
            ),
        ).toBeNull();
    });
});
