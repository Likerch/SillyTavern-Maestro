// Starting scenes of M37 «Подготовить к игре» (plan-2 §7): every greeting of the card is a start of its own — in
// SillyTavern the alternate greetings are the swipes of message 0. Applying the plan stores every checked scene in the
// chat's document 'prepare-scenes' (each one a step of its item's journal record). The scene of the greeting message 0
// shows now is the ACTIVE one: its parts are applied — the starting outfits (the wardrobe, which journals them itself),
// the type of the first scene (the director's override, released after the first committed turn like the direction's)
// and the canon note of the start («Story start», one per chat: rewritten in place when the start changes, never
// doubled). While the player has not written yet, a swipe of message 0 switches the active scene quietly: the previous
// one's parts are taken back (the wardrobe's records undone, the director's override handed on, the note rewritten) and
// the new one's applied, with one info notice. The first user message locks the start; later swipes change nothing.
// Undoing a scene's apply takes it out of the document and, when it was the active one, takes its parts back.
// A Russian story's outfits reach the wardrobe as Russian statements (prepare-apply outfitStatement); its start note names
// the place and the cast in English (the names kept with the scene when it was stored).
import { normName } from '../../domain/dossier-names';
import { TYPED_FIELDS_KEY } from '../../domain/entry-types';
import { outfitStatement, startNoteDraft } from '../../domain/prepare-apply';
import type { StartNames, StartOutfit } from '../../domain/prepare-apply';
import { clonePlan, isFirstScene, migrateScenes } from '../../domain/prepare-plan';
import type { AnyPrepareItem, FirstScene, SceneData } from '../../domain/prepare-plan';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { CanonApi, CanonDraft } from '../canon/api';
import type { DirectorApi, SceneType } from '../director/api';
import type { WardrobeApi } from '../wardrobe/api';
import type { StartScenesInfo } from './api';
import { apiOf, hasUserMessages, isDict, linkedRecords, safely, shownGreeting, shownGreetingNow } from './collect';

/** Per-chat document of the starting scenes. */
export const SCENES_DOC = 'prepare-scenes';

/** A starting scene kept for this chat, with what it brings resolved when it was stored. */
export interface StoredScene {
    greeting: number;
    /** The plan item it came from (`scene:<n>`). */
    itemId: string;
    data: SceneData;
    /** The Russian line of the scene. */
    russian: string;
    /** Its outfits, else those of the characters present (resolved against the plan when stored). */
    outfits: StartOutfit[];
    /** Its type of the first scene, else the direction's. */
    firstScene: FirstScene | '';
    /** The English names of its place and cast for the canon note (a Russian story); missing: the scene's own. */
    names?: StartNames;
}

/** What the active scene has applied (taken back when the start changes or its apply is undone). */
export interface ActiveParts {
    greeting: number;
    /** Journal records of the wardrobe for the starting outfits. */
    outfits: string[];
    /** The director's override set for this start and what it replaced. */
    director?: { type: string; previous: string | null };
    /** The canon note of the start: where it is and what was written (a note edited by hand is never removed). */
    note?: { book: string; uid: number; content: string };
}

export interface ScenesDoc {
    scenes: StoredScene[];
    active: ActiveParts | null;
    /** The player wrote: the start no longer follows the greeting swipe. */
    locked: boolean;
}

/** What an activation did, in story words (the apply step's outcome lines). */
export interface ActivationResult {
    done: string[];
    skipped: string[];
    failed: string[];
}

