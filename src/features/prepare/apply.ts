// Applying a plan of M37 «Подготовить к игре» (plan-2 §7 п. 4): every chosen item is one part — written through the
// owning modules' APIs and journaled as one record of its own (kind 'prepare.apply', or 'prepare.import' for the saved
// character-level preparation) whose changes are the steps, each undone through its owner:
// - canon texts (characters, the world, places, factions, items, traditions, the calendar): the chat canon (typed
//   additions with Russian keys from DES-RU, canon.russianKeys); «для персонажа» also the card's Maestro book;
// - places: the chat's place registry (nested from the top down) bound to their canon entry;
// - NAI passports of characters without one: NAI Studio's text generator (never Anlas), saved for the chat or, «для
//   персонажа», into the card;
// - secrets → «Кто что знает», promises → the calendar, mechanics → the mechanics module (a definition for this chat
//   or this card, starting values per holder), the first scene type → the director (released after the first turn),
//   starting outfits → the wardrobe (its own journal record is linked);
// - backgrounds are only proposed (a library pick or «generate» in the backgrounds window), never generated here.
import { adaptersOf } from '../../adapters';
import { readPassport } from '../../adapters/nai';
import { hasCyrillic, uniqueStrings } from '../../domain/canon-keys';
import { normName } from '../../domain/dossier-names';
import { freeId } from '../../domain/dossier-styleup';
import { TYPED_FIELDS_KEY } from '../../domain/entry-types';
import { canonDraftOf } from '../../domain/prepare-apply';
import type { CanonEntryDraft } from '../../domain/prepare-apply';
import { itemTitle } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PrepareItem, PrepareScope } from '../../domain/prepare-plan';
import type { App, JournalChange, Logger } from '../../shared/contracts';
import type { BackgroundsApi } from '../backgrounds/api';
import type { CalendarApi } from '../calendar/api';
import type { CanonApi, CanonDraft } from '../canon/api';
import type { DirectorApi, SceneType } from '../director/api';
import type { KnowledgeApi } from '../knowledge/api';
import type { PlacesApi } from '../places/api';
import type { WardrobeApi } from '../wardrobe/api';
import { CardBook } from './card-book';
import type { CardBookItem } from './card-book';
import type { CardRef } from './collect';
import { apiOf, isDict, safely, withTimeout } from './collect';
import { mechanicsPort } from './mechanics-adapter';
import { APPLY_KIND, IMPORT_KIND, PREPARE_ID, PREPARE_STEP_TARGET } from './settings';

type Dict = Record<string, unknown>;

const BACKGROUND_TIMEOUT_MS = 3000;

/** How the steps are written. */
export interface ApplyEnv {
    card: CardRef;
    /** The card's Maestro book («для персонажа»). */
    cardBook: string;
    passports: boolean;
    /** 'import': the saved character-level preparation into a new chat (no card writes, texts from the card book). */
    mode: 'apply' | 'import';
    /** Card-book entries by item id (import). */
    imported?: ReadonlyMap<string, CardBookItem>;
    /** Every item of the plan (the scene looks up the characters' outfits). */
    plan: readonly AnyPrepareItem[];
}

/** State shared by the items of one pack. */
export interface PackState {
    /** Normalised place name → place id (created now or found). */
    placeIds: Map<string, string>;
    /** Characters whose passport was generated now (their outfit went into it). */
    passported: Set<string>;
    proposals: string[];
    /** The director's first scene set now (released after the first turn). */
    firstScene?: { type: string; previous: string | null };
}

export function newPack(): PackState {
    return { placeIds: new Map(), passported: new Set(), proposals: [] };
}

export interface ItemOutcome {
    itemId: string;
    kind: AnyPrepareItem['kind'];
    title: string;
    /** Parts written, in story words. */
    done: string[];
    /** Why parts were not written. */
    skipped: string[];
    /** Parts that failed (story word + reason). */
    failed: string[];
    journalId?: string;
    /** Something was written for the card (book entry, card passport, card mechanic). */
    forCard: boolean;
}

