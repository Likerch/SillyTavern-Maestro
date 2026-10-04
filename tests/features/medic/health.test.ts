import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { medicModule } from '../../../src/features/medic';
import { PREFILL_KIND } from '../../../src/features/medic/prefill';
import type { RulesApi } from '../../../src/features/rules/api';
import type { HealthCheck } from '../../../src/shared/contracts';
import { createFeatureEnv, withTracker } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';
import { message } from '../../helpers/st-mock';

let env: FeatureEnv;
let stop: () => Promise<void>;

function check(id: string): HealthCheck {
    const found = env.ui.checks.get(`medic.${id}`);
    if (!found) throw new Error(`no check ${id}`);
    return found;
}

function fakeRules(enabled: string[] = []): RulesApi & { setEnabled: ReturnType<typeof vi.fn> } {
    const on = new Set(enabled);
    return {
        register: () => () => {},
        list: () =>
            ['qvink.gapGuard', 'role.assistantToSystem'].map((id) => ({
                id,
                enabled: on.has(id),
                definition: {} as never,
                lastChanges: [],
            })),
        isEnabled: (id) => on.has(id),
        setEnabled: vi.fn(async (id: string, value: boolean) => {
            if (value) on.add(id);
        }),
        compare: async () => ({}) as never,
        suspended: () => false,
    };
}

beforeEach(async () => {
    env = await createFeatureEnv();
    stop = await env.start(medicModule);
});

afterEach(async () => {
    await stop();
});

describe('dependencies', () => {
    it('is ok when everything is in place', async () => {
        env.capReport.push({ id: 'st.cm', ok: true }, { id: 'st.regex', ok: true });
        const result = await check('deps').run();
        expect(result.status).toBe('ok');
        expect(result.message).toContain('2 of 2');
    });

    it('reports group chats, Text Completion, Connection Manager and missing ST features', async () => {
        env.group.value = true;
        env.chatCompletion.value = false;
        env.caps.delete('st.cm');
        env.capReport.push({ id: 'st.regex', ok: false }, { id: 'st.cm', ok: false }, { id: 'des.present', ok: false });
        const result = await check('deps').run();
        expect(result.status).toBe('warn');
        expect(result.message).toContain('Group chat');
        expect(result.message).toContain('Text Completion');
        expect(result.message).toContain('Connection Manager');
        expect(result.message).toContain('st.regex');
        expect(result.message).not.toContain('des.present');
    });
});

describe('DES tracker and regexes', () => {
    it('skips without DES or outside together mode and without replies', async () => {
        env.adapters.des.present = false;
        expect((await check('desTracker').run()).status).toBe('skip');
        expect((await check('desFieldKeys').run()).status).toBe('skip');
        env.adapters.des.present = true;
        env.adapters.des.mode = 'external';
        expect((await check('desTracker').run()).status).toBe('skip');
        expect((await check('regexDamage').run()).status).toBe('skip');
        env.adapters.des.mode = 'together';
        expect((await check('desTracker').run()).status).toBe('skip');
        expect((await check('regexDamage').run()).status).toBe('skip');
    });

    it('finds a missing tracker and offers the repair', async () => {
        env.mock.chat.push(message('Hi', { is_user: true }), message('```json\n{"infoBox": x}\n```'));
        env.llm.request.mockResolvedValue({ ok: true, text: '{"infoBox":{"location":"Inn"}}' });
        const result = await check('desTracker').run();
        expect(result.status).toBe('warn');
        expect((await check('regexDamage').run()).status).toBe('warn');
        await result.fix?.();
        expect((await check('desTracker').run()).status).toBe('ok');
        expect((await check('regexDamage').run()).status).toBe('ok');
    });

    it('repairs a reply that a NAI picture post follows', async () => {
        env.mock.chat.push(
            message('Hi', { is_user: true }),
            message('The scene'),
            message('1girl, tavern', { extra: { nai_studio: { model: 'v4' } } }),
        );
        env.llm.request.mockResolvedValue({ ok: true, text: '{"infoBox":{"location":"Inn"}}' });
        const result = await check('desTracker').run();
        expect(result.message).toContain('#2');
        await result.fix?.();
        const swipes = env.mock.chat[1]!.extra!.dooms_tracker_swipes as Record<string, Record<string, unknown>>;
        expect(swipes['0']?.infoBox).toBe('{"location":"Inn"}');
        expect(env.des.state.lastGeneratedData.infoBox).toBe('{"location":"Inn"}');
    });

    it('checks Cyrillic field names against DES-RU', async () => {
        env.adapters.des.settings = {
            trackerConfig: {
                presentCharacters: { customFields: [{ name: 'Внешность', enabled: true }, { name: 'Mood' }] },
                infoBox: { customFields: [] },
            },
        };
        expect((await check('desFieldKeys').run()).status).toBe('warn');
        env.adapters.desru.present = true;
        env.mock.extensionSettings.desru = { modules: { fixes: { enabled: true, fieldKeys: true } } };
        const fixed = await check('desFieldKeys').run();
        expect(fixed.status).toBe('ok');
        expect(fixed.message).toContain('Внешность');

        env.mock.chat.push(
            withTracker(message('reply'), {
                quests: null,
                infoBox: null,
                characterThoughts: JSON.stringify([{ name: 'A', details: { '': 'x' } }]),
            }),
        );
        const broken = await check('desFieldKeys').run();
        expect(broken.status).toBe('warn');
        expect(broken.message).toContain('Check DES-RU');

        env.adapters.des.settings = {};
        env.mock.chat.length = 0;
        expect((await check('desFieldKeys').run()).message).toContain('fine');
    });
});

