// M4 «Страж настроек и вкладок» (plan M4; dev-plan 1.4; audit T11, A17, B17): a baseline of the curated settings
// of the stack (tracked.ts), drift as one Inbox card at a time, restore with undo, and the tab guard that holds
// saves of an out-of-date tab (tab-guard.ts). Exposes GuardianApi under 'guardian'.
import { currentTabId } from '../../core/files';
import { SETTINGS_KEY } from '../../core/settings';
import type { App, MaestroModule } from '../../shared/contracts';
import { BANNER_CSS, StaleBanner } from './banner';
import { DRIFT_KIND, GuardianService, SETTING_TARGET } from './service';
import { GUARDIAN_STRINGS } from './strings';
import { TabGuard } from './tab-guard';
import type { GuardianSlice } from './tab-guard';
import { guardianTab } from './view';

export type GuardianSettings = GuardianSlice;

/** Where ST keeps our stamp inside settings.json (the settings slice of this module). */
export const STAMP_PATH = `extension_settings.${SETTINGS_KEY}.modules.guardian.stamp`;
const MINUTE = 60_000;

/** settings.json as text: POST /api/settings/get returns `{ settings: "<file contents>", … }` (endpoints/settings.js). */
export async function fetchServerSettings(app: App): Promise<string | null> {
    const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: app.host.ctx().getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    const text = data && typeof data === 'object' ? (data as Record<string, unknown>).settings : undefined;
    return typeof text === 'string' ? text : null;
}

export const guardianModule: MaestroModule<GuardianSettings> = {
    id: 'M4',
    key: 'guardian',
    stage: 1,
    titleKey: 'm4.title',
    enabledByDefault: true,
    defaults: () => ({ autoCheckMinutes: 10 }),
    i18n: GUARDIAN_STRINGS,
    // Settings values (preset bodies, regex scripts, extension keys) are technical: the card's description names
    // what changed, the values themselves stay under «Подробнее».
    targets: [{ target: SETTING_TARGET, technical: true }],

    init({ app, settings, log, own }) {
        const t = app.i18n.t.bind(app.i18n);
        const service = new GuardianService(app, log, t);

        const banner = new StaleBanner(t, {
            reload: () => window.location.reload(),
            saveAnyway: () => guard.saveAnyway(),
        });
        own(app.ui.style('m4-banner', BANNER_CSS));
        const guard: TabGuard = new TabGuard({
            gate: app.host.fetchGate,
            stampPath: STAMP_PATH,
            myTabId: currentTabId(),
            slice: () => settings,
            fetchServer: () => fetchServerSettings(app),
            local: () => {
                const ctx = app.host.ctx() as STContext & { chatCompletionSettings?: unknown };
                return {
                    extension_settings: ctx.extensionSettings,
                    power_user: ctx.powerUserSettings,
                    oai_settings: ctx.chatCompletionSettings,
                };
            },
            now: () => Date.now(),
            log: log.scope('tabs'),
            document: typeof document === 'undefined' ? null : document,
            window: typeof window === 'undefined' ? null : window,
            onChange: () => {
                banner.render(guard.info());
                app.ui.refresh();
                service.emit();
            },
        });
        guard.install();
        service.guard = guard;
        own(() => guard.dispose());
        own(() => banner.remove());

        app.modules.expose('guardian', service);
        // Settings edits are never promoted to 'auto' (plan §8).
        app.autonomy.neverAuto(DRIFT_KIND);
        app.journal.registerUndo(SETTING_TARGET, (change) => service.undoChange(change));
        own(
            app.inbox.registerApplier(
                DRIFT_KIND,
                (payload) => service.applyCard(payload),
                (payload) => service.cardValid(payload),
            ),
        );
        own(app.inbox.onChange(() => void service.onInboxChange()));
        own(app.bus.on('chat:changed', () => service.forgetCards()));
        own(
            app.leader.onChange((leader) => {
                if (leader) void service.checkDrift();
            }),
        );
        own(app.ui.addTab(guardianTab(app, service, t)));

        const minutes = Math.max(1, Number(settings.autoCheckMinutes) || 10);
        const timer = setInterval(() => void service.checkDrift(), minutes * MINUTE);
        own(() => clearInterval(timer));

        // Loading the baseline is a file request: not awaited, so other modules start meanwhile.
        void service
            .start()
            .then(() => service.checkDrift())
            .catch((error: unknown) => log.warn('baseline start failed', error));
    },
};
