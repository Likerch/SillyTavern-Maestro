// M36 «Промпты соседей» over the ST mock with neighbour fakes: what the registry shows, global writes through the
// neighbours' own setters (journaled, undo, M4 told, DES Workshop respected), Maestro's copies for a card or a chat
// kept per scope and put into the outgoing messages at CHAT_COMPLETION_PROMPT_READY.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { NeighbourPromptsApi } from '../../../src/features/neighbourPrompts/api';
import { neighbourPromptsModule } from '../../../src/features/neighbourPrompts';
import { NEIGHBOUR_DOC_KIND } from '../../../src/features/neighbourPrompts/service';
import { createFeatureEnv } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';
import { EVENT_TYPES } from '../../helpers/st-mock';

type Dict = Record<string, unknown>;

const HTML_BUILTIN = 'If appropriate, include inline HTML pieces in the reply.';
const TRACKER_GENERATED = 'At the start of every reply attach the tracker JSON. Exclude {userName}... no, User.';
const LOCK = '[Язык ролевой игры — русский. Отвечай по-русски.]';
const MARKERS_NOW = 'Place 1 to 3 picture markers in the reply, captions in Russian.';

let env: FeatureEnv;
let api: NeighbourPromptsApi;
let stop: () => Promise<void>;
let des: Dict;
let setDes: Mock;
let acknowledge: Mock;
let prompts: Record<string, { value: string; position: number; depth: number; scan: boolean; role: number }>;

function slot(value: string) {
    return { value, position: 1, depth: 0, scan: false, role: 0 };
}

async function openChat(chatId: string, characterId: number): Promise<void> {
    env.mock.chatId = chatId;
    env.mock.context.characterId = characterId;
    await env.app.bus.emit('chat:changed', { chatId });
    await api.ready();
}

/** Emits PROMPT_READY with these messages and returns them. */
async function promptReady(messages: Dict[], dryRun = false): Promise<Dict[]> {
    await env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready', {
        chat: messages,
        dryRun,
    });
    return messages;
}

beforeEach(async () => {
    env = await createFeatureEnv();
    const ctx = env.mock.context as unknown as Dict;
    ctx.characters = [
        { name: 'Alice', avatar: 'alice.png' },
        { name: 'Bob', avatar: 'bob.png' },
    ];
    ctx.characterId = 0;
    prompts = {
        nai_studio_markers: slot(MARKERS_NOW),
        desru_bunnymo_language: slot(LOCK),
        maestro_director: slot('Slow down: let the scene breathe.'),
    };
    ctx.extensionPrompts = prompts;
    // DES with its prompt overrides (state.js) and the exported built-in texts.
    des = {
        customHtmlPrompt: '',
        customTrackerPrompt: '',
        customTrackerInstructionsPrompt: '',
        customTrackerContinuationPrompt: 'Then continue the story from the last message, please.',
        customDialogueColoringPrompt: '',
        customContextInstructionsPrompt: '',
        customNarratorPrompt: '',
    };
    setDes = vi.fn((key: string, text: string) => {
        des[key] = text;
        return true;
    });
    Object.assign(env.app.adapters.des, {
        promptOverride: (key: string) => (typeof des[key] === 'string' ? des[key] : ''),
        promptBuiltin: (key: string) =>
            key === 'customHtmlPrompt' ? HTML_BUILTIN : key === 'customTrackerPrompt' ? TRACKER_GENERATED : null,
        setPromptOverride: setDes,
    });
    // NAI Studio with its marker settings.
    env.adapters.nai.present = true;
    env.mock.extensionSettings.nai_studio = {
        markers: {
            enabled: true,
            inject: true,
            preset: 'tags',
            template: '',
            min: 1,
            max: 3,
            captionLanguage: 'Russian',
        },
    };
    const naiMarkers = () => (env.mock.extensionSettings.nai_studio as { markers: Dict }).markers;
    Object.assign(env.app.adapters.nai, {
        markerSettings: () => ({ ...naiMarkers() }),
        setMarkerInstruction: (next: { preset: string; template: string }) => {
            Object.assign(naiMarkers(), next);
            return true;
        },
    });
    // Qvink with a profile.
    env.adapters.qvink.present = true;
    env.mock.extensionSettings.qvink_memory = {
        prompt: 'Summarize the message {{message}} in one line.',
        profile: 'Default',
        profiles: { Default: { prompt: 'Summarize the message {{message}} in one line.' } },
    };
    const qvinkSettings = () => env.mock.extensionSettings.qvink_memory as Dict;
    Object.assign(env.app.adapters.qvink, {
        textSetting: (key: string) => (typeof qvinkSettings()[key] === 'string' ? qvinkSettings()[key] : null),
        setTextSetting: (key: string, text: string) => {
            qvinkSettings()[key] = text;
            ((qvinkSettings().profiles as Dict).Default as Dict)[key] = text;
            return true;
        },
    });
    env.adapters.desru.present = true;
    env.adapters.ck.present = true;
    env.mock.extensionSettings.CarrotKernel = { templates: { character_consistency: { content: 'OOC: {{TAGS}}' } } };
    acknowledge = vi.fn(async () => {});
    env.apis.set('guardian', { acknowledge });
    stop = await env.start(neighbourPromptsModule);
    api = env.apis.get('neighbourPrompts') as NeighbourPromptsApi;
    await api.ready();
});

