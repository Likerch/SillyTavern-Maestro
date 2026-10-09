// Dramatis, our personality engine (Dramatis docs/model.md §13, docs/dev-plan.md; Maestro docs/integration-dramatis.md).
// Found by its manifest; it publishes `globalThis.DRAMATIS_API` version 1 (contract: ./apis.ts, copied from Dramatis)
// and announces it with the window event `dramatis-api-ready` (it may load after Maestro). Maestro pulls from it:
// stances for the relations graph (M19), goals and outcomes for the offscreen brief (M16), mature agendas for the
// director (M14), whether it replaces the social mechanics templates (M25), whether this generation gets its cast block
// and which characters' dependence it owns.
//
// Quiet modes (plan §2.2, P8, P11): Dramatis claims functions of Maestro's side through MAESTRO_API.quiet(); the claims
// live here, in memory only (Dramatis claims again after a reload, on `maestro-api-ready`). Maestro silences a function
// only while Dramatis is present AND claims it AND (for the prompt parts) says this generation gets its cast block:
// - 'voices'                 Maestro's `maestro_voices` injection is left out (Dramatis renders one combined block);
// - 'ck.consistency'         CarrotKernel's «Character Consistency» insert is taken out of the assembled prompt;
// - 'bunnymo.medicineCheck'  BunnyMo's «Medicine Check» entry is switched off at scan time while every present
//                            character with `<MED:…>`/`<REC:…>` tags is one whose dependence Dramatis owns (M22 rule).
//
// Capabilities:
// - `dramatis.present` installed, enabled in ST and loaded (its API or its module script is on the page);
// - `dramatis.api`     its API version 1 is published.
import { NeighbourBase, homePageHas, isDict } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';
import { DRAMATIS_API_GLOBAL, DRAMATIS_API_READY_EVENT } from './apis';
import type {
    ApiUnsubscribe,
    DramatisApiV1,
    DramatisStanceInfo,
    DramatisStartMember,
    MaestroQuietFunction,
} from './apis';

export * from './apis';

export const DRAMATIS_DISPLAY_NAME = 'Dramatis';
export const DRAMATIS_REPO = 'sillytavern-dramatis';
export const DRAMATIS_KNOWN_NAMES = ['third-party/SillyTavern-Dramatis'];
/** The API version this adapter speaks; within a version Dramatis only adds members. */
export const DRAMATIS_API_VERSION = 1;
/** Functions of Maestro's side Dramatis may silence (MAESTRO_API.quiet). */
export const QUIET_FUNCTIONS: readonly MaestroQuietFunction[] = ['voices', 'ck.consistency', 'bunnymo.medicineCheck'];

const API_METHODS = [
    'active',
    'castBlockActive',
    'dependenceOwned',
    'stances',
    'goals',
    'offscreenBrief',
    'matureAgendas',
    'replacesSocialMechanics',
    'onChange',
] as const;

/** A mature agenda as a director twist source. */
export interface DramatisAgenda {
    text: string;
    weight: number;
}

/** One claim of a quiet mode. */
export interface QuietClaim {
    fn: MaestroQuietFunction;
    owners: string[];
}

export function isDramatisManifest(manifest: ExtensionManifest): boolean {
    return manifest.display_name === DRAMATIS_DISPLAY_NAME || homePageHas(manifest, DRAMATIS_REPO);
}

/** The published Dramatis API when it is version 1 with every method; undefined otherwise. */
export function readDramatisApi(value: unknown): DramatisApiV1 | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const api = value as Record<string, unknown>;
    if (api.version !== DRAMATIS_API_VERSION) return undefined;
    return API_METHODS.every((method) => typeof api[method] === 'function') ? (value as DramatisApiV1) : undefined;
}

export function isQuietFunction(value: unknown): value is MaestroQuietFunction {
    return typeof value === 'string' && (QUIET_FUNCTIONS as readonly string[]).includes(value);
}

