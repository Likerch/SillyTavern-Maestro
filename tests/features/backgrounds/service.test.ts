// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BOUND_SCORE,
    CHAT_BG_TARGET,
    GENERATE_KIND,
    PICK_KIND,
    POINTER,
    SET_KIND,
} from '../../../src/features/backgrounds';
import type { SetPayload } from '../../../src/features/backgrounds';
import { GLOBAL_URL, SETTLE, createBgEnv, proposalKinds, reply, url } from './helpers';
import type { BgEnv } from './helpers';

let env: BgEnv;

beforeEach(() => {
    vi.useFakeTimers();
    env = createBgEnv();
    env.library.push('tavern day.jpg', 'tavern night.jpg', 'landscape beach day.png', 'landscape beach night.jpg');
    env.library.push('bedroom clean.jpg', 'royal.jpg', '_black.jpg');
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const pointer = () =>
    ((env.mock.chatMetadata.maestro as { pointers?: Record<string, unknown> } | undefined)?.pointers?.[POINTER] ??
        null) as {
        url: string;
        choice: { file: string; source: string; manual?: boolean } | null;
        undone: unknown[];
    } | null;

/** Nothing that changes the GLOBAL background was touched. */
function expectGlobalUntouched(): void {
    expect(env.mock.saveSettingsCalls).toBe(0);
    expect(env.globalSettings).toEqual({ name: 'global.jpg', url: GLOBAL_URL });
    expect(env.slashCalls).toEqual([]);
    expect(env.mock.requests.some((request) => request.url.includes('/api/settings/save'))).toBe(false);
    expect(env.mock.chatMetadata.chat_backgrounds).toBeUndefined();
}

describe('automatic choice on entering a place', () => {
    it('sets the best library match as the CHAT background only, journaled with undo data', async () => {
        const tavern = env.places.add('Таверна «Ржавый якорь»');
        await env.start();
        await env.turn({ time: '12:00' });
        await env.enter(tavern.id);

        expect(env.live()).toBe(url('tavern day.jpg'));
        expect(env.layer().style.backgroundImage).toContain('tavern%20day.jpg');
        expect(env.metadataSaves).toBeGreaterThan(0);
        expectGlobalUntouched();
        expect(proposalKinds(env)).toEqual([SET_KIND]);
        const record = env.journal.records.at(-1)!;
        expect(record).toMatchObject({ module: 'backgrounds', kind: SET_KIND });
        expect(record.changes[0]).toMatchObject({
            target: CHAT_BG_TARGET,
            before: null,
            after: 'tavern day',
            ref: { chatId: 'chat-1', placeId: tavern.id, file: 'tavern day.jpg', beforeUrl: '', auto: true },
        });
        expect(env.service().current()).toEqual({
            placeId: tavern.id,
            file: 'tavern day.jpg',
            variant: ['day'],
            source: 'library',
            score: 4,
        });
        expect(pointer()).toMatchObject({ url: url('tavern day.jpg') });
        expect(env.service().userPinned()).toBe(false);
        expect(env.service().state().owner).toBe('maestro');
    });

    it('prefers the bound background and its variant for the time of day', async () => {
        const hall = env.places.add('Зал', { background: 'bedroom clean.jpg', state: { 'bg:night': 'royal.jpg' } });
        await env.start();
        await env.turn({ time: '13:00' });
        await env.enter(hall.id);
        expect(env.live()).toBe(url('bedroom clean.jpg'));
        expect(env.service().current()).toMatchObject({ source: 'user', score: BOUND_SCORE });

        await env.turn({ time: '23:00' });
        expect(env.live()).toBe(url('royal.jpg'));
        expect(env.service().current()).toMatchObject({ file: 'royal.jpg', variant: ['night'] });
        expectGlobalUntouched();
    });

    it('follows DES time changes through library siblings, and not when variants are off', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.turn({ time: '12:00' });
        await env.enter(tavern.id);
        expect(env.live()).toBe(url('tavern day.jpg'));
        await env.turn({ time: '22:30' });
        expect(env.live()).toBe(url('tavern night.jpg'));
        expect(env.journal.records).toHaveLength(2);
        await env.turn({ time: '23:00' });
        expect(env.journal.records).toHaveLength(2);

        // Variants off: time no longer matters (the two taverns tie, the first title wins), DES changes do nothing.
        env.slices.backgrounds!.variants = false;
        env.notifySettings('modules.backgrounds.variants');
        await env.tick(SETTLE);
        expect(env.live()).toBe(url('tavern day.jpg'));
        const count = env.journal.records.length;
        await env.turn({ time: '03:00' });
        expect(env.journal.records).toHaveLength(count);
    });

    it('does nothing below the threshold and offers generation in «Кино» only', async () => {
        env.library.splice(0, env.library.length, 'tavern day.jpg');
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.turn({ time: '23:00' });
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
        expect(env.service().state().noMatch).toBe(true);
        expect(env.ui.notices).toEqual([]);

        env.core.mode = 'cinema';
        const cave = env.places.add('Пещера');
        await env.enter(cave.id);
        expect(env.ui.notices).toHaveLength(1);
        expect(env.ui.notices[0]).toMatchObject({ text: expect.stringContaining('Пещера') as string });
        expect(env.ui.notices[0]!.options?.urgent).toBeFalsy();
        await env.enter(tavern.id);
        await env.enter(cave.id);
        expect(env.ui.notices.filter((notice) => notice.text.includes('Пещера'))).toHaveLength(1);
        // The notice action is the user's click: only then NAI Studio is asked.
        expect(env.nai.calls).toHaveLength(0);
        env.ui.notices[0]!.options!.action!.run();
        await env.tick(SETTLE);
        expect(env.nai.calls).toHaveLength(1);
    });

    it('leaves the background alone in a tab that is not the leader, and when auto is off', async () => {
        const tavern = env.places.add('Таверна');
        env.leader.value = false;
        await env.start();
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
        env.leader.value = true;
        env.slices.backgrounds!.auto = false;
        await env.enter(null);
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
        expect(env.autonomy.proposals).toHaveLength(0);
    });

    it('starts inside an open chat whose place is known', async () => {
        const tavern = env.places.add('Таверна');
        env.places.currentId = tavern.id;
        env.mock.chat.push(reply({ time: '10:00' }));
        await env.start();
        expect(env.live()).toBe(url('tavern day.jpg'));
    });
});

describe("the user's own background", () => {
    it('is never replaced: a chat background Maestro did not write counts as pinned', async () => {
        const tavern = env.places.add('Таверна');
        const beach = env.places.add('Пляж');
        await env.start();
        await env.enter(tavern.id);
        expect(env.live()).toBe(url('tavern day.jpg'));

        await env.userSets(url('bedroom clean.jpg'));
        expect(env.service().userPinned()).toBe(true);
        expect(env.service().current()).toBeNull();
        expect(env.service().state()).toMatchObject({ owner: 'user', pinned: true });
        await env.enter(beach.id);
        expect(env.live()).toBe(url('bedroom clean.jpg'));
        expectGlobalUntouched();
    });

    it("treats removing Maestro's background as the user's choice", async () => {
        const tavern = env.places.add('Таверна');
        const beach = env.places.add('Пляж');
        await env.start();
        await env.enter(tavern.id);
        await env.userSets('');
        expect(env.service().userPinned()).toBe(true);
        await env.enter(beach.id);
        expect(env.live()).toBe('');
    });

    it('is recognised in a chat that already had one before Maestro', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.switchTo('chat-2', { custom_background: 'url("user/images/mine.png")' });
        await env.enter(tavern.id);
        expect(env.live()).toBe('url("user/images/mine.png")');
        expect(env.service().userPinned()).toBe(true);
        expect(env.service().preview(env.live())).toBe('user/images/mine.png');
    });

    it('notices background changes on the layer and ST events', async () => {
        await env.start();
        const changes = vi.fn();
        env.service().onChange(changes);
        await env.userSets(url('royal.jpg'));
        expect(changes).toHaveBeenCalled();
        changes.mockClear();
        await env.mock.eventSource.emit('FORCE_SET_BACKGROUND', { url: 'url("x")', path: 'x' });
        await env.tick(10);
        expect(changes).toHaveBeenCalled();
    });

    it('«Снова выбирать самому» takes the background over and chooses again, even in a non-leader tab', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.userSets(url('bedroom clean.jpg'));
        await env.enter(tavern.id);
        expect(env.live()).toBe(url('bedroom clean.jpg'));
        env.leader.value = false;
        await env.service().release();
        await env.tick(SETTLE);
        expect(env.live()).toBe(url('tavern day.jpg'));
        expect(env.service().userPinned()).toBe(false);
        // Undo brings the user's background back — and it is the user's again.
        await env.journal.undo(env.journal.records.at(-1)!.id);
        expect(env.live()).toBe(url('bedroom clean.jpg'));
        expect(env.service().userPinned()).toBe(false);
    });
});

