// M23 «Лор-студия», stage 2: the data layer (LoreStore, exposed as 'loreStore'), the studio window, its entry
// points (pult tab, /maestro-lore) and the optional takeover of ST's «Worlds/Lorebooks» button. The entry form is
// injected (form/index.ts, written separately) so this module can be built and tested without it.
import type { MaestroModule } from '../../shared/contracts';
import { DesLore } from './des-lore';
import type { RenderEntryForm } from './form-api';
import { StLore } from './st-lore';
import { STORE_KEY, LoreStoreService } from './store';
import type { LoreStore } from './store-api';
import { M23_STRINGS } from './strings';
import { LoreStudio, defaultStudioSettings } from './studio';
import type { LoreStudioSettings } from './studio';
import { M23_CSS } from './styles';
import { ButtonTakeover } from './takeover';
import { loreStudioTab } from './view-tab';

export const LORE_STUDIO_KEY = 'loreStudio';

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
            own(app.ui.style('m23-lore-studio', M23_CSS));

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