function cleanText(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function cleanList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const text = cleanText(item);
        if (text && !out.includes(text)) out.push(text);
    }
    return out;
}

/** A stance as Maestro shows it: names and a label, the stance clamped to −3…+3; null for junk. */
export function readStance(value: unknown): DramatisStanceInfo | null {
    if (!isDict(value)) return null;
    const from = cleanText(value.from);
    const to = cleanText(value.to);
    const stance = Number(value.stance);
    if (!from || !to || !Number.isFinite(stance)) return null;
    return {
        from,
        to,
        stance: Math.max(-3, Math.min(3, Math.round(stance))),
        label: cleanText(value.label),
        reasons: cleanList(value.reasons).slice(0, 6),
    };
}

/**
 * One character of a starting scene (`startCast`) as Maestro uses it: a name, presence, texts cleaned, the stance
 * clamped to −3…+3 (dropped when not a number), the gender only when Dramatis knows it; null for junk.
 */
export function readStartMember(value: unknown): DramatisStartMember | null {
    if (!isDict(value)) return null;
    const name = cleanText(value.name);
    if (!name) return null;
    const member: DramatisStartMember = { name, present: value.present === true };
    for (const key of ['doing', 'goal', 'stanceLabel', 'reason', 'mood'] as const) {
        const text = cleanText(value[key]);
        if (text) member[key] = text;
    }
    const stance = Number(value.stance);
    if (value.stance !== undefined && value.stance !== null && Number.isFinite(stance)) {
        member.stance = Math.max(-3, Math.min(3, Math.round(stance)));
    }
    if (value.gender === 'female' || value.gender === 'male') member.gender = value.gender;
    return member;
}

/** A mature agenda with a positive finite weight; null for junk. */
export function readAgenda(value: unknown): DramatisAgenda | null {
    if (!isDict(value)) return null;
    const text = cleanText(value.text);
    const weight = Number(value.weight);
    if (!text || !Number.isFinite(weight) || weight <= 0) return null;
    return { text, weight };
}