describe('autonomy and undo', () => {
    it('queues to the Inbox and applies the card later while it is still valid', async () => {
        env.autonomy.levels.set(SET_KIND, 'inbox');
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
        const proposal = env.autonomy.proposals.at(-1)!;
        const payload = JSON.parse(JSON.stringify(proposal.payload)) as SetPayload;
        expect(await env.inbox.validators.get(SET_KIND)!(payload)).toBe(true);
        await env.inbox.appliers.get(SET_KIND)!(payload);
        expect(env.live()).toBe(url('tavern day.jpg'));
        expect(env.service().current()?.file).toBe('tavern day.jpg');
        // The same card again: the background is not what it saw any more.
        expect(await env.inbox.validators.get(SET_KIND)!(payload)).toBe(false);
        await expect(env.inbox.appliers.get(SET_KIND)!(payload)).rejects.toThrow();
        await expect(env.inbox.appliers.get(SET_KIND)!({ junk: true })).rejects.toThrow();
        expect(await env.inbox.validators.get(SET_KIND)!('junk')).toBe(false);
    });

    it('skips when the kind is off', async () => {
        env.autonomy.levels.set(SET_KIND, 'off');
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
    });

    it('undo clears the chat background (the global one shows) and keeps that file away from the place', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        expect(await env.journal.undo(env.journal.records.at(-1)!.id)).toBe(true);
        await env.tick(10);
        expect(env.live()).toBe('');
        expect('custom_background' in env.mock.chatMetadata).toBe(false);
        expect(env.layer().style.backgroundImage).toContain('global.jpg');
        expect(env.service().userPinned()).toBe(false);
        expect(pointer()?.undone).toEqual([{ placeId: tavern.id, file: 'tavern day.jpg' }]);
        await env.enter(null);
        await env.enter(tavern.id);
        expect(env.live()).toBe('');
        expectGlobalUntouched();
    });

    it("undo restores the previous place's background and refuses after a later change", async () => {
        const tavern = env.places.add('Таверна');
        const beach = env.places.add('Пляж');
        await env.start();
        await env.turn({ time: '12:00' });
        await env.enter(tavern.id);
        await env.enter(beach.id);
        expect(env.live()).toBe(url('landscape beach day.png'));
        const [first, second] = env.journal.records;
        expect(await env.journal.undo(first!.id)).toBe(false);
        expect(await env.journal.undo(second!.id)).toBe(true);
        expect(env.live()).toBe(url('tavern day.jpg'));
        expect(env.service().current()?.file).toBe('tavern day.jpg');
        await env.userSets(url('royal.jpg'));
        expect(await env.journal.undo(first!.id)).toBe(false);
    });

    it('undo is refused in another chat', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        const record = env.journal.records.at(-1)!;
        await env.switchTo('chat-2');
        expect(await env.journal.undo(record.id)).toBe(false);
    });
});