/** A step of an applied item (the journal change's `after`). */
interface StepAfter {
    /** What it was, in story words («в канон», «паспорт»). */
    what: string;
    name: string;
    /** Technical text (English canon content, tags): «Подробнее» only. */
    detail?: string;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class Applier {
    private readonly cardBook: CardBook;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        /** A card-book entry of an item was undone: the saved preparation forgets the item. */
        private readonly onCardItemUndone: (avatar: string, itemId: string) => Promise<void>,
    ) {
        this.cardBook = new CardBook(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private canon(): CanonApi | undefined {
        return apiOf<CanonApi>(this.app, 'canon');
    }

    /* ---------------------------------------------------------------- one item */

    async applyItem(item: AnyPrepareItem, env: ApplyEnv, pack: PackState): Promise<ItemOutcome> {
        const outcome: ItemOutcome = {
            itemId: item.id,
            kind: item.kind,
            title: itemTitle(item) || this.t(`m37.section.${item.kind}`),
            done: [],
            skipped: [],
            failed: [],
            forCard: false,
        };
        const steps: JournalChange[] = [];
        const step = async (label: string, run: () => Promise<JournalChange[] | string | null>): Promise<void> => {
            try {
                const result = await run();
                if (typeof result === 'string') outcome.skipped.push(result);
                else if (result) {
                    steps.push(...result);
                    outcome.done.push(label);
                }
            } catch (error) {
                this.log.warn(`prepare: ${item.id} ${label} failed`, error);
                outcome.failed.push(this.t('m37.result.failedPart', { part: label, error: message(error) }));
            }
        };
        const scope: PrepareScope = env.mode === 'import' ? 'chat' : item.scope;
        const forCard = scope === 'character';

        switch (item.kind) {
            case 'character':
                if (item.data.persona) {
                    outcome.skipped.push(this.t('m37.skip.persona'));
                    break;
                }
                await this.canonParts(item, env, forCard, step);
                await step(this.t(forCard ? 'm37.part.passportCard' : 'm37.part.passport'), () =>
                    this.passport(item as PrepareItem<'character'>, env, forCard, pack),
                );
                break;
            case 'place':
                await step(this.t('m37.part.place'), () => this.place(item as PrepareItem<'place'>, pack));
                await this.canonParts(item, env, forCard, step, pack);
                await this.backgroundProposal(item as PrepareItem<'place'>, pack);
                break;
            case 'world':
            case 'time':
            case 'faction':
            case 'item':
            case 'tradition':
                await this.canonParts(item, env, forCard, step);
                break;
            case 'secret':
                await step(this.t('m37.part.secret'), () => this.secret(item as PrepareItem<'secret'>));
                if (forCard) await step(this.t('m37.part.cardBook'), () => this.cardBookPart(item, env, null));
                break;
            case 'promise':
                await step(this.t('m37.part.promise'), () => this.promise(item as PrepareItem<'promise'>));
                if (forCard) await step(this.t('m37.part.cardBook'), () => this.cardBookPart(item, env, null));
                break;
            case 'mechanic':
                await this.mechanic(item as PrepareItem<'mechanic'>, env, forCard, outcome, steps);
                break;
            case 'scene':
                await step(this.t('m37.part.outfits'), () => this.outfits(item as PrepareItem<'scene'>, env, pack));
                break;
            case 'direction':
                await step(this.t('m37.part.firstScene'), () => this.direction(item as PrepareItem<'direction'>, pack));
                break;
        }
        outcome.forCard = steps.some((change) => {
            const ref = change.ref;
            return ref.step === 'cardBook' || (ref.step === 'passport' && ref.scope === 'card') || ref.forCard === true;
        });
        if (steps.length) {
            try {
                outcome.journalId = await this.app.journal.record({
                    module: PREPARE_ID,
                    kind: env.mode === 'import' ? IMPORT_KIND : APPLY_KIND,
                    summary: this.t(env.mode === 'import' ? 'm37.journal.import' : 'm37.journal.apply', {
                        title: outcome.title,
                        parts: outcome.done.join(', '),
                    }),
                    // The card passport cannot be taken back by Maestro: it goes first, so it is undone last.
                    changes: [...steps].sort((a, b) => Number(isCardPassport(b)) - Number(isCardPassport(a))),
                });
            } catch (error) {
                this.log.warn('prepare: the part was not journaled', error);
            }
        }
        return outcome;
    }

    /* ---------------------------------------------------------------- canon and the card book */

    private async canonParts(
        item: AnyPrepareItem,
        env: ApplyEnv,
        forCard: boolean,
        step: (label: string, run: () => Promise<JournalChange[] | string | null>) => Promise<void>,
        pack?: PackState,
    ): Promise<void> {
        const draft = await this.draftOf(item, env);
        if (!draft) return;
        await step(this.t('m37.part.canon'), () => this.canonEntry(item, draft, pack));
        if (forCard) await step(this.t('m37.part.cardBook'), () => this.cardBookPart(item, env, draft));
    }

    /** The canon draft: from the card book on import (the user may have edited it), else from the item. */
    private async draftOf(item: AnyPrepareItem, env: ApplyEnv): Promise<CanonEntryDraft | null> {
        const saved = env.imported?.get(item.id);
        let draft: CanonEntryDraft | null = canonDraftOf(item);
        if (saved && saved.content.trim()) {
            draft = {
                type: (saved.type || draft?.type || 'note') as CanonEntryDraft['type'],
                title: saved.title || draft?.title || item.id,
                fields: Object.keys(saved.fields).length ? saved.fields : (draft?.fields ?? {}),
                content: saved.content,
                keys: saved.keys.length ? saved.keys : (draft?.keys ?? []),
            };
        }
        if (!draft) return null;
        const canon = this.canon();
        const names = (item.data as { name?: string }).name;
        if (canon && names && hasCyrillic(names)) {
            try {
                const russian = await withTimeout(canon.russianKeys(names), 4000, [] as string[]);
                draft = { ...draft, keys: uniqueStrings([...draft.keys, ...russian]) };
            } catch (error) {
                this.log.debug('prepare: Russian keys were not made', error);
            }
        }
        return draft;
    }

    private async canonEntry(
        item: AnyPrepareItem,
        draft: CanonEntryDraft,
        pack?: PackState,
    ): Promise<JournalChange[] | string> {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId())
            return this.t('m37.skip.moduleOff', { module: this.t('m37.module.canon') });
        if (item.links?.canonUid !== undefined) return this.t('m37.skip.inCanon');
        const meta = {
            kind: 'addition',
            status: 'active',
            origin: 'import',
            type: draft.type,
            [TYPED_FIELDS_KEY]: { ...draft.fields },
        } as unknown as CanonDraft['meta'];
        const uid = await canon.put({
            entry: { comment: draft.title, key: [...draft.keys], keysecondary: [], content: draft.content },
            meta,
        });
        const book = canon.bookName();
        // A place created now points at its description entry.
        if (item.kind === 'place' && pack) {
            const placeId = pack.placeIds.get(normName(item.data.name));
            const places = apiOf<PlacesApi>(this.app, 'places');
            const place = placeId ? places?.get(placeId) : undefined;
            if (places && place && !place.entry) {
                try {
                    await places.update(place.id, { entry: { world: book, uid } });
                } catch (error) {
                    this.log.debug('prepare: the place was not bound to its entry', error);
                }
            }
        }
        return [
            this.change({ step: 'canon', book, uid }, null, {
                what: this.t('m37.part.canon'),
                name: draft.title,
                detail: draft.content,
            }),
        ];
    }

    private async cardBookPart(
        item: AnyPrepareItem,
        env: ApplyEnv,
        draft: CanonEntryDraft | null,
    ): Promise<JournalChange[] | string> {
        const note = draft ?? noteDraft(item);
        const written = await this.cardBook.put(env.cardBook, env.card.avatar, item, note);
        return [
            this.change(
                {
                    step: 'cardBook',
                    book: written.book,
                    uid: written.uid,
                    avatar: env.card.avatar,
                    itemId: item.id,
                    created: written.created,
                },
                written.before,
                { what: this.t('m37.part.cardBook'), name: note.title, detail: str(written.after.content) },
            ),
        ];
    }

    /* ---------------------------------------------------------------- places */

    private async place(item: PrepareItem<'place'>, pack: PackState): Promise<JournalChange[] | string> {
        const places = apiOf<PlacesApi>(this.app, 'places');
        if (!places || !this.app.host.chatId())
            return this.t('m37.skip.moduleOff', { module: this.t('m37.module.places') });
        const remember = (id: string) => {
            for (const name of [item.data.name, item.data.english, ...item.data.forms]) {
                if (name.trim()) pack.placeIds.set(normName(name), id);
            }
        };
        const known = item.links?.placeId ? places.get(item.links.placeId) : places.resolve(item.data.name);
        if (known) {
            remember(known.id);
            return this.t('m37.skip.placeExists');
        }
        const parentName = normName(item.data.parent);
        const parent = parentName
            ? (pack.placeIds.get(parentName) ?? places.resolve(item.data.parent)?.id ?? null)
            : null;
        const place = await places.create(item.data.name, parent);
        remember(place.id);
        const aliases = uniqueStrings(
            [item.data.english].filter((name) => name && normName(name) !== normName(place.name)),
        );
        const forms = uniqueStrings(item.data.forms);
        if (aliases.length || forms.length) {
            try {
                await places.update(place.id, {
                    aliases: uniqueStrings([...place.aliases, ...aliases]),
                    forms: uniqueStrings([...place.forms, ...forms]),
                });
            } catch (error) {
                this.log.debug('prepare: place names were not added', error);
            }
        }
        return [
            this.change({ step: 'place', placeId: place.id }, null, {
                what: this.t('m37.part.place'),
                name: place.name,
            }),
        ];
    }

    /** Backgrounds are only proposed: a library pick when one fits, else a pointer to generation by the user. */
    private async backgroundProposal(item: PrepareItem<'place'>, pack: PackState): Promise<void> {
        const backgrounds = apiOf<BackgroundsApi>(this.app, 'backgrounds');
        const placeId = pack.placeIds.get(normName(item.data.name));
        if (!backgrounds || !placeId) return;
        const place = apiOf<PlacesApi>(this.app, 'places')?.get(placeId);
        if (!place || place.background) return;
        const candidates = await withTimeout(backgrounds.candidates(placeId, 1), BACKGROUND_TIMEOUT_MS, []);
        const best = candidates[0];
        pack.proposals.push(
            best
                ? this.t('m37.proposal.background', { place: place.name, file: best.file })
                : this.t('m37.proposal.generate', { place: place.name }),
        );
    }

    /* ---------------------------------------------------------------- passports */

    private async passport(
        item: PrepareItem<'character'>,
        env: ApplyEnv,
        forCard: boolean,
        pack: PackState,
    ): Promise<JournalChange[] | string> {
        if (!env.passports) return this.t('m37.skip.passportsOff');
        if (item.links?.passportId) return this.t('m37.skip.passportExists');
        const nai = safely(() => adaptersOf(this.app).nai, null);
        const api = nai?.api();
        if (!nai || !api || typeof api.generatePassport !== 'function') return this.t('m37.skip.noPassportGen');
        const data = item.data;
        const description = [
            data.appearance ? `Appearance: ${data.appearance}` : '',
            data.role ? `Role: ${data.role}` : '',
            data.personality ? `Personality: ${data.personality}` : '',
            data.outfit ? `Wearing when the story starts: ${data.outfit}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        if (!description) return this.t('m37.skip.noAppearance');
        const generated = await nai.generatePassport({
            name: data.english || data.name,
            kind: 'character',
            description,
            language: hasCyrillic(data.name) ? 'ru' : 'en',
        });
        const passport = generated ? readPassport(generated) : null;
        if (!passport) throw new Error(this.t('m37.error.passport'));
        passport.kind = 'character';
        passport.name = data.name;
        passport.aliases = uniqueStrings(
            [...passport.aliases, data.english, ...data.forms].filter(
                (name) => name && normName(name) !== normName(data.name),
            ),
        );
        passport.id = freeId(
            `maestro-prep-${normName(data.english || data.name).replace(/[^\p{L}\p{N}]+/gu, '-')}`,
            (id) => !!safely(() => api.getPassport(id), null),
        );
        if (forCard) await api.savePassport(passport, 'card', { avatar: env.card.avatar });
        else await api.savePassport(passport, 'chat');
        pack.passported.add(normName(data.name));
        return [
            this.change(
                {
                    step: 'passport',
                    id: passport.id,
                    scope: forCard ? 'card' : 'chat',
                    ...(forCard ? { avatar: env.card.avatar } : {}),
                },
                null,
                {
                    what: this.t(forCard ? 'm37.part.passportCard' : 'm37.part.passport'),
                    name: data.name,
                    detail: passport.id,
                },
            ),
        ];
    }

    /* ---------------------------------------------------------------- secrets, promises */

    private async secret(item: PrepareItem<'secret'>): Promise<JournalChange[] | string> {
        const knowledge = apiOf<KnowledgeApi>(this.app, 'knowledge');
        if (!knowledge) return this.t('m37.skip.moduleOff', { module: this.t('m37.module.knowledge') });
        if (item.exists) return this.t('m37.skip.exists');
        const data = item.data;
        const linked = await this.linkedRecords('M18', () =>
            knowledge.addSecret({
                text: data.text,
                topics: uniqueStrings([data.about, ...data.knownBy, ...data.hiddenFrom]),
                knownBy: [...data.knownBy],
                sourceMessage: 0,
                quote: '',
            }),
        );
        return linked.map((journalId) =>
            this.change({ step: 'record', journalId }, null, {
                what: this.t('m37.part.secret'),
                name: data.about || data.text,
                detail: data.text,
            }),
        );
    }

    private async promise(item: PrepareItem<'promise'>): Promise<JournalChange[] | string> {
        const calendar = apiOf<CalendarApi>(this.app, 'calendar');
        if (!calendar) return this.t('m37.skip.moduleOff', { module: this.t('m37.module.calendar') });
        if (item.exists) return this.t('m37.skip.exists');
        const data = item.data;
        const id = await calendar.add({
            who: [...data.who],
            toWhom: [...data.toWhom],
            what: data.what,
            quote: '',
            due: data.due ? { label: data.due, day: null } : null,
            sourceMessage: 0,
        });
        return [this.change({ step: 'promise', id }, null, { what: this.t('m37.part.promise'), name: data.what })];
    }

    /* ---------------------------------------------------------------- mechanics */

    private async mechanic(
        item: PrepareItem<'mechanic'>,
        env: ApplyEnv,
        forCard: boolean,
        outcome: ItemOutcome,
        steps: JournalChange[],
    ): Promise<void> {
        const port = mechanicsPort(this.app);
        if (!port) {
            outcome.skipped.push(this.t('m37.skip.moduleOff', { module: this.t('m37.module.mechanics') }));
            return;
        }
        const chatId = this.app.host.chatId();
        const scope = forCard
            ? { kind: 'card' as const, avatar: env.card.avatar }
            : chatId
              ? { kind: 'chat' as const, chatId }
              : null;
        if (!scope) {
            outcome.skipped.push(this.t('m37.skip.noChat'));
            return;
        }
        const plan = port.plan(item.data, item.links, scope);
        let id = plan.def.id;
        if (!plan.existing) {
            if (plan.errors.length) {
                outcome.failed.push(
                    this.t('m37.result.failedPart', {
                        part: this.t('m37.part.mechanic'),
                        error: plan.errors.join(', '),
                    }),
                );
                return;
            }
            try {
                const saved = await port.save(plan.def);
                id = saved.id;
                steps.push(
                    this.change({ step: 'mechanic', id, forCard }, null, {
                        what: this.t(forCard ? 'm37.part.mechanicCard' : 'm37.part.mechanic'),
                        name: saved.name,
                    }),
                );
                outcome.done.push(this.t(forCard ? 'm37.part.mechanicCard' : 'm37.part.mechanic'));
            } catch (error) {
                outcome.failed.push(
                    this.t('m37.result.failedPart', { part: this.t('m37.part.mechanic'), error: message(error) }),
                );
                return;
            }
        }
        let written = 0;
        for (const value of plan.values) {
            try {
                const before = port.value(id, value.holder, value.attribute);
                await port.setValue(id, value.holder, value.attribute, value.value);
                steps.push(
                    this.change(
                        { step: 'value', mechanicId: id, holder: value.holder, attribute: value.attribute },
                        before,
                        {
                            what: this.t('m37.part.value'),
                            name: `${value.holder}: ${Array.isArray(value.value) ? value.value.join(', ') : String(value.value)}`,
                        },
                    ),
                );
                written++;
            } catch (error) {
                this.log.debug('prepare: a starting value was not set', error);
            }
        }
        if (written) outcome.done.push(this.t('m37.part.values', { count: written }));
        if (plan.existing && !written) outcome.skipped.push(this.t('m37.skip.exists'));
        if (plan.dropped) outcome.skipped.push(this.t('m37.skip.values', { count: plan.dropped }));
    }

    /* ---------------------------------------------------------------- the starting scene and direction */

    private async outfits(
        item: PrepareItem<'scene'>,
        env: ApplyEnv,
        pack: PackState,
    ): Promise<JournalChange[] | string> {
        const wardrobe = apiOf<WardrobeApi>(this.app, 'wardrobe');
        if (!wardrobe?.intakeOutfit) return this.t('m37.skip.moduleOff', { module: this.t('m37.module.wardrobe') });
        const present = new Set(item.data.present.map((name) => normName(name)));
        const characters = env.plan.filter(
            (candidate): candidate is PrepareItem<'character'> =>
                candidate.kind === 'character' &&
                !candidate.data.persona &&
                !!candidate.data.outfit &&
                (candidate.data.present || present.has(normName(candidate.data.name))),
        );
        const changes: JournalChange[] = [];
        for (const character of characters) {
            if (pack.passported.has(normName(character.data.name))) continue;
            const data = character.data;
            const linked = await this.linkedRecords('M27', async () =>
                wardrobe.intakeOutfit?.({
                    entityName: data.name,
                    value: `${data.english || data.name} wears ${data.outfit}`,
                    evidence: '',
                    sourceMessage: 0,
                }),
            );
            for (const journalId of linked) {
                changes.push(
                    this.change({ step: 'record', journalId }, null, {
                        what: this.t('m37.part.outfit'),
                        name: data.name,
                        detail: data.outfit,
                    }),
                );
            }
        }
        return changes.length ? changes : this.t('m37.skip.noOutfits');
    }

    private async direction(item: PrepareItem<'direction'>, pack: PackState): Promise<JournalChange[] | string> {
        const type = item.data.firstScene;
        if (!type) return this.t('m37.skip.noFirstScene');
        const director = apiOf<DirectorApi>(this.app, 'director');
        if (!director) return this.t('m37.skip.moduleOff', { module: this.t('m37.module.director') });
        const previous = safely(() => director.override?.() ?? null, null);
        await director.setScene(type as SceneType);
        pack.firstScene = { type, previous };
        return [
            this.change({ step: 'scene', type }, previous, {
                what: this.t('m37.part.firstScene'),
                name: this.t(`m37.scene.${type}`),
            }),
        ];
    }

    /* ---------------------------------------------------------------- journal helpers */

    private change(ref: Dict, before: unknown, after: StepAfter): JournalChange {
        return { target: PREPARE_STEP_TARGET, ref, before: before ?? null, after };
    }

    /** Runs a call that journals itself and returns the ids of the records it added (module's own undo). */
    private async linkedRecords(module: string, run: () => Promise<unknown>): Promise<string[]> {
        const before = new Set(
            safely(() => this.app.journal.list({ module, limit: 20 }), []).map((record) => record.id),
        );
        const result = await run();
        if (result === null || result === undefined || result === '') return [];
        return safely(() => this.app.journal.list({ module, limit: 20 }), [])
            .filter((record) => !before.has(record.id) && !record.undone)
            .map((record) => record.id);
    }

    /* ---------------------------------------------------------------- undo */

    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref;
        const after = isDict(change.after) ? change.after : {};
        switch (ref.step) {
            case 'canon': {
                const canon = this.canon();
                const uid = Number(ref.uid);
                if (!canon || !Number.isFinite(uid)) return false;
                if (typeof ref.book === 'string' && canon.bookName() !== ref.book) return false;
                const item = (await canon.list()).find((candidate) => candidate.uid === uid);
                if (!item) return true;
                if (str(item.entry.content) !== str(after.detail)) return false;
                await canon.remove(uid);
                return true;
            }
            case 'cardBook': {
                const book = str(ref.book);
                const uid = Number(ref.uid);
                if (!book || !Number.isFinite(uid)) return false;
                const before = isDict(change.before) ? change.before : null;
                const ok = await this.cardBook.remove(book, uid, str(after.detail), before);
                if (ok && !before) await this.onCardItemUndone(str(ref.avatar), str(ref.itemId));
                return ok;
            }
            case 'place': {
                const places = apiOf<PlacesApi>(this.app, 'places');
                const id = str(ref.placeId);
                if (!places || !id) return false;
                if (!places.get(id)) return true;
                await places.remove(id);
                return true;
            }
            case 'passport': {
                const api = safely(() => adaptersOf(this.app).nai.api(), undefined);
                const id = str(ref.id);
                if (!api || !id) return false;
                if (ref.scope === 'card') {
                    const still = safely(() => api.passports({ avatar: str(ref.avatar) }), []).some(
                        (item) => item.id === id,
                    );
                    if (!still) return true;
                    // NAI Studio's API cannot delete a card passport: the user removes it there.
                    this.app.ui.notice(this.t('m37.undo.cardPassport', { name: str(after.name) }), {
                        level: 'warn',
                        importance: 'important',
                    });
                    return false;
                }
                if (!safely(() => api.getPassport(id), null)) return true;
                await api.clearChatOverride(id);
                return true;
            }
            case 'mechanic': {
                const port = mechanicsPort(this.app);
                const id = str(ref.id);
                if (!port || !id) return false;
                if (!port.get(id)) return true;
                await port.remove(id);
                return true;
            }
            case 'value': {
                const port = mechanicsPort(this.app);
                if (!port) return false;
                const mechanicId = str(ref.mechanicId);
                if (!port.get(mechanicId)) return true;
                const before = change.before;
                if (typeof before === 'number' || typeof before === 'string' || Array.isArray(before)) {
                    await port.setValue(mechanicId, str(ref.holder), str(ref.attribute), before as never);
                }
                return true;
            }
            case 'promise': {
                const calendar = apiOf<CalendarApi>(this.app, 'calendar');
                const id = str(ref.id);
                if (!calendar || !id) return false;
                if (!calendar.promises().some((promise) => promise.id === id)) return true;
                await calendar.setStatus(id, 'cancelled');
                return true;
            }
            case 'record': {
                const id = str(ref.journalId);
                const record = safely(() => this.app.journal.list(), []).find((item) => item.id === id);
                if (!record || record.undone) return true;
                return this.app.journal.undo(id);
            }
            case 'scene': {
                const director = apiOf<DirectorApi>(this.app, 'director');
                if (!director) return false;
                if (safely(() => director.override?.() ?? null, null) !== ref.type) return true;
                const before = typeof change.before === 'string' ? (change.before as SceneType) : null;
                await director.setScene(before);
                return true;
            }
            default:
                return false;
        }
    }
}

function isCardPassport(change: JournalChange): boolean {
    return change.ref.step === 'passport' && change.ref.scope === 'card';
}

/** A card-book note for an item without a canon text (secrets, promises). */
function noteDraft(item: AnyPrepareItem): CanonEntryDraft {
    const title = itemTitle(item) || item.id;
    const text =
        item.kind === 'secret'
            ? `${item.data.text}${item.data.knownBy.length ? `\nKnown by: ${item.data.knownBy.join(', ')}` : ''}`
            : item.kind === 'promise'
              ? `${item.data.who.join(', ')} → ${item.data.toWhom.join(', ')}: ${item.data.what}${item.data.due ? ` (due: ${item.data.due})` : ''}`
              : title;
    return { type: 'note', title, fields: { name: title, text }, content: `Note: ${title}\nText: ${text}`, keys: [] };
}