export class DramatisAdapter extends NeighbourBase<'dramatis'> {
    readonly id = 'dramatis' as const;
    private readonly claimed = new Map<MaestroQuietFunction, Map<number, string>>();
    private claimSeq = 0;
    private readonly quietListeners = new Set<() => void>();
    private readonly changeListeners = new Set<() => void>();
    /** The Dramatis API object we follow with onChange, and the unsubscription. */
    private followed: { api: DramatisApiV1; off: ApiUnsubscribe | null } | null = null;
    private readyOff: (() => void) | null = null;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('dramatis.present', () => this.present());
        this.capability('dramatis.api', () => this.present() && this.api() !== undefined);
        this.listenForReady();
    }

    present(): boolean {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        if (disabled) return false;
        return this.api() !== undefined || this.scriptUrl() !== null;
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isDramatisManifest, DRAMATIS_KNOWN_NAMES);
        return true;
    }

    /** Dramatis may load after Maestro: its ready event refreshes the capabilities and tells the views. */
    private listenForReady(): void {
        const target = typeof window !== 'undefined' ? window : null;
        if (!target?.addEventListener) return;
        const onReady = () => {
            this.follow();
            void this.host.caps.refresh().catch((error: unknown) => this.log.debug('caps refresh failed', error));
            this.emitChange();
        };
        target.addEventListener(DRAMATIS_API_READY_EVENT, onReady);
        this.readyOff = () => target.removeEventListener(DRAMATIS_API_READY_EVENT, onReady);
    }

    /** Stops listening (Maestro stops). Claims are forgotten: Dramatis claims again on `maestro-api-ready`. */
    dispose(): void {
        this.readyOff?.();
        this.readyOff = null;
        this.unfollow();
        this.claimed.clear();
        this.quietListeners.clear();
        this.changeListeners.clear();
    }

    /** Dramatis's API (read live: it appears when Dramatis starts and goes when it is disabled). */
    api(): DramatisApiV1 | undefined {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        if (disabled) return undefined;
        const api = readDramatisApi((globalThis as Record<string, unknown>)[DRAMATIS_API_GLOBAL]);
        if (api && this.followed?.api !== api && this.changeListeners.size) this.follow(api);
        return api;
    }

    /** The version Dramatis reports (its API, else its manifest). */
    override version(): string | undefined {
        const api = this.api();
        return typeof api?.dramatisVersion === 'string' ? api.dramatisVersion : super.version();
    }

    private call<T>(what: string, run: (api: DramatisApiV1) => T, fallback: T): T {
        const api = this.api();
        if (!api) return fallback;
        try {
            return run(api);
        } catch (error) {
            this.log.debug(`DRAMATIS_API.${what} failed`, error);
            return fallback;
        }
    }

    /* ---------------------------------------------------------------- reads */

    /** Enabled and the current chat has a cast. */
    active(): boolean {
        return this.call('active', (api) => api.active() === true, false);
    }

    /** This generation gets Dramatis's `dramatis_cast` block. */
    castBlockActive(): boolean {
        return this.call('castBlockActive', (api) => api.castBlockActive() === true, false);
    }

    /** Names whose dependence (drink, substance) Dramatis owns. */
    dependenceOwned(): string[] {
        return this.call('dependenceOwned', (api) => cleanList(api.dependenceOwned()), []);
    }

    /** Stances between characters (NPC → player, NPC ↔ NPC), cleaned. */
    stances(): DramatisStanceInfo[] {
        return this.call(
            'stances',
            (api) => {
                const list = api.stances();
                return Array.isArray(list)
                    ? list.map(readStance).filter((item): item is DramatisStanceInfo => item !== null)
                    : [];
            },
            [],
        );
    }

    goals(name: string): string[] {
        return this.call('goals', (api) => cleanList(api.goals(name)), []);
    }

    /** Lines for the offscreen brief of a character (goals, attempt, outcome); [] when none. */
    offscreenBrief(name: string): string[] {
        return this.call(
            'offscreenBrief',
            (api) => {
                const text = api.offscreenBrief(name);
                if (typeof text !== 'string') return [];
                return text
                    .split('\n')
                    .map((line) => line.replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
            },
            [],
        );
    }

    /** Agendas whose clocks are full or close (director twist sources), cleaned. */
    matureAgendas(): DramatisAgenda[] {
        return this.call(
            'matureAgendas',
            (api) => {
                const list = api.matureAgendas();
                return Array.isArray(list)
                    ? list.map(readAgenda).filter((item): item is DramatisAgenda => item !== null)
                    : [];
            },
            [],
        );
    }

    /** Dramatis replaces the «relationships» / «social» mechanics templates now. */
    replacesSocialMechanics(): boolean {
        return this.call('replacesSocialMechanics', (api) => api.replacesSocialMechanics() === true, false);
    }

    /**
     * The cast of a starting scene (greeting n, 0 = first_mes) as Dramatis read the card — presence, what they do and
     * want, the stance toward the player — cleaned, each name once. [] without Dramatis 1.2 (the method is optional
     * within API v1), before it has read the card, or for junk (M37 seeds DES's starting scenes from it).
     */
    startCast(greeting: number): DramatisStartMember[] {
        if (!Number.isInteger(greeting) || greeting < 0) return [];
        return this.call(
            'startCast',
            (api) => {
                if (typeof api.startCast !== 'function') return [];
                const list = api.startCast(greeting);
                if (!Array.isArray(list)) return [];
                const out: DramatisStartMember[] = [];
                for (const item of list) {
                    const member = readStartMember(item);
                    if (member && !out.some((other) => other.name.toLowerCase() === member.name.toLowerCase())) {
                        out.push(member);
                    }
                }
                return out;
            },
            [],
        );
    }

    /* ---------------------------------------------------------------- changes */

    /**
     * Stances, goals or the cast changed in Dramatis, or Dramatis (re)appeared. The listener works even when Dramatis
     * loads later: the adapter follows the API object as soon as it is published.
     */
    onChange(listener: () => void): () => void {
        this.changeListeners.add(listener);
        this.follow();
        return () => {
            this.changeListeners.delete(listener);
            if (!this.changeListeners.size) this.unfollow();
        };
    }

    private follow(
        api: DramatisApiV1 | undefined = readDramatisApi((globalThis as Record<string, unknown>)[DRAMATIS_API_GLOBAL]),
    ): void {
        if (!api || this.followed?.api === api) return;
        this.unfollow();
        let off: ApiUnsubscribe | null = null;
        try {
            const result = api.onChange(() => this.emitChange());
            off = typeof result === 'function' ? result : null;
        } catch (error) {
            this.log.debug('DRAMATIS_API.onChange failed', error);
        }
        this.followed = { api, off };
    }

    private unfollow(): void {
        try {
            this.followed?.off?.();
        } catch (error) {
            this.log.debug('DRAMATIS_API.onChange unsubscription failed', error);
        }
        this.followed = null;
    }

    private emitChange(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('Dramatis change listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- quiet modes */

    /**
     * Records Dramatis's claim of a function of Maestro's side (MAESTRO_API.quiet). Returns the remover (idempotent).
     * An unknown function is refused (a remover that does nothing).
     */
    quiet(fn: MaestroQuietFunction, owner: string): ApiUnsubscribe {
        if (!isQuietFunction(fn)) {
            this.log.warn(`unknown quiet function ${String(fn)}`);
            return () => {};
        }
        const token = ++this.claimSeq;
        let owners = this.claimed.get(fn);
        if (!owners) {
            owners = new Map();
            this.claimed.set(fn, owners);
        }
        owners.set(token, cleanText(owner) || 'dramatis');
        this.emitQuiet();
        return () => {
            const current = this.claimed.get(fn);
            if (!current?.delete(token)) return;
            if (!current.size) this.claimed.delete(fn);
            this.emitQuiet();
        };
    }

    /** Somebody claims this function now (whether Dramatis is present or not). */
    isClaimed(fn: MaestroQuietFunction): boolean {
        return (this.claimed.get(fn)?.size ?? 0) > 0;
    }

    claims(): QuietClaim[] {
        return [...this.claimed.entries()].map(([fn, owners]) => ({ fn, owners: [...new Set(owners.values())] }));
    }

    onQuietChange(listener: () => void): () => void {
        this.quietListeners.add(listener);
        return () => this.quietListeners.delete(listener);
    }

    private emitQuiet(): void {
        for (const listener of [...this.quietListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('quiet listener failed', error);
            }
        }
    }

    /** Dramatis is present, claims `fn` and this generation gets its cast block: Maestro's part is silenced. */
    silences(fn: 'voices' | 'ck.consistency'): boolean {
        return this.isClaimed(fn) && this.present() && this.castBlockActive();
    }

    /** Dramatis is present and claims the Medicine Check (the M22 rule then checks the present characters). */
    claimsMedicineCheck(): boolean {
        return this.isClaimed('bunnymo.medicineCheck') && this.present() && this.api() !== undefined;
    }
}

/**
 * The Dramatis adapter of an App, or undefined (test apps built before 1.17 have none). Features use this instead of
 * `adaptersOf(app).dramatis` so a fake App without it keeps working.
 */
export function dramatisOf(app: { adapters: unknown }): DramatisAdapter | undefined {
    const adapters = app.adapters as Dict | undefined;
    const adapter = adapters?.dramatis;
    return adapter instanceof DramatisAdapter ? adapter : isDramatisLike(adapter) ? adapter : undefined;
}

/** A test double shaped like the adapter (duck-typed: the methods the features call). */
function isDramatisLike(value: unknown): value is DramatisAdapter {
    return (
        isDict(value) &&
        typeof value.silences === 'function' &&
        typeof value.present === 'function' &&
        typeof value.stances === 'function'
    );
}