describe('bind, unbind and pick', () => {
    it('binds the main background and a variant, shows it at once for the current place', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        await env.service().bind(tavern.id, 'royal.jpg');
        expect(env.places.updates.at(-1)).toEqual({ id: tavern.id, patch: { background: 'royal.jpg' } });
        expect(env.live()).toBe(url('royal.jpg'));
        expect(env.journal.records.at(-1)).toMatchObject({ kind: PICK_KIND });

        await env.service().bind(tavern.id, 'tavern night.jpg', ['night']);
        expect(env.places.get(tavern.id)?.state).toEqual({ 'bg:night': 'tavern night.jpg' });
        await env.turn({ time: '23:30' });
        expect(env.live()).toBe(url('tavern night.jpg'));

        await env.service().unbind(tavern.id, ['night']);
        expect(env.places.get(tavern.id)?.state).toEqual({});
        await env.service().unbind(tavern.id);
        expect(env.places.get(tavern.id)?.background).toBeUndefined();
        await expect(env.service().bind(tavern.id, 'x.jpg', ['lava'])).rejects.toThrow(/variant/i);
        await expect(env.service().bind('nope', 'x.jpg')).rejects.toThrow();
        await expect(env.service().unbind('nope')).rejects.toThrow();
    });

    it('binds without changing the user’s own background', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.userSets(url('bedroom clean.jpg'));
        await env.enter(tavern.id);
        await env.service().bind(tavern.id, 'royal.jpg');
        expect(env.places.get(tavern.id)?.background).toBe('royal.jpg');
        expect(env.live()).toBe(url('bedroom clean.jpg'));
    });

    it('a pick stays while the scene stays in that place', async () => {
        const tavern = env.places.add('Таверна');
        const beach = env.places.add('Пляж');
        await env.start();
        await env.turn({ time: '12:00' });
        await env.enter(tavern.id);
        await env.service().pick(tavern.id, 'royal.jpg');
        expect(env.live()).toBe(url('royal.jpg'));
        expect(pointer()?.choice).toMatchObject({ file: 'royal.jpg', manual: true, source: 'user' });
        expect(env.journal.records.at(-1)).toMatchObject({ kind: PICK_KIND });
        await env.turn({ time: '23:00' });
        expect(env.live()).toBe(url('royal.jpg'));
        await env.enter(beach.id);
        expect(env.live()).toBe(url('landscape beach night.jpg'));
        // Picking what is already on only records it.
        const count = env.journal.records.length;
        await env.service().pick(beach.id, 'landscape beach night.jpg');
        expect(env.journal.records).toHaveLength(count);
    });

    it('fails without the place registry or a chat', async () => {
        await env.start();
        env.modules.apis.delete('places');
        await expect(env.service().bind('p1', 'x.jpg')).rejects.toThrow(/Places/);
        await expect(env.service().unbind('p1')).rejects.toThrow(/Places/);
        expect(env.service().places()).toEqual([]);
        expect(env.service().hasPlaces()).toBe(false);
        await env.switchTo(undefined);
        await expect(env.service().pick('p1', 'x.jpg')).rejects.toThrow();
        expect(env.service().current()).toBeNull();
        expect(env.service().userPinned()).toBe(false);
        await env.service().release();
    });
});