afterEach(async () => {
    await stop();
});

describe('the registry', () => {
    it('describes each neighbour text: where it comes from, whether it can be changed or copied', () => {
        const html = api.get('des.html');
        expect(html).toMatchObject({
            owner: 'des',
            present: true,
            text: HTML_BUILTIN,
            globalText: HTML_BUILTIN,
            setting: '',
            defaultText: HTML_BUILTIN,
            scoped: {},
            editable: true,
            scopable: true,
            usedIn: 'prompt',
        });
        expect(html?.label).not.toContain('des.');
        expect(api.get('des.trackerInstructions')).toMatchObject({ editable: true, scopable: false });
        expect(api.get('des.trackerInstructions')?.note).toBeTruthy();
        expect(api.get('des.trackerContinuation')).toMatchObject({ editable: true, scopable: true });
        expect(api.get('nai.markers')).toMatchObject({
            setting: '',
            globalText: MARKERS_NOW,
            editable: true,
            scopable: true,
        });
        expect(api.get('qvink.prompt')).toMatchObject({ editable: true, scopable: false, usedIn: 'background' });
        expect(api.get('desru.languageLock')).toMatchObject({ globalText: LOCK, editable: false, scopable: true });
        expect(api.get('ck.template')).toMatchObject({ globalText: 'OOC: {{TAGS}}', editable: false, scopable: false });
        expect(api.get('maestro.director')).toMatchObject({ editable: false, scopable: false, owner: 'maestro' });
        expect(api.get('maestro.director')?.note).toBeTruthy();
        expect(api.get('nope')).toBeNull();
        expect(api.effective('nope')).toBe('');
        expect(api.list().map((entry) => entry.id)).toContain('qvink.longTemplate');
    });
});

describe('changing a neighbour’s own text («везде»)', () => {
    it('writes DES through its own setter, journals it, tells M4, and undoes it', async () => {
        await api.setGlobal('des.html', 'Only plain text, no HTML.');
        expect(setDes).toHaveBeenCalledWith('customHtmlPrompt', 'Only plain text, no HTML.');
        expect(api.get('des.html')?.text).toBe('Only plain text, no HTML.');
        expect(acknowledge).toHaveBeenCalledWith(['des.customHtmlPrompt']);
        const record = env.journal.list({ module: 'M36' })[0];
        expect(record).toMatchObject({ kind: 'neighbourPrompts.global' });
        expect(record?.changes[0]).toMatchObject({
            target: 'neighbour-prompt',
            before: '',
            after: 'Only plain text, no HTML.',
        });
        expect(await env.journal.undo(record?.id ?? '')).toBe(true);
        expect(des.customHtmlPrompt).toBe('');
    });

    it('never writes DES while its Workshop is open; stores no tracker override equal to what DES generates', async () => {
        env.adapters.des.workshopOpen = true;
        await expect(api.setGlobal('des.html', 'x x x x x x x x x')).rejects.toMatchObject({ code: 'busy' });
        expect(setDes).not.toHaveBeenCalled();
        env.adapters.des.workshopOpen = false;
        await api.setGlobal('des.tracker', `  ${TRACKER_GENERATED}\n`);
        expect(setDes).not.toHaveBeenCalled();
        await api.setGlobal('des.tracker', 'My own tracker block for {userName}.');
        expect(des.customTrackerPrompt).toBe('My own tracker block for {userName}.');
    });

    it('refuses read-only texts; writes Qvink into the active profile too', async () => {
        await expect(api.setGlobal('desru.languageLock', 'x')).rejects.toMatchObject({ code: 'readOnly' });
        await expect(api.setGlobal('maestro.director', 'x')).rejects.toMatchObject({ code: 'readOnly' });
        await expect(api.setGlobal('nope', 'x')).rejects.toMatchObject({ code: 'unknown' });
        await api.setGlobal('qvink.prompt', 'Retell {{message}} in Russian.');
        const qvink = env.mock.extensionSettings.qvink_memory as Dict;
        expect(qvink.prompt).toBe('Retell {{message}} in Russian.');
        expect(((qvink.profiles as Dict).Default as Dict).prompt).toBe('Retell {{message}} in Russian.');
    });

    it('switches NAI Studio to a custom template and back; undo restores the preset it had', async () => {
        const markers = () => (env.mock.extensionSettings.nai_studio as { markers: Dict }).markers;
        await api.setGlobal('nai.markers', 'Add {{min}}-{{max}} pictures.');
        expect(markers()).toMatchObject({ preset: 'custom', template: 'Add {{min}}-{{max}} pictures.' });
        await api.setGlobal('nai.markers', '');
        expect(markers()).toMatchObject({ preset: 'natural' });
        const [reset, custom] = env.journal.list({ module: 'M36' });
        expect(await env.journal.undo(reset?.id ?? '')).toBe(true);
        expect(markers()).toMatchObject({ preset: 'custom' });
        expect(await env.journal.undo(custom?.id ?? '')).toBe(true);
        expect(markers()).toMatchObject({ preset: 'tags', template: '' });
    });
});