describe('NAI markers', () => {
    it('finds raw markers in the last story reply', async () => {
        expect((await check('naiMarkers').run()).status).toBe('skip');
        env.adapters.nai.present = true;
        expect((await check('naiMarkers').run()).status).toBe('skip');
        env.mock.chat.push(message("<img data-nai='{}'>"));
        expect((await check('naiMarkers').run()).status).toBe('warn');
        env.mock.chat[0]!.mes = 'done [nai:img:1]';
        expect((await check('naiMarkers').run()).status).toBe('ok');
    });
});

describe('Qvink gaps', () => {
    beforeEach(() => {
        env.adapters.qvink.present = true;
        env.mock.extensionSettings.qvink_memory = { message_length_threshold: 1 };
        env.mock.chat.push(
            message('An old reply without a summary'),
            message('A summarised reply', { extra: { qvink_memory: { memory: 'sum', lagging: false } } }),
            message('A recent reply', { extra: { qvink_memory: { memory: '', lagging: true } } }),
        );
    });

    it('counts dropped messages without a memory and offers the M22 rule', async () => {
        const rules = fakeRules();
        env.apis.set('rules', rules);
        const result = await check('qvinkGaps').run();
        expect(result.status).toBe('warn');
        expect(result.message).toContain('without a summary: 1');
        await result.fix?.();
        expect(rules.setEnabled).toHaveBeenCalledWith('qvink.gapGuard', true);
        const guarded = await check('qvinkGaps').run();
        expect(guarded.status).toBe('ok');
    });

    it('skips when Qvink is absent, off for the chat or keeps messages', async () => {
        env.adapters.qvink.removes = false;
        expect((await check('qvinkGaps').run()).status).toBe('ok');
        env.adapters.qvink.chatEnabled = false;
        expect((await check('qvinkGaps').run()).status).toBe('skip');
        env.adapters.qvink.present = false;
        expect((await check('qvinkGaps').run()).status).toBe('skip');
    });

    it('is ok without gaps and without M22 has no fix', async () => {
        const result = await check('qvinkGaps').run();
        expect(result.fix).toBeUndefined();
        env.mock.chat[0]!.extra = { qvink_memory: { memory: 'x', lagging: false } };
        expect((await check('qvinkGaps').run()).status).toBe('ok');
    });
});

describe('lorebooks', () => {
    const books: Record<string, unknown> = {
        World: {
            entries: {
                1: { uid: 1, position: 4, role: 2, comment: 'Archive' },
                2: { uid: 2, position: 4, role: 0 },
                3: {
                    uid: 3,
                    key: ['Anna'],
                    keysecondary: [],
                    extensions: {
                        lorebook_localizer: {
                            version: 1,
                            languages: { ru: { added: { key: ['Анна'], keysecondary: [] } } },
                        },
                    },
                },
            },
        },
        Chat: { entries: [{ uid: 9, position: 4, role: 2 }] },
    };

    beforeEach(() => {
        env.stModules.worldInfo = { selected_world_info: ['World'], world_info: { charLore: [] } };
        env.mock.chatMetadata.world_info = 'Chat';
        (env.mock.context as unknown as Record<string, unknown>).loadWorldInfo = async (name: string) =>
            structuredClone(books[name]) ?? null;
    });

    it('finds assistant-role entries at depth per book and offers the M22 rule', async () => {
        env.apis.set('rules', fakeRules());
        const result = await check('assistantDepth').run();
        expect(result.status).toBe('warn');
        expect(result.message).toContain('World: 1');
        expect(result.message).toContain('Chat: 1');
        expect(result.fix).toBeDefined();
        env.apis.set('rules', fakeRules(['role.assistantToSystem']));
        expect((await check('assistantDepth').run()).status).toBe('ok');
    });

    it('uses the books M1 reports when M1 runs', async () => {
        env.apis.set('loreJournal', { whyActive: async () => [{ book: 'Chat', reasons: ['chat'] }] });
        const result = await check('assistantDepth').run();
        expect(result.message).toContain('Chat: 1');
        expect(result.message).not.toContain('World');
    });

    it('finds keys the Localizer added that are gone', async () => {
        expect((await check('localizerKeys').run()).status).toBe('skip');
        env.adapters.localizer.present = true;
        const result = await check('localizerKeys').run();
        expect(result.status).toBe('warn');
        expect(result.message).toContain('World: 1');
        (books.World as { entries: Record<string, Record<string, unknown>> }).entries[3]!.key = ['Anna', 'Анна'];
        expect((await check('localizerKeys').run()).status).toBe('ok');
    });

    it('reports clean books', async () => {
        books.Chat = { entries: [] };
        (books.World as { entries: Record<string, unknown> }).entries = {};
        expect((await check('assistantDepth').run()).status).toBe('ok');
    });
});

