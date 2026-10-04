// What the M9 services share: the app, the settings, the chat document, typed access to the neighbour modules
// (canon, world model, places) and Qvink's slash commands.
import { adaptersOf } from '../../adapters';
import type { QvinkAdapter } from '../../adapters/qvink';
import type { App, Logger } from '../../shared/contracts';
import type { CanonApi } from '../canon/api';
import type { PlacesApi } from '../places/api';
import type { WorldModelApi } from '../world/api';
import type { ChronicleSettings } from './settings';
import type { ChronicleStore } from './store';

type Dict = Record<string, unknown>;

export interface ChronicleEnv {
    app: App;
    log: Logger;
    store: ChronicleStore;
    settings(): ChronicleSettings;
    t(key: string, params?: Record<string, string | number>): string;
    canon(): CanonApi | undefined;
    world(): WorldModelApi | undefined;
    places(): PlacesApi | undefined;
    qvink(): QvinkAdapter;
    /** Qvink is installed and on for this chat. */
    qvinkReady(): boolean;
    slashExists(name: string): boolean;
    /** Runs an STscript line quietly; a failed command throws. */
    runSlash(command: string): Promise<void>;
}

export function createChronicleEnv(
    app: App,
    log: Logger,
    store: ChronicleStore,
    settings: () => ChronicleSettings,
): ChronicleEnv {
    const qvink = () => adaptersOf(app).qvink;
    const env: ChronicleEnv = {
        app,
        log,
        store,
        settings,
        t: (key, params) => app.i18n.t(key, params),
        canon: () => app.modules.api<CanonApi>('canon'),
        world: () => app.modules.api<WorldModelApi>('world'),
        places: () => app.modules.api<PlacesApi>('places'),
        qvink,
        qvinkReady: () => {
            try {
                const adapter = qvink();
                return adapter.present() && adapter.chatEnabled();
            } catch {
                return false;
            }
        },
        slashExists(name) {
            const commands = (app.host.ctx() as Partial<STContext>).SlashCommandParser?.commands;
            return typeof commands === 'object' && commands !== null && name in commands;
        },
        async runSlash(command) {
            const ctx = app.host.ctx();
            if (typeof ctx.executeSlashCommandsWithOptions !== 'function') throw new Error(command);
            const result = await ctx.executeSlashCommandsWithOptions(command, {
                handleParserErrors: false,
                handleExecutionErrors: false,
                source: 'maestro',
            });
            if (typeof result === 'object' && result !== null && (result as Dict).isError === true) {
                const message = (result as Dict).errorMessage;
                throw new Error(typeof message === 'string' ? message : command);
            }
        },
    };
    return env;
}
