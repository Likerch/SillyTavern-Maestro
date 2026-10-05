// «Оформить» (M7 п. 6; plan §8 «Оформление нового NPC — Входящие»; P2, P3, P13): a new NPC or place gets every store
// at once, as one proposal through app.autonomy (kind 'dossier.styleUp', the Inbox by default):
// - a typed chat-canon addition (character/place) with fields made from what the stack knows and Russian keys
//   (canon.russianKeys → DES-RU forms);
// - for a character, a CarrotKernel archive in Baby Bunny's format (src/domain/dossier-archive.ts): tags picked by the
//   cheap model from the loaded packs' dictionary (BunnyMo mode), checked by the dictionary and by the BunnyMo mode's
//   own tag check, written into a user CK repository book — never a BunnyMo book (P13); without one the plan offers to
//   create «Maestro · архив» with the role 'ck.archive';
// - the NAI passport: NAI Studio makes NPC passports itself from the DES tracker when its auto passports are on — then
//   only a hint (P3); otherwise a chat-level passport from NAI Studio's generator (adapter `generatePassport`, NAI
//   Studio 0.12+), saved through its API;
// - for a place, the place registry's description entry (places.ensureEntry, filled with what is known) and the lore
//   passport of that entry (M28 lorePassports.generate).
// The plan is built when the user presses «Оформить» (the model call happens then) and shown as a preview; the card
// carries every part with its before/after. Applying writes each part at once and journals each part on its own (undo
// per part); the card's own journal record undoes the parts that are still there. «Повысить до книги карточки» copies
// a canon addition into the card's primary book (kind 'dossier.promoteToCard', «Спросить», never «auto»).
import { adaptersOf } from '../../adapters';
import { readPassport } from '../../adapters/nai';
import type { NaiPassport, NaiPassportKind } from '../../adapters/nai';
import { uniqueStrings } from '../../domain/canon-keys';
import {
    archiveEntry,
    archiveKeys,
    archiveSchema,
    archiveVocabularyOf,
    buildArchiveContent,
    buildArchiveMessages,
    formatArchiveTags,
    isEmptyVocabulary,
    parseArchiveAnswer,
} from '../../domain/dossier-archive';
import type { ArchiveMbti, ArchiveTag } from '../../domain/dossier-archive';
import { overridePassport, passportTagLine } from '../../domain/dossier-data';
import { namesOverlap, normName } from '../../domain/dossier-names';
import {
    ARCHIVE_BOOK_NAME,
    archiveBookChoice,
    archiveKnownText,
    characterFields,
    freeId,
    passportDescription,
    placeFields,
    promotedFields,
    styleUpGaps,
    styleUpKeys,
    typedContent,
} from '../../domain/dossier-styleup';
import type {
    ArchiveBookCandidate,
    CharacterKnowledge,
    PlaceKnowledge,
    StyleUpGaps,
    StyleUpPartId,
} from '../../domain/dossier-styleup';
import { entryKeyOf } from '../../domain/doctor-fixes';
import type { BookData } from '../../domain/doctor-fixes';
import { TYPED_FIELDS_KEY } from '../../domain/entry-types';
import { freeUid, templateEntry } from '../../domain/lore-studio-entries';
import { archiveMatch } from '../../domain/sheet-context';
import type { App, Decision, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { CanonApi, CanonDraft, CanonItem } from '../canon/api';
import type { LivingCanonApi } from '../livingCanon/api';
import type { LorePassportsApi } from '../lorePassports/api';
import { ProtectedBookError } from './actions';
import { bookIo } from './book-io';
import { DOSSIER_ID } from './settings';
import type { DossierSources, EntityFacts } from './sources';

export const STYLE_UP_KIND = 'dossier.styleUp';
export const PROMOTE_KIND = 'dossier.promoteToCard';
/** LLM task of the archive's tag choice (labels the cost; Settings → profiles may route it). */
export const STYLE_UP_TASK = 'dossier.styleUp';
/** Journal target of the card's changes: undoing one undoes that part's own record. */
export const STYLE_UP_TARGET = 'dossier-styleup';
/** Journal target of one written part (the real locator: canon uid, book + uid, passport id). */
export const STYLE_UP_PART_TARGET = 'dossier-styleup-part';

const ARCHIVE_MAX_TOKENS = 700;

type Dict = Record<string, unknown>;

export type StyleUpPart =
    | { part: 'canon'; title: string; keys: string[]; content: string; fields: Record<string, string> }
    | {
          part: 'archive';
          /** The book the archive goes to (a CK repository, a book with the role, or the one to create). */
          book: string;
          /** Books the user may choose from (empty: `book` is created). */
          books: string[];
          create: boolean;
          /** `<Name:…>`. */
          name: string;
          keys: string[];
          content: string;
          /** Tags as written (`<SPECIES:ELF>`, `<INFP-H>`). */
          tags: string[];
          /** Tags of the model's answer that did not pass the checks. */
          rejected: { tag: string; reason: string }[];
      }
    | { part: 'passport'; passport: NaiPassport }
    | { part: 'placeEntry'; placeId: string; fields: Record<string, string>; content: string }
    | { part: 'lorePassport'; placeId: string };

export interface StyleUpHint {
    part: StyleUpPartId;
    /** Suffix of `m7.styleUp.hint.*`. */
    key: string;
    params?: Record<string, string | number>;
}

export interface StyleUpPlan {
    planId: string;
    entityId: string;
    /** Canonical name. */
    name: string;
    kind: 'character' | 'place';
    parts: StyleUpPart[];
    hints: StyleUpHint[];
    /** What planning cost (the archive's model call). */
    costUsd?: number;
}

/** The Inbox card's payload (JSON). */
export interface StyleUpPayload {
    op: 'styleUp';
    planId: string;
    entityId: string;
    name: string;
    kind: 'character' | 'place';
    parts: StyleUpPart[];
}

export interface PromotePayload {
    op: 'promote';
    planId: string;
    entityId: string;
    canonUid: number;
    book: string;
    title: string;
}

export interface PartOutcome {
    part: StyleUpPartId | 'promote';
    ok: boolean;
    error?: string;
    /** Something to know about a part that was written (the book is not a CK repository yet, …). */
    note?: string;
}

export interface StyleUpResult {
    planId: string;
    entityId: string;
    at: number;
    outcomes: PartOutcome[];
}

/** What the dossier page needs: the stores missing, the card's book and the canon additions it can take. */
export interface StyleUpInfo {
    gaps: StyleUpGaps | null;
    cardBook: string | null;
    promotable: number[];
}

export interface StyleUpChoice {
    /** Parts to propose (default: all of the plan). */
    parts?: StyleUpPartId[];
    /** The archive's book among the plan's choices. */
    book?: string;
}

/** NAI Studio's passport generator as the nai adapter offers it (NAI Studio 0.12+; feature-detected). */
type PassportGenerator = (input: {
    name: string;
    kind: NaiPassportKind;
    description: string;
    language?: string;
}) => Promise<NaiPassport | null>;

interface ApplyContext {
    placeEntry?: { world: string; uid: number };
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function isStyleUpPayload(value: unknown): value is StyleUpPayload {
    return (
        isDict(value) &&
        value.op === 'styleUp' &&
        typeof value.planId === 'string' &&
        typeof value.entityId === 'string' &&
        Array.isArray(value.parts)
    );
}

export function isPromotePayload(value: unknown): value is PromotePayload {
    return (
        isDict(value) &&
        value.op === 'promote' &&
        typeof value.canonUid === 'number' &&
        typeof value.book === 'string' &&
        typeof value.planId === 'string'
    );
}

export class DossierStyleUp {
    private readonly t: App['i18n']['t'];
    private readonly results = new Map<string, StyleUpResult>();
    private readonly listeners = new Set<(entityId: string) => void>();

    constructor(
        private readonly app: App,
        private readonly sources: DossierSources,
        private readonly log: Logger,
    ) {
        this.t = app.i18n.t.bind(app.i18n);
    }

    /** Undo handlers (permanent) and Inbox appliers (owned by the module). */
    install(): Unsubscribe[] {
        this.app.journal.registerUndo(STYLE_UP_TARGET, (change) => this.undoCard(change));
        this.app.journal.registerUndo(STYLE_UP_PART_TARGET, (change) => this.undoPart(change));
        // Promotion writes the card's book: never «auto» (plan §8).
        this.app.autonomy.neverAuto(PROMOTE_KIND);
        return [
            this.app.inbox.registerApplier(
                STYLE_UP_KIND,
                async (payload) => {
                    if (!isStyleUpPayload(payload)) throw new Error('bad dossier card');
                    await this.applyStyleUp(payload);
                },
                async (payload) => isStyleUpPayload(payload) && (await this.stillValid(payload)),
            ),
            this.app.inbox.registerApplier(
                PROMOTE_KIND,
                async (payload) => {
                    if (!isPromotePayload(payload)) throw new Error('bad dossier card');
                    await this.applyPromote(payload);
                },
                async (payload) => isPromotePayload(payload) && (await this.promoteValid(payload)),
            ),
            this.app.bus.on('chat:changed', () => this.results.clear()),
        ];
    }

    onResult(listener: (entityId: string) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The last «Оформить» or promotion applied for an entity in this chat (this page's life). */
    lastResult(entityId: string): StyleUpResult | null {
        return this.results.get(entityId) ?? null;
    }

    private finish(result: StyleUpResult): void {
        this.results.set(result.entityId, result);
        for (const listener of [...this.listeners]) {
            try {
                listener(result.entityId);
            } catch (error) {
                this.log.error('dossier listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- other modules */

    private canon(): CanonApi | undefined {
        return this.sources.canon();
    }

    private bunnymo(): BunnyMoModeApi | undefined {
        const api = this.app.modules.api<BunnyMoModeApi>('bunnymoMode');
        return api && typeof api.dictionary === 'function' && typeof api.validateTags === 'function' ? api : undefined;
    }

    private lorePassports(): LorePassportsApi | undefined {
        const api = this.app.modules.api<LorePassportsApi>('lorePassports');
        return api && typeof api.generate === 'function' && typeof api.get === 'function' ? api : undefined;
    }

    private roles(): BookRolesApi | undefined {
        return this.app.modules.api<BookRolesApi>('bookRoles');
    }

    /** NAI Studio's passport generator through the nai adapter (absent before NAI Studio 0.12). */
    private generator(): PassportGenerator | undefined {
        try {
            const nai = adaptersOf(this.app).nai as unknown as { generatePassport?: PassportGenerator };
            const generate = nai.generatePassport;
            return typeof generate === 'function' ? (input) => generate.call(nai, input) : undefined;
        } catch {
            return undefined;
        }
    }

    private safe<T>(read: () => T, fallback: T): T {
        try {
            return read();
        } catch (error) {
            this.log.debug('dossier «style up» source failed', error);
            return fallback;
        }
    }

    private async safeAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await read();
        } catch (error) {
            this.log.debug('dossier «style up» source failed', error);
            return fallback;
        }
    }

    /** ST's book list knows the book (loadWorldInfo answers a missing book with an empty dummy). */
    private bookExists(book: string, data: BookData | null): boolean {
        const names = this.safe(() => this.app.host.ctx().getWorldInfoNames?.(), undefined);
        return Array.isArray(names) ? names.includes(book) : data !== null;
    }

    /* ---------------------------------------------------------------- what is missing */

    /** Missing stores of a character or place, the card's book and the canon additions that may be promoted. */
    async info(facts: EntityFacts): Promise<StyleUpInfo> {
        const gaps = await this.gaps(facts);
        const personlike = facts.entity.kind === 'character';
        const cardBook = personlike && this.canon() ? await this.cardBook() : null;
        const promotable = cardBook
            ? facts.canon.filter((item) => item.meta.kind === 'addition').map((item) => item.uid)
            : [];
        return { gaps, cardBook, promotable };
    }

    async gaps(facts: EntityFacts): Promise<StyleUpGaps | null> {
        const kind = facts.entity.kind;
        const canonOn = !!this.canon() && !!this.app.host.chatId();
        if (kind === 'character') {
            return styleUpGaps({
                kind,
                canonOn,
                archiveOn: facts.ckPresent,
                naiOn: facts.naiPresent,
                // The card character's description is the card itself.
                hasEntry: !!facts.cardAvatar || facts.canon.length > 0 || facts.lore.some((fact) => !fact.description),
                hasArchive: facts.archives.length > 0,
                hasPassport: facts.passports.length > 0,
            });
        }
        if (kind !== 'place') return null;
        const place = facts.place?.place;
        const lore = this.lorePassports();
        let hasPlacePassport = facts.passports.length > 0 || !!place?.passportId;
        const entry = place?.entry;
        if (!hasPlacePassport && lore && entry) {
            hasPlacePassport = !!(await this.safeAsync(() => lore.get(entry.world, entry.uid), null));
        }
        return styleUpGaps({
            kind,
            canonOn,
            archiveOn: false,
            naiOn: false,
            placesOn: !!place && !!this.sources.places(),
            lorePassportsOn: !!lore && !!place,
            hasPlaceEntry: !!entry,
            hasPlacePassport,
        });
    }

    /* ---------------------------------------------------------------- knowledge */

    private canonicalName(facts: EntityFacts): string {
        if (facts.entity.kind === 'place') return facts.place?.place.name ?? facts.entity.name;
        return facts.des?.canonical?.trim() || facts.entity.name;
    }

    /** Living-canon quotes and texts about these names. */
    private quotes(names: readonly string[]): string[] {
        const living = this.app.modules.api<LivingCanonApi>('livingCanon');
        if (!living) return [];
        const list = this.safe(() => living.facts?.() ?? living.provisional(), []);
        return uniqueStrings(
            list
                .filter((fact) => fact.status !== 'dropped' && namesOverlap([fact.name, ...fact.keys], names))
                .map((fact) => fact.text?.trim() || fact.quote),
        );
    }

    private worldFacts(entityId: string): string[] {
        const world = this.sources.world();
        if (!world) return [];
        return uniqueStrings(this.safe(() => world.facts(entityId), []).map((fact) => fact.text));
    }

    private characterKnowledge(facts: EntityFacts): CharacterKnowledge {
        const entity = facts.entity;
        const name = this.canonicalName(facts);
        const persona = str(this.app.host.ctx().name1).trim() || 'User';
        const aliases = uniqueStrings([entity.name, ...entity.aliases, ...(facts.des?.aliases ?? [])]).filter(
            (alias) => normName(alias) !== normName(name),
        );
        return {
            name,
            aliases,
            details: { ...(facts.des?.character?.details ?? {}) },
            portraitPrompt: facts.des?.portraitPrompt,
            workshopDescription: facts.des?.workshopDescription,
            cardDescription: facts.cardDescription ?? undefined,
            relationship: facts.relation ? { with: persona, value: facts.relation } : null,
            quotes: this.quotes([name, ...aliases]),
            facts: this.worldFacts(entity.id),
        };
    }

    private placeKnowledge(facts: EntityFacts): PlaceKnowledge | null {
        const fact = facts.place;
        if (!fact) return null;
        const { place } = fact;
        return {
            name: place.name,
            aliases: [...place.aliases],
            path: [...fact.parents].reverse().map((item) => item.name),
            background: place.background,
            state: { ...(place.state ?? {}) },
            people: place.visits.flatMap((visit) => visit.present),
            quotes: this.quotes([place.name, ...place.aliases]),
            facts: this.worldFacts(facts.entity.id),
        };
    }

    /* ---------------------------------------------------------------- the plan */

    /**
     * What «Оформить» would create for this entity, with the archive's tags already chosen (one model call) and the
     * NAI passport already generated, so the preview and the card show the real content.
     */
    async plan(facts: EntityFacts): Promise<StyleUpPlan> {
        const gaps = await this.gaps(facts);
        const plan: StyleUpPlan = {
            planId: newId('su'),
            entityId: facts.entity.id,
            name: this.canonicalName(facts),
            kind: facts.entity.kind === 'place' ? 'place' : 'character',
            parts: [],
            hints: [],
        };
        if (!gaps) return plan;
        if (!this.app.host.chatId()) {
            plan.hints.push({ part: gaps.missing[0] ?? 'canon', key: 'noChat' });
            return plan;
        }
        const character = gaps.kind === 'character' ? this.characterKnowledge(facts) : null;
        const place = gaps.kind === 'place' ? this.placeKnowledge(facts) : null;
        for (const part of gaps.missing) {
            try {
                if (part === 'canon' && character) await this.planCanon(plan, character);
                else if (part === 'archive' && character) await this.planArchive(plan, facts, character);
                else if (part === 'passport' && character) await this.planPassport(plan, facts, character);
                else if (part === 'placeEntry' && place) this.planPlaceEntry(plan, facts, place);
                else if (part === 'lorePassport' && facts.place) {
                    plan.parts.push({ part: 'lorePassport', placeId: facts.place.place.id });
                }
            } catch (error) {
                this.log.warn(`dossier: «style up» ${part} could not be planned`, error);
                plan.hints.push({ part, key: 'failed', params: { error: message(error) } });
            }
        }
        return plan;
    }

    private async planCanon(plan: StyleUpPlan, knowledge: CharacterKnowledge): Promise<void> {
        const canon = this.canon();
        if (!canon) {
            plan.hints.push({ part: 'canon', key: 'canonOff' });
            return;
        }
        const russian: string[] = [];
        for (const name of [knowledge.name, ...knowledge.aliases]) {
            russian.push(...(await this.safeAsync(() => canon.russianKeys(name), [])));
        }
        const fields = characterFields(knowledge);
        plan.parts.push({
            part: 'canon',
            title: knowledge.name,
            keys: styleUpKeys(knowledge.name, knowledge.aliases, russian),
            content: typedContent('character', fields),
            fields,
        });
    }

    /** Books a new archive may go to (CK repos, books with the role, «Maestro · архив»), BunnyMo books left out. */
    async archiveBooks(): Promise<{ books: string[]; create: string | null; skipped: string[] }> {
        const adapters = adaptersOf(this.app);
        const repos = this.safe(() => adapters.ck.repoBooks(), []);
        const roles = this.roles();
        const roleBooks = roles
            ? this.safe(
                  () =>
                      roles
                          .all()
                          .filter((info) => info.role === 'ck.archive')
                          .map((info) => info.book),
                  [],
              )
            : [];
        const candidates: ArchiveBookCandidate[] = [];
        for (const book of uniqueStrings([...repos, ...roleBooks, ARCHIVE_BOOK_NAME])) {
            const state = await this.sources.bookState(book);
            candidates.push({
                book,
                repo: repos.includes(book),
                role: roleBooks.includes(book),
                protected: state.protected,
                exists: this.bookExists(book, state.data),
            });
        }
        const choice = archiveBookChoice(candidates);
        const skipped = candidates.filter((item) => item.protected && item.exists).map((item) => item.book);
        return { ...choice, skipped };
    }

    private async planArchive(plan: StyleUpPlan, facts: EntityFacts, knowledge: CharacterKnowledge): Promise<void> {
        const hint = (key: string, params?: Record<string, string | number>) =>
            plan.hints.push(params ? { part: 'archive', key, params } : { part: 'archive', key });
        const bunnymo = this.bunnymo();
        if (!bunnymo) return void hint('archiveNoBunnymo');
        if (!this.app.llm.available(STYLE_UP_TASK)) return void hint('archiveNoProfile');
        if (this.app.cost.backgroundCapReached()) return void hint('archiveCap');
        const choice = await this.archiveBooks();
        for (const book of choice.skipped) hint('archiveBunnyRepo', { book });
        const vocabulary = archiveVocabularyOf(await bunnymo.dictionary());
        if (isEmptyVocabulary(vocabulary)) return void hint('archiveNoPacks');
        const known = archiveKnownText(knowledge, {
            lore: [
                ...facts.lore.map((fact) => str(fact.entry.content)),
                ...facts.canon.map((item) => str(item.entry.content)),
            ],
            memories: facts.memories.map((memory) => memory.text),
            passportTags: facts.passports
                .map((fact) => passportTagLine(overridePassport(fact.passport, fact.chat).passport))
                .filter(Boolean)
                .join('; '),
        });
        const response = await this.app.llm.request<unknown>({
            task: STYLE_UP_TASK,
            messages: buildArchiveMessages({ name: knowledge.name, aliases: knowledge.aliases, known }, vocabulary),
            maxTokens: ARCHIVE_MAX_TOKENS,
            temperature: 0.2,
            schema: { name: 'bunnymo_archive', schema: archiveSchema(vocabulary) },
        });
        if (response.costUsd !== undefined) plan.costUsd = (plan.costUsd ?? 0) + response.costUsd;
        if (!response.ok) {
            return void hint('archiveFailed', { error: response.refusal ? 'refusal' : (response.error ?? 'failed') });
        }
        const answer = parseArchiveAnswer(response.data ?? response.text, vocabulary);
        if (!answer) return void hint('archiveParse');
        // The BunnyMo mode's own check (the sheet editor's) has the last word before anything is written.
        const written = formatArchiveTags(answer.tags, answer.mbti);
        const checks = await bunnymo.validateTags(written);
        const rejected: { tag: string; reason: string }[] = answer.rejected.map((item) => ({ ...item }));
        const okAt = (index: number) => {
            const check = checks[index];
            if (check && !check.ok)
                rejected.push({ tag: written[index] ?? check.tag, reason: check.reason ?? 'invalid' });
            return !check || check.ok;
        };
        const tags: ArchiveTag[] = answer.tags.filter((_, index) => okAt(index));
        const mbti: ArchiveMbti | null = answer.mbti && okAt(answer.tags.length) ? answer.mbti : null;
        if (!tags.length && !mbti) {
            if (rejected.length) hint('archiveRejected', { tags: rejected.map((item) => item.tag).join(', ') });
            return void hint('archiveEmpty');
        }
        const book = choice.books[0] ?? choice.create ?? ARCHIVE_BOOK_NAME;
        if (!choice.books.length) hint('archiveNewBook', { book });
        plan.parts.push({
            part: 'archive',
            book,
            books: choice.books,
            create: !choice.books.length,
            name: knowledge.name,
            keys: archiveKeys(knowledge.name, knowledge.aliases),
            content: buildArchiveContent({ name: knowledge.name, tags, mbti, linguistics: answer.linguistics }),
            tags: formatArchiveTags(tags, mbti),
            rejected,
        });
    }

    private async planPassport(plan: StyleUpPlan, facts: EntityFacts, knowledge: CharacterKnowledge): Promise<void> {
        const hint = (key: string, params?: Record<string, string | number>) =>
            plan.hints.push(params ? { part: 'passport', key, params } : { part: 'passport', key });
        // NAI Studio writes passports of new DES characters itself (settings.des.autoPassports): no duplicate (P3).
        const settings = this.safe(() => adaptersOf(this.app).nai.settings(), null);
        const des = isDict(settings) && isDict(settings.des) ? settings.des : null;
        const auto = des ? des.enabled !== false && des.autoPassports !== false : false;
        const inDes = facts.desPresent && !!facts.des && (facts.des.inRoster || !!facts.des.character);
        if (auto && inDes) return void hint('passportAuto', { name: knowledge.name });
        const api = this.sources.naiApi();
        const generate = this.generator();
        if (!api || !generate) return void hint('passportManual');
        let generated: NaiPassport | null;
        try {
            generated = await generate({
                name: knowledge.name,
                kind: 'character',
                description: passportDescription(knowledge),
            });
        } catch (error) {
            return void hint('passportFailed', { error: message(error) });
        }
        const passport = generated ? readPassport(generated) : null;
        if (!passport) return void hint('passportFailed', { error: '—' });
        passport.kind = 'character';
        passport.name = knowledge.name;
        passport.aliases = uniqueStrings([...passport.aliases, ...knowledge.aliases]);
        passport.id = freeId(`maestro-${plan.planId}`, (id) => !!this.safe(() => api.getPassport(id), null));
        plan.parts.push({ part: 'passport', passport });
    }

    private planPlaceEntry(plan: StyleUpPlan, facts: EntityFacts, knowledge: PlaceKnowledge): void {
        const place = facts.place?.place;
        if (!place || !this.sources.places()) {
            plan.hints.push({ part: 'placeEntry', key: 'placesOff' });
            return;
        }
        const fields = placeFields(knowledge);
        plan.parts.push({ part: 'placeEntry', placeId: place.id, fields, content: typedContent('place', fields) });
    }

    /* ---------------------------------------------------------------- the proposal */

    private partLabel(part: StyleUpPart): string {
        switch (part.part) {
            case 'canon':
                return this.t('m7.styleUp.line.canon', { name: part.title, keys: part.keys.length });
            case 'archive':
                return this.t(part.create ? 'm7.styleUp.line.archiveNew' : 'm7.styleUp.line.archive', {
                    book: part.book,
                    count: part.tags.length,
                });
            case 'passport':
                return this.t('m7.styleUp.line.passport', { name: part.passport.name });
            case 'placeEntry':
                return this.t('m7.styleUp.line.placeEntry', { name: part.fields.name ?? '' });
            case 'lorePassport':
                return this.t('m7.styleUp.line.lorePassport');
        }
    }

    /** One line per part (the preview and the card). */
    describe(part: StyleUpPart): string {
        return this.partLabel(part);
    }

    hintText(hint: StyleUpHint): string {
        return this.t(`m7.styleUp.hint.${hint.key}`, hint.params);
    }

    /** What the card shows for a part: the store's content after (before: nothing). */
    preview(part: StyleUpPart): unknown {
        switch (part.part) {
            case 'canon':
                return { keys: [...part.keys], content: part.content };
            case 'archive':
                return { book: part.book, keys: [...part.keys], content: part.content };
            case 'passport':
                return {
                    name: part.passport.name,
                    aliases: [...part.passport.aliases],
                    tags: passportTagLine(part.passport),
                };
            case 'placeEntry':
                return { content: part.content };
            case 'lorePassport':
                return this.t('m7.styleUp.preview.lorePassport');
        }
    }

    private cardChanges(payload: StyleUpPayload): JournalChange[] {
        return payload.parts.map((part) => ({
            target: STYLE_UP_TARGET,
            ref: {
                plan: payload.planId,
                part: part.part,
                store: this.t(`m7.styleUp.part.${part.part}`),
                ...(part.part === 'archive' ? { book: part.book } : {}),
            },
            before: null,
            after: this.preview(part),
        }));
    }

    /** The parts the user kept, with the archive's book as chosen. */
    payloadOf(plan: StyleUpPlan, choice: StyleUpChoice = {}): StyleUpPayload {
        const wanted = new Set<StyleUpPartId>(choice.parts ?? plan.parts.map((part) => part.part));
        const parts = plan.parts
            .filter((part) => wanted.has(part.part))
            .map((part): StyleUpPart => {
                if (part.part !== 'archive' || !choice.book || !part.books.includes(choice.book)) return part;
                return { ...part, book: choice.book, create: false };
            });
        return {
            op: 'styleUp',
            planId: plan.planId,
            entityId: plan.entityId,
            name: plan.name,
            kind: plan.kind,
            parts: structuredClone(parts),
        };
    }

    /** Proposes the chosen parts as one card (kind 'dossier.styleUp', the Inbox by default; plan §8). */
    async propose(plan: StyleUpPlan, choice: StyleUpChoice = {}): Promise<Decision> {
        const payload = this.payloadOf(plan, choice);
        if (!payload.parts.length) return 'skipped';
        const lines = payload.parts.map((part) => `• ${this.partLabel(part)}`);
        const hints = plan.hints
            .filter((hint) => hint.key === 'archiveNewBook' || hint.key === 'passportAuto')
            .map((hint) => this.hintText(hint));
        const proposal: Proposal<StyleUpPayload> = {
            module: DOSSIER_ID,
            kind: STYLE_UP_KIND,
            title: this.t(plan.kind === 'place' ? 'm7.styleUp.card.place' : 'm7.styleUp.card.title', {
                name: plan.name,
            }),
            description: [this.t('m7.styleUp.card.body'), ...lines, ...hints].join('\n'),
            changes: this.cardChanges(payload),
            payload,
            apply: async (value) => {
                await this.applyStyleUp(value);
            },
            stillValid: () => this.stillValid(payload),
        };
        return this.app.autonomy.decide<StyleUpPayload>(proposal, 'inbox');
    }

    /** At least one part can still be written (the others are skipped and reported when applied). */
    async stillValid(payload: StyleUpPayload): Promise<boolean> {
        for (const part of payload.parts) {
            if (await this.partValid(part)) return true;
        }
        return false;
    }

    private async partValid(part: StyleUpPart): Promise<boolean> {
        try {
            switch (part.part) {
                case 'canon':
                    return !!this.canon() && !!this.app.host.chatId();
                case 'archive': {
                    const state = await this.sources.bookState(part.book);
                    const exists = this.bookExists(part.book, state.data);
                    return !state.protected && (exists || part.create);
                }
                case 'passport':
                    return !!this.sources.naiApi();
                case 'placeEntry': {
                    const place = this.sources.places()?.get(part.placeId);
                    return !!place && !place.entry && !!this.canon();
                }
                case 'lorePassport':
                    return !!this.lorePassports() && !!this.sources.places()?.get(part.placeId);
            }
        } catch (error) {
            this.log.debug('dossier «style up» check failed', error);
            return false;
        }
    }

    /* ---------------------------------------------------------------- applying */

    /**
     * Writes every part (each saved at once and journaled on its own). Parts that fail are reported; the call throws
     * only when nothing was written, so the card stays in the Inbox.
     */
    async applyStyleUp(payload: StyleUpPayload): Promise<StyleUpResult> {
        const outcomes: PartOutcome[] = [];
        const context: ApplyContext = {};
        for (const part of payload.parts) {
            try {
                const note = await this.applyPart(payload, part, context);
                outcomes.push(note ? { part: part.part, ok: true, note } : { part: part.part, ok: true });
            } catch (error) {
                this.log.warn(`dossier: «style up» ${part.part} failed`, error);
                outcomes.push({ part: part.part, ok: false, error: message(error) });
            }
        }
        const result: StyleUpResult = { planId: payload.planId, entityId: payload.entityId, at: Date.now(), outcomes };
        this.finish(result);
        const failed = outcomes.filter((outcome) => !outcome.ok);
        if (outcomes.length && failed.length === outcomes.length) {
            throw failed[0]?.error?.includes('P13')
                ? new ProtectedBookError(failed[0].error)
                : new Error(failed[0]?.error ?? 'failed');
        }
        if (failed.length) {
            this.app.ui.notice(
                this.t('m7.styleUp.partial', {
                    count: failed.length,
                    errors: failed.map((item) => `${this.t(`m7.styleUp.part.${item.part}`)}: ${item.error}`).join('; '),
                }),
                { level: 'warn' },
            );
        }
        return result;
    }

    private async applyPart(
        payload: StyleUpPayload,
        part: StyleUpPart,
        context: ApplyContext,
    ): Promise<string | undefined> {
        switch (part.part) {
            case 'canon':
                return this.applyCanon(payload, part);
            case 'archive':
                return this.applyArchive(payload, part);
            case 'passport':
                return this.applyPassport(payload, part);
            case 'placeEntry':
                return this.applyPlaceEntry(payload, part, context);
            case 'lorePassport':
                return this.applyLorePassport(payload, part, context);
        }
    }

    private async journalPart(
        planId: string,
        kind: string,
        summary: string,
        ref: Dict,
        after: unknown,
        before: unknown = null,
    ): Promise<void> {
        try {
            await this.app.journal.record({
                module: DOSSIER_ID,
                kind,
                summary,
                changes: [{ target: STYLE_UP_PART_TARGET, ref: { plan: planId, ...ref }, before, after }],
            });
        } catch (error) {
            this.log.warn('dossier: «style up» part was not journaled', error);
        }
    }

    private async applyCanon(
        payload: StyleUpPayload,
        part: Extract<StyleUpPart, { part: 'canon' }>,
    ): Promise<undefined> {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId()) throw new Error(this.t('m7.error.noCanon'));
        const meta: Dict = {
            kind: 'addition',
            status: 'active',
            origin: 'entity',
            type: 'character',
            [TYPED_FIELDS_KEY]: { ...part.fields },
        };
        const uid = await canon.put({
            entry: { comment: part.title, key: [...part.keys], keysecondary: [], content: part.content },
            meta: meta as unknown as CanonDraft['meta'],
        });
        await this.journalPart(
            payload.planId,
            STYLE_UP_KIND,
            this.t('m7.styleUp.journal.canon', { name: payload.name }),
            { part: 'canon', uid },
            { content: part.content },
        );
        return undefined;
    }

    private async applyArchive(
        payload: StyleUpPayload,
        part: Extract<StyleUpPart, { part: 'archive' }>,
    ): Promise<string | undefined> {
        const io = bookIo(this.app, this.log);
        if (!io) throw new Error(this.t('m7.error.noWorldInfo'));
        const book = part.book;
        let state = await this.sources.bookState(book);
        if (state.protected) throw new ProtectedBookError(this.t('m7.p13', { book }));
        let created = false;
        if (!this.bookExists(book, state.data)) {
            if (!part.create) throw new Error(this.t('m7.styleUp.error.noBook', { book }));
            await io.create(book);
            created = true;
            const roles = this.roles();
            if (roles) await this.safeAsync(() => roles.setRole(book, 'ck.archive'), undefined);
            state = await this.sources.bookState(book);
        }
        // Checked again right before the write (P13): a book may have been marked or filled since.
        if (state.protected) throw new ProtectedBookError(this.t('m7.p13', { book }));
        const data: BookData = state.data ?? { entries: {} };
        const exists = Object.values(data.entries).some(
            (entry) => isDict(entry) && entry.disable !== true && archiveMatch(entry, part.name) === 'exact',
        );
        if (exists) throw new Error(this.t('m7.styleUp.error.archiveExists', { name: part.name, book }));
        const uid = freeUid(data.entries);
        data.entries[String(uid)] = archiveEntry(uid, { name: part.name, keys: part.keys, content: part.content });
        await io.save(book, data);
        this.refreshCk(book);
        await this.journalPart(
            payload.planId,
            STYLE_UP_KIND,
            this.t('m7.styleUp.journal.archive', { name: part.name, book }),
            { part: 'archive', book, uid, createdBook: created },
            part.content,
        );
        const repos = this.safe(() => adaptersOf(this.app).ck.repoBooks(), []);
        return repos.includes(book) ? undefined : this.t('m7.styleUp.note.notRepo', { book });
    }

    /** CK keeps parsed archives in memory: re-scan every repository after one changed (research §5 step 3). */
    private refreshCk(book: string): void {
        try {
            const ck = adaptersOf(this.app).ck;
            const repos = ck.repoBooks();
            if (!repos.includes(book)) return;
            void Promise.resolve(ck.kernel()?.scanSelectedLorebooks?.(repos)).catch((error: unknown) =>
                this.log.debug('CK rescan failed', error),
            );
        } catch (error) {
            this.log.debug('CK rescan is not available', error);
        }
    }

    private async applyPassport(
        payload: StyleUpPayload,
        part: Extract<StyleUpPart, { part: 'passport' }>,
    ): Promise<undefined> {
        const api = this.sources.naiApi();
        if (!api) throw new Error(this.t('m7.error.noNaiApi'));
        const passport = readPassport(part.passport);
        if (!passport) throw new Error(this.t('m7.styleUp.error.passport'));
        // A chat passport whose id a card passport has would become that card's override instead.
        passport.id = freeId(passport.id, (id) => !!api.getPassport(id));
        await api.savePassport(passport, 'chat');
        await this.journalPart(
            payload.planId,
            STYLE_UP_KIND,
            this.t('m7.styleUp.journal.passport', { name: passport.name }),
            { part: 'passport', id: passport.id },
            passportTagLine(passport),
        );
        return undefined;
    }

    private async applyPlaceEntry(
        payload: StyleUpPayload,
        part: Extract<StyleUpPart, { part: 'placeEntry' }>,
        context: ApplyContext,
    ): Promise<string | undefined> {
        const places = this.sources.places();
        if (!places) throw new Error(this.t('m7.error.noPlaces'));
        const place = places.get(part.placeId);
        if (!place) throw new Error(this.t('m7.styleUp.error.placeGone'));
        const canon = this.canon();
        const known = new Set(canon ? (await canon.list()).map((item) => item.uid) : []);
        const entry = await places.ensureEntry(part.placeId);
        context.placeEntry = { ...entry };
        const created = !!canon && entry.world === canon.bookName() && !known.has(entry.uid);
        if (!canon || !created) return this.t('m7.styleUp.note.placeLinked');
        // The registry wrote a bare template («Description: »): fill it with what is known.
        const item = (await canon.list()).find((candidate) => candidate.uid === entry.uid);
        let content = str(item?.entry.content);
        if (item && part.content.trim()) {
            const meta: Dict = { ...item.meta, [TYPED_FIELDS_KEY]: { ...part.fields } };
            delete meta.createdAt;
            delete meta.updatedAt;
            await canon.put(
                {
                    entry: {
                        comment: str(item.entry.comment) || place.name,
                        key: strings(item.entry.key),
                        keysecondary: strings(item.entry.keysecondary),
                        content: part.content,
                    },
                    meta: meta as unknown as CanonDraft['meta'],
                },
                { uid: entry.uid },
            );
            content = part.content;
        }
        await this.journalPart(
            payload.planId,
            STYLE_UP_KIND,
            this.t('m7.styleUp.journal.placeEntry', { name: place.name }),
            { part: 'placeEntry', placeId: place.id, world: entry.world, uid: entry.uid },
            { content },
        );
        return undefined;
    }

    private async applyLorePassport(
        payload: StyleUpPayload,
        part: Extract<StyleUpPart, { part: 'lorePassport' }>,
        context: ApplyContext,
    ): Promise<string | undefined> {
        const api = this.lorePassports();
        if (!api) throw new Error(this.t('m7.styleUp.error.noLorePassports'));
        const target = context.placeEntry ?? this.sources.places()?.get(part.placeId)?.entry;
        if (!target) throw new Error(this.t('m7.styleUp.error.noPlaceEntry'));
        if (await api.get(target.world, target.uid)) return this.t('m7.styleUp.note.passportExists');
        const generated = await api.generate(target.world, target.uid);
        if (!generated) throw new Error(this.t('m7.styleUp.error.lorePassport'));
        const passport = readPassport(generated.passport);
        await this.journalPart(
            payload.planId,
            STYLE_UP_KIND,
            this.t('m7.styleUp.journal.lorePassport', { name: payload.name }),
            { part: 'lorePassport', world: target.world, uid: target.uid },
            passport ? passportTagLine(passport) : '',
        );
        return undefined;
    }

    /* ---------------------------------------------------------------- undo */

    /** A card change: undoes the part's own record (nothing to do when it was not written or is undone already). */
    private async undoCard(change: JournalChange): Promise<boolean> {
        const plan = change.ref.plan;
        const part = change.ref.part;
        if (typeof plan !== 'string' || typeof part !== 'string') return false;
        const record = this.app.journal
            .list({ module: DOSSIER_ID })
            .find((item) =>
                item.changes.some(
                    (candidate) =>
                        candidate.target === STYLE_UP_PART_TARGET &&
                        candidate.ref.plan === plan &&
                        candidate.ref.part === part,
                ),
            );
        if (!record || record.undone) return true;
        return this.app.journal.undo(record.id);
    }

    /** One written part; refuses (false) when the store changed since, so nothing of the user's is lost. */
    private async undoPart(change: JournalChange): Promise<boolean> {
        const ref = change.ref;
        const after = change.after;
        switch (ref.part) {
            case 'canon':
            case 'placeEntry':
                return this.undoCanonItem(Number(ref.uid), isDict(after) ? str(after.content) : null);
            case 'archive':
            case 'promote':
                return this.undoBookEntry(change);
            case 'passport': {
                const api = this.sources.naiApi();
                const id = ref.id;
                if (!api || typeof id !== 'string') return false;
                if (!api.getPassport(id)) return true;
                await api.clearChatOverride(id);
                return true;
            }
            case 'lorePassport': {
                const api = this.lorePassports();
                if (!api || typeof ref.world !== 'string' || !Number.isFinite(Number(ref.uid))) return false;
                await api.remove(ref.world, Number(ref.uid));
                return true;
            }
            default:
                return false;
        }
    }

    private async undoCanonItem(uid: number, content: string | null): Promise<boolean> {
        const canon = this.canon();
        if (!canon || !Number.isFinite(uid)) return false;
        const item = (await canon.list()).find((candidate) => candidate.uid === uid);
        if (!item) return true;
        if (content !== null && str(item.entry.content) !== content) return false;
        await canon.remove(uid);
        return true;
    }

    private async undoBookEntry(change: JournalChange): Promise<boolean> {
        const ref = change.ref;
        const book = ref.book;
        const uid = Number(ref.uid);
        const io = bookIo(this.app, this.log);
        if (typeof book !== 'string' || !Number.isFinite(uid) || !io) return false;
        const state = await this.sources.bookState(book);
        if (state.protected) return false;
        const data = state.data;
        const key = data ? entryKeyOf(data, uid) : null;
        if (data && key !== null) {
            const entry = data.entries[key];
            const written = isDict(change.after) ? str(change.after.content) : str(change.after);
            if (!isDict(entry) || str(entry.content) !== written) return false;
            delete data.entries[key];
            await io.save(book, data);
            this.refreshCk(book);
        }
        if (ref.part === 'promote' && isDict(change.before)) return this.restoreCanonItem(change.before);
        return true;
    }

    /** A promoted canon addition comes back to the chat canon. */
    private async restoreCanonItem(snapshot: Dict): Promise<boolean> {
        const canon = this.canon();
        if (!canon || !isDict(snapshot.entry) || !isDict(snapshot.meta)) return false;
        const entry = { ...snapshot.entry };
        delete entry.uid;
        const meta = { ...snapshot.meta };
        delete meta.createdAt;
        delete meta.updatedAt;
        await canon.put({ entry, meta: meta as unknown as CanonDraft['meta'] });
        return true;
    }

    /* ---------------------------------------------------------------- promotion to the card's book */

    /** The card's primary book: the Lore Studio's bindings, else the card field `extensions.world`. */
    async cardBook(): Promise<string | null> {
        const store = this.app.modules.api<{ bindings?: () => Promise<{ character?: { primary?: string | null } }> }>(
            'loreStore',
        );
        if (typeof store?.bindings === 'function') {
            const bindings = await this.safeAsync(() => store.bindings?.() ?? Promise.resolve(undefined), undefined);
            const primary = bindings?.character?.primary;
            if (typeof primary === 'string' && primary.trim()) return primary.trim();
            if (bindings) return null;
        }
        const ctx = this.app.host.ctx();
        if (ctx.groupId || ctx.characterId === undefined) return null;
        const world = ctx.characters[Number(ctx.characterId)]?.data?.extensions?.world;
        return typeof world === 'string' && world.trim() ? world.trim() : null;
    }

    private async additionOf(uid: number): Promise<CanonItem | undefined> {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId()) return undefined;
        return (await canon.list()).find((item) => item.uid === uid && item.meta.kind === 'addition');
    }

    /**
     * «Повысить до книги карточки»: the canon addition is copied into the card's primary book (kind
     * 'dossier.promoteToCard', «Спросить» by default, never «auto»); the chat's copy then leaves the canon so the entry
     * does not fire twice. BunnyMo books are refused (P13).
     */
    async promote(entityId: string, canonUid: number): Promise<Decision> {
        const item = await this.additionOf(canonUid);
        if (!item) throw new Error(this.t('m7.error.gone'));
        const book = await this.cardBook();
        if (!book) throw new Error(this.t('m7.styleUp.promote.noBook'));
        const state = await this.sources.bookState(book);
        if (state.protected) throw new ProtectedBookError(this.t('m7.p13', { book }));
        const title = str(item.entry.comment).trim() || strings(item.entry.key)[0] || `#${item.uid}`;
        const payload: PromotePayload = { op: 'promote', planId: newId('pr'), entityId, canonUid, book, title };
        const fields = promotedFields(item.entry);
        return this.app.autonomy.decide<PromotePayload>(
            {
                module: DOSSIER_ID,
                kind: PROMOTE_KIND,
                title: this.t('m7.styleUp.promote.title', { title, book }),
                description: this.t('m7.styleUp.promote.body', { title, book }),
                changes: [
                    {
                        target: STYLE_UP_TARGET,
                        ref: { plan: payload.planId, part: 'promote', book },
                        before: null,
                        after: { keys: strings(fields.key), content: str(fields.content) },
                    },
                ],
                payload,
                apply: async (value) => {
                    await this.applyPromote(value);
                },
                stillValid: () => this.promoteValid(payload),
            },
            'ask',
        );
    }

    async promoteValid(payload: PromotePayload): Promise<boolean> {
        try {
            if (!(await this.additionOf(payload.canonUid))) return false;
            const state = await this.sources.bookState(payload.book);
            return !state.protected && this.bookExists(payload.book, state.data);
        } catch (error) {
            this.log.debug('dossier promotion check failed', error);
            return false;
        }
    }

    async applyPromote(payload: PromotePayload): Promise<StyleUpResult> {
        const canon = this.canon();
        const item = await this.additionOf(payload.canonUid);
        if (!canon || !item) throw new Error(this.t('m7.error.gone'));
        const io = bookIo(this.app, this.log);
        if (!io) throw new Error(this.t('m7.error.noWorldInfo'));
        const state = await this.sources.bookState(payload.book);
        if (state.protected) throw new ProtectedBookError(this.t('m7.p13', { book: payload.book }));
        if (!state.data || !this.bookExists(payload.book, state.data)) {
            throw new Error(this.t('m7.styleUp.error.noBook', { book: payload.book }));
        }
        const data = state.data;
        const uid = freeUid(data.entries);
        const entry = templateEntry(uid, promotedFields(item.entry));
        data.entries[String(uid)] = entry;
        await io.save(payload.book, data);
        // P2: the type of a base-book entry lives in the roles sidecar, not in the file.
        const roles = this.roles();
        const typed = (item.meta as unknown as Dict)[TYPED_FIELDS_KEY];
        if (roles && item.meta.type) {
            await this.safeAsync(
                () =>
                    roles.setEntryMeta(payload.book, uid, {
                        type: item.meta.type,
                        [TYPED_FIELDS_KEY]: isDict(typed) ? { ...typed } : {},
                    }),
                undefined,
            );
        }
        const snapshot = { entry: structuredClone(item.entry), meta: structuredClone(item.meta) };
        await canon.remove(item.uid);
        await this.journalPart(
            payload.planId,
            PROMOTE_KIND,
            this.t('m7.styleUp.journal.promote', { title: payload.title, book: payload.book }),
            { part: 'promote', book: payload.book, uid },
            { content: str(entry.content) },
            snapshot,
        );
        const result: StyleUpResult = {
            planId: payload.planId,
            entityId: payload.entityId,
            at: Date.now(),
            outcomes: [{ part: 'promote', ok: true }],
        };
        this.finish(result);
        return result;
    }
}