describe('copies for a character or a chat', () => {
    const outgoing = (): Dict[] => [
        { role: 'system', content: 'Main prompt.' },
        { role: 'user', content: 'Hi' },
        { role: 'system', content: `Tracker...\n${HTML_BUILTIN}` },
    ];

    it('keeps the chat copy in the chat document and puts it in place of the global text at prompt time', async () => {
        await api.setScoped('des.html', 'chat', 'No HTML in this chat, plain prose only.');
        const doc = (await env.app.chat.getFor('chat-1', NEIGHBOUR_DOC_KIND, () => ({}))) as Dict;
        expect(doc.texts).toEqual({ 'des.html': 'No HTML in this chat, plain prose only.' });
        expect(api.get('des.html')).toMatchObject({
            text: 'No HTML in this chat, plain prose only.',
            globalText: HTML_BUILTIN,
            scoped: { chat: 'No HTML in this chat, plain prose only.' },
        });
        expect(des.customHtmlPrompt).toBe('');
        const messages = await promptReady(outgoing());
        expect(messages).toEqual([
            { role: 'system', content: 'Main prompt.' },
            { role: 'user', content: 'Hi' },
            { role: 'system', content: 'Tracker...\nNo HTML in this chat, plain prose only.' },
        ]);
        expect(api.lastReport()).toMatchObject({ replaced: ['des.html'], notFound: [] });
        // Dry runs (test assemblies) get the copy too; the report is about real generations.
        const dry = await promptReady(outgoing(), true);
        expect(dry[2]?.content).toContain('No HTML in this chat');
    });

    it('uses the character’s copy in all its chats, the chat’s copy over it, nothing in another card’s chat', async () => {
        await api.setScoped('des.html', 'character', 'Alice prefers letters drawn as HTML.');
        await openChat('chat-2', 0);
        expect((await promptReady(outgoing()))[2]?.content).toContain('Alice prefers letters');
        await api.setScoped('des.html', 'chat', 'Chat two: no HTML at all, plain prose.');
        expect((await promptReady(outgoing()))[2]?.content).toContain('Chat two: no HTML');
        await openChat('chat-3', 1);
        expect(api.get('des.html')?.scoped).toEqual({});
        expect((await promptReady(outgoing()))[2]?.content).toContain(HTML_BUILTIN);
    });

    it('reports a copy whose global text was not in the prompt, and removes copies (with undo)', async () => {
        await api.setScoped('des.html', 'chat', 'No HTML in this chat, plain prose only.');
        await promptReady([{ role: 'system', content: 'Nothing of DES here.' }]);
        expect(api.lastReport()).toMatchObject({ replaced: [], notFound: ['des.html'] });
        await api.setScoped('des.html', 'chat', null);
        expect(api.get('des.html')?.scoped).toEqual({});
        const record = env.journal.list({ module: 'M36' })[0];
        expect(record?.kind).toBe('neighbourPrompts.copy');
        expect(await env.journal.undo(record?.id ?? '')).toBe(true);
        expect(api.get('des.html')?.scoped).toEqual({ chat: 'No HTML in this chat, plain prose only.' });
    });

    it('refuses copies of texts that are not in the main prompt or not known', async () => {
        await expect(api.setScoped('qvink.prompt', 'chat', 'x')).rejects.toMatchObject({ code: 'notScopable' });
        await expect(api.setScoped('des.trackerInstructions', 'chat', 'x')).rejects.toMatchObject({
            code: 'notScopable',
        });
        env.mock.context.characterId = '' as unknown as number;
        await openChat('chat-4', '' as unknown as number);
        await expect(api.setScoped('des.html', 'character', 'x')).rejects.toMatchObject({ code: 'noScope' });
    });

    it('copies of slot texts: DES-RU’s rule as sent now, NAI’s instruction with its placeholders filled', async () => {
        await api.setScoped('desru.languageLock', 'chat', '[Игра идёт по-английски.]');
        await api.setScoped('nai.markers', 'chat', 'Place {{min}} to {{max}} markers, captions in English.');
        const messages = await promptReady([
            { role: 'system', content: `Rules\n\n${LOCK}` },
            { role: 'system', content: MARKERS_NOW },
        ]);
        expect(messages).toEqual([
            { role: 'system', content: 'Rules\n\n[Игра идёт по-английски.]' },
            { role: 'system', content: 'Place 1 to 3 markers, captions in English.' },
        ]);
        expect(api.lastReport()?.replaced.sort()).toEqual(['desru.languageLock', 'nai.markers']);
    });

    it('remembers what Maestro’s own slots sent at the last real generation', async () => {
        env.app.settings.setModuleEnabled('director', true);
        await promptReady([{ role: 'system', content: 'x' }]);
        prompts.maestro_director = slot('');
        expect(api.get('maestro.director')?.text).toBe('Slow down: let the scene breathe.');
    });
});
