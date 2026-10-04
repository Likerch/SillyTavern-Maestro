// The Settings tab's data buttons (plan §4.8 «Экспорт и импорт», §4.9 «Подготовить к отключению»): export and import
// of Maestro's data (settings, the current chat's documents, global Maestro files) and the preparation for turning
// Maestro off — every chat's canon becomes a plain lorebook and the preset layer is either dropped from the working
// copy or saved as a normal preset. What Maestro does at runtime (rules, flags, button takeovers) goes away by
// itself when it is disabled (P11); only what persists needs this step.
import { registerSettingsAction } from '../ui';
import type { App, I18nParts, Unsubscribe } from '../shared/contracts';
import type { CanonApi } from '../features/canon/api';
import type { PresetLayerApi } from '../features/presetStudio/layer-api';

export const EXPORT_FORMAT = 'maestro-export';

/** Global Maestro files worth carrying over (per-chat documents travel with the chat bundle). */
export const GLOBAL_FILES: readonly string[] = [
    'maestro-book-roles.json',
    'maestro-entry-meta.json',
    'maestro-autonomy.json',
    'maestro-baseline.json',
    'maestro-preset-layers.json',
    'maestro-metrics-packs.json',
];

export interface ExportBundle {
    format: typeof EXPORT_FORMAT;
    version: 1;
    at: string;
    settings: unknown;
    chatId: string | null;
    chat: Record<string, unknown> | null;
    files: Record<string, unknown>;
}

export const DATA_ACTION_STRINGS: I18nParts = {
    en: {
        'app.data.exported': 'Maestro data saved to {file}.',
        'app.data.importTitle': 'Import Maestro data?',
        'app.data.importBody':
            'Settings, global Maestro files and, for this chat, its Maestro documents are replaced by the file from {at}. The page reloads the settings right away.',
        'app.data.importChatOther':
            'The file holds the documents of another chat ({chat}); they are imported into the open chat.',
        'app.data.imported': 'Maestro data imported: settings, {files} files{chat}.',
        'app.data.importedChat': ', this chat’s documents',
        'app.data.badFile': 'This is not a Maestro export file.',
        'app.prepare.title': 'Prepare to turn Maestro off?',
        'app.prepare.body':
            'Every chat’s canon becomes a plain lorebook (overrides expanded, suppressed entries listed in a note). The preset layer is either removed from the working copy or saved as a separate preset. Rules, flags and button takeovers go away by themselves when Maestro is off.',
        'app.prepare.mergedQuestion': 'Save the preset with your layer as a separate preset?',
        'app.prepare.mergedBody':
            'Yes: a new preset «base + layer» is saved and selected. No: the base preset is selected again without the layer.',
        'app.prepare.report': 'Ready to turn off. Canon exported: {books}. Preset: {preset}.',
        'app.prepare.noCanon': 'no canon',
        'app.prepare.noLayer': 'no layer',
        'app.prepare.failed': 'Preparing to turn off stopped: {error}',
    },
    ru: {
        'app.data.exported': 'Данные Maestro сохранены в {file}.',
        'app.data.importTitle': 'Импортировать данные Maestro?',
        'app.data.importBody':
            'Настройки, общие файлы Maestro и документы Maestro этого чата заменятся данными из файла от {at}. Настройки перечитаются сразу.',
        'app.data.importChatOther': 'В файле документы другого чата ({chat}) — они импортируются в открытый чат.',
        'app.data.imported': 'Данные Maestro импортированы: настройки, файлов — {files}{chat}.',
        'app.data.importedChat': ', документы этого чата',
        'app.data.badFile': 'Это не файл экспорта Maestro.',
        'app.prepare.title': 'Подготовить Maestro к отключению?',
        'app.prepare.body':
            'Канон каждого чата станет обычным лорбуком (переопределения развёрнуты, подавленные записи перечислены в заметке). Слой пресета либо уберётся из рабочей копии, либо сохранится отдельным пресетом. Правила, флаги и перехваты кнопок исчезнут сами, когда Maestro выключен.',
        'app.prepare.mergedQuestion': 'Сохранить пресет вместе со слоем как отдельный пресет?',
        'app.prepare.mergedBody':
            'Да — сохранится и выберется новый пресет «база + слой». Нет — снова выберется базовый пресет без слоя.',
        'app.prepare.report': 'Можно выключать. Канон выгружен: {books}. Пресет: {preset}.',
        'app.prepare.noCanon': 'канона нет',
        'app.prepare.noLayer': 'слоя нет',
        'app.prepare.failed': 'Подготовка к отключению остановилась: {error}',
    },
};

function stamp(date: Date): string {
    return date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

async function download(app: App, text: string, file: string): Promise<void> {
    try {
        const utils = await app.host.modules.utils();
        const fn = utils.download as ((content: string, name: string, type: string) => void) | undefined;
        if (typeof fn === 'function') {
            fn(text, file, 'application/json');
            return;
        }
    } catch {
        // fall through to a plain link
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
    });
}

export function isExportBundle(value: unknown): value is ExportBundle {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as ExportBundle).format === EXPORT_FORMAT &&
        (value as ExportBundle).version === 1
    );
}

