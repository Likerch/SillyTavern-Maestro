// M38 «Проверка промпта», the capture over the ST mock: the instruction map of a real turn (preset blocks with the
// turn's flags, the card, every slot with its owner, Maestro's own injections that are cleared after the generation,
// instruction-like lore only), kept per chat across a reload; quiet generations and foreign dry runs are not turns;
// the test assembly through ST's generate(…, dryRun) with the last turn's slots added.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_DOC_KIND } from '../../../src/features/promptAudit';
import { createAuditEnv, flush, realCaseMessages, realCaseSlots } from '../../helpers/prompt-audit-env';
import type { AuditEnv } from '../../helpers/prompt-audit-env';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { MARKERS_TEXT, TASK_TEXT, WORLD_TEXT } from '../../helpers/prompt-audit-fixtures';

type Dict = Record<string, unknown>;

let a: AuditEnv;
let ctx: Dict;

beforeEach(async () => {
    a = await createAuditEnv();
    ctx = a.env.mock.context as unknown as Dict;
});

afterEach(async () => {
    await a.stop();
});

describe('the capture of a real turn', () => {
    it('keeps every instruction with its owner, role, place and message — Maestro’s own injections included', async () => {
        ctx.extensionPrompts = realCaseSlots();
        a.env.mock.chatMetadata.variables = { maestro_quiet: '' };
        a.loreContents.push(
            { world: 'BunnyMo', uid: 1, comment: 'AUTO-FILTRATION: LINGUISTICS', content: 'Never write purple prose.' },
            { world: 'World', uid: 2, comment: 'Tavern', content: 'A small tavern by the road.' },
        );
        await a.generate(realCaseMessages());
        const capture = a.api.capture()!;
        expect(capture).toMatchObject({
            source: 'turn',
            type: 'normal',
            chatId: 'chat-1',
            preset: 'Marinara',
            connection: { source: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
        });
        expect(capture.connection?.quirks).toContain('systemMerge');
        expect(capture.items.map((item) => [item.ref, item.owner, item.role, item.message])).toEqual([
            ['preset:task', 'preset', 'system', 0],
            ['preset:world', 'preset', 'system', 0],
            ['slot:dooms-tracker-inject', 'des', 'user', 4],
            ['slot:nai_studio_markers', 'nai', 'system', 5],
            ['slot:maestro_wardrobe', 'maestro', 'system', 3],
            ['lore:BunnyMo#1', 'bunnymo', 'system', -1],
        ]);
        // The world block's {{if}} resolved with the turn's flags (maestro_quiet was empty).
        expect(capture.items[1]!.text).toBe(WORLD_TEXT);
        expect(capture.items[0]!.text).toBe(TASK_TEXT);
        expect(capture.items[2]).toMatchObject({ neighbours: ['des.tracker'], place: 'chat', depth: 0 });
        expect(capture.items[3]!.neighbours).toEqual(['nai.markers']);
        expect(capture.items[4]).toMatchObject({ module: 'wardrobe', depth: 1 });
        expect(capture.messages.map((message) => message.refs.length)).toEqual([2, 0, 0, 1, 1, 1]);
        // Stored in the chat document.
        const files = [...a.env.mock.files.keys()].filter((name) => name.includes(AUDIT_DOC_KIND));
        expect(files).toHaveLength(1);
    });

    it('resolves conditionals with the flags of that turn and leaves out blocks of other generation types', async () => {
        a.env.mock.chatMetadata.variables = { maestro_quiet: '1' };
        await a.generate([{ role: 'system', content: `${TASK_TEXT}\n\nNothing happens.` }]);
        const capture = a.api.capture()!;
        expect(capture.items.find((item) => item.ref === 'preset:world')?.text).toBe('Nothing happens.');
        expect(capture.items.some((item) => item.ref === 'preset:combat')).toBe(false);
    });

    it('reads the card’s system prompt in place of the preset’s main block', async () => {
        (ctx.characters as Dict[])[0]!.data = {
            system_prompt: 'You are Alice. Reply in English.',
            post_history_instructions: '',
        };
        await a.generate([{ role: 'system', content: 'You are Alice. Reply in English.' }]);
        expect(a.api.capture()!.items[0]).toMatchObject({ ref: 'card:system', owner: 'card', message: 0 });
    });

    it('does not take quiet generations or other extensions’ dry runs for a turn', async () => {
        await a.generate([{ role: 'system', content: TASK_TEXT }], 'quiet');
        expect(a.api.capture()).toBeNull();
        await a.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready', {
            chat: [{ role: 'system', content: TASK_TEXT }],
            dryRun: true,
        });
        await a.env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await flush();
        expect(a.api.capture()).toBeNull();
    });

    it('survives a reload: the capture comes back from the chat document', async () => {
        ctx.extensionPrompts = realCaseSlots();
        await a.generate(realCaseMessages());
        const before = a.api.capture();
        await a.restart();
        expect(a.api.capture()).toEqual(before);
    });
});

describe('the test assembly', () => {
    it('asks ST for a dry run, captures it and adds the last turn’s slots the dry run lacks', async () => {
        ctx.extensionPrompts = realCaseSlots();
        await a.generate(realCaseMessages());
        // In a dry run the interceptors do not run: only NAI Studio's slot is there now.
        ctx.extensionPrompts = {
            nai_studio_markers: { value: MARKERS_TEXT, position: 1, depth: 0, scan: false, role: 0 },
        };
        const calls: unknown[][] = [];
        ctx.generate = async (...args: unknown[]) => {
            calls.push(args);
            await a.env.mock.eventSource.emit(
                EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready',
                {
                    chat: [
                        { role: 'system', content: TASK_TEXT },
                        { role: 'user', content: 'I follow her.' },
                        { role: 'system', content: MARKERS_TEXT },
                    ],
                    dryRun: true,
                },
            );
        };
        expect(a.api.dryRunAvailable()).toBe(true);
        const report = await a.api.check({ dry: true });
        expect(calls).toEqual([['normal', {}, true]]);
        expect(report?.source).toBe('dry');
        const capture = a.api.capture()!;
        expect(capture.source).toBe('dry');
        expect(capture.items.map((item) => [item.ref, item.fromTurn ?? false])).toEqual([
            ['preset:task', false],
            ['preset:world', false],
            ['slot:nai_studio_markers', false],
            ['slot:dooms-tracker-inject', true],
            ['slot:maestro_wardrobe', true],
        ]);
    });

    it('is not offered without ST’s generate, in a group chat or while a generation runs', async () => {
        expect(a.api.dryRunAvailable()).toBe(false);
        ctx.generate = async () => {};
        expect(a.api.dryRunAvailable()).toBe(true);
        a.env.group.value = true;
        expect(a.api.dryRunAvailable()).toBe(false);
        a.env.group.value = false;
        a.env.generation.current = { type: 'normal', dryRun: false, quiet: false };
        expect(a.api.dryRunAvailable()).toBe(false);
    });

    it('falls back to the last turn when ST assembled nothing', async () => {
        await a.generate([{ role: 'system', content: TASK_TEXT }]);
        ctx.generate = async () => {};
        const report = await a.api.check({ dry: true });
        expect(report?.source).toBe('turn');
        expect(a.env.ui.notices.at(-1)?.text).toContain('test assembly did not work out');
    });
});
