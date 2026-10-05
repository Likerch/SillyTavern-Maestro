// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBackground } from '../../../src/features/backgrounds/st-background';
import { GLOBAL_URL, createBgEnv, url } from './helpers';
import type { BgEnv } from './helpers';

let env: BgEnv;
let door: ChatBackground;

beforeEach(() => {
    vi.useFakeTimers();
    env = createBgEnv();
    door = new ChatBackground(env.app, env.app.log);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ChatBackground (ST 1.19 chat background path)', () => {
    it('sets and clears only chat metadata and the #bg1 layer', async () => {
        door.set(url('a.jpg'));
        expect(env.mock.chatMetadata.custom_background).toBe(url('a.jpg'));
        expect(env.layer().style.backgroundImage).toContain('a.jpg');
        expect(env.metadataSaves).toBe(1);
        await door.clear();
        expect('custom_background' in env.mock.chatMetadata).toBe(false);
        expect(env.layer().style.backgroundImage).toContain('global.jpg');
        expect(env.mock.saveSettingsCalls).toBe(0);
        expect(env.slashCalls).toEqual([]);
    });

    it('falls back to the last global background seen and to saveMetadata()', async () => {
        env.host.modules.load = async () => {
            throw new Error('no module');
        };
        const context = env.mock.context as unknown as Record<string, unknown>;
        delete context.saveMetadataDebounced;
        const saveMetadata = vi.fn(async () => {});
        context.saveMetadata = saveMetadata;
        const off = door.observe(() => {});
        door.set(url('a.jpg'));
        expect(saveMetadata).toHaveBeenCalledTimes(1);
        await door.clear();
        expect(env.layer().style.backgroundImage).toContain('global.jpg');
        expect(await door.probe()).toBe(false);
        off();
        // Never seen and no module: the layer is just cleared.
        const fresh = new ChatBackground(env.app, env.app.log);
        fresh.set(url('b.jpg'));
        await fresh.clear();
        expect(env.layer().style.backgroundImage).toBe('');
    });

    it('does not paint over a chat background set while clearing', async () => {
        door.set(url('a.jpg'));
        const clearing = door.clear();
        env.mock.chatMetadata.custom_background = url('user.jpg');
        await clearing;
        expect(env.layer().style.backgroundImage).toContain('a.jpg');
    });

    it('works without the #bg1 layer', async () => {
        document.getElementById('bg1')?.remove();
        expect(door.observe(() => {})).toBeTypeOf('function');
        door.set(url('a.jpg'));
        await door.clear();
        expect(door.live()).toBe('');
    });

    it('previews library files by thumbnail and other images by path', () => {
        expect(door.preview(url('a b.jpg'))).toBe('/thumbnail?type=bg&file=a%20b.jpg');
        expect(door.preview('url("user/images/x.png")')).toBe('user/images/x.png');
        expect(door.preview('url("javascript:alert(1)")')).toBeNull();
        expect(door.preview('none')).toBeNull();
        delete (env.mock.context as unknown as Record<string, unknown>).getThumbnailUrl;
        expect(door.thumbnail('c.jpg')).toBe('/thumbnail?type=bg&file=c.jpg');
    });

    it('reads the library and tolerates odd answers', async () => {
        env.library.push('a.jpg', 'b.jpg');
        env.folders.push(
            { id: 'f1', name: 'Taverns', files: ['a.jpg'] },
            { id: 'f2', name: 'Night', files: ['a.jpg'] },
        );
        expect(await door.list()).toEqual([
            { file: 'a.jpg', folders: ['Taverns', 'Night'] },
            { file: 'b.jpg', folders: [] },
        ]);
        env.listFails = true;
        expect(await door.list()).toBeNull();
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const address = String(input);
            if (address.includes('/all'))
                return new Response(JSON.stringify({ images: ['c.jpg', { filename: 'd.jpg' }, 5] }));
            return new Response('not json');
        }) as typeof fetch;
        expect(await door.list()).toEqual([
            { file: 'c.jpg', folders: [] },
            { file: 'd.jpg', folders: [] },
        ]);
        globalThis.fetch = (async () => new Response(JSON.stringify({ images: 'x' }))) as typeof fetch;
        expect(await door.list()).toBeNull();
        globalThis.fetch = (async () => {
            throw new Error('offline');
        }) as typeof fetch;
        expect(await door.list()).toBeNull();
        globalThis.fetch = realFetch;
        expect(GLOBAL_URL).toContain('global.jpg');
    });
});
