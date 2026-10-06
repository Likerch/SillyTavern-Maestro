// M6 «Канон чата» (plan M6, M20 п. 5; dev-plan 2.3, 2.4): one lorebook per chat holding what the story changed —
// overrides replacing base entries in place, additions, suppressions and pins — mixed into every World Info scan
// and never switched on by itself; canon budget, archive with return on mention, base drift, promotion, branches,
// the plain export, Russian keys and scan-only English glosses. Exposed as app.modules.api<CanonApi>('canon').
import { adaptersOf } from '../../adapters';
import { isCanonBookName } from '../../domain/roles-detect';
import type { MaestroModule, Unsubscribe } from '../../shared/contracts';
import type { CanonApi } from './api';
import { CanonBranches } from './branch';
import { CanonGlosses } from './glosses';
import { CanonScan, defaultCanonSettings } from './scan';
import type { CanonSettings } from './scan';
import { CANON_ID, CANON_KEY, CanonStore } from './store';
import { CANON_STRINGS, CANON_TARGETS } from './strings';
import { CANON_CSS, canonTab } from './view';

function readSettings(slice: Partial<CanonSettings>): CanonSettings {
    const defaults = defaultCanonSettings();
    if (typeof slice.budgetChars !== 'number' || !Number.isFinite(slice.budgetChars) || slice.budgetChars < 0) {
        slice.budgetChars = defaults.budgetChars;
    }
    if (typeof slice.scanGlosses !== 'boolean') slice.scanGlosses = defaults.scanGlosses;
    if (typeof slice.glossMessages !== 'number' || !Number.isFinite(slice.glossMessages)) {
        slice.glossMessages = defaults.glossMessages;
    }
    return slice as CanonSettings;
}

export const canonModule: MaestroModule<CanonSettings> = {
    id: CANON_ID,
    key: CANON_KEY,
    stage: 2,
    titleKey: 'm6.title',
    enabledByDefault: true,
    defaults: defaultCanonSettings,
    requires: ['st.events.entriesLoaded', 'st.events.scanDone'],
    i18n: CANON_STRINGS,
    targets: CANON_TARGETS,
    init({ app, log, own }) {
        const settings = () => readSettings(app.settings.module<Partial<CanonSettings>>(CANON_KEY));
        const store = new CanonStore(app, log);
        for (const off of store.install()) own(off);
        const glosses = new CanonGlosses(app, store, settings, log);
        for (const off of glosses.install()) own(off);
        const scan = new CanonScan(app, store, settings, glosses, log);
        for (const off of scan.install()) own(off);
        const branches = new CanonBranches(app, store, log);
        for (const off of branches.install()) own(off);

        const api: Required<CanonApi> = {
            bookName: (chatId) => store.bookName(chatId),
            ensureBook: () => store.ensureBook(),
            list: (filter) => store.list(filter),
            put: (draft, options) => store.put(draft, options),
            remove: (uid) => store.remove(uid),
            setStatus: (uid, status) => store.setStatus(uid, status),
            promote: (uid) => store.promote(uid),
            baseDrift: () => store.baseDrift(),
            exportPlain: () => store.exportPlain(),
            budget: () => scan.budget(),
            russianKeys: async (term) => glosses.russianKeys(term),
            onChange: (listener) => {
                const offs: Unsubscribe[] = [store.onChange(listener), scan.onReport(listener)];
                return () => offs.forEach((off) => off());
            },
            lastScan: () => scan.lastScan(),
            renameBase: (oldName, newName) => store.renameBase(oldName, newName),
            exportAll: () => store.exportAll(),
        };
        app.modules.expose(CANON_KEY, api);

        own(app.ui.style('m6-view', CANON_CSS));
        own(app.ui.addTab(canonTab(app, store, scan)));
        own(
            app.ui.addHealthCheck({
                id: 'm6.inactive',
                module: CANON_ID,
                titleKey: 'm6.health.title',
                async run() {
                    let books: string[];
                    try {
                        books = (await adaptersOf(app).bunnymo.activeBooks()).filter(isCanonBookName);
                    } catch {
                        return { status: 'skip' };
                    }
                    return books.length
                        ? { status: 'warn', message: app.i18n.t('m6.health.active', { books: books.join(', ') }) }
                        : { status: 'ok', message: app.i18n.t('m6.health.ok') };
                },
            }),
        );
        // A chat opened before Maestro started may already be a branch.
        void branches.check();
    },
};

export { CANON_STRINGS, CANON_TARGETS } from './strings';
export { CanonStore } from './store';
export { CanonScan, defaultCanonSettings } from './scan';
export type { CanonSettings } from './scan';
export type { CanonApi, CanonDraft, CanonItem, CanonMeta } from './api';
