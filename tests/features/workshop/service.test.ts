// @vitest-environment happy-dom
// M42 «Мастерская» over the ST mock: a card with a workshop tag pauses Maestro's story modules in its chats (and only
// there), says so, switches Qvink off for the chat (and back when the card leaves the workshop), cuts every
// extension's text but ST's own out of the outgoing prompt and drops the global lore; the card's tag is set and
// removed through ST's /tag-add and /tag-remove, journaled with undo; MAESTRO_API-facing state and the slash command.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { WORKSHOP_KEEPS, workshopModule } from '../../../src/features/workshop';
import type { WorkshopApi } from '../../../src/features/workshop';
import { workshopCommand } from '../../../src/features/workshop/index';
import { QVINK_POINTER, WORKSHOP_CARD_KIND, WORKSHOP_QVINK_KIND } from '../../../src/features/workshop/service';
import type { WorkshopService } from '../../../src/features/workshop/service';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';
import { EVENT_TYPES } from '../../helpers/st-mock';

type Dict = Record<string, unknown>;

const TRACKER = 'At the start of every reply attach the tracker JSON exactly as shown below.';
const MARKERS = 'Place 1 to 3 picture markers in the reply, captions in Russian.';
const DEPTH = 'Celestia is a helper: she designs characters with the user.';
const NOTE = 'Author’s note: keep the answers short.';

let env: FeatureEnv;
let api: WorkshopApi;
let stop: () => Promise<void>;
let suspended: readonly string[] | null;
let suspend: Mock<(keep: readonly string[]) => Promise<void>>;
let resume: Mock<() => Promise<void>>;
let slash: string[];
let tags: { id: string; name: string }[];
let tagMap: Record<string, string[]>;
let flips: boolean[];

function ctx(): Dict {
    return env.mock.context as unknown as Dict;
}

async function openChat(characterId: number, chatId: string): Promise<void> {
    ctx().characterId = characterId;
    env.mock.chatId = chatId;
    env.mock.chatMetadata = {};
    await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED ?? 'chat_id_changed', chatId);
    await flush();
}

async function promptReady(messages: Dict[], dryRun = false): Promise<Dict[]> {
    await env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready', {
        chat: messages,
        dryRun,
    });
    return messages;
}

/** /tag-add, /tag-remove and /qm-toggle as ST and Qvink do them. */
async function runSlash(text: string): Promise<Dict> {
    slash.push(text);
    const tag = /^\/tag-(add|remove) name="([^"]+)" (.+)$/.exec(text);
    if (tag) {
        const [, op, avatar, name] = tag as unknown as [string, string, string, string];
        let found = tags.find((item) => item.name === name);
        if (!found && op === 'add') {
            found = { id: `tag-${tags.length + 1}`, name };
            tags.push(found);
        }
        if (!found) return { pipe: 'false' };
        const list = tagMap[avatar] ?? [];
        tagMap[avatar] = op === 'add' ? [...list, found.id] : list.filter((id) => id !== found.id);
        return { pipe: 'true' };
    }
    const toggle = /^\/qm-toggle (true|false)$/.exec(text);
    if (toggle) env.adapters.qvink.chatEnabled = toggle[1] === 'true';
    return { pipe: '' };
}

beforeEach(async () => {
    env = await createFeatureEnv();
    tags = [
        { id: 'w', name: 'Мастерская' },
        { id: 'f', name: 'Fantasy' },
    ];
    tagMap = { 'celestia.png': ['f', 'w'], 'alice.png': ['f'] };
    Object.assign(ctx(), {
        characters: [
            { name: 'Celestia', avatar: 'celestia.png' },
            { name: 'Alice', avatar: 'alice.png' },
        ],
        characterId: 1,
        tags,
        tagMap,
        executeSlashCommandsWithOptions: vi.fn(runSlash),
        extensionPrompts: {
            'dooms-tracker-inject': { value: TRACKER, position: 1, depth: 0, scan: false, role: 1 },
            nai_studio_markers: { value: MARKERS, position: 1, depth: 0, scan: false, role: 0 },
            DEPTH_PROMPT: { value: DEPTH, position: 1, depth: 4, scan: false, role: 0 },
            '2_floating_prompt': { value: NOTE, position: 1, depth: 4, scan: false, role: 0 },
        },
    });
    env.mock.chatId = 'alice-1';
    env.adapters.qvink.present = true;
    env.adapters.qvink.chatEnabled = true;
    env.mock.extensionSettings.qvink_memory = { use_global_toggle_state: false };
    suspended = null;
    suspend = vi.fn(async (keep: readonly string[]) => {
        suspended = keep;
    });
    resume = vi.fn(async () => {
        suspended = null;
    });
    Object.assign(env.app.modules, { suspend, resume, isSuspended: () => suspended !== null });
    flips = [];
    env.app.bus.on('workshop:changed', ({ active }) => {
        flips.push(active);
    });
    slash = [];
    stop = await env.start(workshopModule);
    api = env.apis.get('workshop') as WorkshopApi;
    await flush();
});

afterEach(async () => {
    await stop();
});

