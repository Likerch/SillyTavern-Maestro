// M23 «Лор-студия», stage 2: the data layer (LoreStore, exposed as 'loreStore'), the studio window, its entry
// points (pult tab, /maestro-lore) and the optional takeover of ST's «Worlds/Lorebooks» button. The entry form is
// injected (form/index.ts, written separately) so this module can be built and tested without it.
import { formatClip, formatPlain } from '../../core/labels';
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import { DesLore } from './des-lore';
import type { RenderEntryForm } from './form-api';
import { userJobs } from './jobs';
import { StLore } from './st-lore';
import { STORE_KEY, LoreStoreService, UNDO_BINDING, UNDO_BOOK, UNDO_ENTRY, UNDO_SETTINGS } from './store';
import type { LoreStore } from './store-api';
import { M23_STRINGS } from './strings';
import { LoreStudio, defaultStudioSettings, loreStudioWindow } from './studio';
import type { LoreStudioSettings } from './studio';
import { M23_CSS } from './styles';
import { ButtonTakeover } from './takeover';
import { loreStudioTab } from './view-tab';

export const LORE_STUDIO_KEY = 'loreStudio';

/** Yes for a set flag, nothing otherwise (the row then shows as added or removed). */
function flag(value: unknown, i18n: I18n): string {
    return value === true ? i18n.t('core.value.yes') : '';
}

/** A binding: on/off for a global book, a book name, a list of names, «нет» for none. */
function binding(value: unknown, i18n: I18n): string {
    if (typeof value === 'boolean') return i18n.t(value ? 'm23.value.on' : 'm23.value.off');
    if (value === null || (Array.isArray(value) && !value.length)) return i18n.t('m23.value.none');
    return formatPlain(value, i18n);
}

/**
 * Lore Studio changes: an entry reads by its title and on/off state (its text and keys are often English and long —
 * «Подробнее»), a book snapshot by its entry count, bindings by book names. The WI settings are ST's own option keys.
 */
export const LORE_STUDIO_TARGETS: TargetSpec[] = [
    {
        target: UNDO_ENTRY,
        fields: {
            comment: { labelKey: 'm23.field.title', format: formatClip(80) },
            disable: { labelKey: 'm23.field.off', format: flag },
            constant: { labelKey: 'm23.field.always', format: flag },
            content: { labelKey: 'm23.field.text', hidden: true },
            key: { labelKey: 'm23.field.keys', hidden: true },
        },
    },
    { target: UNDO_BOOK, fields: { entries: { labelKey: 'm23.field.entries' } } },
    { target: UNDO_BINDING, format: binding, nullable: true },
    { target: UNDO_SETTINGS, technical: true },
];

/** Runtime handles of a started module (tests, other code in this feature). */
export interface LoreStudioRuntime {
    store: LoreStoreService;
    studio: LoreStudio;
    takeover: ButtonTakeover;
}

let runtime: LoreStudioRuntime | null = null;

export function loreStudioRuntime(): LoreStudioRuntime | null {
    return runtime;
}

export function createLoreStudioModule(renderForm: RenderEntryForm | null): MaestroModule<LoreStudioSettings> {
    return {
        id: 'M23',
        key: LORE_STUDIO_KEY,
        stage: 2,
        titleKey: 'm23.title',
        enabledByDefault: true,
        defaults: defaultStudioSettings,
        requires: ['st.wi.module'],
        i18n: M23_STRINGS,
        targets: LORE_STUDIO_TARGETS,
        init({ app, settings, log, own }) {
            const st = new StLore(app, log);
            const des = new DesLore(app, log);
            const store = new LoreStoreService({ app, log, st, des });
            own(store.install());
            app.modules.expose(STORE_KEY, store satisfies LoreStore);
            own(() => app.modules.expose(STORE_KEY, undefined));

            const saveSettings = () => {
                app.settings.notify(`modules.${LORE_STUDIO_KEY}`);
                app.settings.save();
            };
            const ref: { studio: LoreStudio | null } = { studio: null };
            const takeover = new ButtonTakeover({ app, log, open: (book) => ref.studio?.open(book) });
            const studio = new LoreStudio({
                app,
                log,
                store,
                renderForm,
                settings,
                saveSettings,
                openClassic: (book) => takeover.openClassic(book),
            });
            ref.studio = studio;
            runtime = { store, studio, takeover };
            // Other modules (dossier, places, BunnyMo mode) open the studio on a book and entry.
            app.modules.expose(LORE_STUDIO_KEY, { open: (book?: string, uid?: number) => studio.open(book, uid) });
            own(() => {
                studio.dispose();
                if (runtime?.studio === studio) runtime = null;
            });
            // P11: a disabled studio leaves nothing running (a Localizer without «stop» finishes on its own).
            own(() => {
                const jobs = userJobs(app);
                for (const job of jobs.list()) {
                    if (job.module === LORE_STUDIO_KEY && job.state === 'active') jobs.cancel(job.key);
                }
            });
            own(app.ui.style('m23-lore-studio', M23_CSS));
            // Plan-2 §10: the studio is a non-modal Maestro window.
            if (typeof app.ui.addWindow === 'function') own(app.ui.addWindow(loreStudioWindow(studio)));

            const setTakeover = async (on: boolean): Promise<boolean> => {
                settings.takeoverButton = on;
                saveSettings();
                if (!on) {
                    takeover.restore();
                    return true;
                }
                return takeover.install();
            };
            own(
                app.ui.addTab(
                    loreStudioTab(app, {
                        settings,
                        open: () => studio.open(),
                        openClassic: () => void takeover.openClassic(),
                        setTakeover,
                        takeoverActive: () => takeover.active(),
                        bookCount: () => store.books().length,
                    }),
                ),
            );
            own(
                app.ui.addSlashCommand({
                    name: 'maestro-lore',
                    helpKey: 'm23.slash.help',
                    args: [{ name: 'value', descriptionKey: 'm23.slash.book', optional: true }],
                    callback: (_args, value) => {
                        const book = value.trim();
                        studio.open(book || undefined);
                        return '';
                    },
                }),
            );

            // Restoring ST's and DES's handlers is part of every disable (P11).
            own(() => takeover.restore());
            if (settings.takeoverButton) {
                void takeover.install().then((ok) => {
                    if (!ok) log.warn('the World Info button could not be taken over (no jQuery, toggle or handler)');
                });
            }
        },
    };
}
