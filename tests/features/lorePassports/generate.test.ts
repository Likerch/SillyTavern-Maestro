import { describe, expect, it } from 'vitest';
import { GENERATE_TASK } from '../../../src/features/lorePassports/service';
import type { LlmRequest } from '../../../src/shared/contracts';
import { ANNA_PASSPORT, createEnv, fakeNai, seedBooks, settle } from './helpers';
import type { Env } from './helpers';

const MODEL_ANSWER = {
    kind: 'location',
    name: 'Silver Tower',
    aliases: ['Серебряная башня'],
    tags: 'Tower, white_walls, silver spires, masterpiece, башня',
    slots: { base: '', hair: '', eyes: '', body: '', skin: '', clothing: '', accessories: '' },
    negative: '',
};

/** Starts a model-path call, runs the queued task and returns the call's result. */
async function withTask<T>(env: Env, call: () => Promise<T>): Promise<T> {
    const running = call();
    await settle();
    await env.tasks.runLatest(GENERATE_TASK);
    return running;
}

describe('lore passports: generation', () => {
    it('uses NAI Studio’s generator when the adapter offers it, and cleans its passport', async () => {
        const env = createEnv({ nai: fakeNai({ provider: false, generator: true }) });
        seedBooks(env);
        env.world.add({
            name: 'Anna',
            sources: [{ kind: 'lore.entry', ref: 'World#0', label: 'Anna', world: 'World', uid: 0 }],
        });
        const service = env.service();
        expect(service.generator()).toEqual({ kind: 'nai' });
        const result = await service.generate('World', 0);
        expect(env.nai.generatePassport).toHaveBeenCalledWith({
            name: 'Anna',
            kind: 'character',
            description: 'Anna is an elf with silver hair.',
            language: 'en',
        });
        expect(result).toMatchObject({ storage: 'sidecar', generatedBy: 'nai' });
        const slots = result!.passport.slots as Record<string, string>;
        expect(slots.base).toBe('1girl, elf');
        expect(slots.hair).toBe('silver hair');
        expect(result!.passport.id).toBeUndefined();
        expect(env.llm.request).not.toHaveBeenCalled();
        expect(env.confirm).not.toHaveBeenCalled();
    });

    it('falls back to the background model when NAI Studio returns nothing', async () => {
        const nai = fakeNai({ provider: false, generator: true });
        nai.generatePassport!.mockResolvedValueOnce(null);
        const env = createEnv({ nai });
        seedBooks(env);
        env.llm.request.mockResolvedValue({ ok: true, data: MODEL_ANSWER });
        const result = await withTask(env, () => env.service().generate('Places', 0));
        expect(nai.generatePassport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'location' }));
        expect(result).toMatchObject({ generatedBy: 'model', storage: 'entry' });
    });

    it('writes with the background model as a task with the strict schema, cleaning the answer', async () => {
        const env = createEnv();
        seedBooks(env);
        env.llm.request.mockResolvedValue({ ok: true, data: MODEL_ANSWER });
        const service = env.service();
        expect(service.generator()).toEqual({ kind: 'model' });
        const result = await withTask(env, () => service.generate('Places', 0));
        expect(env.tasks.queued[0]).toMatchObject({
            kind: GENERATE_TASK,
            dedupeKey: 'Places#0',
            payload: { world: 'Places', uid: 0, kind: 'location' },
        });
        const request = env.llm.request.mock.calls[0]![0] as LlmRequest;
        expect(request.task).toBe(GENERATE_TASK);
        expect(request.schema?.name).toBe('lore_passport');
        expect(request.messages[1]!.content).toContain('Kind to write: location');
        expect(request.messages[1]!.content).toContain('Entry type: Place');
        expect(result).toMatchObject({ generatedBy: 'model', storage: 'entry' });
        // Lower case, spaces, no style words, no non-English tags.
        expect(result!.passport.tags).toBe('tower, white walls, silver spires');
        expect(result!.passport.aliases).toEqual(['Серебряная башня']);
        const stored = env.store.entry('Places', 0)!.extensions as { maestro: { passport: { generatedBy: string } } };
        expect(stored.maestro.passport.generatedBy).toBe('model');
    });

    it('reports malformed answers, refusals and failures without saving', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        env.llm.request.mockResolvedValueOnce({ ok: false, error: 'parse', text: '{"kind": "loc' });
        await expect(withTask(env, () => service.generate('Places', 0))).rejects.toThrow(/not a passport/);
        env.llm.request.mockResolvedValueOnce({ ok: true, data: 'definitely not json' });
        await expect(withTask(env, () => service.generate('Places', 0))).rejects.toThrow(/nothing to draw/);
        env.llm.request.mockResolvedValueOnce({ ok: true, data: { kind: 'location', name: 'X', tags: 'башня' } });
        await expect(withTask(env, () => service.generate('Places', 0))).rejects.toThrow(/nothing to draw/);
        env.llm.request.mockResolvedValueOnce({ ok: false, refusal: true, error: 'refusal' });
        await expect(withTask(env, () => service.generate('Places', 0))).rejects.toThrow(/refused/);
        env.llm.request.mockResolvedValueOnce({ ok: false, error: 'HTTP 500' });
        await expect(withTask(env, () => service.generate('Places', 0))).rejects.toThrow(/HTTP 500/);
        expect(await service.get('Places', 0)).toBeNull();
    });

    it('accepts a JSON answer given as text', async () => {
        const env = createEnv();
        seedBooks(env);
        env.llm.request.mockResolvedValue({ ok: true, text: '```json\n' + JSON.stringify(MODEL_ANSWER) + '\n```' });
        const result = await withTask(env, () => env.service().generate('Places', 0));
        expect(result!.passport.name).toBe('Silver Tower');
    });

    it('never replaces a passport made by hand without confirmation', async () => {
        const env = createEnv({ nai: fakeNai({ provider: false, generator: true }) });
        seedBooks(env);
        const service = env.service();
        await service.set('World', 0, { ...ANNA_PASSPORT, slots: { hair: 'red hair' } });
        env.confirm.mockResolvedValueOnce(false);
        expect(await service.generate('World', 0)).toBeNull();
        expect(env.confirm).toHaveBeenCalledTimes(1);
        expect(env.confirm.mock.calls[0]![1]).toContain('Anna');
        expect(env.nai.generatePassport).not.toHaveBeenCalled();
        expect(((await service.get('World', 0))!.passport.slots as Record<string, string>).hair).toBe('red hair');
        env.confirm.mockResolvedValueOnce(true);
        const replaced = await service.generate('World', 0);
        expect(replaced!.generatedBy).toBe('nai');
        // A generated passport is replaced without asking.
        env.confirm.mockClear();
        await service.generate('World', 0);
        expect(env.confirm).not.toHaveBeenCalled();
    });

    it('asks again when the passport was made by hand while the model was writing', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        env.llm.request.mockImplementation(async () => {
            await service.set('Places', 0, { kind: 'location', name: 'Tower', tags: 'hand made' });
            return { ok: true, data: MODEL_ANSWER };
        });
        env.confirm.mockResolvedValueOnce(false);
        expect(await withTask(env, () => service.generate('Places', 0))).toBeNull();
        expect(env.confirm).toHaveBeenCalledTimes(1);
        expect((await service.get('Places', 0))!.passport.tags).toBe('hand made');
    });

    it('propose() generates without saving', async () => {
        const env = createEnv({ nai: fakeNai({ provider: false, generator: true }) });
        seedBooks(env);
        const proposed = await env.service().propose('World', 0);
        expect(proposed).toMatchObject({ by: 'nai', passport: { name: 'Anna' } });
        expect(env.roles.setEntryMeta).not.toHaveBeenCalled();
    });

    it('says why nothing can generate (no chat, group, tab, profile, cap; NAI failed)', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        env.state.chatId = null;
        expect(service.generator()).toEqual({ kind: 'none', reason: 'noChat' });
        await expect(service.generate('Places', 0)).rejects.toThrow(/open chat/);
        env.state.chatId = 'chat1';
        env.state.group = true;
        expect(service.generator()).toEqual({ kind: 'none', reason: 'groupChat' });
        env.state.group = false;
        env.state.leader = false;
        expect(service.generator()).toEqual({ kind: 'none', reason: 'notLeader' });
        env.state.leader = true;
        env.llm.available.mockReturnValue(false);
        expect(service.generator()).toEqual({ kind: 'none', reason: 'noProfile' });
        env.llm.available.mockReturnValue(true);
        env.state.cap = true;
        expect(service.generator()).toEqual({ kind: 'none', reason: 'cap' });
        const broken = fakeNai({ provider: false, generator: true });
        broken.generatePassport!.mockRejectedValue(new Error('no key'));
        const other = createEnv({ nai: broken });
        seedBooks(other);
        other.state.chatId = null;
        await expect(other.service().generate('World', 0)).rejects.toThrow(/NAI Studio could not/);
    });

    it('refuses entries without text', async () => {
        const env = createEnv({ nai: fakeNai({ provider: false, generator: true }) });
        seedBooks(env);
        await env.store.updateEntry('World', 1, { content: '  ' }, { module: 'test', summary: '' });
        await expect(env.service().generate('World', 1)).rejects.toThrow(/no text/);
    });

    it('a task left from before a reload saves only where there is no passport', async () => {
        const env = createEnv();
        seedBooks(env);
        const service = env.service();
        env.llm.request.mockResolvedValue({ ok: true, data: MODEL_ANSWER });
        const runner = env.tasks.runners.get(GENERATE_TASK)!;
        const info = {
            id: 'x',
            kind: GENERATE_TASK,
            payload: {},
            state: 'running' as const,
            attempts: 1,
            createdAt: 0,
        };
        await runner({ world: 'Places', uid: 0, requestId: 'gone' }, info);
        expect((await service.get('Places', 0))!.generatedBy).toBe('model');
        await service.set('Places', 0, { kind: 'location', name: 'Tower', tags: 'mine' });
        await runner({ world: 'Places', uid: 0, requestId: 'gone' }, info);
        expect((await service.get('Places', 0))!.passport.tags).toBe('mine');
        // A task for an entry that is gone does nothing.
        await runner({ world: 'Places', uid: 42, requestId: 'gone' }, info);
    });

    it('generates the missing passports one by one, skipping those made meanwhile', async () => {
        const env = createEnv({ nai: fakeNai({ provider: false, generator: true }) });
        seedBooks(env);
        const service = env.service();
        await service.set('World', 1, { kind: 'object', name: 'Sword', tags: 'sword' });
        const result = await service.generateMissing([
            { world: 'Places', uid: 0 },
            { world: 'World', uid: 1 },
            { world: 'Bunny', uid: 0 },
        ]);
        expect(result).toMatchObject({ total: 3, done: 1, skipped: 1, failed: 1, running: false });
        expect(result.lastError).toMatch(/BunnyMo/);
        expect((await service.get('Places', 0))!.generatedBy).toBe('nai');
        expect(service.batch()).toMatchObject({ running: false, done: 1 });
    });
});
