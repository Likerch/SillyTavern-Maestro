// M29 «Фоны»: the chat background follows the place (plan M29, §2.1, §8, §12). When the scene enters a place (M24
// onEnter, after the turn is committed; also when a chat opens) or DES moves the time of day or the weather, the
// leader tab picks the place's bound background (its variant for now) or the best match from ST's background library
// and sets it as the CHAT background through autonomy kind 'backgrounds.set' (default «Само»), journaled with undo.
// Nothing fits → nothing changes; the pult offers «Сгенерировать фон» (NAI Studio, only on the user's click; in «Кино»
// also a quiet notice). A chat background Maestro did not write is the user's: Maestro leaves it alone until
// «Снова выбирать самому» (release). Exposed as app.modules.api<BackgroundsApi>('backgrounds').
import { adaptersOf } from '../../adapters';
import {
    bestMatch,
    boundSet,
    chooseBound,
    conditionsKey,
    emptyConditions,
    indexLibrary,
    placeProfile,
    rankLibrary,
    sceneConditions,
    variantFit,
    withPlace,
    withVariant,
} from '../../domain/backgrounds-score';
import type { LibraryItem, PlaceProfile, SceneConditions } from '../../domain/backgrounds-score';
import {
    generationTags,
    isFreeOnlyRefusal,
    isUndone,
    isUserPinned,
    libraryCssUrl,
    libraryFileOf,
    naiFreeOnly,
    readChoice,
    readPointer,
    withGenerated,
    withUndone,
} from '../../domain/backgrounds-state';
import type { BackgroundsPointer, ChoiceSource, StoredChoice } from '../../domain/backgrounds-state';
import { fileTitle, tokenizeFile, variantKind } from '../../domain/backgrounds-tokens';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { Place, PlacesApi } from '../places/api';
import type { BackgroundChoice, BackgroundsApi } from './api';
import { BACKGROUNDS_KEY, CHAT_BG_TARGET, GENERATE_KIND, PICK_KIND, POINTER, SET_KIND } from './settings';
import type { BackgroundsSettings } from './settings';
import { CAP_ST_BACKGROUNDS, ChatBackground } from './st-background';

/** Quiet time after a trigger: places, DES and the turn settle; several triggers become one evaluation. */
export const EVAL_DELAY_MS = 400;
const IDLE_WAIT_MS = 2_000;
/** How far back DES time and weather are looked for. */
const SCAN_BACK = 20;
/** Score of a bound background (the user's choice beats any library match). */
export const BOUND_SCORE = 100;
const PROPOSAL_TTL_MS = 30 * 60_000;
const PARENTS_MAX = 8;
export const CANDIDATES_DEFAULT = 5;

/** What the NAI adapter offers for backgrounds (NAI Studio 0.12.0+); every member is checked before use. */
export interface GenerateBackgroundInput {
    locationName: string;
    tags?: string;
    passportId?: string;
    timeOfDay?: string;
    weather?: string;
    style?: string;
}

/** Why NAI Studio's `generateBackground` resolved null (its `requestFailed` event, NAI Studio 0.12.0+). */
interface RequestFailed {
    request?: string;
    name?: string;
    /** `free-only-blocked`: «free only» refused to spend Anlas; `aborted`: the user declined the cost; … */
    code?: string;
    message?: string;
}

/**
 * The part of the NAI adapter M29 uses, feature-detected member by member. The adapter always has
 * generateBackground (it resolves null when NAI Studio lacks it), so ability is NAI Studio's own API member
 * (capability 'nai.backgrounds').
 */
interface NaiBackgroundPort {
    present?(): boolean;
    settings?(): unknown;
    api?(): { generateBackground?: unknown } | undefined;
    on?(event: string, listener: (detail: unknown) => void): () => void;
    /** Generates one image, uploads it to ST's backgrounds library and returns the file name; never sets it. */
    generateBackground?(input: GenerateBackgroundInput): Promise<{ file: string } | null>;
}

/** Capability of the NAI adapter: NAI Studio draws backgrounds of places (0.12.0+). */
export const CAP_NAI_BACKGROUNDS = 'nai.backgrounds';

/** Payload of an automatic change (JSON: Inbox cards outlive the page). */
export interface SetPayload {
    chatId: string;
    placeId: string;
    placeName: string;
    file: string;
    url: string;
    /** The chat background value it replaces ('' = none). */
    beforeUrl: string;
    variant: string[];
    source: ChoiceSource;
    score: number;
}

