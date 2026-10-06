// M24 «Места»: the place registry service behind PlacesApi (plan M24 п.1–4, §4.4, P14, P15, §16).
//
// Capture runs only in the leader tab and never on the send path: `turn:committed` (the user sent a message, so the
// reply before it is final) schedules a pass that reads the DES tracker of that reply from the chat (no adapter
// round-trips), checks the recent capture records against the chat (a changed or vanished message rolls back), catches
// up committed replies this tab has not seen and applies them. `message:invalidated` rolls back every record from the
// message on and replays the committed replies after the last remaining one. Look-alike candidates go to the Inbox
// (kind 'places.merge'); user edits are journaled with undo (targets 'places.place', 'places.current').
import { adaptersOf } from '../../adapters';
import { uniqueStrings } from '../../domain/canon-keys';
import { desSwipeRecord, parseDesCharacters, parseDesInfoBox } from '../../domain/des-tracker';
import { stableHash } from '../../domain/hash';
import { cleanLabel, normalizePlaceName } from '../../domain/places-label';
import { placeMap, placePath, resolvePlaceLabel } from '../../domain/places-match';
import {
    PlacesError,
    addPlace,
    applyCapture,
    cleanAliases,
    collectForms,
    committedIndices,
    copyPlace,
    createCandidatePlace,
    dismissCandidate,
    firstStaleRecord,
    lastRecordIndex,
    mergeCandidate,
    mergePlaces,
    removePlace,
    reinsertPlace,
    restorePlaceFields,
    rollbackFrom,
    updatePlace,
} from '../../domain/places-registry';
import type {
    CaptureDeps,
    CaptureInput,
    CandidateData,
    MergeProposalData,
    PlaceData,
    PlacesDocData,
} from '../../domain/places-registry';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { CanonApi } from '../canon/api';
import type { WorldModelApi } from '../world/api';
import type { Place, PlaceCandidate, PlacesApi } from './api';
import { PlacesStore } from './store';
import type { Change } from './store';

export const PLACES_KEY = 'places';
export const PLACES_ID = 'M24';
export const MERGE_KIND = 'places.merge';
export const PLACE_TARGET = 'places.place';
export const CURRENT_TARGET = 'places.current';
/** Records checked against the chat on every commit (a full check runs on invalidation and chat load). */
const RECENT_CHECK = 20;
/** Committed replies replayed at most in one pass (after a long gap or in another tab). */
const CATCH_UP = 100;
const QVINK_NOTE_CHARS = 200;
/** Longest wait for an idle moment after a commit. */
const IDLE_WAIT_MS = 1500;

type IdleRequest = (callback: () => void, options?: { timeout?: number }) => number;

export interface PlacesSettings {
    /** Committed replies read when a chat with no places is opened for the first time. */
    bootstrapTurns: number;
}

export function defaultPlacesSettings(): PlacesSettings {
    return { bootstrapTurns: 20 };
}

/** Payload of a 'places.merge' Inbox card (JSON). */
export interface MergePayload {
    key: string;
    label: string;
    name: string;
    target: string;
    similar: string[];
    index: number;
}

// The registry's plain data is exactly the API's Place (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameShape: Exact<Place, PlaceData> = true;
void sameShape;

type EnterListener = (place: Place | null, previous: Place | null) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMergePayload(value: unknown): MergePayload | null {
    if (!isRecord(value) || typeof value.key !== 'string' || typeof value.target !== 'string') return null;
    return {
        key: value.key,
        label: typeof value.label === 'string' ? value.label : value.key,
        name: typeof value.name === 'string' ? value.name : value.key,
        target: value.target,
        similar: Array.isArray(value.similar) ? value.similar.filter((id): id is string => typeof id === 'string') : [],
        index: typeof value.index === 'number' ? value.index : -1,
    };
}

