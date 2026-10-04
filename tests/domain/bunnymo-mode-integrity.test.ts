import { describe, expect, it } from 'vitest';
import {
    ckWrapperName,
    hasNestedWrapper,
    integrityFindings,
    isCkWrapped,
    stripCkWrappers,
    wrapFacts,
} from '../../src/domain/bunnymo-mode-integrity';
import type { IntegrityFacts } from '../../src/domain/bunnymo-mode-integrity';
import type { UidEntry } from '../../src/domain/bunnymo-mode-tags';

/** CK index.js wrapLorebookEntries. */
function ckWrap(entry: { comment?: string; key?: string[]; content: string }): string {
    const name = (entry.comment || entry.key?.[0] || 'Entry').replace(/[<>]/g, '');
    return `<BunnymoTags:${name}>\n${entry.content}\n</BunnymoTags:${name}>`;
}

const uidEntries = (entries: Record<string, unknown>[]): UidEntry[] =>
    entries.map((entry, index) => ({ uid: Number(entry.uid ?? index), entry }));

function facts(patch: Partial<IntegrityFacts> = {}): IntegrityFacts {
    return {
        books: [],
        global: [],
        cores: [],
        packs: [],
        ckRepos: [],
        wraps: [],
        isCanon: (book) => book.startsWith('Maestro · канон'),
        chatBooks: [],
        ...patch,
    };
}

describe('CK wrappers', () => {
    it('names and recognises CK wrappers like CK does', () => {
        expect(ckWrapperName({ comment: '<Elf>' })).toBe('Elf');
        expect(ckWrapperName({ key: ['<ELF>'] })).toBe('ELF');
        expect(ckWrapperName({})).toBe('Entry');
        const entry = { comment: 'Elf', content: ckWrap({ comment: 'Elf', content: 'Text' }) };
        expect(isCkWrapped(entry)).toBe(true);
        expect(isCkWrapped({ comment: 'Elf', content: 'Text' })).toBe(false);
        expect(isCkWrapped({ comment: 'Elf' })).toBe(false);
    });

    it('strips wrappers, nested ones included', () => {
        const once = ckWrap({ comment: 'Elf', content: 'Text' });
        const twice = ckWrap({ comment: 'Эльф', content: once });
        expect(stripCkWrappers(once)).toBe('Text');
        expect(stripCkWrappers(twice)).toBe('Text');
        expect(stripCkWrappers('<BunnymoTags:Elf>\nText')).toBe('<BunnymoTags:Elf>\nText');
        expect(hasNestedWrapper(twice)).toBe(true);
        expect(hasNestedWrapper(once)).toBe(false);
        expect(hasNestedWrapper(undefined)).toBe(false);
    });

    it('finds entries CK rewrote compared with the .carrot_backup copy', () => {
        const original = [
            { uid: 1, comment: 'A', content: 'Alpha' },
            { uid: 2, comment: 'B', content: 'Beta' },
            { uid: 3, comment: 'C', content: 'Gamma' },
        ];
        const current = [
            { uid: 1, comment: 'A', content: ckWrap({ comment: 'A', content: 'Alpha' }) },
            { uid: 2, comment: 'B', content: 'Beta, edited by hand' },
            { uid: 3, comment: 'C', content: 'Gamma' },
            { uid: 4, comment: 'D', content: 'New' },
        ];
        const result = wrapFacts('World', uidEntries(current), uidEntries(original), {
            tagLibrary: false,
            wrapping: true,
            bunnymo: false,
        });
        expect(result).toEqual({ book: 'World', rewritten: 1, nested: 0, pending: false, bunnymo: false });
    });

    it('reports double wrappers and pending rewrites of Tag Libraries', () => {
        const nested = {
            uid: 1,
            comment: 'Новое имя',
            content: ckWrap({ comment: 'Новое имя', content: ckWrap({ comment: 'Old', content: 'x' }) }),
        };
        const plain = { uid: 2, comment: 'Plain', content: 'not wrapped' };
        const empty = { uid: 3, comment: 'Empty', content: '   ' };
        const result = wrapFacts('Pack', uidEntries([nested, plain, empty]), null, {
            tagLibrary: true,
            wrapping: true,
            bunnymo: true,
        });
        expect(result).toEqual({ book: 'Pack', rewritten: 0, nested: 1, pending: true, bunnymo: true });
        expect(
            wrapFacts('Pack', uidEntries([plain]), null, { tagLibrary: true, wrapping: false, bunnymo: true }).pending,
        ).toBe(false);
        // Shipped packs are already wrapped: nothing is pending.
        const shipped = { uid: 1, comment: 'Erotic', content: ckWrap({ comment: 'Erotic', content: 'x' }) };
        expect(
            wrapFacts('Pack', uidEntries([shipped]), null, { tagLibrary: true, wrapping: true, bunnymo: true }).pending,
        ).toBe(false);
    });
});

