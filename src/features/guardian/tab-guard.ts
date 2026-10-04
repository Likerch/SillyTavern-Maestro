// Tab guard (plan M4 п. 4, audit T11/B17). SillyTavern has no settings revision: /api/settings/save simply
// overwrites settings.json, and a tab saves on its own (≈440 call sites), so a forgotten tab or another device
// silently rolls settings back. Maestro keeps a stamp {tabId, seq, at} in its settings slice, which ST writes into
// settings.json with every save:
// - after each successful save from this tab (fetch gate afterResponse) the stamp on the server is "ours" and the
//   seq is bumped for the next save (we never trigger a save ourselves — that would loop);
// - on returning to the tab (visibilitychange → visible, window focus; at most once a minute) and always before the
//   first save after the tab was hidden, POST /api/settings/get is read and its stamp compared;
// - while the check runs, saves of settings, presets and lorebooks wait for it; when the tab is stale they are held
//   (oldest beyond a small limit vetoed with a non-ok Response, so ST shows its own "could not be saved" toast —
//   never a fake ok) until the user reloads or chooses "save anyway".
// Request bodies may be gzip-compressed (request-compression.js): they are never parsed.
import {
    getPath,
    isTabFresh,
    parseSettingsText,
    readStamp,
    stableStringify,
    topLevelDiff,
} from '../../domain/settings-diff';
import type { KnownStamp, TabStamp } from '../../domain/settings-diff';
import type { FetchGate, Logger, Unsubscribe } from '../../shared/contracts';

export type TabState = 'fresh' | 'stale' | 'checking' | 'unknown';
export type SaveKind = 'settings' | 'preset' | 'worldinfo';

