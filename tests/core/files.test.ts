import { beforeEach, describe, expect, it } from 'vitest';
import {
    assertFileName,
    createFileStore,
    currentTabId,
    makeFileName,
    readFresh,
    utf8ToBase64,
} from '../../src/core/files';
import type { MaestroFileStore } from '../../src/core/files';
import { stableHash } from '../../src/domain/hash';
import type { FileStore } from '../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let files: MaestroFileStore;

beforeEach(() => {
    mock = installStMock();
    files = createFileStore(createTestHost(mock), createTestLogger());
});

describe('file names', () => {
    it('builds maestro-<kind>[-<hash>].json', () => {
        expect(makeFileName('tasks')).toBe('maestro-tasks.json');
        expect(makeFileName('lock', 'chat-1')).toBe(`maestro-lock-${stableHash('chat-1')}.json`);
        expect(files.fileName('lock', 'chat-1')).toBe(makeFileName('lock', 'chat-1'));
    });

    it('sanitises kinds and does not double the prefix', () => {
        expect(makeFileName('m1.lore journal')).toBe('maestro-m1_lore_journal.json');
        expect(makeFileName('maestro-tasks')).toBe('maestro-tasks.json');
        expect(makeFileName('')).toBe('maestro-file.json');
        expect(makeFileName('Анна')).toMatch(/^maestro-[A-Za-z0-9_.-]+\.json$/);
    });

    it('rejects names ST would refuse or that lack the prefix', () => {
        expect(() => assertFileName('tasks.json')).toThrow(/maestro-/);
        expect(() => assertFileName('maestro-a b.json')).toThrow(/invalid/);
        expect(() => assertFileName('maestro-../x.json')).toThrow(/invalid/);
        expect(() => assertFileName('maestro-Анна.json')).toThrow(/invalid/);
        expect(() => assertFileName(`maestro-${'x'.repeat(300)}.json`)).toThrow(/invalid/);
        expect(() => assertFileName('maestro-ok_name-1.json')).not.toThrow();
    });
});

describe('utf8ToBase64', () => {
    it('encodes UTF-8 bytes, not Latin-1', () => {
        const text = '{"name":"Анна","note":"🎻 «ёж»"}';
        expect(Buffer.from(utf8ToBase64(text), 'base64').toString('utf8')).toBe(text);
        expect(utf8ToBase64('')).toBe('');
    });

    it('handles large texts (chunked conversion)', () => {
        const text = 'Ж'.repeat(100_000);
        expect(Buffer.from(utf8ToBase64(text), 'base64').toString('utf8')).toBe(text);
    });
});

describe('createFileStore', () => {
    it('writes through /api/files/upload and reads back through /user/files', async () => {
        await files.write('maestro-test.json', { name: 'Анна', list: [1, 2] });
        expect(JSON.parse(mock.files.get('maestro-test.json')!)).toEqual({ name: 'Анна', list: [1, 2] });
        const upload = mock.requests.find((request) => request.url === '/api/files/upload');
        expect(upload?.init?.method).toBe('POST');
        expect(JSON.parse(String(upload?.init?.body))).toMatchObject({ name: 'maestro-test.json' });

        files.invalidate();
        expect(await files.read('maestro-test.json')).toEqual({ name: 'Анна', list: [1, 2] });
        const read = mock.requests.at(-1)!;
        expect(read.url).toBe('/user/files/maestro-test.json');
        expect(read.init?.cache).toBe('no-store');
        expect(read.init?.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('returns null for a missing file', async () => {
        expect(await files.read('maestro-none.json')).toBeNull();
    });

    it('serves repeated reads from the cache, fresh reads from the server', async () => {
        mock.files.set('maestro-a.json', '{"v":1}');
        expect(await files.read('maestro-a.json')).toEqual({ v: 1 });
        const count = mock.requests.length;
        mock.files.set('maestro-a.json', '{"v":2}');
        expect(await files.read('maestro-a.json')).toEqual({ v: 1 });
        expect(mock.requests.length).toBe(count);
        expect(await files.read('maestro-a.json', { fresh: true })).toEqual({ v: 2 });
        expect(await readFresh(files, 'maestro-a.json')).toEqual({ v: 2 });
    });

    it('returns independent copies from the cache', async () => {
        await files.write('maestro-a.json', { list: [1] });
        const first = await files.read<{ list: number[] }>('maestro-a.json');
        first!.list.push(2);
        expect(await files.read('maestro-a.json')).toEqual({ list: [1] });
    });

    it('removes through /api/files/delete with a user-root relative path', async () => {
        await files.write('maestro-gone.json', { x: 1 });
        await files.remove('maestro-gone.json');
        const request = mock.requests.find((item) => item.url === '/api/files/delete');
        expect(JSON.parse(String(request?.init?.body))).toEqual({ path: '/user/files/maestro-gone.json' });
        expect(mock.files.has('maestro-gone.json')).toBe(false);
        expect(await files.read('maestro-gone.json')).toBeNull();
    });

    it('treats a 404 on delete as success', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = async () => new Response('File not found', { status: 404 });
        await expect(files.remove('maestro-x.json')).resolves.toBeUndefined();
        globalThis.fetch = original;
    });

    it('throws on server errors and does not cache failed writes', async () => {
        await files.write('maestro-a.json', { v: 1 });
        const original = globalThis.fetch;
        globalThis.fetch = async () => new Response('boom', { status: 500 });
        await expect(files.write('maestro-a.json', { v: 2 })).rejects.toThrow(/HTTP 500/);
        await expect(files.read('maestro-b.json')).rejects.toThrow(/HTTP 500/);
        globalThis.fetch = original;
        expect(await files.read('maestro-a.json')).toEqual({ v: 1 });
    });

    it('treats invalid JSON as absent with a warning', async () => {
        const log = createTestLogger();
        const store = createFileStore(createTestHost(mock), log);
        mock.files.set('maestro-bad.json', '{oops');
        expect(await store.read('maestro-bad.json')).toBeNull();
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    it('rejects invalid names before any request', async () => {
        await expect(files.write('bad name.json', {})).rejects.toThrow();
        await expect(files.read('other.json')).rejects.toThrow();
        expect(mock.requests).toHaveLength(0);
    });

    it('keeps writes of one file in order', async () => {
        const order: number[] = [];
        const original = globalThis.fetch;
        let delay = 30;
        globalThis.fetch = async (input, init) => {
            const body = JSON.parse(String(init?.body)) as { data: string };
            const value = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')) as { n: number };
            const wait = delay;
            delay = 0;
            await new Promise((resolve) => setTimeout(resolve, wait));
            order.push(value.n);
            return original(input, init);
        };
        await Promise.all([files.write('maestro-o.json', { n: 1 }), files.write('maestro-o.json', { n: 2 })]);
        globalThis.fetch = original;
        expect(order).toEqual([1, 2]);
        expect(JSON.parse(mock.files.get('maestro-o.json')!)).toEqual({ n: 2 });
    });

    it('works with any FileStore in readFresh', async () => {
        const plain: FileStore = {
            read: async <T>() => ({ plain: true }) as T,
            write: async () => {},
            remove: async () => {},
            fileName: (kind) => `maestro-${kind}.json`,
        };
        expect(await readFresh(plain, 'maestro-x.json')).toEqual({ plain: true });
    });

    it('has a stable tab id', () => {
        expect(currentTabId()).toBe(currentTabId());
        expect(currentTabId()).toMatch(/^t[0-9a-z]+$/);
    });
});
