import { describe, expect, it } from 'vitest';
import { bodyHash } from '../../src/domain/preset-store-diff';
import {
    BLOB_MIN_CHARS,
    DRAFT_BY,
    VERSIONS_SCHEMA,
    appendVersion,
    makeVersion,
    makeVersionId,
    newestFileState,
    packVersionsDoc,
    readVersionsDoc,
} from '../../src/domain/preset-store-versions';
import type { StoredVersion } from '../../src/domain/preset-store-versions';

function version(temperature: number, by = 'user', at = temperature * 10): StoredVersion {
    return makeVersion({ temperature, proxy_password: 'secret' }, { at, by, summary: `t=${temperature}` });
}

describe('versions', () => {
    it('makes entries without secrets, with a hash and an id', () => {
        const entry = version(1);
        expect(entry.body).toEqual({ temperature: 1 });
        expect(entry.hash).toBe(bodyHash({ temperature: 1 }));
        expect(entry.id).toMatch(/^v-a-[0-9a-z]+$/);
        expect(makeVersionId(1, 'x')).not.toBe(makeVersionId(1, 'y'));
    });

    it('appends unless the body repeats the newest file state; drafts compare with the newest entry too', () => {
        let versions = appendVersion([], version(1)).versions;
        const same = appendVersion(versions, version(1, 'st'));
        expect(same.added).toBe(false);
        expect(same.holder).toBe(versions[0]);
        versions = appendVersion(versions, version(2, DRAFT_BY)).versions;
        expect(newestFileState(versions)?.body.temperature).toBe(1);
        expect(appendVersion(versions, version(2, DRAFT_BY)).added).toBe(false);
        expect(appendVersion(versions, version(1, DRAFT_BY)).added).toBe(false);
        // The file state after a draft is compared with the newest file state, not with the draft.
        expect(appendVersion(versions, version(1, 'st')).added).toBe(false);
        expect(appendVersion(versions, version(2, 'st')).added).toBe(true);
        expect(newestFileState([version(3, DRAFT_BY)])).toBeNull();
    });

    it('keeps the newest entries within the limit', () => {
        let versions: StoredVersion[] = [];
        for (let i = 1; i <= 5; i++) versions = appendVersion(versions, version(i), 3).versions;
        expect(versions.map((entry) => entry.body.temperature)).toEqual([3, 4, 5]);
    });
});

describe('file packing', () => {
    const long = 'x'.repeat(BLOB_MIN_CHARS);
    const bodyWith = (content: string) => ({
        prompts: [{ identifier: 'a', content }, { identifier: 'b', content: 'short' }, 'odd'],
    });

    it('stores long prompt texts once and reads them back', () => {
        const versions = [
            makeVersion(bodyWith(long), { at: 1, by: 'user', summary: '' }),
            makeVersion({ ...bodyWith(long), temperature: 2 }, { at: 2, by: 'user', summary: '' }),
            makeVersion({ temperature: 3 }, { at: 3, by: 'st', summary: '' }),
        ];
        const doc = packVersionsDoc('Preset', versions);
        expect(doc.schema).toBe(VERSIONS_SCHEMA);
        expect(Object.values(doc.blobs)).toEqual([long]);
        expect(JSON.stringify(doc).split(long).length - 1).toBe(1);
        const read = readVersionsDoc(JSON.parse(JSON.stringify(doc)));
        expect(read?.name).toBe('Preset');
        expect(read?.versions).toEqual(versions);
    });

    it('drops broken entries and rejects foreign files', () => {
        expect(readVersionsDoc(null)).toBeNull();
        expect(readVersionsDoc({ schema: 2, versions: [] })).toBeNull();
        const read = readVersionsDoc({
            schema: VERSIONS_SCHEMA,
            versions: [
                { id: 'v1', body: { prompts: [{ content: { $blob: 'missing' } }] } },
                { id: 'v2', body: { temperature: 1 } },
                { body: {} },
                'junk',
            ],
            blobs: { k: 'text', bad: 1 },
        });
        expect(read?.name).toBe('');
        expect(read?.versions).toEqual([
            { id: 'v2', at: 0, by: 'st', summary: '', hash: bodyHash({ temperature: 1 }), body: { temperature: 1 } },
        ]);
    });

    it('keeps different texts under different keys', () => {
        const a = 'a'.repeat(BLOB_MIN_CHARS);
        const versions = [
            makeVersion(bodyWith(a), { at: 1, by: 'user', summary: '' }),
            makeVersion(bodyWith('b'.repeat(BLOB_MIN_CHARS)), { at: 2, by: 'user', summary: '' }),
        ];
        const packed = packVersionsDoc('P', versions);
        expect(Object.keys(packed.blobs)).toHaveLength(2);
        expect(readVersionsDoc(packed)?.versions).toEqual(versions);
    });
});