export const SAVE_RE = /\/api\/(?:settings\/save|presets\/save|worldinfo\/edit)(?:[?#]|$)/;
export const SETTINGS_SAVE_RE = /\/api\/settings\/save(?:[?#]|$)/;
/** Proactive checks on focus are rate-limited; the check before a save is not. */
export const CHECK_INTERVAL_MS = 60_000;
/** Held saves per kind; older ones are vetoed (a newer settings save carries everything anyway). */
export const HOLD_LIMIT = 3;
const OVERWRITE_LIMIT = 40;

export interface GuardianSlice {
    stamp?: TabStamp;
    autoCheckMinutes: number;
}

/** Events the guard listens to (document and window in the browser). */
export interface PageTarget {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

export interface TabGuardEnv {
    gate: FetchGate;
    /** Path of the stamp inside settings.json (`extension_settings.maestro.modules.guardian.stamp`). */
    stampPath: string;
    myTabId: string;
    slice(): GuardianSlice;
    /** settings.json as text from POST /api/settings/get; null when the server did not answer. */
    fetchServer(): Promise<string | null>;
    /** This tab's copies of the big settings.json sections (for the "would overwrite" list). */
    local(): { extension_settings?: unknown; power_user?: unknown; oai_settings?: unknown };
    now(): number;
    log: Logger;
    document: (PageTarget & { visibilityState?: string }) | null;
    window: PageTarget | null;
    onChange(): void;
}

interface Held {
    kind: SaveKind;
    at: number;
    resolve: (value: Response | void) => void;
}

export interface GuardInfo {
    state: TabState;
    /** Top-level settings keys this tab would overwrite (best effort, filled when stale). */
    overwrites: string[];
    held: Record<SaveKind, number>;
    vetoed: Record<SaveKind, number>;
    lastCheckAt: number;
    server: TabStamp | null;
}

export function saveKindOf(url: string): SaveKind {
    if (/\/api\/presets\/save/.test(url)) return 'preset';
    if (/\/api\/worldinfo\/edit/.test(url)) return 'worldinfo';
    return 'settings';
}

function zero(): Record<SaveKind, number> {
    return { settings: 0, preset: 0, worldinfo: 0 };
}

function vetoResponse(): Response {
    return new Response(JSON.stringify({ error: 'Maestro: this tab is out of date; reload it before saving' }), {
        status: 409,
        statusText: 'Stale tab (Maestro)',
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Maestro's own slice without the stamp (which differs between tabs by design). */
function maestroWithoutStamp(value: unknown, stampPath: string): unknown {
    if (value === undefined) return undefined;
    let copy: unknown;
    try {
        copy = JSON.parse(stableStringify(value));
    } catch {
        return value;
    }
    const parts = stampPath.split('.').slice(2); // drop 'extension_settings.maestro'
    const last = parts.pop();
    const parent = getPath(copy, parts.join('.'));
    if (last && parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[last];
    return copy;
}

/** What a save from this tab would overwrite: differing top-level keys of the three big sections. */
export function overwriteList(
    local: ReturnType<TabGuardEnv['local']>,
    server: Record<string, unknown>,
    stampPath: string,
): string[] {
    const list = topLevelDiff(local.extension_settings, server.extension_settings, {
        prefix: 'extension_settings',
        ignore: ['maestro'],
        limit: OVERWRITE_LIMIT,
    });
    const localMaestro = maestroWithoutStamp(getPath(local.extension_settings, 'maestro'), stampPath);
    const serverMaestro = maestroWithoutStamp(getPath(server.extension_settings, 'maestro'), stampPath);
    try {
        if (stableStringify(localMaestro) !== stableStringify(serverMaestro)) list.push('extension_settings.maestro');
    } catch {
        // not comparable
    }
    list.push(...topLevelDiff(local.power_user, server.power_user, { prefix: 'power_user', limit: OVERWRITE_LIMIT }));
    list.push(
        ...topLevelDiff(local.oai_settings, server.oai_settings, { prefix: 'oai_settings', limit: OVERWRITE_LIMIT }),
    );
    return list.slice(0, OVERWRITE_LIMIT);
}

export class TabGuard {
    private stateValue: TabState = 'fresh';
    private known: KnownStamp;
    /** Bumped whenever `known` changes: a check that overlapped a save of ours is re-judged. */
    private knownVersion = 0;
    private dirty = false;
    private lastCheckAt = 0;
    private checking: Promise<void> | null = null;
    private readonly heldList: Held[] = [];
    private readonly vetoed = zero();
    private overwrites: string[] = [];
    private lastServer: TabStamp | null = null;
    private readonly disposers: Unsubscribe[] = [];
    private disposed = false;

    constructor(private readonly env: TabGuardEnv) {
        const slice = env.slice();
        const loaded = readStamp(slice.stamp);
        // The page loaded settings.json just before Maestro started: the stamp in it is what the server holds.
        this.known = { kind: 'exact', stamp: loaded };
        this.lastServer = loaded;
        // The next save from this tab carries a stamp of its own.
        slice.stamp = { tabId: env.myTabId, seq: loaded?.tabId === env.myTabId ? loaded.seq + 1 : 1, at: env.now() };
    }

    install(): void {
        const { gate } = this.env;
        this.disposers.push(gate.beforeRequest(SAVE_RE, (url) => this.beforeSave(url)));
        this.disposers.push(gate.afterResponse(SETTINGS_SAVE_RE, (_url, response) => this.afterSettingsSave(response)));
        const doc = this.env.document;
        if (doc) {
            const onVisibility = () => {
                if (doc.visibilityState === 'hidden') this.dirty = true;
                else this.maybeCheck();
            };
            doc.addEventListener('visibilitychange', onVisibility);
            this.disposers.push(() => doc.removeEventListener('visibilitychange', onVisibility));
        }
        const win = this.env.window;
        if (win) {
            const onFocus = () => this.maybeCheck();
            win.addEventListener('focus', onFocus);
            this.disposers.push(() => win.removeEventListener('focus', onFocus));
        }
    }

    state(): TabState {
        return this.stateValue;
    }

    info(): GuardInfo {
        const held = zero();
        for (const item of this.heldList) held[item.kind]++;
        return {
            state: this.stateValue,
            overwrites: [...this.overwrites],
            held,
            vetoed: { ...this.vetoed },
            lastCheckAt: this.lastCheckAt,
            server: this.lastServer,
        };
    }

    /** Compares this tab's stamp with the server now (one check at a time). */
    check(): Promise<void> {
        if (this.checking) return this.checking;
        const previous = this.stateValue;
        // A stale tab stays stale (banner up, saves held) until a check proves otherwise.
        if (previous !== 'stale') this.setState('checking');
        const run = this.runCheck(previous).finally(() => {
            if (this.checking === run) this.checking = null;
        });
        this.checking = run;
        return run;
    }

    /** "Сохранить всё равно": this tab wins; held saves go out in order. */
    saveAnyway(): void {
        this.setKnown({ kind: 'exact', stamp: this.lastServer });
        this.dirty = false;
        this.lastCheckAt = this.env.now();
        this.overwrites = [];
        this.setState('fresh');
        this.releaseAll();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const dispose of this.disposers.splice(0)) {
            try {
                dispose();
            } catch (error) {
                this.env.log.debug('tab guard dispose', error);
            }
        }
        // Without the guard nothing should stay blocked.
        this.releaseAll();
    }

    private maybeCheck(): void {
        if (this.disposed || this.checking) return;
        if (this.env.now() - this.lastCheckAt < CHECK_INTERVAL_MS) return;
        void this.check();
    }

    private async beforeSave(url: string): Promise<Response | void> {
        if (this.disposed) return;
        if (this.stateValue !== 'stale' && (this.dirty || this.checking)) await this.check();
        if (this.disposed || this.stateValue !== 'stale') return;
        return this.hold(saveKindOf(url));
    }

    private hold(kind: SaveKind): Promise<Response | void> {
        return new Promise((resolve) => {
            this.heldList.push({ kind, at: this.env.now(), resolve });
            const same = this.heldList.filter((item) => item.kind === kind);
            if (same.length > HOLD_LIMIT) {
                const oldest = same[0] as Held;
                this.heldList.splice(this.heldList.indexOf(oldest), 1);
                this.vetoed[kind]++;
                this.env.log.warn(`stale tab: an older ${kind} save was refused`);
                oldest.resolve(vetoResponse());
            }
            this.env.onChange();
        });
    }

    private releaseAll(): void {
        const held = this.heldList.splice(0);
        for (const item of held) item.resolve();
        if (held.length && !this.disposed) this.env.onChange();
    }

    private afterSettingsSave(response: Response): void {
        if (this.disposed || !response.ok) return;
        this.setKnown({ kind: 'mine' });
        const slice = this.env.slice();
        const current = readStamp(slice.stamp);
        const seq = (current?.tabId === this.env.myTabId ? current.seq : 0) + 1;
        slice.stamp = { tabId: this.env.myTabId, seq, at: this.env.now() };
        if (this.stateValue === 'unknown') this.setState('fresh');
    }

    private async runCheck(previous: TabState): Promise<void> {
        const version = this.knownVersion;
        let next: TabState = 'unknown';
        try {
            const server = parseSettingsText(await this.env.fetchServer());
            if (server) {
                const stamp = readStamp(getPath(server, this.env.stampPath));
                this.lastServer = stamp;
                if (isTabFresh(this.known, stamp, this.env.myTabId)) {
                    next = 'fresh';
                } else {
                    next = 'stale';
                    this.overwrites = overwriteList(this.env.local(), server, this.env.stampPath);
                }
            }
        } catch (error) {
            this.env.log.warn('tab check failed', error);
        }
        this.dirty = false;
        this.lastCheckAt = this.env.now();
        if (this.disposed) return;
        // A save of ours landed while we were reading: the server copy we read may predate it.
        if (this.knownVersion !== version && this.known.kind === 'mine') next = 'fresh';
        if (next === 'unknown' && previous === 'stale') next = 'stale';
        if (next !== 'stale') this.overwrites = [];
        this.setState(next);
    }

    private setKnown(known: KnownStamp): void {
        this.known = known;
        this.knownVersion++;
    }

    private setState(state: TabState): void {
        if (this.stateValue === state) return;
        this.stateValue = state;
        if (!this.disposed) this.env.onChange();
    }
}