export function emptyScenes(): ScenesDoc {
    return { scenes: [], active: null, locked: false };
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readOutfits(value: unknown): StartOutfit[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(isDict)
        .map((row) => ({ name: str(row.name), english: str(row.english), wearing: str(row.wearing) }))
        .filter((row) => row.name && row.wearing);
}

function readNames(raw: unknown): StartNames | undefined {
    if (!isDict(raw)) return undefined;
    const present = Array.isArray(raw.present)
        ? raw.present.filter((name): name is string => typeof name === 'string')
        : [];
    const place = str(raw.place);
    return place || present.length ? { place, present } : undefined;
}

function readStored(raw: unknown): StoredScene | null {
    if (!isDict(raw) || typeof raw.greeting !== 'number' || !Number.isInteger(raw.greeting) || raw.greeting < 0) {
        return null;
    }
    const greeting = raw.greeting;
    const [item] = migrateScenes(
        [
            {
                id: '',
                kind: 'scene',
                data: (isDict(raw.data) ? raw.data : {}) as never,
                russian: '',
                sources: [],
                scope: 'chat',
            },
        ],
        greeting,
    );
    const data = (item as AnyPrepareItem & { kind: 'scene' }).data;
    data.greeting = greeting;
    const names = readNames(raw.names);
    return {
        greeting,
        itemId: str(raw.itemId) || `scene:${greeting}`,
        data,
        russian: str(raw.russian),
        outfits: readOutfits(raw.outfits),
        firstScene: isFirstScene(raw.firstScene) ? raw.firstScene : '',
        ...(names ? { names } : {}),
    };
}

function readActive(raw: unknown): ActiveParts | null {
    if (!isDict(raw) || typeof raw.greeting !== 'number') return null;
    const active: ActiveParts = {
        greeting: raw.greeting,
        outfits: Array.isArray(raw.outfits) ? raw.outfits.filter((id): id is string => typeof id === 'string') : [],
    };
    if (isDict(raw.director) && typeof raw.director.type === 'string') {
        active.director = {
            type: raw.director.type,
            previous: typeof raw.director.previous === 'string' ? raw.director.previous : null,
        };
    }
    if (isDict(raw.note) && typeof raw.note.uid === 'number' && typeof raw.note.book === 'string') {
        active.note = { book: raw.note.book, uid: raw.note.uid, content: str(raw.note.content) };
    }
    return active;
}

export function readScenesDoc(raw: unknown): ScenesDoc {
    const doc = emptyScenes();
    if (!isDict(raw)) return doc;
    if (Array.isArray(raw.scenes)) {
        for (const row of raw.scenes) {
            const scene = readStored(row);
            if (scene && !doc.scenes.some((other) => other.greeting === scene.greeting)) doc.scenes.push(scene);
        }
        doc.scenes.sort((a, b) => a.greeting - b.greeting);
    }
    doc.active = readActive(raw.active);
    doc.locked = raw.locked === true;
    return doc;
}

export class StartScenes {
    private doc: ScenesDoc | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; job: Promise<ScenesDoc> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private followQueued = false;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        try {
            offs.push(
                this.app.host.events.on('MESSAGE_SWIPED', (messageId) => {
                    if (Number(messageId) !== 0) return;
                    this.emit();
                    void this.follow();
                }),
            );
        } catch (error) {
            this.log.debug('prepare: no swipe event', error);
        }
        offs.push(
            this.app.bus.on('chat:changed', () => {
                this.doc = null;
                this.docChat = null;
                this.emit();
                void this.follow();
            }),
        );
        offs.push(() => this.listeners.clear());
        return offs;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('prepare: a scenes listener failed', error);
            }
        }
    }

    /** One change of the document at a time (applies, undo, swipes, the first turn). */
    private exclusive<T>(run: () => Promise<T>): Promise<T> {
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /* ---------------------------------------------------------------- the document */

    load(): Promise<ScenesDoc> {
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId) return Promise.resolve(emptyScenes());
        if (this.doc && this.docChat === chatId) return Promise.resolve(this.doc);
        if (this.loading?.chatId === chatId) return this.loading.job;
        const job = (async () => {
            let raw: unknown = null;
            try {
                raw = await this.app.chat.get<Record<string, unknown>>(SCENES_DOC, () => ({}));
            } catch (error) {
                this.log.debug('prepare: the starting scenes did not load', error);
            }
            const doc = readScenesDoc(raw);
            if (safely(() => this.app.host.chatId(), null) === chatId) {
                this.doc = doc;
                this.docChat = chatId;
                this.emit();
            }
            return doc;
        })();
        const slot = { chatId, job };
        this.loading = slot;
        void job.finally(() => {
            if (this.loading === slot) this.loading = null;
        });
        return job;
    }

    private async save(doc: ScenesDoc, chatId: string): Promise<boolean> {
        if (safely(() => this.app.host.chatId(), null) !== chatId) return false;
        this.doc = doc;
        this.docChat = chatId;
        try {
            const ok = await this.app.chat.put(SCENES_DOC, clonePlan(doc) as unknown as Record<string, unknown>);
            if (!ok) this.log.warn('prepare: another tab wrote the starting scenes; this one is kept in memory');
        } catch (error) {
            this.log.warn('prepare: the starting scenes were not saved', error);
        }
        this.emit();
        return true;
    }

    /** The loaded document of the current chat (null before it is read; the read starts). */
    private current(): ScenesDoc | null {
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId) return null;
        if (this.docChat === chatId && this.doc) return this.doc;
        void this.load().catch(() => null);
        return null;
    }

    /** Where the starts of this chat are: the greeting shown, those prepared, the active one, the lock. */
    info(): StartScenesInfo {
        const doc = this.current();
        return {
            shown: shownGreetingNow(this.app),
            prepared: (doc?.scenes ?? []).map((scene) => scene.greeting),
            active: doc?.active?.greeting ?? null,
            locked: doc?.locked ?? false,
        };
    }

    /** A stored scene of this chat (loaded document only). */
    scene(greeting: number): StoredScene | undefined {
        const found = this.current()?.scenes.find((scene) => scene.greeting === greeting);
        return found ? clonePlan(found) : undefined;
    }

    /** Every stored scene of this chat (copies; the document is read first). */
    async all(): Promise<StoredScene[]> {
        return clonePlan((await this.load()).scenes);
    }

    /** The active scene set the director's type (the direction's own type then stays out). */
    async typed(): Promise<boolean> {
        return !!(await this.load()).active?.director;
    }

    /** The greeting shown now (the card loaded fully when needed). */
    shown(): Promise<number | null> {
        return shownGreeting(this.app);
    }

    /* ---------------------------------------------------------------- store and undo */

    /** Keeps a scene for this chat; returns the one it replaced (the journal's `before`). */
    store(scene: StoredScene): Promise<StoredScene | null> {
        return this.exclusive(async () => {
            const chatId = this.app.host.chatId();
            if (!chatId) throw new Error(this.t('m37.error.noChat'));
            const doc = clonePlan(await this.load());
            const index = doc.scenes.findIndex((other) => other.greeting === scene.greeting);
            const before = index >= 0 ? clonePlan(doc.scenes[index]!) : null;
            if (index >= 0) doc.scenes[index] = clonePlan(scene);
            else doc.scenes.push(clonePlan(scene));
            doc.scenes.sort((a, b) => a.greeting - b.greeting);
            await this.save(doc, chatId);
            return before;
        });
    }

    /**
     * The undo of a stored scene: when it is the active one its parts are taken back first; the scene it replaced
     * comes back (and is active again while the chat is new and shows it), else it is gone.
     */
    unstore(greeting: number, before: unknown): Promise<boolean> {
        return this.exclusive(async () => {
            const chatId = this.app.host.chatId();
            if (!chatId) return false;
            const doc = clonePlan(await this.load());
            if (doc.active?.greeting === greeting) {
                await this.takeBack(doc.active, {});
                doc.active = null;
            }
            const restored = readStored(before);
            doc.scenes = doc.scenes.filter((scene) => scene.greeting !== greeting);
            if (restored && restored.greeting === greeting) {
                doc.scenes.push(restored);
                doc.scenes.sort((a, b) => a.greeting - b.greeting);
            }
            await this.save(doc, chatId);
            if (restored && this.followable(doc) && (await this.shown()) === greeting) {
                await this.activateNow(greeting, {});
            }
            return true;
        });
    }

    /* ---------------------------------------------------------------- the active scene */

    /** The start may still follow the greeting: scenes stored, no lock, the player has not written. */
    private followable(doc: ScenesDoc): boolean {
        if (doc.locked || !doc.scenes.length) return false;
        return !hasUserMessages(safely(() => this.app.host.ctx().chat ?? [], [] as STChatMessage[]));
    }

    /** Makes a stored scene the active one (the previous one's parts are taken back first). */
    activate(greeting: number, options: { passported?: ReadonlyMap<string, string> } = {}): Promise<ActivationResult> {
        return this.exclusive(() => this.activateNow(greeting, options));
    }

    private async activateNow(
        greeting: number,
        options: { passported?: ReadonlyMap<string, string> },
    ): Promise<ActivationResult> {
        const result: ActivationResult = { done: [], skipped: [], failed: [] };
        const chatId = this.app.host.chatId();
        if (!chatId) return result;
        const doc = clonePlan(await this.load());
        const scene = doc.scenes.find((candidate) => candidate.greeting === greeting);
        if (!scene) return result;
        const previous = doc.active;
        // The note and the director's override are handed on to the new start (rewritten, not removed and added).
        if (previous) await this.takeBack(previous, { note: true, director: true });
        const parts: ActiveParts = { greeting, outfits: [] };
        const fail = (part: string, error: unknown) => {
            this.log.warn(`prepare: starting scene ${greeting}: ${part} failed`, error);
            result.failed.push(this.t('m37.result.failedPart', { part, error: message(error) }));
        };

        // Starting outfits: through the wardrobe (its own records); an outfit that went into a passport made now is
        // already worn.
        const outfits = scene.outfits.filter(
            (outfit) => options.passported?.get(normName(outfit.name)) !== outfit.wearing,
        );
        if (outfits.length) {
            const wardrobe = apiOf<WardrobeApi>(this.app, 'wardrobe');
            if (!wardrobe?.intakeOutfit) {
                result.skipped.push(this.t('m37.skip.moduleOff', { module: this.t('m37.module.wardrobe') }));
            } else {
                for (const outfit of outfits) {
                    try {
                        const ids = await linkedRecords(this.app, 'M27', async () =>
                            wardrobe.intakeOutfit?.({
                                entityName: outfit.name,
                                value: outfitStatement(outfit),
                                evidence: '',
                                sourceMessage: 0,
                            }),
                        );
                        parts.outfits.push(...ids);
                    } catch (error) {
                        fail(this.t('m37.part.outfit'), error);
                    }
                }
                if (parts.outfits.length) result.done.push(this.t('m37.part.outfits'));
            }
        }

        // The type of the first scene: the director's override, what it replaced is kept from the first start.
        const director = apiOf<DirectorApi>(this.app, 'director');
        const type = scene.firstScene;
        if (director) {
            try {
                const current = safely(() => director.override?.() ?? null, null);
                const ours = !!previous?.director && current === previous.director.type;
                const base = ours ? (previous?.director?.previous ?? null) : current;
                if (type) {
                    if (current !== type) await director.setScene(type as SceneType);
                    parts.director = { type, previous: base };
                    result.done.push(this.t('m37.part.firstScene'));
                } else if (ours) {
                    await director.setScene(base as SceneType | null);
                }
            } catch (error) {
                fail(this.t('m37.part.firstScene'), error);
            }
        } else if (type) {
            result.skipped.push(this.t('m37.skip.moduleOff', { module: this.t('m37.module.director') }));
        }

        // The canon note of the start: the previous start's note is rewritten in place.
        const draft = startNoteDraft(scene.data, scene.names);
        const canon = apiOf<CanonApi>(this.app, 'canon');
        const kept = previous?.note;
        if (draft && canon) {
            try {
                const book = canon.bookName();
                let uid: number | undefined;
                if (kept && kept.book === book && (await canon.list()).some((item) => item.uid === kept.uid)) {
                    uid = kept.uid;
                }
                const meta = {
                    kind: 'addition',
                    status: 'active',
                    origin: 'import',
                    type: draft.type,
                    [TYPED_FIELDS_KEY]: { ...draft.fields },
                } as unknown as CanonDraft['meta'];
                const written = await canon.put(
                    {
                        entry: { comment: draft.title, key: [...draft.keys], keysecondary: [], content: draft.content },
                        meta,
                    },
                    uid !== undefined ? { uid } : {},
                );
                parts.note = { book, uid: written, content: draft.content };
                result.done.push(this.t('m37.part.startNote'));
            } catch (error) {
                fail(this.t('m37.part.startNote'), error);
            }
        } else {
            if (draft) result.skipped.push(this.t('m37.skip.moduleOff', { module: this.t('m37.module.canon') }));
            if (kept) await this.removeNote(kept);
        }

        doc.active = parts;
        await this.save(doc, chatId);
        return result;
    }

    /** Takes back what an active scene applied (`keep` hands the note or the director's override to the next one). */
    private async takeBack(active: ActiveParts, keep: { note?: boolean; director?: boolean }): Promise<void> {
        for (const id of [...active.outfits].reverse()) {
            try {
                await this.app.journal.undo(id);
            } catch (error) {
                this.log.debug('prepare: a starting outfit was not taken back', error);
            }
        }
        if (!keep.director && active.director) {
            const director = apiOf<DirectorApi>(this.app, 'director');
            try {
                if (director && safely(() => director.override?.() ?? null, null) === active.director.type) {
                    await director.setScene((active.director.previous as SceneType | null) ?? null);
                }
            } catch (error) {
                this.log.debug('prepare: the first scene type was not taken back', error);
            }
        }
        if (!keep.note && active.note) await this.removeNote(active.note);
    }

    /** Removes the note of a start unless the user changed it. */
    private async removeNote(note: NonNullable<ActiveParts['note']>): Promise<void> {
        const canon = apiOf<CanonApi>(this.app, 'canon');
        if (!canon) return;
        try {
            if (canon.bookName() !== note.book) return;
            const item = (await canon.list()).find((candidate) => candidate.uid === note.uid);
            if (item && str(item.entry.content) === note.content) await canon.remove(note.uid);
        } catch (error) {
            this.log.debug('prepare: the note of the start was not removed', error);
        }
    }

    /* ---------------------------------------------------------------- following the greeting */

    /**
     * The active scene follows the greeting message 0 shows (a swipe, a chat opened again) while the chat is new: the
     * previous one's parts are taken back, the shown one's applied, one quiet notice. A greeting without a prepared
     * scene leaves no start active; an unknown one (not a greeting of the card) changes nothing.
     */
    follow(): Promise<void> {
        if (this.followQueued) return Promise.resolve();
        this.followQueued = true;
        return this.exclusive(async () => {
            this.followQueued = false;
            try {
                await this.followNow();
            } catch (error) {
                this.log.warn('prepare: the starting scene did not follow the greeting', error);
            }
        });
    }

    private async followNow(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const doc = clonePlan(await this.load());
        if (!doc.scenes.length || doc.locked) return;
        if (!this.followable(doc)) {
            doc.locked = true;
            await this.save(doc, chatId);
            return;
        }
        const shown = await this.shown();
        if (shown === null || doc.active?.greeting === shown || this.app.host.chatId() !== chatId) return;
        const scene = doc.scenes.find((candidate) => candidate.greeting === shown);
        if (scene) {
            await this.activateNow(shown, {});
            const what =
                [scene.data.place, scene.data.time].filter((part) => part.trim()).join(', ') ||
                this.t('m37.sceneNumber', { n: shown + 1 });
            this.app.ui.notice(this.t('m37.notice.scene', { what }), { importance: 'info' });
            return;
        }
        if (!doc.active) return;
        await this.takeBack(doc.active, {});
        doc.active = null;
        await this.save(doc, chatId);
        this.app.ui.notice(this.t('m37.notice.sceneNone'), { importance: 'info' });
    }

    /**
     * The player's first message: the start no longer follows the greeting swipe. The director's override of its
     * first scene stays — the first reply is written with it; release() takes it off once that reply is committed.
     */
    lock(): Promise<void> {
        return this.exclusive(async () => {
            const chatId = this.app.host.chatId();
            if (!chatId) return;
            const doc = clonePlan(await this.load());
            if (doc.locked || (!doc.scenes.length && !doc.active)) return;
            doc.locked = true;
            await this.save(doc, chatId);
        });
    }

    /**
     * The first reply is committed: the start is locked (if it was not yet) and the director's override of its first
     * scene is released (the outfits and the note stay: they are the story now).
     */
    release(): Promise<void> {
        return this.exclusive(async () => {
            const chatId = this.app.host.chatId();
            if (!chatId) return;
            const doc = clonePlan(await this.load());
            if (!doc.scenes.length && !doc.active) return;
            if (doc.locked && !doc.active?.director) return;
            doc.locked = true;
            const first = doc.active?.director;
            if (doc.active && first) {
                const director = apiOf<DirectorApi>(this.app, 'director');
                try {
                    if (director && safely(() => director.override?.() ?? null, null) === first.type) {
                        await director.setScene((first.previous as SceneType | null) ?? null);
                    }
                } catch (error) {
                    this.log.debug('prepare: the first scene of the start was not released', error);
                }
                delete doc.active.director;
            }
            await this.save(doc, chatId);
        });
    }
}
