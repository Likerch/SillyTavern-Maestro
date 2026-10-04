import { describe, expect, it } from 'vitest';
import { structuralIssues } from '../../src/domain/dossier-check';
import type { CheckInput } from '../../src/domain/dossier-check';

function input(overrides: Partial<CheckInput> = {}): CheckInput {
    return {
        kind: 'character',
        name: 'Лира',
        known: [],
        inDes: true,
        desCanonical: 'Лира',
        desAliases: [],
        entries: [{ world: 'World', uid: 1, title: 'Lyra', keys: ['Лира', 'Lyra'], protected: false }],
        canonItems: 0,
        naiPresent: false,
        passportNames: [],
        ckPresent: false,
        archiveNames: [],
        formsOf: null,
        ...overrides,
    };
}

const kinds = (overrides: Partial<CheckInput>) => structuralIssues(input(overrides)).map((issue) => issue.kind);

describe('structuralIssues', () => {
    it('finds nothing for a consistent character', () => {
        expect(structuralIssues(input())).toEqual([]);
    });

    it('reports a DES character without an entry or canon', () => {
        expect(kinds({ entries: [] })).toEqual(['missingEntry']);
        expect(kinds({ entries: [], canonItems: 1 })).toEqual([]);
        expect(kinds({ entries: [], inDes: false })).toEqual([]);
        expect(kinds({ kind: 'place', entries: [] })).toEqual([]);
    });

    it('reports missing passports and archives only when NAI Studio and CK are there', () => {
        expect(kinds({ naiPresent: true })).toEqual(['missingPassport']);
        expect(kinds({ naiPresent: true, inDes: false })).toEqual([]);
        expect(kinds({ naiPresent: true, passportNames: ['Лира'] })).toEqual([]);
        expect(kinds({ kind: 'persona', naiPresent: true, inDes: false })).toEqual(['missingPassport']);
        expect(kinds({ ckPresent: true })).toEqual(['missingArchive']);
        expect(kinds({ ckPresent: true, archiveNames: ['Лира'] })).toEqual([]);
        expect(kinds({ kind: 'persona', ckPresent: true })).toEqual([]);
    });

    it('reports DES aliases that no key covers, with the keys to add', () => {
        const issues = structuralIssues(input({ desAliases: ['Ли', 'Lyra', 'лира', 'Лисичка', 'Лисичка', ' '] }));
        expect(issues).toEqual([
            {
                kind: 'aliasNotKey',
                severity: 'warn',
                params: { alias: 'Ли', entry: 'Lyra' },
                entry: { world: 'World', uid: 1 },
                addKeys: ['Ли'],
            },
            {
                kind: 'aliasNotKey',
                severity: 'warn',
                params: { alias: 'Лисичка', entry: 'Lyra' },
                entry: { world: 'World', uid: 1 },
                addKeys: ['Лисичка'],
            },
        ]);
        expect(kinds({ entries: [], desAliases: ['Ли'] })).toEqual(['missingEntry']);
    });

    it('offers no fix when every entry is in a BunnyMo book (P13)', () => {
        const [issue] = structuralIssues(
            input({
                desAliases: ['Лисичка'],
                entries: [{ world: 'Pack', uid: 3, title: 'Pack entry', keys: ['Лира'], protected: true }],
            }),
        );
        expect(issue?.kind).toBe('aliasNotKey');
        expect(issue?.addKeys).toBeUndefined();
        expect(issue?.entry).toBeUndefined();
        expect(issue?.params.entry).toBe('Pack entry');
    });

    it('fixes into the first entry outside BunnyMo books', () => {
        const [issue] = structuralIssues(
            input({
                desAliases: ['Лисичка'],
                entries: [
                    { world: 'Pack', uid: 3, title: 'Pack entry', keys: ['Лира'], protected: true },
                    { world: 'World', uid: 9, title: 'Lyra', keys: ['Лира'], protected: false },
                ],
            }),
        );
        expect(issue?.entry).toEqual({ world: 'World', uid: 9 });
    });

    it('reports names that disagree with the DES canonical name', () => {
        const issues = structuralIssues(
            input({
                desCanonical: 'Лира',
                desAliases: ['Lyra'],
                entries: [{ world: 'World', uid: 1, title: 'Lyra', keys: ['Лира', 'Lyra'], protected: false }],
                archiveNames: ['Lyra', 'Mara_Vane', null],
                passportNames: ['Mara Vane', 'Лира Серебряная'],
            }),
        );
        expect(issues).toEqual([
            { kind: 'nameMismatch', severity: 'warn', params: { name: 'Лира', names: 'Mara_Vane' } },
        ]);
        expect(kinds({ desCanonical: null, archiveNames: ['Lyra'] })).toEqual(['nameMismatch']);
        expect(kinds({ kind: 'place', archiveNames: ['Other'] })).toEqual([]);
    });

    it('reports Cyrillic name keys without case forms, preferring the DES-RU regex key', () => {
        const forms: Record<string, string[]> = { Лира: ['Лира', 'Лиры', 'Лире', 'Лиру', 'Лирой'] };
        const formsOf = (name: string) => forms[name] ?? [name];
        const [issue] = structuralIssues(input({ formsOf, formsKeyOf: () => '/лир(а|ы|е|у|ой)/iu' }));
        expect(issue).toEqual({
            kind: 'formsMissing',
            severity: 'info',
            params: { key: 'Лира', entry: 'Lyra', forms: 'Лиры, Лире, Лиру, Лирой', count: 4 },
            entry: { world: 'World', uid: 1 },
            addKeys: ['/лир(а|ы|е|у|ой)/iu'],
        });
        expect(structuralIssues(input({ formsOf }))[0]?.addKeys).toEqual(['Лиры', 'Лире', 'Лиру', 'Лирой']);
        expect(structuralIssues(input({ formsOf, formsKeyOf: null }))[0]?.addKeys).toHaveLength(4);
    });

    it('accepts stems and regex keys as forms and skips other keys and BunnyMo books', () => {
        const formsOf = () => ['Лира', 'Лиры', 'Лиру'];
        expect(
            kinds({ formsOf, entries: [{ world: 'W', uid: 1, title: 'L', keys: ['Лира', 'Лир'], protected: false }] }),
        ).toEqual([]);
        expect(
            kinds({
                formsOf,
                entries: [{ world: 'W', uid: 1, title: 'L', keys: ['Лира', '/лир[ыу]/i'], protected: false }],
            }),
        ).toEqual([]);
        expect(
            kinds({ formsOf, entries: [{ world: 'W', uid: 1, title: 'L', keys: ['таверна'], protected: false }] }),
        ).toEqual([]);
        expect(
            kinds({ formsOf, entries: [{ world: 'W', uid: 1, title: 'L', keys: ['Лира'], protected: true }] }),
        ).toEqual([]);
        expect(
            kinds({
                formsOf: () => null,
                entries: [{ world: 'W', uid: 1, title: 'L', keys: ['Лира'], protected: false }],
            }),
        ).toEqual([]);
    });

    it('checks forms of aliases too', () => {
        const issues = structuralIssues(
            input({
                known: ['Лисичка'],
                formsOf: (name) => (name === 'Лисичка' ? ['Лисичка', 'Лисички'] : [name]),
                entries: [{ world: 'W', uid: 2, title: 'L', keys: ['Лира', 'Лисичка'], protected: false }],
            }),
        );
        expect(issues.map((issue) => issue.params.key)).toEqual(['Лисичка']);
    });
});