describe('a workshop chat', () => {
    it('pauses the story modules, says so once, switches Qvink off for the chat and remembers it', async () => {
        expect(api.active()).toBe(false);
        await openChat(0, 'celestia-1');
        expect(api.active()).toBe(true);
        expect(api.preset()).toBe('Мастерская');
        expect(suspend).toHaveBeenCalledWith(WORKSHOP_KEEPS);
        expect(flips).toEqual([true]);
        expect(env.ui.notices.filter((notice) => notice.text.includes('Мастерская'))).toHaveLength(1);
        expect(slash).toContain('/qm-toggle false');
        expect(env.adapters.qvink.chatEnabled).toBe(false);
        expect(env.app.chat.pointer(QVINK_POINTER)).toBe(true);
        expect(env.journal.list().map((record) => record.kind)).toContain(WORKSHOP_QVINK_KIND);
        // Nothing new on a check that changes nothing.
        await env.mock.eventSource.emit(EVENT_TYPES.SETTINGS_UPDATED ?? 'settings_updated');
        await flush();
        expect(suspend).toHaveBeenCalledTimes(1);
        expect(flips).toEqual([true]);
    });

    it('leaving for a story chat starts the story modules again', async () => {
        await openChat(0, 'celestia-1');
        await openChat(1, 'alice-1');
        expect(api.active()).toBe(false);
        expect(api.preset()).toBeNull();
        expect(resume).toHaveBeenCalledTimes(1);
        expect(flips).toEqual([true, false]);
    });

    it('cuts every extension’s text out of the prompt and keeps ST’s own (dry runs too)', async () => {
        await openChat(0, 'celestia-1');
        const messages = await promptReady([
            { role: 'system', content: `Main prompt.\n${DEPTH}` },
            { role: 'user', content: 'Сделай мне персонажа.' },
            { role: 'system', content: `${NOTE}\n${MARKERS}` },
            { role: 'user', content: TRACKER },
        ]);
        expect(messages).toEqual([
            { role: 'system', content: `Main prompt.\n${DEPTH}` },
            { role: 'user', content: 'Сделай мне персонажа.' },
            { role: 'system', content: `${NOTE}\n` },
        ]);
        const preview = await promptReady([{ role: 'user', content: `Hi\n${TRACKER}` }], true);
        expect(preview).toEqual([{ role: 'user', content: 'Hi\n' }]);
    });

    it('drops the global and persona lore by default, all of it or none of it as set', async () => {
        await openChat(0, 'celestia-1');
        const payload = () => ({
            globalLore: [{ world: 'BunnyMo' }],
            characterLore: [{ world: 'Celestia lore' }],
            chatLore: [{ world: 'Chat lore' }],
            personaLore: [{ world: 'Persona lore' }],
        });
        const own = payload();
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED ?? 'worldinfo_entries_loaded', own);
        expect([own.globalLore.length, own.characterLore.length, own.chatLore.length, own.personaLore.length]).toEqual([
            0, 1, 1, 0,
        ]);
        (env.settings.module('workshop') as Dict).lore = 'none';
        const none = payload();
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED ?? 'worldinfo_entries_loaded', none);
        expect(none.characterLore).toEqual([]);
    });

    it('a story chat keeps its prompt and its lore', async () => {
        await openChat(1, 'alice-1');
        const messages = await promptReady([{ role: 'user', content: TRACKER }]);
        expect(messages).toEqual([{ role: 'user', content: TRACKER }]);
        const data = { globalLore: [{ world: 'BunnyMo' }], characterLore: [], chatLore: [], personaLore: [] };
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED ?? 'worldinfo_entries_loaded', data);
        expect(data.globalLore).toHaveLength(1);
        expect(slash).not.toContain('/qm-toggle false');
    });

    it('leaves a Qvink with one switch for every chat alone, with a warning', async () => {
        env.mock.extensionSettings.qvink_memory = { use_global_toggle_state: true };
        await openChat(0, 'celestia-1');
        expect(slash).not.toContain('/qm-toggle false');
        expect(env.ui.notices.some((notice) => notice.text.includes('Qvink'))).toBe(true);
    });
});

describe('the card’s tag', () => {
    it('is set through /tag-add (journaled), the open chat follows at once, and undo takes it away', async () => {
        await openChat(1, 'alice-1');
        expect(await api.setCard('alice.png', true)).toBe(true);
        expect(slash).toContain('/tag-add name="alice.png" Мастерская');
        expect(api.isWorkshopCard('alice.png')).toBe(true);
        await flush();
        expect(api.active()).toBe(true);
        const record = env.journal.list().find((item) => item.kind === WORKSHOP_CARD_KIND);
        expect(record?.summary).toContain('Alice');
        expect(await env.journal.undo(record!.id)).toBe(true);
        expect(api.isWorkshopCard('alice.png')).toBe(false);
        await flush();
        expect(api.active()).toBe(false);
    });

    it('removing it gives the chat its Qvink back on the next visit', async () => {
        await openChat(0, 'celestia-1');
        const metadata = env.mock.chatMetadata;
        expect(await api.setCard('celestia.png', false)).toBe(true);
        expect(tagMap['celestia.png']).toEqual(['f']);
        await flush();
        // Qvink comes back in that same chat (its pointer is in this chat's metadata).
        expect(slash).toContain('/qm-toggle true');
        expect(env.adapters.qvink.chatEnabled).toBe(true);
        expect(env.mock.chatMetadata).toBe(metadata);
        expect(env.app.chat.pointer(QVINK_POINTER) ?? null).toBeNull();
    });

    it('the slash command switches the card of the open chat', async () => {
        await openChat(1, 'alice-1');
        const command = workshopCommand(env.app, api as unknown as WorkshopService);
        expect(await command.callback({}, 'on')).toBe('true');
        expect(api.isWorkshopCard('alice.png')).toBe(true);
        expect(await command.callback({}, '')).toBe('false');
        expect(api.isWorkshopCard('alice.png')).toBe(false);
    });
});

describe('stopping the module', () => {
    it('starts the paused modules again and tells the others the workshop is over', async () => {
        await openChat(0, 'celestia-1');
        await stop();
        stop = async () => {};
        expect(resume).toHaveBeenCalled();
        expect(flips).toEqual([true, false]);
        expect(api.active()).toBe(false);
    });
});
