import { describe, expect, it, vi } from 'vitest';
import { createHostModules, ST_MODULE_PATHS } from '../../src/host/modules';
import { memoryLogger } from '../helpers/host-fakes';

const ORIGIN = 'http://127.0.0.1:8000';

describe('host modules', () => {
    it('imports ST modules by absolute URL and caches the promise', async () => {
        const importer = vi.fn(async (url: string) => ({ url }));
        const modules = createHostModules(memoryLogger(), importer, () => ORIGIN);
        const first = await modules.worldInfo();
        const second = await modules.worldInfo();
        expect(first).toBe(second);
        expect(first).toEqual({ url: `${ORIGIN}/scripts/world-info.js` });
        expect(importer).toHaveBeenCalledTimes(1);

        await modules.script();
        await modules.openai();
        await modules.presetManager();
        await modules.chats();
        await modules.regexEngine();
        await modules.utils();
        expect(importer.mock.calls.map(([url]) => url)).toEqual(
            Object.values(ST_MODULE_PATHS).map((path) => ORIGIN + path),
        );
    });

    it('load() accepts paths under /scripts/ in several spellings', async () => {
        const importer = vi.fn(async (url: string) => ({ url }));
        const modules = createHostModules(memoryLogger(), importer, () => ORIGIN);
        await modules.load('extensions.js');
        await modules.load('scripts/extensions.js');
        await modules.load('/scripts/extensions.js');
        expect(importer).toHaveBeenCalledTimes(1);
        expect(modules.url('popup.js')).toBe(`${ORIGIN}/scripts/popup.js`);
    });

    it('surfaces import errors to the caller and retries later', async () => {
        let fail = true;
        const importer = vi.fn(async (url: string) => {
            if (fail) throw new Error(`404 ${url}`);
            return { ok: true };
        });
        const log = memoryLogger();
        const modules = createHostModules(log, importer, () => ORIGIN);
        await expect(modules.chats()).rejects.toThrow('404');
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
        fail = false;
        await expect(modules.chats()).resolves.toEqual({ ok: true });
        expect(importer).toHaveBeenCalledTimes(2);
    });

    it('refuses modules from another origin', async () => {
        const importer = vi.fn(async () => ({}));
        const modules = createHostModules(memoryLogger(), importer, () => ORIGIN);
        await expect(modules.load('//evil.example/x.js')).rejects.toThrow('another origin');
        expect(importer).not.toHaveBeenCalled();
    });
});