describe('assistant prefill', () => {
    type Prompt = Record<string, unknown>;
    let live: { preset_settings_openai: string; prompts: Prompt[]; prompt_order: unknown[] };
    let stored: { prompts: Prompt[] };
    let savePreset: ReturnType<typeof vi.fn>;
    let render: ReturnType<typeof vi.fn>;
    let acknowledged: string[][];

    beforeEach(() => {
        const prompts = (): Prompt[] => [
            { identifier: 'main', role: 'system', content: 'Main' },
            { identifier: 'chatHistory', marker: true },
            { identifier: 'prefill', name: 'Prefill', role: 'assistant', content: 'Sure!' },
        ];
        live = {
            preset_settings_openai: 'Marinara',
            prompts: prompts(),
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'prefill', enabled: true },
                    ],
                },
            ],
        };
        stored = { prompts: prompts() };
        savePreset = vi.fn(async () => {});
        render = vi.fn();
        (env.mock.context as unknown as Record<string, unknown>).chatCompletionSettings = live;
        env.stModules.openai = {
            openai_setting_names: { Marinara: 0 },
            openai_settings: [stored],
            promptManager: { render },
        };
        env.stModules.presetManager = { getPresetManager: () => ({ savePreset }) };
        acknowledged = [];
        env.apis.set('guardian', { acknowledge: async (paths: string[]) => void acknowledged.push(paths) });
    });

    it('detects the prefill and fixes it after confirmation', async () => {
        const result = await check('prefill').run();
        expect(result.status).toBe('warn');
        expect(result.message).toContain('Prefill');
        await result.fix?.();
        expect(env.ui.confirms).toHaveLength(1);
        expect(live.prompts[2]?.role).toBe('user');
        expect(savePreset).toHaveBeenCalledTimes(1);
        const [name, body, options] = savePreset.mock.calls[0]!;
        expect(name).toBe('Marinara');
        expect((body as { prompts: Prompt[] }).prompts[2]?.role).toBe('user');
        expect(options).toEqual({ skipUpdate: true });
        expect(stored.prompts[2]?.role).toBe('assistant');
        expect(render).toHaveBeenCalledWith(false);
        expect(env.mock.saveSettingsCalls).toBeGreaterThan(0);
        expect(acknowledged[0]).toContain('preset.roles');
        expect((await check('prefill').run()).status).toBe('ok');

        await env.journal.load();
        const record = env.journal.list({ module: 'M3' }).find((item) => item.kind === PREFILL_KIND)!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(live.prompts[2]?.role).toBe('assistant');
    });

    it('changes nothing when the user declines', async () => {
        env.ui.confirmAnswer = false;
        await (await check('prefill').run()).fix?.();
        expect(live.prompts[2]?.role).toBe('assistant');
        expect(savePreset).not.toHaveBeenCalled();
    });

    it('detects in-chat prefills at depth 0 and ignores the rest', async () => {
        live.prompts[2] = {
            identifier: 'prefill',
            role: 'assistant',
            content: 'x',
            injection_position: 1,
            injection_depth: 0,
        };
        expect((await check('prefill').run()).message).toContain('depth 0');
        live.prompts[2] = { identifier: 'prefill', role: 'user', content: 'x' };
        expect((await check('prefill').run()).status).toBe('ok');
        env.chatCompletion.value = false;
        expect((await check('prefill').run()).status).toBe('skip');
    });

    it('still fixes the live settings without ST preset modules', async () => {
        env.caps.delete('st.presetManager');
        await (await check('prefill').run()).fix?.();
        expect(live.prompts[2]?.role).toBe('user');
        expect(savePreset).not.toHaveBeenCalled();
    });

    it('is never promoted to auto', () => {
        env.settings.core().autonomy[PREFILL_KIND] = 'auto';
        expect(env.autonomy.level(PREFILL_KIND, 'ask')).toBe('ask');
    });
});
