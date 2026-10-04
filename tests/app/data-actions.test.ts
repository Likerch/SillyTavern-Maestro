import { describe, expect, it, vi } from 'vitest';
import { applyImport, buildExport, EXPORT_FORMAT, isExportBundle, prepareDisable } from '../../src/app/data-actions';
import type { App } from '../../src/shared/contracts';

function fakeApp(options: { chatId?: string | null; apis?: Record<string, unknown>; preset?: string } = {}) {
    const files = new Map<string, unknown>([
        ['maestro-book-roles.json', { schema: 1, books: { World: { role: 'world' } } }],
        ['maestro-autonomy.json', { levels: {} }],
    ]);
    const extensionSettings: Record<string, unknown> = { maestro: { core: { mode: 'balanced' }, modules: {} } };
    const chatDocs: Record<string, unknown> = { inbox: { cards: [] } };
    const imported: [string, Record<string, unknown>][] = [];
    const settings = { reload: vi.fn(), save: vi.fn() };
    const app = {
        host: {
            chatId: () => (options.chatId === undefined ? 'chat-1' : options.chatId),
            ctx: () => ({
                extensionSettings,
                chatCompletionSettings: { preset_settings_openai: options.preset ?? 'Marinara' },
            }),
        },
        files: {
            read: async (name: string) => files.get(name) ?? null,
            write: async (name: string, data: unknown) => {
                files.set(name, data);
            },
        },
        chat: {
            exportChat: async () => chatDocs,
            importChat: async (chatId: string, bundle: Record<string, unknown>) => {
                imported.push([chatId, bundle]);
            },
        },
        settings,
        modules: { api: (key: string) => options.apis?.[key] },
    } as unknown as App;
    return { app, files, extensionSettings, imported, settings };
}

describe('data actions', () => {
    it('exports settings, the current chat and the known global files', async () => {
        const { app } = fakeApp();
        const bundle = await buildExport(app, new Date('2026-10-04T12:00:00Z'));
        expect(bundle).toMatchObject({
            format: EXPORT_FORMAT,
            version: 1,
            at: '2026-10-04T12:00:00.000Z',
            settings: { core: { mode: 'balanced' } },
            chatId: 'chat-1',
            chat: { inbox: { cards: [] } },
        });
        expect(Object.keys(bundle.files)).toEqual(['maestro-book-roles.json', 'maestro-autonomy.json']);
        expect(isExportBundle(bundle)).toBe(true);
        expect(isExportBundle({ format: 'other' })).toBe(false);
        expect(isExportBundle(null)).toBe(false);
        const noChat = await buildExport(fakeApp({ chatId: null }).app);
        expect(noChat.chat).toBeNull();
    });

    it('imports settings, only known files, and the chat documents into the open chat', async () => {
        const source = await buildExport(fakeApp().app);
        source.settings = { core: { mode: 'cinema' } };
        source.files['maestro-evil.json'] = { x: 1 };
        const { app, extensionSettings, files, imported, settings } = fakeApp({ chatId: 'chat-2' });
        const result = await applyImport(app, source);
        expect(extensionSettings.maestro).toEqual({ core: { mode: 'cinema' } });
        expect(settings.reload).toHaveBeenCalled();
        expect(settings.save).toHaveBeenCalled();
        expect(result).toEqual({ files: 2, chat: true });
        expect(files.has('maestro-evil.json')).toBe(false);
        expect(imported).toEqual([['chat-2', { inbox: { cards: [] } }]]);
    });

    it('prepares to turn off: exports every canon and handles the preset layer', async () => {
        const exportAll = vi.fn(async () => ['chat-1 — канон']);
        const layerPrepare = vi.fn(async (mode: string) =>
            mode === 'saveMerged' ? 'Marinara (со слоем)' : 'Marinara',
        );
        const apis = {
            canon: { exportAll },
            presetLayer: { get: () => ({ ops: [{ op: 'toggle' }] }), prepareDisable: layerPrepare },
        };
        const merged = await prepareDisable(fakeApp({ apis }).app, true);
        expect(merged).toEqual({ books: ['chat-1 — канон'], preset: 'Marinara (со слоем)', layer: true });
        expect(layerPrepare).toHaveBeenLastCalledWith('saveMerged');
        const base = await prepareDisable(fakeApp({ apis }).app, false);
        expect(base.preset).toBe('Marinara');
        expect(layerPrepare).toHaveBeenLastCalledWith('reselectBase');
        const noLayer = await prepareDisable(
            fakeApp({ apis: { ...apis, presetLayer: { get: () => null, prepareDisable: layerPrepare } } }).app,
            true,
        );
        expect(noLayer).toEqual({ books: ['chat-1 — канон'], preset: null, layer: false });
        expect(await prepareDisable(fakeApp().app, true)).toEqual({ books: [], preset: null, layer: false });
    });
});