describe('integrityFindings', () => {
    it('is quiet when nothing is wrong', () => {
        expect(integrityFindings(facts())).toEqual([]);
        expect(
            integrityFindings(
                facts({
                    cores: [{ book: 'Core', active: true, named: '3.0', detected: '3.0' }],
                    packs: [{ book: 'Pack', active: true }],
                }),
            ),
        ).toEqual([]);
    });

    it('reports packs without an active core', () => {
        expect(
            integrityFindings(
                facts({
                    packs: [
                        { book: 'P', active: true },
                        { book: 'Q', active: false },
                    ],
                }),
            ),
        ).toEqual([{ kind: 'coreMissing', variant: 'absent', params: { count: 1 } }]);
        expect(
            integrityFindings(
                facts({
                    cores: [{ book: 'Core', active: false, named: null, detected: '3.0' }],
                    packs: [{ book: 'P', active: true }],
                }),
            ),
        ).toEqual([{ kind: 'coreMissing', variant: 'inactive', book: 'Core', params: { book: 'Core', count: 1 } }]);
    });

    it('reports old and doubled cores', () => {
        const items = integrityFindings(
            facts({
                cores: [
                    { book: 'V3', active: true, named: '3.0', detected: '3.0' },
                    { book: 'V2.8', active: true, named: '2.8', detected: '2.7' },
                ],
            }),
        );
        expect(items).toEqual([
            { kind: 'coreVersion', variant: 'several', params: { books: 'V3, V2.8' } },
            {
                kind: 'coreVersion',
                variant: 'old',
                book: 'V2.8',
                params: { book: 'V2.8', version: '2.7', expected: '3.0' },
            },
        ]);
    });

    it('reports BunnyMo books marked as CK repos', () => {
        const items = integrityFindings(
            facts({
                cores: [{ book: 'Core', active: true, named: null, detected: '3.0' }],
                packs: [{ book: 'Pack', active: false }],
                ckRepos: ['Core', 'Characters', 'Pack'],
            }),
        );
        expect(items.map((item) => [item.kind, item.book])).toEqual([
            ['packAsRepo', 'Core'],
            ['packAsRepo', 'Pack'],
        ]);
    });

    it('reports CK rewrites (packs and other books) and backups', () => {
        const items = integrityFindings(
            facts({
                books: ['Pack', 'Pack.carrot_backup', 'Gone.carrot_backup', 'World'],
                wraps: [
                    { book: 'Pack', rewritten: 3, nested: 1, pending: true, bunnymo: true },
                    { book: 'World', rewritten: 2, nested: 0, pending: false, bunnymo: false },
                ],
            }),
        );
        expect(items.map((item) => `${item.kind}.${item.variant}:${item.book}`)).toEqual([
            'ckWrapRewrite.backupPack:Pack',
            'ckWrapRewrite.nestedPack:Pack',
            'ckWrapRewrite.pendingPack:Pack',
            'ckWrapRewrite.backup:World',
            'ckBackup.copy:Pack.carrot_backup',
            'ckBackup.orphan:Gone.carrot_backup',
        ]);
        expect(items[0]?.params).toEqual({ book: 'Pack', count: 3 });
        expect(items[4]?.params).toEqual({ book: 'Pack.carrot_backup', original: 'Pack' });
    });

    it('reports canon and chat books switched on globally', () => {
        const items = integrityFindings(
            facts({ global: ['Maestro · канон · abc', 'Chat book', 'World'], chatBooks: ['Chat book'] }),
        );
        expect(items).toEqual([
            {
                kind: 'canonGlobal',
                variant: 'global',
                book: 'Maestro · канон · abc',
                params: { book: 'Maestro · канон · abc' },
            },
            { kind: 'chatBookGlobal', variant: 'global', book: 'Chat book', params: { book: 'Chat book' } },
        ]);
    });
});