export async function buildExport(app: App, now = new Date()): Promise<ExportBundle> {
    const chatId = app.host.chatId();
    const files: Record<string, unknown> = {};
    for (const name of GLOBAL_FILES) {
        try {
            const data = await app.files.read(name);
            if (data !== null && data !== undefined) files[name] = data;
        } catch {
            // missing files are simply not exported
        }
    }
    return {
        format: EXPORT_FORMAT,
        version: 1,
        at: now.toISOString(),
        settings: JSON.parse(JSON.stringify(app.host.ctx().extensionSettings.maestro ?? {})) as unknown,
        chatId,
        chat: chatId ? await app.chat.exportChat(chatId) : null,
        files,
    };
}

export async function applyImport(app: App, bundle: ExportBundle): Promise<{ files: number; chat: boolean }> {
    const store = app.host.ctx().extensionSettings as Record<string, unknown>;
    store.maestro = JSON.parse(JSON.stringify(bundle.settings ?? {})) as unknown;
    app.settings.reload?.();
    app.settings.save();
    let count = 0;
    for (const [name, data] of Object.entries(bundle.files ?? {})) {
        if (!GLOBAL_FILES.includes(name)) continue;
        await app.files.write(name, data);
        count++;
    }
    const chatId = app.host.chatId();
    const chat = !!(chatId && bundle.chat);
    if (chatId && bundle.chat) await app.chat.importChat(chatId, bundle.chat);
    return { files: count, chat };
}

/** «Подготовить к отключению»: canon of every chat → plain lorebooks; the preset layer → dropped or saved merged. */
export async function prepareDisable(
    app: App,
    saveMerged: boolean,
): Promise<{ books: string[]; preset: string | null; layer: boolean }> {
    const canon = app.modules.api<CanonApi>('canon');
    const books = canon?.exportAll ? await canon.exportAll() : [];
    const layer = app.modules.api<PresetLayerApi>('presetLayer');
    let preset: string | null = null;
    let hasLayer = false;
    if (layer?.prepareDisable) {
        const current = app.host.ctx().chatCompletionSettings?.preset_settings_openai;
        hasLayer = typeof current === 'string' && (layer.get(current)?.ops.length ?? 0) > 0;
        if (hasLayer) preset = await layer.prepareDisable(saveMerged ? 'saveMerged' : 'reselectBase');
    }
    return { books, preset, layer: hasLayer };
}

export function installDataActions(app: App): Unsubscribe[] {
    app.i18n.register(DATA_ACTION_STRINGS);
    const t = app.i18n.t.bind(app.i18n);
    const offs: Unsubscribe[] = [];

    offs.push(
        registerSettingsAction('export', 'ui.settings.export', async () => {
            const bundle = await buildExport(app);
            const file = `maestro-export-${stamp(new Date())}.json`;
            await download(app, JSON.stringify(bundle, null, 2), file);
            app.ui.notice(t('app.data.exported', { file }), { urgent: true, level: 'info' });
        }),
    );

    offs.push(
        registerSettingsAction('import', 'ui.settings.import', async () => {
            const file = await pickFile();
            if (!file) return;
            let bundle: unknown;
            try {
                bundle = JSON.parse(await file.text());
            } catch {
                bundle = null;
            }
            if (!isExportBundle(bundle)) {
                app.ui.notice(t('app.data.badFile'), { urgent: true, level: 'error' });
                return;
            }
            const chatId = app.host.chatId();
            const other = bundle.chat && bundle.chatId && chatId && bundle.chatId !== chatId;
            const body = [
                t('app.data.importBody', { at: bundle.at.slice(0, 16).replace('T', ' ') }),
                other ? t('app.data.importChatOther', { chat: bundle.chatId ?? '' }) : '',
            ]
                .filter(Boolean)
                .join('\n\n');
            if (!(await app.ui.confirm(t('app.data.importTitle'), body))) return;
            const result = await applyImport(app, bundle);
            app.ui.notice(
                t('app.data.imported', {
                    files: result.files,
                    chat: result.chat ? t('app.data.importedChat') : '',
                }),
                { urgent: true, level: 'info' },
            );
        }),
    );

    offs.push(
        registerSettingsAction(
            'prepareDisable',
            'ui.settings.prepareDisable',
            async () => {
                if (!(await app.ui.confirm(t('app.prepare.title'), t('app.prepare.body')))) return;
                const layer = app.modules.api<PresetLayerApi>('presetLayer');
                const current = app.host.ctx().chatCompletionSettings?.preset_settings_openai;
                const layered = typeof current === 'string' && (layer?.get(current)?.ops.length ?? 0) > 0;
                const merged = layered
                    ? await app.ui.confirm(t('app.prepare.mergedQuestion'), t('app.prepare.mergedBody'))
                    : false;
                try {
                    const result = await prepareDisable(app, merged);
                    app.ui.notice(
                        t('app.prepare.report', {
                            books: result.books.length ? result.books.join(', ') : t('app.prepare.noCanon'),
                            preset: result.layer ? (result.preset ?? '—') : t('app.prepare.noLayer'),
                        }),
                        { urgent: true, level: 'info' },
                    );
                } catch (error) {
                    app.ui.notice(
                        t('app.prepare.failed', { error: error instanceof Error ? error.message : String(error) }),
                        { urgent: true, level: 'error' },
                    );
                }
            },
            { icon: 'fa-power-off', danger: true },
        ),
    );
    return offs;
}