describe('candidates and the library', () => {
    it('lists the bound background first, then library matches, and reads folders', async () => {
        env.library.push('IMG_7.png');
        env.folders.push({ id: 'f1', name: 'Taverns', files: ['IMG_7.png'] });
        const tavern = env.places.add('Таверна', { background: 'royal.jpg' });
        await env.start();
        await env.turn({ time: '22:00' });
        const list = await env.service().candidates(tavern.id);
        expect(list[0]).toMatchObject({ file: 'royal.jpg', source: 'user', score: BOUND_SCORE });
        expect(list.map((choice) => choice.file)).toEqual([
            'royal.jpg',
            'tavern night.jpg',
            'IMG_7.png',
            'tavern day.jpg',
        ]);
        expect(await env.service().candidates(tavern.id, 2)).toHaveLength(2);
        expect(await env.service().candidates('nope')).toEqual([]);
        expect(env.service().libraryInfo()).toEqual({ count: 7, ok: true });
        expect(env.service().inLibrary('royal.jpg')).toBe(true);
        expect(env.service().inLibrary('gone.jpg')).toBe(false);
        expect(env.service().thumbnail('a b.jpg')).toBe('/thumbnail?type=bg&file=a%20b.jpg');
    });

    it('reads the library once per session, retries a failure and refreshes on demand', async () => {
        const tavern = env.places.add('Таверна');
        env.listFails = true;
        await env.start();
        expect(await env.service().candidates(tavern.id)).toEqual([]);
        expect(env.service().libraryInfo()).toBeNull();
        expect(env.service().inLibrary('x')).toBeNull();
        env.listFails = false;
        await env.service().candidates(tavern.id);
        await env.service().candidates(tavern.id);
        const calls = env.listCalls;
        env.library.push('tavern rain.jpg');
        await env.service().refreshLibrary();
        expect(env.listCalls).toBe(calls + 1);
        expect(env.service().libraryInfo()?.count).toBe(7);
    });

    it('skips a bound file that left the library and falls back to a match', async () => {
        const tavern = env.places.add('Таверна', { background: 'deleted.jpg' });
        await env.start();
        await env.enter(tavern.id);
        expect(env.live()).toBe(url('tavern day.jpg'));
    });

    it('describes the scene from DES and the place path', async () => {
        const city = env.places.add('Порт-Ройал');
        const tavern = env.places.add('Таверна', { parent: city.id });
        await env.start();
        await env.turn({ time: '21:30', weather: 'Ливень', date: '3 января' });
        await env.enter(tavern.id);
        expect(env.service().state()).toMatchObject({
            placePath: ['Порт-Ройал', 'Таверна'],
            conditions: { time: 'night', weather: ['rain'], season: 'winter' },
        });
        expect(env.service().conditions().time).toBe('night');
    });
});

