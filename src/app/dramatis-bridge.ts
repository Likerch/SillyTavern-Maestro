// Maestro's side of Dramatis's quiet modes that no module covers (release 1.17, docs/integration-dramatis.md): while the
// voice cards (M15) are off, CarrotKernel's «Character Consistency» insert still leaves the prompt of a generation in
// which Dramatis — present, claiming 'ck.consistency' — sends its cast block (Dramatis renders the speech itself through
// MAESTRO_API.speech()), and DES-RU is told to stop rebuilding that insert meanwhile. The code is the voice cards' own
// (src/features/voices/ck-quiet.ts). With M15 running it does all of this itself, so the bridge stays out of the way.
// The Medicine Check quiet mode is an M22 rule; the voice cards' merge lives in M15.
import { dramatisOf } from '../adapters';
import { CkQuiet } from '../features/voices/ck-quiet';
import type { App, Unsubscribe } from '../shared/contracts';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DramatisBridge {
    /** The last generation in which the bridge took CK's insert out (null: none yet). */
    last(): ReturnType<CkQuiet['remove']> | null;
    dispose(): void;
}

export function installDramatisBridge(app: App): DramatisBridge {
    const log = app.log.scope('dramatis');
    const ck = new CkQuiet(app, log);
    const offs: Unsubscribe[] = [];
    let last: ReturnType<CkQuiet['remove']> | null = null;
    /** The bridge told DES-RU to stop rebuilding CK's insert (given back when it no longer has to). */
    let claimed = false;

    const voicesRunning = (): boolean => app.modules.api('voices') !== undefined;

    const silences = (): boolean => {
        try {
            return dramatisOf(app)?.silences('ck.consistency') === true;
        } catch (error) {
            log.debug('Dramatis is not readable', error);
            return false;
        }
    };

    /** Takes DES-RU's function while the bridge acts, gives it back when it stops acting (M15 takes it while it runs). */
    const syncDesRu = (): void => {
        if (voicesRunning()) {
            claimed = false;
            return;
        }
        const wanted = ((): boolean => {
            try {
                const dramatis = dramatisOf(app);
                return !!dramatis && dramatis.isClaimed('ck.consistency') && dramatis.present();
            } catch {
                return false;
            }
        })();
        if (wanted && !claimed) {
            ck.claimDesRu();
            claimed = true;
        } else if (!wanted && claimed) {
            ck.releaseDesRu();
            claimed = false;
        }
    };

    const prompt = app.host.events.name('CHAT_COMPLETION_PROMPT_READY');
    if (prompt) {
        offs.push(
            app.host.events.on(prompt, (data) => {
                if (voicesRunning() || !isDict(data) || data.dryRun !== false || !Array.isArray(data.chat)) return;
                // Only Maestro's real generation: quiet requests of other extensions and sheet commands are left alone.
                const generation = app.turn.current();
                if (!generation || generation.quiet || generation.dryRun || generation.sheetCommand) return;
                if (!app.host.chatId() || !silences()) return;
                syncDesRu();
                last = ck.remove(data.chat as unknown[]);
            }),
        );
    }
    const dramatis = dramatisOf(app);
    if (dramatis) offs.push(dramatis.onQuietChange(() => syncDesRu()));
    offs.push(app.bus.on('chat:changed', () => syncDesRu()));

    return {
        last: () => (last ? { ...last } : null),
        dispose() {
            for (const off of offs.splice(0)) off();
            if (claimed && !voicesRunning()) ck.releaseDesRu();
            claimed = false;
        },
    };
}