function randomId(): string {
    return `p-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

function candidateView(candidate: CandidateData): PlaceCandidate {
    const view: PlaceCandidate = {
        label: candidate.label,
        seen: [...candidate.seen],
        similar: [...candidate.similar],
        key: candidate.key,
        name: candidate.name,
        parent: candidate.parent,
    };
    if (candidate.proposed) view.proposed = true;
    return view;
}

export class PlacesService implements Required<PlacesApi> {
    readonly store: PlacesStore;
    private readonly changeListeners = new Set<() => void>();
    private readonly enterListeners = new Set<EnterListener>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly idles = new Set<number>();
    private readonly formsCache = new Map<string, string[]>();
    private emitted: { chatId: string | null; current: string | null; place: Place | null } = {
        chatId: null,
        current: null,
        place: null,
    };
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => PlacesSettings,
    ) {
        this.store = new PlacesStore(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [
            this.store.onChange(() => this.changed()),
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // MESSAGE_SENT is on the send path (P15): wait until the page is idle (the request is in flight).
                this.later(() => this.sync({ upTo: messageIndex, check: RECENT_CHECK }), true);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => {
                this.later(() => this.invalidate(messageIndex, reason));
            }),
            app.bus.on('chat:changed', () => {
                this.store.reset();
                this.later(() => this.open());
            }),
            app.leader.onChange((leader) => {
                if (leader) this.later(() => this.sync({ check: Infinity }));
            }),
            app.inbox.registerApplier(
                MERGE_KIND,
                (payload) => this.applyMerge(payload),
                (payload) => this.mergeStillValid(payload),
                (payload) => this.rejectMerge(payload),
            ),
        ];
        app.journal.registerUndo(PLACE_TARGET, (change) => this.undoPlace(change));
        app.journal.registerUndo(CURRENT_TARGET, (change) => this.undoCurrent(change));
        this.later(() => this.open());
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
        for (const handle of this.idles) cancel?.(handle);
        this.idles.clear();
        this.changeListeners.clear();
        this.enterListeners.clear();
    }

    /**
     * Runs a job after the current event handlers; `idle` waits for an idle moment of the page (at most IDLE_WAIT_MS)
     * where the browser offers one, so nothing runs inside ST's send path (P15).
     */
    private later(job: () => Promise<void>, idle = false): void {
        if (this.disposed) return;
        const run = () => {
            if (this.disposed) return;
            job().catch((error: unknown) => this.log.error('places update failed', error));
        };
        const request = (globalThis as { requestIdleCallback?: IdleRequest }).requestIdleCallback;
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

    /** Loads the open chat's places and catches up (chat open, module start). */
    async open(): Promise<void> {
        await this.store.load();
        this.changed();
        await this.sync({ check: Infinity });
    }

    /* ------------------------------------------------------------ capture */

    private captureDeps(): CaptureDeps {
        return { newId: randomId, forms: (name) => this.formsOf(name) };
    }

    /** DES-RU case forms of a name (cached while DES-RU's API is there; [] without it). */
    private formsOf(name: string): string[] {
        const cached = this.formsCache.get(name);
        if (cached) return cached;
        let api: { nameForms(name: string): string[] } | undefined;
        try {
            api = adaptersOf(this.app).desru.api?.();
        } catch {
            api = undefined;
        }
        if (!api) return [];
        let forms: string[] = [];
        try {
            const list = api.nameForms(name);
            forms = Array.isArray(list) ? list.filter((form): form is string => typeof form === 'string') : [];
        } catch (error) {
            this.log.debug('DES-RU nameForms failed', error);
        }
        this.formsCache.set(name, forms);
        return forms;
    }

    private chat(): STChatMessage[] {
        const chat = this.app.host.ctx().chat;
        return Array.isArray(chat) ? chat : [];
    }

    private labelOf(message: STChatMessage | undefined): string | null {
        const record = desSwipeRecord(message);
        return record ? (parseDesInfoBox(record.infoBox)?.location ?? null) : null;
    }

    private stampOf(message: STChatMessage, label: string | null): string {
        const swipe = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
        return `${String(message.send_date ?? '')}|${swipe}|${stableHash(cleanLabel(label) ?? '')}`;
    }

    /** Fingerprint of a committed assistant message now; null when it is gone or not an assistant reply. */
    private stampAt(index: number): string | null {
        const message = this.chat()[index];
        if (!message || message.is_user || message.is_system) return null;
        return this.stampOf(message, this.labelOf(message));
    }

    /** DES canonical names by normalised alias (the world model's identity resolution first). */
    private nameResolver(): (name: string) => string {
        const world = this.app.modules.api<WorldModelApi>('world');
        const byAlias = new Map<string, string>();
        try {
            const aliases = adaptersOf(this.app).des.aliases?.() ?? {};
            for (const [canonical, list] of Object.entries(aliases)) {
                for (const alias of [canonical, ...list]) byAlias.set(normalizePlaceName(alias), canonical);
            }
        } catch (error) {
            this.log.debug('DES aliases unavailable', error);
        }
        return (name) => {
            try {
                const entity = world?.resolve(name, 'character') ?? world?.resolve(name, 'persona');
                if (entity?.name) return entity.name;
            } catch (error) {
                this.log.debug('world model resolve failed', error);
            }
            return byAlias.get(normalizePlaceName(name)) ?? name;
        };
    }

    private qvinkNote(index: number): string | null {
        try {
            const memory = adaptersOf(this.app).qvink.memoryOf?.(index);
            if (!memory || !memory.memory.trim() || (!memory.remember && memory.include !== 'long')) return null;
            const text = memory.memory.replace(/\s+/g, ' ').trim();
            return text.length > QVINK_NOTE_CHARS ? `${text.slice(0, QVINK_NOTE_CHARS - 1)}…` : text;
        } catch {
            return null;
        }
    }

    /** What a committed reply says: DES location, present characters, story date, recent events, a long Qvink memory. */
    private inputAt(index: number, canonical: (name: string) => string): CaptureInput {
        const message = this.chat()[index];
        const record = desSwipeRecord(message);
        const info = record ? parseDesInfoBox(record.infoBox) : null;
        const label = info?.location ?? null;
        const present = record
            ? uniqueStrings(
                  parseDesCharacters(record.characterThoughts)
                      .filter((character) => !character.offScene)
                      .map((character) => canonical(character.name)),
              )
            : [];
        const storyDate = [info?.date, info?.time?.start].filter((part): part is string => !!part).join(', ');
        const events = [...(info?.recentEvents ?? [])];
        const note = this.qvinkNote(index);
        if (note) events.push(note);
        const input: CaptureInput = {
            index,
            stamp: message ? this.stampOf(message, label) : '',
            label,
            present,
            events,
            now: Date.now(),
        };
        if (storyDate) input.storyDate = storyDate;
        return input;
    }

    /** Case forms for Cyrillic places that have none yet (DES-RU appeared after they were made). */
    private refreshForms(doc: PlacesDocData): boolean {
        let changed = false;
        for (const place of doc.places) {
            const names = [place.name, ...place.aliases];
            if (place.forms.length || !names.some((name) => /\p{Script=Cyrillic}/u.test(name))) continue;
            const forms = collectForms(place.name, place.aliases, (name) => this.formsOf(name));
            if (forms.length) {
                place.forms = forms;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * One capture pass (leader only): rolls back from the first record whose message changed or vanished (among the
     * last `check` records), then applies the committed replies after the last record (up to `upTo`).
     */
    async sync(options: { upTo?: number; check: number }): Promise<void> {
        if (this.disposed || !this.app.leader.isLeader() || !this.app.host.chatId()) return;
        const chat = this.chat();
        const canonical = this.nameResolver();
        const deps = this.captureDeps();
        const proposals = await this.store.mutate<MergeProposalData[]>((doc) => {
            let changed = false;
            const stale = firstStaleRecord(doc, (index) => this.stampAt(index), options.check);
            if (stale !== null) changed = rollbackFrom(doc, stale).count > 0;
            const last = lastRecordIndex(doc);
            const fresh = !doc.log.length && !doc.places.length && !doc.candidates.length;
            const limit = fresh ? Math.max(0, Math.floor(this.settings().bootstrapTurns)) : CATCH_UP;
            const pending = committedIndices(chat).filter(
                (index) => index > last && (options.upTo === undefined || index <= options.upTo),
            );
            const found: MergeProposalData[] = [];
            for (const index of limit > 0 ? pending.slice(-limit) : []) {
                const result = applyCapture(doc, this.inputAt(index, canonical), deps);
                changed = changed || result.changed;
                found.push(...result.proposals);
            }
            changed = this.refreshForms(doc) || changed;
            return { changed, result: found };
        });
        for (const proposal of proposals ?? []) await this.propose(proposal);
    }

    /**
     * A swipe, deletion or edit: every record is checked against its message (date, swipe, DES label). A swiped or
     * deleted reply no longer matches and is rolled back with everything after it; ST reports a deletion with the new
     * chat length, and a deletion in the middle shifts the messages after it, so a full check catches both. An edit
     * that kept the location changes nothing, so place ids stay stable.
     */
    private async invalidate(index: number, reason: 'swiped' | 'deleted' | 'edited'): Promise<void> {
        if (reason === 'edited' && this.chat()[index]?.is_user) return;
        await this.store.load();
        await this.sync({ check: Infinity });
    }

    /* ------------------------------------------------------------ Inbox: look-alike candidates */

    private async propose(data: MergeProposalData): Promise<void> {
        const target = data.similar.map((id) => this.get(id)).find((place): place is Place => !!place);
        if (!target) return;
        const payload: MergePayload = {
            key: data.key,
            label: data.label,
            name: data.name,
            target: target.id,
            similar: data.similar,
            index: data.index,
        };
        const after = copyPlace(target);
        after.aliases = cleanAliases(target.name, [...target.aliases, data.name]);
        const others = data.similar
            .filter((id) => id !== target.id)
            .map((id) => this.get(id)?.name)
            .filter((name): name is string => !!name);
        const proposal: Proposal<MergePayload> = {
            module: PLACES_ID,
            kind: MERGE_KIND,
            title: this.t('m24.merge.title', { name: data.name, place: target.name }),
            description: [
                this.t('m24.merge.description', {
                    label: data.label,
                    name: data.name,
                    place: this.path(target.id).join(' › '),
                }),
                others.length ? this.t('m24.merge.others', { places: others.join(', ') }) : '',
            ]
                .filter(Boolean)
                .join(' '),
            details: this.t('m24.merge.details', { label: data.label }),
            appliedNotice: { text: this.t('m24.merge.applied', { name: data.name, place: target.name }) },
            changes: [{ target: PLACE_TARGET, ref: { id: target.id }, before: copyPlace(target), after }],
            payload,
            sourceMessage: data.index,
            apply: (value) => this.applyMerge(value),
            stillValid: () => this.mergeStillValid(payload),
        };
        try {
            await this.app.autonomy.decide(proposal, 'inbox');
        } catch (error) {
            this.log.warn('places merge proposal failed', error);
        }
    }

    private async mergeStillValid(value: unknown): Promise<boolean> {
        const payload = readMergePayload(value);
        if (!payload) return false;
        const doc = await this.store.load();
        return (
            !!doc &&
            doc.candidates.some((candidate) => candidate.key === payload.key) &&
            doc.places.some((place) => place.id === payload.target)
        );
    }

    private async applyMerge(value: unknown): Promise<void> {
        const payload = readMergePayload(value);
        if (!payload) throw new Error(this.t('m24.error.missing'));
        await this.mergeCandidateInto(payload.key, payload.target, false);
    }

    /** «These are different»: the candidate held for two turns, so it becomes a place of its own. */
    private async rejectMerge(value: unknown): Promise<void> {
        const payload = readMergePayload(value);
        if (!payload) return;
        const doc = await this.store.load();
        if (!doc?.candidates.some((candidate) => candidate.key === payload.key)) return;
        await this.createCandidate(payload.key);
    }

    /* ------------------------------------------------------------ enter events */

    private changed(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('places change listener failed', error);
            }
        }
        const doc = this.store.peek();
        if (!doc) return;
        const chatId = this.app.host.chatId();
        const current = doc.current;
        if (chatId === this.emitted.chatId && current === this.emitted.current) return;
        const previous = chatId === this.emitted.chatId ? this.emitted.place : null;
        const place = current ? (this.get(current) ?? null) : null;
        this.emitted = { chatId, current, place };
        if (!place && !previous) return;
        for (const listener of [...this.enterListeners]) {
            try {
                listener(place, previous);
            } catch (error) {
                this.log.error('places enter listener failed', error);
            }
        }
    }

    /* ------------------------------------------------------------ reads */

    private doc(): PlacesDocData | null {
        const doc = this.store.peek();
        if (!doc) void this.store.load();
        return doc;
    }

    list(): Place[] {
        return (this.doc()?.places ?? []).map(copyPlace);
    }

    get(id: string): Place | undefined {
        const place = this.doc()?.places.find((item) => item.id === id);
        return place ? copyPlace(place) : undefined;
    }

    current(): Place | null {
        const doc = this.doc();
        const current = doc?.current;
        if (!doc || !current) return null;
        const place = doc.places.find((item) => item.id === current);
        return place ? copyPlace(place) : null;
    }

    resolve(label: string): Place | undefined {
        const doc = this.doc();
        if (!doc || typeof label !== 'string') return undefined;
        const { match } = resolvePlaceLabel(doc.places, label, { current: doc.current });
        return match ? this.get(match) : undefined;
    }

    candidates(): PlaceCandidate[] {
        return (this.doc()?.candidates ?? []).map(candidateView);
    }

    path(id: string): string[] {
        return placePath(placeMap(this.doc()?.places ?? []), id);
    }

    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    onEnter(listener: EnterListener): Unsubscribe {
        this.enterListeners.add(listener);
        return () => this.enterListeners.delete(listener);
    }

    /* ------------------------------------------------------------ edits */

    private errorText(error: unknown): Error {
        if (error instanceof PlacesError) return new Error(this.t(`m24.error.${error.code}`));
        return error instanceof Error ? error : new Error(String(error));
    }

    /** A user edit: applied to the document (errors translated), then journaled. */
    private async edit<R>(change: (doc: PlacesDocData) => Change<R>): Promise<R> {
        let result: R | undefined;
        try {
            result = await this.store.mutate(change);
        } catch (error) {
            throw this.errorText(error);
        }
        if (result === undefined) throw new Error(this.t('m24.error.save'));
        return result;
    }

    private async journal(kind: string, summary: string, changes: JournalChange[]): Promise<void> {
        if (!changes.length) return;
        try {
            await this.app.journal.record({ module: PLACES_ID, kind, summary, changes });
        } catch (error) {
            this.log.warn('places change not journaled', error);
        }
    }

    async create(name: string, parent: string | null = null): Promise<Place> {
        const deps = this.captureDeps();
        const place = await this.edit((doc) => ({
            changed: true,
            result: copyPlace(addPlace(doc, { name, parent }, deps, Date.now())),
        }));
        await this.journal('places.create', this.t('m24.journal.create', { name: place.name }), [
            { target: PLACE_TARGET, ref: { id: place.id }, before: null, after: place },
        ]);
        return place;
    }

    async update(id: string, patch: Partial<Omit<Place, 'id' | 'visits'>>): Promise<void> {
        const deps = this.captureDeps();
        const { before, after } = await this.edit((doc) => ({
            changed: true,
            result: updatePlace(doc, id, patch, deps),
        }));
        const summary =
            before.name !== after.name
                ? this.t('m24.journal.rename', { from: before.name, to: after.name })
                : this.t('m24.journal.update', { name: after.name });
        await this.journal('places.update', summary, [{ target: PLACE_TARGET, ref: { id }, before, after }]);
    }

    async merge(keepId: string, mergeId: string): Promise<void> {
        const deps = this.captureDeps();
        const outcome = await this.edit((doc) => ({ changed: true, result: mergePlaces(doc, keepId, mergeId, deps) }));
        const changes: JournalChange[] = [];
        if (outcome.currentBefore === mergeId) {
            changes.push({ target: CURRENT_TARGET, ref: {}, before: mergeId, after: keepId });
        }
        changes.push({
            target: PLACE_TARGET,
            ref: { id: keepId, movedVisits: outcome.movedVisits },
            before: outcome.keepBefore,
            after: outcome.keepAfter,
        });
        for (const child of outcome.reparented) {
            changes.push({
                target: PLACE_TARGET,
                ref: { id: child.id },
                before: child,
                after: { ...child, parent: keepId },
            });
        }
        changes.push({ target: PLACE_TARGET, ref: { id: mergeId }, before: outcome.merged, after: null });
        await this.journal(
            'places.merge',
            this.t('m24.journal.merge', { from: outcome.merged.name, to: outcome.keepAfter.name }),
            changes,
        );
    }

    async remove(id: string): Promise<void> {
        const outcome = await this.edit((doc) => ({ changed: true, result: removePlace(doc, id) }));
        const changes: JournalChange[] = [];
        if (outcome.currentBefore === id) changes.push({ target: CURRENT_TARGET, ref: {}, before: id, after: null });
        for (const child of outcome.reparented) {
            changes.push({
                target: PLACE_TARGET,
                ref: { id: child.id },
                before: child,
                after: { ...child, parent: outcome.removed.parent },
            });
        }
        changes.push({ target: PLACE_TARGET, ref: { id }, before: outcome.removed, after: null });
        await this.journal('places.remove', this.t('m24.journal.remove', { name: outcome.removed.name }), changes);
    }

    async createCandidate(key: string): Promise<Place> {
        const deps = this.captureDeps();
        const outcome = await this.edit((doc) => {
            const result = createCandidatePlace(doc, key, deps, Date.now());
            return { changed: true, result: { place: copyPlace(result.place), created: result.created } };
        });
        const created = outcome.created.map((id) => this.get(id)).filter((place): place is Place => !!place);
        await this.journal(
            'places.create',
            this.t('m24.journal.create', { name: outcome.place.name }),
            created.map((place) => ({ target: PLACE_TARGET, ref: { id: place.id }, before: null, after: place })),
        );
        return this.get(outcome.place.id) ?? outcome.place;
    }

    async mergeCandidate(key: string, placeId: string): Promise<void> {
        await this.mergeCandidateInto(key, placeId, true);
    }

    /** The Inbox journals its own card, so its path skips the journal here. */
    private async mergeCandidateInto(key: string, placeId: string, journal: boolean): Promise<void> {
        const deps = this.captureDeps();
        const { before, after } = await this.edit((doc) => ({
            changed: true,
            result: mergeCandidate(doc, key, placeId, deps),
        }));
        if (!journal) return;
        const alias = after.aliases.find((name) => !before.aliases.includes(name)) ?? key;
        await this.journal('places.alias', this.t('m24.journal.alias', { alias, name: after.name }), [
            { target: PLACE_TARGET, ref: { id: placeId }, before, after },
        ]);
    }

    async dismissCandidate(key: string): Promise<void> {
        await this.edit((doc) => ({ changed: dismissCandidate(doc, key), result: true }));
    }

    /* ------------------------------------------------------------ undo */

    private async undoPlace(change: JournalChange): Promise<boolean> {
        if (this.disposed) return false;
        const id = isRecord(change.ref) && typeof change.ref.id === 'string' ? change.ref.id : null;
        if (!id) return false;
        const moved =
            isRecord(change.ref) && Array.isArray(change.ref.movedVisits)
                ? change.ref.movedVisits.filter((value): value is number => typeof value === 'number')
                : [];
        const before = isRecord(change.before) ? (change.before as unknown as PlaceData) : null;
        const after = isRecord(change.after) ? (change.after as unknown as PlaceData) : null;
        const result = await this.store.mutate<boolean>((doc) => {
            if (before === null) {
                if (!doc.places.some((place) => place.id === id)) return { changed: false, result: true };
                removePlace(doc, id);
                return { changed: true, result: true };
            }
            if (after === null) return { changed: reinsertPlace(doc, before), result: true };
            const ok = restorePlaceFields(doc, before, moved);
            return { changed: ok, result: ok };
        });
        return result === true;
    }

    private async undoCurrent(change: JournalChange): Promise<boolean> {
        if (this.disposed) return false;
        const before = typeof change.before === 'string' ? change.before : null;
        const after = typeof change.after === 'string' ? change.after : null;
        const result = await this.store.mutate<boolean>((doc) => {
            if (doc.current !== after) return { changed: false, result: true };
            doc.current = before !== null && doc.places.some((place) => place.id === before) ? before : null;
            return { changed: doc.current !== after, result: true };
        });
        return result === true;
    }

    /* ------------------------------------------------------------ description entry */

    /** Checks that a stored description entry still exists (canon book through the canon, other books via loreStore). */
    private async entryExists(entry: { world: string; uid: number }, canon: CanonApi | undefined): Promise<boolean> {
        try {
            if (canon && entry.world === canon.bookName()) {
                return (await canon.list()).some((item) => item.uid === entry.uid);
            }
            const lore = this.app.modules.api<{
                load(name: string): Promise<{ entries: Record<string, unknown> } | null>;
            }>('loreStore');
            if (!lore) return true;
            const book = await lore.load(entry.world);
            return !!book && isRecord(book.entries) && String(entry.uid) in book.entries;
        } catch (error) {
            this.log.debug('description entry check failed', error);
            return true;
        }
    }

    async ensureEntry(id: string): Promise<{ world: string; uid: number }> {
        await this.store.load();
        const place = this.get(id);
        if (!place) throw new Error(this.t('m24.error.missing'));
        const canon = this.app.modules.api<CanonApi>('canon');
        if (place.entry && (await this.entryExists(place.entry, canon))) return { ...place.entry };
        if (!canon) throw new Error(this.t('m24.error.noCanon'));
        const book = canon.bookName();
        if (!book) throw new Error(this.t('m24.error.noChat'));
        const names = new Set([place.name, ...place.aliases].map(normalizePlaceName).filter(Boolean));
        const existing = (await canon.list({ kind: 'addition' })).find((item) => {
            if (item.meta.type !== 'place') return false;
            const keys = Array.isArray(item.entry.key) ? item.entry.key : [];
            const comment = typeof item.entry.comment === 'string' ? item.entry.comment : '';
            return [comment, ...keys].some((key) => typeof key === 'string' && names.has(normalizePlaceName(key)));
        });
        let uid: number;
        if (existing) {
            uid = existing.uid;
        } else {
            const parent = place.parent ? this.get(place.parent) : undefined;
            const russian: string[] = [];
            for (const name of [place.name, ...place.aliases]) {
                try {
                    russian.push(...(await canon.russianKeys(name)));
                } catch (error) {
                    this.log.debug('russianKeys failed', error);
                }
            }
            const content = [`Place: ${place.name}`, parent ? `Part of: ${parent.name}` : null, 'Description: ']
                .filter((line): line is string => line !== null)
                .join('\n');
            uid = await canon.put({
                entry: { comment: place.name, key: uniqueStrings([place.name, ...place.aliases, ...russian]), content },
                meta: { kind: 'addition', status: 'active', origin: 'entity', type: 'place' },
            });
        }
        const entry = { world: book, uid };
        await this.store.mutate((doc) => {
            const target = doc.places.find((item) => item.id === id);
            if (!target) return { changed: false, result: undefined };
            target.entry = { ...entry };
            return { changed: true, result: undefined };
        });
        return entry;
    }
}