describe('generation', () => {
    it('asks NAI Studio, binds the new file to the place and sets it', async () => {
        const cave = env.places.add('Пещера', { passportId: 'loc-1' });
        await env.start();
        await env.turn({ time: '23:00', weather: 'Rain' });
        await env.enter(cave.id);
        expect(env.live()).toBe('');
        const choice = await env.service().generate(cave.id);
        expect(env.nai.calls).toEqual([
            {
                locationName: 'Пещера',
                tags: 'cave, night, rain',
                passportId: 'loc-1',
                timeOfDay: 'night',
                weather: 'rain',
            },
        ]);
        expect(choice).toMatchObject({ placeId: cave.id, source: 'generated', score: BOUND_SCORE, variant: [] });
        const file = choice!.file;
        expect(env.places.get(cave.id)?.background).toBe(file);
        expect(env.live()).toBe(url(file));
        expect(env.journal.records.at(-1)).toMatchObject({ kind: GENERATE_KIND });
        expect(env.service().current()).toMatchObject({ file, source: 'generated' });
        expect(env.ui.notices.at(-1)?.text).toContain('Пещера');
        expectGlobalUntouched();

        // A second one is bound as the variant for the scene now.
        const again = await env.service().generate(cave.id);
        expect(again?.variant).toEqual(['night', 'rain']);
        expect(env.places.get(cave.id)?.state).toEqual({ 'bg:night+rain': again!.file });
        expect(env.places.get(cave.id)?.background).toBe(file);
    });

    it('refuses with a message when free-only mode would have to spend Anlas', async () => {
        const cave = env.places.add('Пещера');
        await env.start();
        env.nai.respond = async (input) => {
            env.nai.fail({ request: 'background', name: input.locationName, code: 'free-only-blocked', message: 'x' });
            return null;
        };
        expect(await env.service().generate(cave.id)).toBeNull();
        expect(env.ui.notices.at(-1)?.text).toMatch(/free only/i);
        expect(env.places.updates).toEqual([]);

        env.nai.respond = async () => {
            env.nai.fail({ request: 'background', name: 'Пещера', code: 'aborted', message: 'declined' });
            return null;
        };
        const before = env.ui.notices.length;
        expect(await env.service().generate(cave.id)).toBeNull();
        expect(env.ui.notices).toHaveLength(before);

        env.nai.respond = async () => {
            env.nai.fail({ request: 'passport', name: 'x', code: 'boom', message: 'other request' });
            env.nai.fail({ request: 'background', name: 'Пещера', code: 'http', message: 'NovelAI is down' });
            return null;
        };
        await env.service().generate(cave.id);
        expect(env.ui.notices.at(-1)?.text).toContain('NovelAI is down');

        env.nai.respond = async () => {
            throw Object.assign(new Error('free-only-blocked'), { code: 'free-only-blocked' });
        };
        await env.service().generate(cave.id);
        expect(env.ui.notices.at(-1)?.text).toMatch(/free only/i);

        env.nai.respond = async () => {
            throw new Error('network');
        };
        await env.service().generate(cave.id);
        expect(env.ui.notices.at(-1)?.text).toContain('network');

        env.nai.respond = async () => null;
        await env.service().generate(cave.id);
        expect(env.ui.notices.at(-1)?.text).toMatch(/no picture/i);
        expect(env.places.updates).toEqual([]);
        expect(env.live()).toBe('');
    });

    it('reports when NAI Studio cannot draw backgrounds, and the Anlas budget', async () => {
        const cave = env.places.add('Пещера');
        await env.start();
        expect(env.service().canGenerate()).toBe(true);
        expect(env.service().budget()).toBe('free');
        env.nai.naiSettings = { anlas: { freeOnly: false } };
        expect(env.service().budget()).toBe('paid');
        env.nai.naiSettings = null;
        expect(env.service().budget()).toBe('unknown');
        env.nai.hasApi = false;
        expect(env.service().canGenerate()).toBe(false);
        expect(await env.service().generate(cave.id)).toBeNull();
        expect(env.ui.notices.at(-1)?.text).toMatch(/cannot generate/i);
        env.nai.hasApi = true;
        env.nai.isPresent = false;
        expect(env.service().canGenerate()).toBe(false);
        env.nai.isPresent = true;
        expect(await env.service().generate('nope')).toBeNull();
        expect(env.nai.calls).toEqual([]);
    });

    it("binds but keeps the user's own background", async () => {
        const cave = env.places.add('Пещера');
        await env.start();
        await env.userSets(url('bedroom clean.jpg'));
        await env.enter(cave.id);
        const choice = await env.service().generate(cave.id);
        expect(env.places.get(cave.id)?.background).toBe(choice!.file);
        expect(env.live()).toBe(url('bedroom clean.jpg'));
        expect(env.ui.notices.some((notice) => /your own chat background/i.test(notice.text))).toBe(true);
    });
});

describe('module', () => {
    it('registers its tab, style, capability and API, and leaves no trace when disabled', async () => {
        await env.start();
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['backgrounds', 'm29.tab', 62]]);
        expect(env.ui.styles.has('maestro-m29')).toBe(true);
        expect(env.caps).toContain('st.backgrounds');
        expect(env.modules.api('backgrounds')).toBeDefined();
        expect(await env.service().door.probe()).toBe(true);
        expect(await env.service().door.globalUrl()).toBe(GLOBAL_URL);
        await env.stop();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        expect(env.inbox.appliers.size).toBe(0);
        expect(env.places.enterListeners.size).toBe(0);
    });
});