/** Journal `ref` of a chat background change. */
interface ChangeRef {
    chatId: string;
    placeId: string;
    file: string;
    beforeUrl: string;
    afterUrl: string;
    /** Maestro's pointer before the change: a user background stays the user's after undo. */
    beforePointerUrl: string;
    beforeChoice: StoredChoice | null;
    /** An automatic change: undoing it keeps Maestro from choosing that file for the place again. */
    auto: boolean;
}

export type Owner = 'none' | 'maestro' | 'user' | 'released';
export type Budget = 'free' | 'paid' | 'unknown';
type Reason = 'enter' | 'conditions' | 'settings' | 'release';

export interface BackgroundsState {
    chatId: string | null;
    place: Place | null;
    /** Names from the top place down to the current one. */
    placePath: string[];
    /** The chat background value ('' = the global background shows). */
    live: string;
    pinned: boolean;
    owner: Owner;
    current: BackgroundChoice | null;
    conditions: SceneConditions;
    /** The last automatic choice for the current place found nothing. */
    noMatch: boolean;
    generating: boolean;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const SOURCES: readonly ChoiceSource[] = ['library', 'generated', 'user'];

export function readSetPayload(raw: unknown): SetPayload | null {
    if (!isDict(raw)) return null;
    const chatId = text(raw.chatId);
    const placeId = text(raw.placeId);
    const file = text(raw.file);
    const url = text(raw.url);
    const beforeUrl = text(raw.beforeUrl);
    if (!chatId || !placeId || !file || !url || beforeUrl === null) return null;
    return {
        chatId,
        placeId,
        placeName: text(raw.placeName) ?? '',
        file,
        url,
        beforeUrl,
        variant: strings(raw.variant),
        source: SOURCES.find((source) => source === raw.source) ?? 'library',
        score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0,
    };
}

function readChangeRef(raw: unknown): ChangeRef | null {
    if (!isDict(raw)) return null;
    const chatId = text(raw.chatId);
    const afterUrl = text(raw.afterUrl);
    const beforeUrl = text(raw.beforeUrl);
    if (!chatId || !afterUrl || beforeUrl === null) return null;
    return {
        chatId,
        placeId: text(raw.placeId) ?? '',
        file: text(raw.file) ?? '',
        beforeUrl,
        afterUrl,
        beforePointerUrl: text(raw.beforePointerUrl) ?? beforeUrl,
        beforeChoice: readChoice(raw.beforeChoice),
        auto: raw.auto === true,
    };
}

function publicChoice(choice: StoredChoice): BackgroundChoice {
    return {
        placeId: choice.placeId,
        file: choice.file,
        variant: [...choice.variant],
        source: choice.source,
        score: choice.score,
    };
}

export class BackgroundsService implements BackgroundsApi {
    readonly door: ChatBackground;
    private readonly listeners = new Set<() => void>();
    private library: { items: LibraryItem[]; ok: boolean } | null = null;
    private libraryLoading: Promise<{ items: LibraryItem[]; ok: boolean }> | null = null;
    private scene: { chatId: string | null; key: string; conditions: SceneConditions } = {
        chatId: null,
        key: '',
        conditions: emptyConditions(),
    };
    private readonly offered = new Set<string>();
    private placesApi: PlacesApi | null = null;
    private placesOff: Unsubscribe[] = [];
    private chain: Promise<unknown> = Promise.resolve();
    private evalTimer: ReturnType<typeof setTimeout> | null = null;
    private evalReason: Reason = 'enter';
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly idles = new Set<number>();
    private readonly generating = new Set<string>();
    private lastOutcome: { chatId: string; placeId: string; found: boolean } | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => BackgroundsSettings,
    ) {
        this.door = new ChatBackground(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [
            app.bus.on('chat:changed', () => {
                this.lastOutcome = null;
                this.ensurePlaces();
                this.readScene();
                this.emitChange();
            }),
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // MESSAGE_SENT is on the send path (P15): wait for an idle moment.
                this.later(async () => this.onCommitted(messageIndex), true);
            }),
            app.leader.onChange((leader) => {
                if (leader) this.schedule('enter');
            }),
            app.settings.onChange((path) => {
                if (!path.startsWith(`modules.${BACKGROUNDS_KEY}`) && path !== 'core.mode') return;
                this.emitChange();
                if (path.startsWith(`modules.${BACKGROUNDS_KEY}`)) this.schedule('settings');
            }),
            // ST's Stable Diffusion «background» sets a chat background through this event: it is the user's.
            app.host.events.on('FORCE_SET_BACKGROUND', () => this.later(async () => this.emitChange())),
            this.door.observe(() => this.emitChange()),
            app.inbox.registerApplier(
                SET_KIND,
                (payload) => this.applySet(payload),
                async (payload) => {
                    const value = readSetPayload(payload);
                    return !!value && this.setStillValid(value);
                },
            ),
        ];
        app.journal.registerUndo(CHAT_BG_TARGET, (change) => this.undoChange(change));
        app.host.caps.register(CAP_ST_BACKGROUNDS, () => this.door.probe());
        this.ensurePlaces();
        // The module may start inside an open chat whose place was announced already.
        this.schedule('enter');
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        if (this.evalTimer !== null) clearTimeout(this.evalTimer);
        this.evalTimer = null;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
        for (const handle of this.idles) cancel?.(handle);
        this.idles.clear();
        for (const off of this.placesOff.splice(0)) off();
        this.placesApi = null;
        this.listeners.clear();
    }

    /* ---------------------------------------------------------------- plumbing */

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emitChange(): void {
        if (this.disposed) return;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('backgrounds listener failed', error);
            }
        }
    }

    private later(job: () => Promise<void>, idle = false): void {
        if (this.disposed) return;
        const run = () => {
            if (this.disposed) return;
            job().catch((error: unknown) => this.log.warn('backgrounds job failed', error));
        };
        const request = (
            globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }
        ).requestIdleCallback;
        if (idle && typeof request === 'function') {
            const handle = request(
                () => {
                    this.idles.delete(handle);
                    run();
                },
                { timeout: IDLE_WAIT_MS },
            );
            this.idles.add(handle);
            return;
        }
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            run();
        }, 0);
        this.timers.add(timer);
    }

    private enqueue<R>(job: () => Promise<R>): Promise<R> {
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** Evaluates once the triggers settle; `release` (the user's request) outranks the rest. */
    private schedule(reason: Reason, delay = EVAL_DELAY_MS): void {
        if (this.disposed) return;
        if (this.evalTimer === null || reason === 'release') this.evalReason = reason;
        if (this.evalTimer !== null) clearTimeout(this.evalTimer);
        this.evalTimer = setTimeout(() => {
            this.evalTimer = null;
            const next = this.evalReason;
            void this.enqueue(() => this.evaluate(next)).catch((error: unknown) =>
                this.log.warn('background choice failed', error),
            );
        }, delay);
    }

    private ensurePlaces(): PlacesApi | null {
        let api: PlacesApi | null;
        try {
            api = this.app.modules.api<PlacesApi>('places') ?? null;
        } catch {
            api = null;
        }
        if (api === this.placesApi) return api;
        for (const off of this.placesOff.splice(0)) off();
        this.placesApi = api;
        if (!api || this.disposed) return api;
        try {
            this.placesOff.push(api.onEnter(() => this.schedule('enter')));
            this.placesOff.push(api.onChange(() => this.emitChange()));
        } catch (error) {
            this.log.debug('places events are not available', error);
        }
        return api;
    }

    private pointer(): BackgroundsPointer {
        return readPointer(this.app.chat.pointer<unknown>(POINTER));
    }

    private writePointer(next: BackgroundsPointer): void {
        void this.app.chat
            .setPointer(POINTER, next)
            .catch((error: unknown) => this.log.warn('backgrounds pointer was not saved', error));
    }

    private naiPort(): NaiBackgroundPort | null {
        try {
            const port = this.app.adapters.nai as unknown as NaiBackgroundPort | undefined;
            return port ?? null;
        } catch {
            return null;
        }
    }

    /** NAI Studio is on and draws backgrounds (its API has generateBackground; else the capability says so). */
    canGenerate(): boolean {
        const port = this.naiPort();
        if (typeof port?.generateBackground !== 'function') return false;
        try {
            if (typeof port.present === 'function' && !port.present()) return false;
            if (typeof port.api === 'function') return typeof port.api()?.generateBackground === 'function';
            return this.app.host.caps.has(CAP_NAI_BACKGROUNDS);
        } catch {
            return false;
        }
    }

    /** What a generated background costs under NAI Studio's settings. */
    budget(): Budget {
        let free: boolean | null;
        try {
            free = naiFreeOnly(this.naiPort()?.settings?.());
        } catch {
            free = null;
        }
        return free === null ? 'unknown' : free ? 'free' : 'paid';
    }

    isGenerating(placeId: string): boolean {
        return this.generating.has(placeId);
    }

    /* ---------------------------------------------------------------- library */

    private loadLibrary(force = false): Promise<{ items: LibraryItem[]; ok: boolean }> {
        if (!force && this.library) return Promise.resolve(this.library);
        if (!force && this.libraryLoading) return this.libraryLoading;
        const loading = this.door
            .list()
            .then((files) => {
                const result = { items: indexLibrary(files ?? []), ok: files !== null };
                // A failed read is not cached: the next use asks ST again.
                if (result.ok) this.library = result;
                this.emitChange();
                return result;
            })
            .finally(() => {
                if (this.libraryLoading === loading) this.libraryLoading = null;
            });
        this.libraryLoading = loading;
        return loading;
    }

    async refreshLibrary(): Promise<void> {
        this.library = null;
        await this.loadLibrary(true);
    }

    /** The loaded library (null before the first read): count for the pult. */
    libraryInfo(): { count: number; ok: boolean } | null {
        return this.library ? { count: this.library.items.filter((item) => item.usable).length, ok: true } : null;
    }

    thumbnail(file: string): string {
        return this.door.thumbnail(file);
    }

    /* ---------------------------------------------------------------- scene */

    private onCommitted(messageIndex: number): Promise<void> {
        if (this.readScene(messageIndex)) {
            this.emitChange();
            if (this.settings().variants) this.schedule('conditions');
        }
        return Promise.resolve();
    }

    /** Re-reads time, weather and date from DES; true when they changed within the same chat. */
    private readScene(upTo?: number): boolean {
        const chatId = this.app.host.chatId();
        const conditions = chatId ? this.sceneAt(upTo) : emptyConditions();
        const key = conditionsKey(conditions);
        const changed = this.scene.chatId === chatId && this.scene.key !== key;
        this.scene = { chatId, key, conditions };
        return changed;
    }

    private sceneAt(upTo?: number): SceneConditions {
        const chat = this.app.host.ctx().chat ?? [];
        let des: { trackerFor?: (index: number) => unknown } | undefined;
        try {
            des = adaptersOf(this.app).des as unknown as { trackerFor?: (index: number) => unknown };
        } catch {
            des = undefined;
        }
        if (typeof des?.trackerFor !== 'function') return emptyConditions();
        const last = Math.min(upTo ?? chat.length - 1, chat.length - 1);
        for (let index = last; index >= 0 && index > last - SCAN_BACK; index--) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            let info: unknown;
            try {
                const tracker = des.trackerFor(index) as { infoBox?: unknown } | null;
                info = tracker?.infoBox;
            } catch {
                info = null;
            }
            if (!isDict(info)) continue;
            if (info.time || info.weather || info.date) {
                return sceneConditions({
                    time: isDict(info.time) ? (info.time as { start?: string; end?: string }) : null,
                    weather: isDict(info.weather) ? (info.weather as { emoji?: string; forecast?: string }) : null,
                    date: typeof info.date === 'string' ? info.date : null,
                });
            }
        }
        return emptyConditions();
    }

    /** Time of day, weather and season of the scene now (from the last DES tracker). */
    conditions(): SceneConditions {
        if (this.scene.chatId !== this.app.host.chatId()) this.readScene();
        return this.scene.conditions;
    }

    /** Names from the top place down to this one. */
    pathOf(place: Place): string[] {
        const places = this.placesApi;
        try {
            const path = places?.path?.(place.id);
            if (Array.isArray(path) && path.length) return path;
        } catch {
            // fall back to walking the parents
        }
        const names = [place.name];
        let parent = place.parent;
        const seen = new Set<string>([place.id]);
        while (parent && !seen.has(parent) && names.length <= PARENTS_MAX) {
            seen.add(parent);
            const next = places?.get(parent);
            if (!next) break;
            names.unshift(next.name);
            parent = next.parent;
        }
        return names;
    }

    private profileOf(place: Place): PlaceProfile {
        const path = this.pathOf(place);
        const parents = path.slice(0, -1).reverse();
        return placeProfile({ name: place.name, aliases: place.aliases, parents, state: place.state });
    }

    private sourceOf(file: string, fallback: ChoiceSource): ChoiceSource {
        return this.pointer().generated.includes(file) ? 'generated' : fallback;
    }

    /** The place's background for now: bound (its variant), else the best library match over the threshold. */
    private choose(place: Place, items: readonly LibraryItem[], ok: boolean): BackgroundChoice | null {
        const settings = this.settings();
        const options = { variants: settings.variants };
        const profile = this.profileOf(place);
        const scene = withPlace(this.conditions(), profile);
        const bound = boundSet(place);
        const inLibrary = (file: string) => !ok || items.some((item) => item.file === file);
        let pick = chooseBound(bound, scene, options, items);
        if (pick && !inLibrary(pick.file)) {
            this.log.info(`the bound background ${pick.file} is not in the library`);
            pick =
                bound.main && bound.main !== pick.file && inLibrary(bound.main)
                    ? { file: bound.main, variant: [] }
                    : null;
        }
        if (pick) {
            return {
                placeId: place.id,
                file: pick.file,
                variant: [...pick.variant],
                source: this.sourceOf(pick.file, 'user'),
                score: BOUND_SCORE,
            };
        }
        const best = bestMatch(items, profile, scene, options, settings.threshold);
        if (!best) return null;
        return {
            placeId: place.id,
            file: best.file,
            variant: best.variant,
            source: this.sourceOf(best.file, 'library'),
            score: best.score,
        };
    }

    /* ---------------------------------------------------------------- automatic choice */

    private async evaluate(reason: Reason): Promise<void> {
        const settings = this.settings();
        if (this.disposed || !settings.auto) return;
        // Automatic changes belong to the leader tab; «Снова выбирать самому» is the user's request in this tab.
        if (reason !== 'release' && !this.app.leader.isLeader()) return;
        const chatId = this.app.host.chatId();
        const place = this.ensurePlaces()?.current() ?? null;
        if (!chatId || !place) return;
        if (this.userPinned()) return;
        const pointer = this.pointer();
        // A background the user picked in the pult stays while the scene stays in that place.
        if (pointer.choice?.manual && pointer.choice.placeId === place.id) return;
        const library = await this.loadLibrary();
        if (this.disposed || this.app.host.chatId() !== chatId) return;
        const pick = this.choose(place, library.items, library.ok);
        this.lastOutcome = { chatId, placeId: place.id, found: !!pick };
        if (!pick) {
            this.offer(place);
            this.emitChange();
            return;
        }
        const fresh = this.pointer();
        const live = this.door.live();
        if (isUserPinned(live, fresh)) return;
        const url = libraryCssUrl(pick.file);
        if (url === live) {
            const same = fresh.choice?.file === pick.file && fresh.choice.placeId === pick.placeId;
            if (!same) this.writePointer({ ...fresh, url, choice: { ...pick, variant: [...pick.variant] } });
            this.emitChange();
            return;
        }
        if (isUndone(fresh, place.id, pick.file)) return;
        await this.propose(chatId, place, pick, live, fresh);
    }

    private async propose(
        chatId: string,
        place: Place,
        pick: BackgroundChoice,
        live: string,
        pointer: BackgroundsPointer,
    ): Promise<void> {
        const payload: SetPayload = {
            chatId,
            placeId: place.id,
            placeName: place.name,
            file: pick.file,
            url: libraryCssUrl(pick.file),
            beforeUrl: live,
            variant: [...pick.variant],
            source: pick.source,
            score: pick.score,
        };
        const title = this.t('m29.journal.set', { file: fileTitle(pick.file) || pick.file, place: place.name });
        const decision = await this.app.autonomy.decide<SetPayload>(
            {
                module: BACKGROUNDS_KEY,
                kind: SET_KIND,
                title,
                description: this.t(`m29.proposal.${pick.source}`),
                changes: [this.changeOf(payload, pointer, true)],
                payload,
                ttlMs: PROPOSAL_TTL_MS,
                apply: (value) => this.applySet(value),
                stillValid: async () => this.setStillValid(payload),
            },
            'auto',
        );
        this.log.debug(`chat background for ${place.name}: ${decision}`);
    }

    /** The chat and its background are still what the proposal saw, and the background is not the user's. */
    setStillValid(payload: SetPayload): boolean {
        if (this.app.host.chatId() !== payload.chatId) return false;
        const live = this.door.live();
        return live === payload.beforeUrl && this.pointer().url === live;
    }

    /** Applies an automatic change (directly, from a notice or from an Inbox card). */
    async applySet(raw: unknown): Promise<void> {
        const payload = readSetPayload(raw);
        if (!payload || !this.setStillValid(payload)) throw new Error(this.t('m29.error.stale'));
        const pointer = this.pointer();
        this.writePointer({
            ...pointer,
            url: payload.url,
            choice: {
                placeId: payload.placeId,
                file: payload.file,
                variant: [...payload.variant],
                source: payload.source,
                score: payload.score,
            },
        });
        // The pointer first: the `#bg1` observer must not see a background that looks like the user's.
        this.door.set(payload.url);
        this.emitChange();
    }

    private describe(value: string): string | null {
        if (!value) return null;
        const file = libraryFileOf(value);
        return file ? fileTitle(file) || file : value;
    }

    private changeOf(payload: SetPayload, pointer: BackgroundsPointer, auto: boolean): JournalChange {
        const ref: ChangeRef = {
            chatId: payload.chatId,
            placeId: payload.placeId,
            file: payload.file,
            beforeUrl: payload.beforeUrl,
            afterUrl: payload.url,
            beforePointerUrl: pointer.url,
            beforeChoice: pointer.url === payload.beforeUrl ? pointer.choice : null,
            auto,
        };
        return {
            target: CHAT_BG_TARGET,
            ref: ref as unknown as Record<string, unknown>,
            before: this.describe(payload.beforeUrl),
            after: fileTitle(payload.file) || payload.file,
        };
    }

    /** Undo: the previous chat background comes back (or none), unless the background changed since. */
    private async undoChange(change: JournalChange): Promise<boolean> {
        const ref = readChangeRef(change.ref);
        if (!ref || this.app.host.chatId() !== ref.chatId) return false;
        if (this.door.live() !== ref.afterUrl) return false;
        let next: BackgroundsPointer = { ...this.pointer(), url: ref.beforePointerUrl, choice: ref.beforeChoice };
        if (ref.auto && ref.placeId && ref.file) next = withUndone(next, ref.placeId, ref.file);
        this.writePointer(next);
        if (ref.beforeUrl) this.door.set(ref.beforeUrl);
        else await this.door.clear();
        this.emitChange();
        return true;
    }

    /** «Кино»: nothing in the library → a quiet notice with «Сгенерировать фон» (once per place and chat). */
    private offer(place: Place): void {
        const chatId = this.app.host.chatId();
        if (!chatId || this.app.settings.core().mode !== 'cinema' || !this.canGenerate()) return;
        const key = `${chatId}|${place.id}`;
        if (this.offered.has(key)) return;
        this.offered.add(key);
        this.app.ui.notice(this.t('m29.offer', { place: place.name }), {
            level: 'info',
            action: {
                label: this.t('m29.generate.button'),
                run: () => {
                    void this.generate(place.id).catch((error: unknown) =>
                        this.log.warn('background generation failed', error),
                    );
                },
            },
        });
    }

    /* ---------------------------------------------------------------- API */

    current(): BackgroundChoice | null {
        if (!this.app.host.chatId()) return null;
        const pointer = this.pointer();
        const live = this.door.live();
        if (!live || live !== pointer.url || !pointer.choice) return null;
        return publicChoice(pointer.choice);
    }

    userPinned(): boolean {
        if (!this.app.host.chatId()) return false;
        return isUserPinned(this.door.live(), this.pointer());
    }

    async candidates(placeId: string, limit = CANDIDATES_DEFAULT): Promise<BackgroundChoice[]> {
        const place = this.ensurePlaces()?.get(placeId);
        if (!place) return [];
        const library = await this.loadLibrary();
        const options = { variants: this.settings().variants };
        const profile = this.profileOf(place);
        const scene = withPlace(this.conditions(), profile);
        const out: BackgroundChoice[] = [];
        const bound = chooseBound(boundSet(place), scene, options, library.items);
        if (bound) {
            out.push({
                placeId,
                file: bound.file,
                variant: [...bound.variant],
                source: this.sourceOf(bound.file, 'user'),
                score: BOUND_SCORE,
            });
        }
        for (const scored of rankLibrary(library.items, profile, scene, options, limit + 1)) {
            if (out.some((choice) => choice.file === scored.file)) continue;
            out.push({
                placeId,
                file: scored.file,
                variant: scored.variant,
                source: this.sourceOf(scored.file, 'library'),
                score: scored.score,
            });
        }
        return out.slice(0, Math.max(0, limit));
    }

    async bind(placeId: string, file: string, variant?: string[]): Promise<void> {
        const places = this.ensurePlaces();
        if (!places) throw new Error(this.t('m29.error.noPlaces'));
        const place = places.get(placeId);
        if (!place) throw new Error(this.t('m29.error.noPlace'));
        const tags = (variant ?? []).filter((tag) => variantKind(tag) !== null);
        if (variant?.length && !tags.length) throw new Error(this.t('m29.error.variant'));
        await this.bindRaw(places, place, file, tags);
        this.emitChange();
        await this.showBound(placeId);
    }

    async unbind(placeId: string, variant?: string[]): Promise<void> {
        const places = this.ensurePlaces();
        if (!places) throw new Error(this.t('m29.error.noPlaces'));
        const place = places.get(placeId);
        if (!place) throw new Error(this.t('m29.error.noPlace'));
        const tags = (variant ?? []).filter((tag) => variantKind(tag) !== null);
        if (tags.length) await places.update(placeId, { state: withVariant(place.state, tags, null) });
        else await places.update(placeId, { background: undefined });
        this.emitChange();
    }

    async pick(placeId: string, file: string): Promise<void> {
        if (!this.app.host.chatId()) throw new Error(this.t('m29.error.noChat'));
        const place = this.ensurePlaces()?.get(placeId);
        const name = place?.name ?? placeId;
        const variant = variantFit(tokenizeFile(file), this.conditions()).matched;
        await this.setByUser(
            { placeId, file, variant, source: this.sourceOf(file, 'user'), score: 0 },
            PICK_KIND,
            this.t('m29.journal.pick', { file: fileTitle(file) || file, place: name }),
            true,
        );
    }

    async release(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const live = this.door.live();
        // The user's background is taken over as «Maestro's» so that the next choice may replace it.
        this.writePointer({ ...this.pointer(), url: live, choice: null, undone: [] });
        for (const key of [...this.offered]) if (key.startsWith(`${chatId}|`)) this.offered.delete(key);
        this.emitChange();
        await this.enqueue(() => this.evaluate('release'));
    }

    async generate(placeId: string): Promise<BackgroundChoice | null> {
        const port = this.naiPort();
        if (typeof port?.generateBackground !== 'function' || !this.canGenerate()) {
            this.app.ui.notice(this.t('m29.generate.unavailable'), { level: 'warn', urgent: true });
            return null;
        }
        const chatId = this.app.host.chatId();
        const places = this.ensurePlaces();
        const place = places?.get(placeId);
        if (!chatId || !places || !place) {
            this.app.ui.notice(this.t('m29.error.noPlace'), { level: 'warn', urgent: true });
            return null;
        }
        if (this.generating.has(placeId)) return null;
        this.generating.add(placeId);
        this.emitChange();
        try {
            const profile = this.profileOf(place);
            const scene = withPlace(this.conditions(), profile);
            const weather = scene.weather.find((tag) => tag !== 'clear' && tag !== 'cloudy') ?? scene.weather[0];
            const input: GenerateBackgroundInput = { locationName: place.name };
            const tags = generationTags(profile, scene);
            if (tags) input.tags = tags;
            if (place.passportId) input.passportId = place.passportId;
            if (scene.time) input.timeOfDay = scene.time;
            if (weather) input.weather = weather;
            // NAI Studio resolves null on failure and says why in a `requestFailed` event (it also shows a toast).
            let failure: RequestFailed | null = null;
            let offFailed: () => void = () => {};
            try {
                offFailed =
                    port.on?.('requestFailed', (detail) => {
                        if (isDict(detail) && (detail.request === undefined || detail.request === 'background')) {
                            failure = detail as RequestFailed;
                        }
                    }) ?? (() => {});
            } catch (error) {
                this.log.debug('NAI Studio requestFailed is not available', error);
            }
            let result: { file: string } | null;
            try {
                result = await port.generateBackground(input);
            } catch (error) {
                // An adapter that rejects instead (older builds): NaiError carries `code`.
                const code = isDict(error) && typeof error.code === 'string' ? error.code : undefined;
                failure = { code, message: error instanceof Error ? error.message : String(error) };
                result = null;
            } finally {
                try {
                    offFailed();
                } catch {
                    // already gone with NAI Studio
                }
            }
            const file = typeof result?.file === 'string' ? result.file.trim() : '';
            if (!file) {
                this.reportFailure(failure);
                return null;
            }
            // The library has a new file; the chat may have switched meanwhile (the file stays in the library).
            this.library = null;
            if (this.app.host.chatId() !== chatId) return null;
            this.writePointer(withGenerated(this.pointer(), file));
            const fresh = places.get(placeId) ?? place;
            const variant = [scene.time, weather].filter((tag): tag is NonNullable<typeof tag> => !!tag);
            // The first background of a place is its main one; later ones are the variant for the scene now.
            const asVariant = !!fresh.background && variant.length > 0;
            await this.bindRaw(places, fresh, file, asVariant ? variant : []);
            const choice: BackgroundChoice = {
                placeId,
                file,
                variant: asVariant ? [...variant] : [],
                source: 'generated',
                score: BOUND_SCORE,
            };
            if (places.current()?.id === placeId) {
                if (this.userPinned()) this.app.ui.notice(this.t('m29.generate.pinned'), { level: 'info' });
                else {
                    await this.setByUser(
                        choice,
                        GENERATE_KIND,
                        this.t('m29.journal.generate', { file: fileTitle(file) || file, place: place.name }),
                        false,
                    );
                }
            }
            this.app.ui.notice(this.t('m29.generate.done', { place: place.name }), { level: 'info' });
            return choice;
        } finally {
            this.generating.delete(placeId);
            this.emitChange();
        }
    }

    /**
     * Why nothing was generated. NAI Studio already showed its own toast for a failure it reports, so these notices
     * are not urgent; a declined cost confirmation is the user's own answer and needs none.
     */
    private reportFailure(failure: RequestFailed | null): void {
        if (failure?.code === 'aborted') return;
        if (failure && (isFreeOnlyRefusal(failure.code ?? '') || isFreeOnlyRefusal(failure.message ?? ''))) {
            this.app.ui.notice(this.t('m29.generate.freeOnly'), { level: 'warn', urgent: !failure.code });
            return;
        }
        if (failure?.message || failure?.code) {
            this.log.warn('background generation failed', failure);
            this.app.ui.notice(this.t('m29.generate.failed', { error: failure.message || failure.code || '' }), {
                level: 'warn',
                urgent: !failure.code,
            });
            return;
        }
        this.app.ui.notice(this.t('m29.generate.empty'), { level: 'warn', urgent: true });
    }

    /* ---------------------------------------------------------------- user actions */

    private async bindRaw(places: PlacesApi, place: Place, file: string, tags: readonly string[]): Promise<void> {
        if (tags.length) await places.update(place.id, { state: withVariant(place.state, tags, file) });
        else await places.update(place.id, { background: file });
    }

    /** After a bind: the current place shows its bound background at once (unless the user's own is on). */
    private async showBound(placeId: string): Promise<void> {
        const places = this.ensurePlaces();
        if (!this.app.host.chatId() || places?.current()?.id !== placeId || this.userPinned()) return;
        const place = places.get(placeId);
        if (!place) return;
        const library = await this.loadLibrary();
        const pick = this.choose(place, library.items, library.ok);
        if (!pick || pick.score !== BOUND_SCORE) return;
        await this.setByUser(
            pick,
            PICK_KIND,
            this.t('m29.journal.bound', { file: fileTitle(pick.file) || pick.file, place: place.name }),
            false,
        );
    }

    /** A change the user asked for: applied now (also over the user's own background) and journaled. */
    private async setByUser(choice: BackgroundChoice, kind: string, summary: string, manual: boolean): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const pointer = this.pointer();
        const live = this.door.live();
        const url = libraryCssUrl(choice.file);
        const stored: StoredChoice = { ...choice, variant: [...choice.variant] };
        if (manual) stored.manual = true;
        if (url === live) {
            this.writePointer({ ...pointer, url, choice: stored });
            this.emitChange();
            return;
        }
        const payload: SetPayload = {
            chatId,
            placeId: choice.placeId,
            placeName: '',
            file: choice.file,
            url,
            beforeUrl: live,
            variant: [...choice.variant],
            source: choice.source,
            score: choice.score,
        };
        const change = this.changeOf(payload, pointer, false);
        this.writePointer({ ...pointer, url, choice: stored });
        this.door.set(url);
        this.emitChange();
        try {
            await this.app.journal.record({ module: BACKGROUNDS_KEY, kind, summary, changes: [change] });
        } catch (error) {
            this.log.warn('background change was not journaled', error);
        }
    }

    /* ---------------------------------------------------------------- view model */

    state(): BackgroundsState {
        const chatId = this.app.host.chatId();
        const place = chatId ? (this.ensurePlaces()?.current() ?? null) : null;
        const live = chatId ? this.door.live() : '';
        const pointer = this.pointer();
        const pinned = !!chatId && isUserPinned(live, pointer);
        let owner: Owner = 'none';
        if (pinned) owner = 'user';
        else if (live && pointer.choice) owner = 'maestro';
        else if (live) owner = 'released';
        const outcome = this.lastOutcome;
        return {
            chatId,
            place,
            placePath: place ? this.pathOf(place) : [],
            live,
            pinned,
            owner,
            current: this.current(),
            conditions: chatId ? this.conditions() : emptyConditions(),
            noMatch:
                !!outcome && !!place && outcome.chatId === chatId && outcome.placeId === place.id && !outcome.found,
            generating: !!place && this.generating.has(place.id),
        };
    }

    /** Places of the chat (current first) for the pult's place switch. */
    places(): Place[] {
        const api = this.ensurePlaces();
        if (!api || !this.app.host.chatId()) return [];
        const current = api.current();
        const list = api.list();
        return current ? [current, ...list.filter((place) => place.id !== current.id)] : list;
    }

    place(id: string): Place | undefined {
        return this.ensurePlaces()?.get(id);
    }

    /** The place registry (M24) is on. */
    hasPlaces(): boolean {
        return this.ensurePlaces() !== null;
    }

    /** The file is in the loaded library; null before the library was read. */
    inLibrary(file: string): boolean | null {
        return this.library ? this.library.items.some((item) => item.file === file) : null;
    }

    /** Preview image of a chat background value. */
    preview(value: string): string | null {
        return this.door.preview(value);
    }
}
