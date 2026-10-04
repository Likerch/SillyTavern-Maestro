// Revision routes (plan M8 «Маршрутизация», «Проверки перед записью», §8): one known change → one proposal for the
// store that owns it, through app.autonomy (or straight to the Inbox when it conflicts with confirmed canon):
// - canon.fact      → the chat canon: an override of the entity's description entry (P2: base books are never
//                     written), an update of its canon item, or a new canon addition;
// - ck.tags         → a canon override of the CK archive with a clean final tag set from the pack dictionary
//                     (no `!updatesheet` markup, `<Name:…>` untouched), then a CK rescan;
// - nai.appearance  → NAI Studio's API, chat level, permanent slots only (hair, eyes, body, skin, base);
// - chat.alias      → the world model's chat alias map + the alias as a canon key («мелкие правки» — auto);
// - des.alias       → an Inbox note only: DES owns canonical aliases;
// - chronicle.event → a bus signal 'memory.important' for the chronicle (M9);
// - places.state    → the place registry (M24).
// Payloads are JSON (Inbox cards outlive the page) and are applied from their own `value`, so an edited card
// ('edited' outcome) writes the user's text — after the same checks.
import { adaptersOf } from '../../adapters';
import type { NaiPassportTarget } from '../../adapters/nai';
import { isCharacterArchive } from '../../domain/bunnymo';
import { uniqueStrings } from '../../domain/canon-keys';
import { normName } from '../../domain/dossier-names';
import {
    applyTagChange,
    checkAlias,
    checkFactText,
    checkPassportTags,
    checkTagFormat,
    insertFact,
    invalidKeys,
    mergeKeys,
    parseTagList,
    REVISION_SLOTS,
    withoutStatement,
} from '../../domain/revision-checks';
import type { Rejection } from '../../domain/revision-checks';
import type { RevisionTargetName } from '../../domain/revision-prompt';
import type { App, AutonomyLevel, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { CanonMeta, EntryType } from '../canon/api';
import type { Contradiction, ContradictionInput } from '../contradictions/api';
import type { Entity } from '../world/api';
import type { RevisionChange, RevisionTarget } from './api';
import { REVISION_ID } from './settings';
import { DEFAULT_OVERRIDE_FIELDS } from './sources';
import type { RevisionSources } from './sources';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Autonomy kinds of the routed targets (deferred cards and 'new' changes do not go through autonomy). */
export const ROUTED_KINDS = [
    'canon.fact',
    'ck.tags',
    'nai.appearance',
    'chat.alias',
    'des.alias',
    'chronicle.event',
    'places.state',
] as const;
export type RoutedKind = (typeof ROUTED_KINDS)[number];

/** Default levels (plan §8): canon facts, character tags and lasting appearance — Inbox; small fixes — auto. */
export const DEFAULT_LEVELS: Record<RoutedKind, AutonomyLevel> = {
    'canon.fact': 'inbox',
    'ck.tags': 'inbox',
    'nai.appearance': 'inbox',
    'chat.alias': 'auto',
    'des.alias': 'inbox',
    'chronicle.event': 'auto',
    'places.state': 'auto',
};

/** Journal targets (undo handlers registered here). */
export const TARGETS = {
    canon: 'revision.canon',
    ck: 'revision.ck',
    keys: 'revision.keys',
    passport: 'revision.passport',
    alias: 'revision.alias',
    place: 'revision.place',
    note: 'revision.note',
    event: 'revision.event',
} as const;

/** Where a canon change is written. */
export type CanonDest =
    | { kind: 'override'; world: string; uid: number; created: boolean; label: string }
    | { kind: 'item'; uid: number; label: string }
    | { kind: 'addition'; comment: string; keys: string[]; type: EntryType; label: string };

interface PayloadBase {
    /** Marks a revision card (the Inbox view reads entityName/value/evidence/confidence/editable from it). */
    m8: 1;
    target: RevisionTarget;
    entityName: string;
    entityId?: string;
    value: string;
    evidence: string;
    confidence: number;
    sourceMessage: number;
    /** The value can be edited in the Inbox before accepting. */
    editable: boolean;
    field?: string;
}

export type RevisionPayload = PayloadBase &
    (
        | { op: 'fact'; dest: CanonDest; before: string; replace?: string }
        | { op: 'tags'; world: string; uid: number; created: boolean; remove: string[]; before: string }
        | { op: 'passport'; id: string; owner: NaiPassportTarget | null; slot: string; before: string }
        | { op: 'alias'; entityId: string; keys?: { dest: CanonDest; before: string[] } }
        | { op: 'note'; text: string }
        | { op: 'event' }
        | { op: 'place'; placeId: string; key: string; before: string }
    );

export function isRevisionPayload(value: unknown): value is RevisionPayload {
    return isDict(value) && value.m8 === 1 && typeof value.op === 'string' && typeof value.value === 'string';
}

export type Planned =
    | {
          ok: true;
          proposal: Proposal<RevisionPayload>;
          level: AutonomyLevel;
          /** Conflicts with confirmed canon: the card goes to the Inbox whatever the level (never overwrite). */
          forceInbox: boolean;
          costUsd: number;
      }
    | { ok: false; rejection: Rejection; costUsd: number };

export class RouteError extends Error {}

// Compile-time check: the domain's target list is exactly the contract's RevisionTarget.
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _targets: Exact<RevisionTarget, RevisionTargetName> = true;
void _targets;

const TYPE_OF_KIND: Record<string, EntryType> = {
    character: 'character',
    persona: 'character',
    place: 'place',
    item: 'item',
    faction: 'faction',
    event: 'event',
    tradition: 'tradition',
    mechanic: 'mechanic',
};

export interface RevisionRoutesOptions {
    /** How long the model contradiction check may take before the fact counts as unchecked. */
    checkTimeoutMs?: number;
}

const CHECK_TIMEOUT_MS = 30_000;

/** The promise's value, or null when it does not settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

export class RevisionRoutes {
    private readonly t: App['i18n']['t'];
    private readonly checkTimeoutMs: number;

    constructor(
        private readonly app: App,
        private readonly sources: RevisionSources,
        private readonly log: Logger,
        options: RevisionRoutesOptions = {},
    ) {
        this.t = app.i18n.t.bind(app.i18n);
        this.checkTimeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    }

    /** Undo handlers (permanent: journal records outlive the module) and Inbox appliers (owned). */
    install(): Unsubscribe[] {
        const journal = this.app.journal;
        journal.registerUndo(TARGETS.canon, (change) => this.undoCanon(change));
        journal.registerUndo(TARGETS.ck, (change) => this.undoCanon(change));
        journal.registerUndo(TARGETS.keys, (change) => this.undoKeys(change));
        journal.registerUndo(TARGETS.passport, (change) => this.undoPassport(change));
        journal.registerUndo(TARGETS.alias, (change) => this.undoAlias(change));
        journal.registerUndo(TARGETS.place, (change) => this.undoPlace(change));
        // A note and a hand-over to the chronicle change nothing here; the chronicle journals its own action.
        journal.registerUndo(TARGETS.note, async () => true);
        journal.registerUndo(TARGETS.event, async () => true);
        // DES owns canonical names: the note is never applied by itself.
        this.app.autonomy.neverAuto('des.alias');
        const apply = async (payload: unknown) => {
            if (!isRevisionPayload(payload)) throw new RouteError('bad revision card');
            await this.apply(payload);
        };
        const valid = async (payload: unknown) => isRevisionPayload(payload) && (await this.stillValid(payload));
        return ROUTED_KINDS.map((kind) => this.app.inbox.registerApplier(kind, apply, valid));
    }

    /* ---------------------------------------------------------------- planning */

    /** Checks a known change against the live stores and builds its proposal (or says why it cannot be written). */
    async plan(change: RevisionChange, entity: Entity | undefined): Promise<Planned> {
        const reject = (rejection: Rejection, costUsd = 0): Planned => ({ ok: false, rejection, costUsd });
        try {
            switch (change.target) {
                case 'canon.fact':
                    return entity ? await this.planFact(change, entity) : reject({ code: 'unknownEntity' });
                case 'ck.tags':
                    return entity ? await this.planTags(change, entity) : reject({ code: 'unknownEntity' });
                case 'nai.appearance':
                    return entity ? this.planAppearance(change, entity) : reject({ code: 'unknownEntity' });
                case 'chat.alias':
                    return entity ? await this.planAlias(change, entity) : reject({ code: 'unknownEntity' });
                case 'des.alias':
                    return entity ? this.planDesAlias(change, entity) : reject({ code: 'unknownEntity' });
                case 'chronicle.event':
                    return this.planEvent(change, entity);
                case 'places.state':
                    return this.planPlace(change, entity);
                default:
                    return reject({ code: 'noTarget' });
            }
        } catch (error) {
            this.log.warn(`revision: planning ${change.target} failed`, error);
            return reject({ code: 'failed', detail: error instanceof Error ? error.message : String(error) });
        }
    }

    private base(change: RevisionChange, entity: Entity | undefined, editable: boolean): PayloadBase {
        const base: PayloadBase = {
            m8: 1,
            target: change.target,
            entityName: entity?.name ?? change.entityName,
            value: change.value.trim(),
            evidence: change.evidence,
            confidence: change.confidence,
            sourceMessage: change.sourceMessage,
            editable,
        };
        if (entity) base.entityId = entity.id;
        if (change.field) base.field = change.field;
        return base;
    }

    private proposal(
        payload: RevisionPayload,
        title: string,
        description: string,
        changes: JournalChange[],
    ): Proposal<RevisionPayload> {
        return {
            module: REVISION_ID,
            kind: payload.target,
            title,
            description,
            changes,
            payload,
            sourceMessage: payload.sourceMessage,
            apply: (value) => this.apply(isRevisionPayload(value) ? value : payload),
            stillValid: () => this.stillValid(payload),
        };
    }

    private planned(
        payload: RevisionPayload,
        title: string,
        description: string,
        changes: JournalChange[],
        extra: { forceInbox?: boolean; costUsd?: number } = {},
    ): Planned {
        const kind = payload.target as RoutedKind;
        return {
            ok: true,
            proposal: this.proposal(payload, title, description, changes),
            level: DEFAULT_LEVELS[kind] ?? 'inbox',
            forceInbox: extra.forceInbox === true,
            costUsd: extra.costUsd ?? 0,
        };
    }

    /* ---------------------------------------------------------------- canon facts */

    private async planFact(change: RevisionChange, entity: Entity): Promise<Planned> {
        const problem = checkFactText(change.value);
        if (problem) return { ok: false, rejection: problem, costUsd: 0 };
        const dest = await this.factDest(entity);
        if ('code' in dest) return { ok: false, rejection: dest, costUsd: 0 };
        const before = await this.destContent(dest);
        if (before === null) return { ok: false, rejection: { code: 'noTarget' }, costUsd: 0 };
        const inserted = insertFact(before, change.value, change.before);
        if (!inserted) return { ok: false, rejection: { code: 'noChange' }, costUsd: 0 };
        const payload: RevisionPayload = { ...this.base(change, entity, true), op: 'fact', dest, before };
        if (change.before) payload.replace = change.before;

        // Confirmed canon is never overwritten by a contradicting fact: such a card waits in the Inbox (M26 п. 4).
        const against = withoutStatement(before, inserted.replaced ? change.before : undefined);
        const conflict = await this.conflicts(change.value, entity.name, dest.label, against);
        const params = { name: entity.name, dest: dest.label, value: payload.value };
        let description = this.t(inserted.replaced ? 'm8.card.fact.replace' : 'm8.card.fact.body', params);
        if (conflict.lines.length) {
            description += `\n${this.t('m8.card.conflict', { list: conflict.lines.join('; ') })}`;
        } else if (conflict.unchecked) {
            description += `\n${this.t('m8.card.unchecked')}`;
        }
        return this.planned(
            payload,
            this.t('m8.card.fact.title', params),
            description,
            [{ target: TARGETS.canon, ref: this.destRef(dest), before, after: inserted.content }],
            { forceInbox: conflict.lines.length > 0 || conflict.unchecked, costUsd: conflict.costUsd },
        );
    }

    /**
     * Contradictions with confirmed canon (the shared M26 service): its rules always; its model check only when the
     * kind would be applied without the user (level 'auto') — otherwise the Inbox card is the user's own check. The
     * model check is bounded by a timeout (it may be a queued background task itself, and a revision runs inside one):
     * no answer in time, or a failure, means «unchecked», which keeps the fact in the Inbox too.
     */
    private async conflicts(
        statement: string,
        entityName: string,
        label: string,
        against: string,
    ): Promise<{ lines: string[]; unchecked: boolean; costUsd: number }> {
        const none = { lines: [], unchecked: false, costUsd: 0 };
        const service = this.sources.contradictions();
        if (!service || !against.trim()) return none;
        const input: ContradictionInput = { statement, entities: [entityName], against: [{ label, text: against }] };
        const format = (list: readonly Contradiction[]) =>
            list.slice(0, 3).map((item) => `${item.label}: «${item.conflicting}»`);
        try {
            const quick = service.quick(input);
            if (quick.length) return { lines: format(quick), unchecked: false, costUsd: 0 };
        } catch (error) {
            this.log.debug('revision: contradiction rules failed', error);
        }
        if (this.app.autonomy.level('canon.fact', DEFAULT_LEVELS['canon.fact']) !== 'auto') return none;
        try {
            const result = await withTimeout(service.check(input), this.checkTimeoutMs);
            if (!result) return { lines: [], unchecked: true, costUsd: 0 };
            return {
                lines: result.clean ? [] : format(result.contradictions),
                unchecked: false,
                costUsd: result.costUsd,
            };
        } catch (error) {
            this.log.warn('revision: contradiction check failed', error);
            return { lines: [], unchecked: true, costUsd: 0 };
        }
    }

    private destRef(dest: CanonDest): Record<string, unknown> {
        if (dest.kind === 'override') return { world: dest.world, uid: dest.uid, created: dest.created };
        if (dest.kind === 'item') return { itemUid: dest.uid };
        return { addition: dest.comment };
    }

    /** The entry a fact about the entity belongs to (its description), never a protected book or a CK archive. */
    private async factDest(entity: Entity): Promise<CanonDest | Rejection> {
        const canon = this.sources.canon();
        if (!canon || !this.app.host.chatId()) return { code: 'noTarget' };
        const found = await this.entryDest(entity, false);
        if (found) return found;
        const items = await this.sources.canonItems();
        const existing = items.find(
            (item) => item.meta.kind === 'addition' && normName(str(item.entry.comment)) === normName(entity.name),
        );
        if (existing) return { kind: 'item', uid: existing.uid, label: entity.name };
        let keys: string[] = [entity.name];
        try {
            keys = uniqueStrings([
                entity.name,
                ...(await canon.russianKeys(entity.name)),
                ...entity.aliases.slice(0, 4),
            ]);
        } catch (error) {
            this.log.debug('canon keys are not available', error);
        }
        keys = keys.filter((key) => !invalidKeys([key]).length);
        return {
            kind: 'addition',
            comment: entity.name,
            keys,
            type: TYPE_OF_KIND[entity.kind] ?? 'note',
            label: entity.name,
        };
    }

    /**
     * The entity's own entry: its place description, its canon item (or the base entry its override replaces), or
     * its first writable lore entry. Archives only when `archives` is true (keys may go there, prose may not).
     */
    private async entryDest(entity: Entity, archives: boolean): Promise<CanonDest | null> {
        const canonBook = this.sources.canon()?.bookName();
        const items = await this.sources.canonItems();
        const lore = async (world: string, uid: number, label: string): Promise<CanonDest | null> => {
            if (world === canonBook) {
                return items.some((item) => item.uid === uid && item.meta.kind === 'addition')
                    ? { kind: 'item', uid, label }
                    : null;
            }
            const current = await this.sources.effective(world, uid);
            if (!current.entry || current.protected) return null;
            if (!archives && isCharacterArchive(current.entry)) return null;
            return { kind: 'override', world, uid, created: !current.override, label };
        };
        for (const source of entity.sources) {
            if (source.kind === 'place') {
                const entry = this.sources.places()?.get(source.ref)?.entry;
                const dest = entry ? await lore(entry.world, entry.uid, source.label) : null;
                if (dest) return dest;
            }
        }
        for (const source of entity.sources) {
            if (source.kind !== 'canon.entry' || source.uid === undefined) continue;
            const item = items.find((candidate) => candidate.uid === source.uid);
            if (item?.meta.kind === 'addition') return { kind: 'item', uid: item.uid, label: source.label };
            const base = item?.meta.kind === 'override' ? item.meta.base : undefined;
            if (base) {
                const dest = await lore(base.world, base.uid, source.label);
                if (dest) return dest;
            }
        }
        for (const source of entity.sources) {
            const kinds = archives ? ['lore.entry', 'ck.archive'] : ['lore.entry'];
            if (!kinds.includes(source.kind) || !source.world || source.uid === undefined) continue;
            const dest = await lore(source.world, source.uid, source.label);
            if (dest) return dest;
        }
        return null;
    }

    /** Current content of a destination ('' for a new addition); null when it is gone. */
    private async destContent(dest: CanonDest): Promise<string | null> {
        if (dest.kind === 'override') {
            const current = await this.sources.effective(dest.world, dest.uid);
            return current.entry ? current.content : null;
        }
        if (dest.kind === 'item') {
            const item = (await this.sources.canonItems()).find((candidate) => candidate.uid === dest.uid);
            return item ? str(item.entry.content) : null;
        }
        return (await this.additionItem(dest.comment)) ? null : '';
    }

    private async additionItem(comment: string) {
        return (await this.sources.canonItems()).find(
            (item) =>
                item.meta.kind === 'addition' &&
                item.meta.origin === 'revision' &&
                normName(str(item.entry.comment)) === normName(comment),
        );
    }

    private async writeContent(dest: CanonDest, content: string, sourceMessage?: number): Promise<void> {
        if (dest.kind === 'override') {
            await this.putOverride(dest.world, dest.uid, { content }, sourceMessage);
        } else if (dest.kind === 'item') {
            await this.putItem(dest.uid, { content });
        } else {
            const canon = this.requireCanon();
            const meta: Omit<CanonMeta, 'createdAt' | 'updatedAt'> = {
                kind: 'addition',
                status: 'active',
                origin: 'revision',
                type: dest.type,
            };
            if (sourceMessage !== undefined) meta.sourceMessage = sourceMessage;
            await canon.put({ entry: { key: [...dest.keys], keysecondary: [], comment: dest.comment, content }, meta });
        }
    }

    private requireCanon() {
        const canon = this.sources.canon();
        if (!canon) throw new RouteError(this.t('m8.error.noCanon'));
        return canon;
    }

    /** Writes override fields, merging with an existing override of the same base entry (like the dossier does). */
    private async putOverride(world: string, uid: number, fields: Dict, sourceMessage?: number): Promise<void> {
        const canon = this.requireCanon();
        const current = await this.sources.effective(world, uid);
        if (current.protected) throw new RouteError(this.t('m8.error.protected', { book: world }));
        if (!current.entry) throw new RouteError(this.t('m8.error.gone'));
        const existing = current.override;
        const changed = Object.keys(fields);
        if (existing) {
            const kept = existing.meta.fields ?? DEFAULT_OVERRIDE_FIELDS;
            const all = uniqueStrings([...kept, ...changed]);
            const entry: Dict = {};
            for (const field of all) if (field in existing.entry) entry[field] = existing.entry[field];
            const meta = { ...existing.meta, fields: all } as Partial<CanonMeta>;
            delete meta.createdAt;
            delete meta.updatedAt;
            await canon.put(
                { entry: { ...entry, ...fields }, meta: meta as Omit<CanonMeta, 'createdAt' | 'updatedAt'> },
                { uid: existing.uid },
            );
            return;
        }
        const meta: Omit<CanonMeta, 'createdAt' | 'updatedAt'> = {
            kind: 'override',
            status: 'active',
            origin: 'revision',
            base: { world, uid, contentHash: '' },
            fields: changed,
        };
        if (sourceMessage !== undefined) meta.sourceMessage = sourceMessage;
        await canon.put({ entry: { ...fields }, meta });
    }

    private async putItem(uid: number, fields: Dict): Promise<void> {
        const canon = this.requireCanon();
        const item = (await this.sources.canonItems()).find((candidate) => candidate.uid === uid);
        if (!item) throw new RouteError(this.t('m8.error.gone'));
        const meta = { ...item.meta } as Partial<CanonMeta>;
        delete meta.createdAt;
        delete meta.updatedAt;
        const entry: Dict = {};
        for (const field of ['key', 'keysecondary', 'comment', 'content']) {
            if (field in item.entry) entry[field] = item.entry[field];
        }
        await canon.put(
            { entry: { ...entry, ...fields }, meta: meta as Omit<CanonMeta, 'createdAt' | 'updatedAt'> },
            { uid },
        );
    }

    /* ---------------------------------------------------------------- CK tags */

    private async validateTags(tags: readonly string[]): Promise<Rejection | null> {
        const format = checkTagFormat(tags);
        if (format) return format;
        const bunnymo = this.sources.bunnymo();
        if (!bunnymo) return { code: 'noDictionary' };
        const checks = await bunnymo.validateTags(tags);
        const bad = checks.find((check) => !check.ok);
        if (bad) return { code: 'tag', detail: `${bad.tag} — ${bad.message ?? bad.reason ?? '?'}` };
        return null;
    }

    private async planTags(change: RevisionChange, entity: Entity): Promise<Planned> {
        const reject = (rejection: Rejection): Planned => ({ ok: false, rejection, costUsd: 0 });
        const added = parseTagList(change.value);
        if (added.junk || !added.tags.length) return reject({ code: 'malformed', detail: change.value });
        const removed = parseTagList(change.before ?? '');
        if (removed.junk) return reject({ code: 'malformed', detail: change.before });
        const invalid = await this.validateTags(added.tags);
        if (invalid) return reject(invalid);
        if (!this.sources.canon() || !this.app.host.chatId()) return reject({ code: 'noTarget' });
        const archive = entity.sources.find(
            (source) => source.kind === 'ck.archive' && source.world && source.uid !== undefined,
        );
        if (!archive?.world || archive.uid === undefined) return reject({ code: 'noTarget' });
        const current = await this.sources.effective(archive.world, archive.uid);
        if (!current.entry) return reject({ code: 'noTarget' });
        if (current.protected) return reject({ code: 'protectedBook', detail: archive.world });
        const result = applyTagChange(current.content, removed.tags, added.tags);
        if (!result.ok) return reject(result.rejection);
        const payload: RevisionPayload = {
            ...this.base(change, entity, true),
            value: added.tags.join(', '),
            op: 'tags',
            world: archive.world,
            uid: archive.uid,
            created: !current.override,
            remove: removed.tags,
            before: current.content,
        };
        const params = {
            name: entity.name,
            added: added.tags.join(' '),
            removed: removed.tags.join(' ') || '—',
            book: archive.world,
        };
        return this.planned(payload, this.t('m8.card.tags.title', params), this.t('m8.card.tags.body', params), [
            {
                target: TARGETS.ck,
                ref: { world: archive.world, uid: archive.uid, created: !current.override },
                before: current.content,
                after: result.content,
            },
        ]);
    }

    /** Re-reads CK's repos so its character map sees the archive (research §5 step 3); best effort. */
    private rescanCk(): void {
        try {
            const ck = adaptersOf(this.app).ck;
            const scan = ck.kernel()?.scanSelectedLorebooks;
            if (typeof scan === 'function') void Promise.resolve(scan(ck.repoBooks())).catch(() => undefined);
        } catch (error) {
            this.log.debug('CarrotKernel rescan failed', error);
        }
    }

    /* ---------------------------------------------------------------- NAI appearance */

    private planAppearance(change: RevisionChange, entity: Entity): Planned {
        const reject = (rejection: Rejection): Planned => ({ ok: false, rejection, costUsd: 0 });
        const slot = change.field ?? '';
        if (!REVISION_SLOTS.includes(slot)) return reject({ code: 'slot', detail: slot || '—' });
        const tags = checkPassportTags(change.value);
        if (!tags.ok) return reject(tags.rejection);
        const api = this.sources.naiApi();
        const source = entity.sources.find((item) => item.kind === 'nai.passport' && item.passportId);
        if (!api || !source?.passportId) return reject({ code: 'noTarget' });
        const passport = api.getPassport(source.passportId);
        if (!passport) return reject({ code: 'noTarget' });
        const before = passport.slots[slot] ?? '';
        if (before.trim() === tags.tags) return reject({ code: 'noChange' });
        const owner: NaiPassportTarget | null = source.ref.startsWith('persona#')
            ? { persona: true }
            : source.avatar
              ? { avatar: source.avatar }
              : null;
        const payload: RevisionPayload = {
            ...this.base(change, entity, true),
            value: tags.tags,
            field: slot,
            op: 'passport',
            id: source.passportId,
            owner,
            slot,
            before,
        };
        const params = { name: entity.name, slot: this.t(`m8.slot.${slot}`) };
        return this.planned(
            payload,
            this.t('m8.card.appearance.title', params),
            this.t('m8.card.appearance.body', params),
            [{ target: TARGETS.passport, ref: { id: source.passportId, slot, owner }, before, after: tags.tags }],
        );
    }

    private async savePassportSlot(
        id: string,
        owner: NaiPassportTarget | null,
        slot: string,
        value: string,
    ): Promise<void> {
        const api = this.sources.naiApi();
        if (!api) throw new RouteError(this.t('m8.error.noNai'));
        const passport = api.getPassport(id);
        if (!passport) throw new RouteError(this.t('m8.error.gone'));
        await api.savePassport(
            { ...passport, slots: { ...passport.slots, [slot]: value } },
            'chat',
            owner ?? undefined,
        );
    }

    /* ---------------------------------------------------------------- aliases */

    private async aliasKeys(alias: string): Promise<string[]> {
        try {
            return uniqueStrings([alias, ...((await this.sources.canon()?.russianKeys(alias)) ?? [])]);
        } catch {
            return [alias];
        }
    }

    private async destKeys(dest: CanonDest): Promise<string[] | null> {
        if (dest.kind === 'override') {
            const current = await this.sources.effective(dest.world, dest.uid);
            return current.entry ? current.keys : null;
        }
        if (dest.kind === 'item') {
            const item = (await this.sources.canonItems()).find((candidate) => candidate.uid === dest.uid);
            return item ? strings(item.entry.key) : null;
        }
        return null;
    }

    private async writeKeys(dest: CanonDest, keys: string[]): Promise<void> {
        if (dest.kind === 'override') await this.putOverride(dest.world, dest.uid, { key: keys });
        else if (dest.kind === 'item') await this.putItem(dest.uid, { key: keys });
    }

    private async planAlias(change: RevisionChange, entity: Entity): Promise<Planned> {
        const reject = (rejection: Rejection): Planned => ({ ok: false, rejection, costUsd: 0 });
        const alias = change.value.trim();
        const problem = checkAlias(alias);
        if (problem) return reject(problem);
        const world = this.sources.world();
        if (!world) return reject({ code: 'noTarget' });
        const known = [entity.name, ...entity.aliases, ...entity.forms].map(normName);
        if (known.includes(normName(alias))) return reject({ code: 'noChange' });
        const mapped = world.chatAliases()[alias];
        if (mapped && mapped !== entity.id) return reject({ code: 'duplicate', detail: alias });
        const payload: RevisionPayload = {
            ...this.base(change, entity, true),
            value: alias,
            op: 'alias',
            entityId: entity.id,
        };
        const changes: JournalChange[] = [
            { target: TARGETS.alias, ref: { alias }, before: null, after: { alias, entity: entity.name } },
        ];
        const dest = this.sources.canon() && this.app.host.chatId() ? await this.entryDest(entity, true) : null;
        const current = dest ? await this.destKeys(dest) : null;
        if (dest && current) {
            const added = await this.aliasKeys(alias);
            const bad = invalidKeys(added);
            if (bad.length) return reject({ code: 'keys', detail: bad.join(', ') });
            const merged = mergeKeys(current, added);
            if (merged) {
                payload.keys = { dest, before: current };
                changes.push({ target: TARGETS.keys, ref: this.destRef(dest), before: current, after: merged });
            }
        }
        const params = { name: entity.name, alias, dest: dest?.label ?? '—' };
        return this.planned(
            payload,
            this.t('m8.card.alias.title', params),
            this.t(payload.keys ? 'm8.card.alias.keys' : 'm8.card.alias.body', params),
            changes,
        );
    }

    private planDesAlias(change: RevisionChange, entity: Entity): Planned {
        const alias = change.value.trim();
        const problem = checkAlias(alias);
        if (problem) return { ok: false, rejection: problem, costUsd: 0 };
        const params = { name: entity.name, alias };
        const text = this.t('m8.note.desAlias', params);
        const payload: RevisionPayload = { ...this.base(change, entity, false), value: alias, op: 'note', text };
        return this.planned(
            payload,
            this.t('m8.card.desAlias.title', params),
            text,
            [{ target: TARGETS.note, ref: { entity: entity.name }, before: null, after: alias }],
            // DES owns canonical names: the card is a note in the Inbox, whatever the level.
            { forceInbox: true },
        );
    }

    /* ---------------------------------------------------------------- chronicle and places */

    private planEvent(change: RevisionChange, entity: Entity | undefined): Planned {
        const problem = checkFactText(change.value);
        if (problem) return { ok: false, rejection: problem, costUsd: 0 };
        const payload: RevisionPayload = { ...this.base(change, entity, true), op: 'event' };
        const params = { name: payload.entityName, value: payload.value };
        return this.planned(payload, this.t('m8.card.event.title', params), this.t('m8.card.event.body', params), [
            { target: TARGETS.event, ref: { messageIndex: change.sourceMessage }, before: null, after: payload.value },
        ]);
    }

    private planPlace(change: RevisionChange, entity: Entity | undefined): Planned {
        const reject = (rejection: Rejection): Planned => ({ ok: false, rejection, costUsd: 0 });
        const places = this.sources.places();
        if (!places) return reject({ code: 'noTarget' });
        const fromEntity = entity?.sources.find((source) => source.kind === 'place')?.ref;
        const place = (fromEntity ? places.get(fromEntity) : undefined) ?? places.resolve(change.entityName);
        if (!place) return reject({ code: 'unknownPlace', detail: change.entityName });
        const key =
            (change.field ?? 'condition')
                .toLowerCase()
                .replace(/[^a-z0-9 _-]/g, '')
                .trim() || 'condition';
        const problem = checkFactText(change.value);
        if (problem) return reject(problem);
        const before = place.state?.[key] ?? '';
        if (before === change.value.trim()) return reject({ code: 'noChange' });
        const payload: RevisionPayload = {
            ...this.base(change, entity, true),
            entityName: place.name,
            field: key,
            op: 'place',
            placeId: place.id,
            key,
            before,
        };
        const params = { name: place.name, key, value: payload.value };
        return this.planned(payload, this.t('m8.card.place.title', params), this.t('m8.card.place.body', params), [
            { target: TARGETS.place, ref: { placeId: place.id, key }, before, after: payload.value },
        ]);
    }

    /* ---------------------------------------------------------------- apply and validate */

    /** Applies a payload from its own value (an edited card brings the user's text): same checks, fresh data. */
    async apply(payload: RevisionPayload): Promise<void> {
        const value = payload.value.trim();
        switch (payload.op) {
            case 'fact': {
                const problem = checkFactText(value);
                if (problem)
                    throw new RouteError(this.t(`m8.reject.${problem.code}`, { detail: problem.detail ?? '' }));
                const current = await this.destContent(payload.dest);
                if (current === null) throw new RouteError(this.t('m8.error.gone'));
                const next = insertFact(current, value, payload.replace);
                if (next) await this.writeContent(payload.dest, next.content, payload.sourceMessage);
                return;
            }
            case 'tags': {
                const added = parseTagList(value);
                if (added.junk || !added.tags.length)
                    throw new RouteError(this.t('m8.reject.malformed', { detail: value }));
                const invalid = await this.validateTags(added.tags);
                if (invalid) {
                    throw new RouteError(this.t(`m8.reject.${invalid.code}`, { detail: invalid.detail ?? '' }));
                }
                const current = await this.sources.effective(payload.world, payload.uid);
                const result = applyTagChange(current.content, payload.remove, added.tags);
                if (!result.ok) {
                    if (result.rejection.code === 'noChange') return;
                    throw new RouteError(
                        this.t(`m8.reject.${result.rejection.code}`, { detail: result.rejection.detail ?? '' }),
                    );
                }
                await this.putOverride(payload.world, payload.uid, { content: result.content }, payload.sourceMessage);
                this.rescanCk();
                return;
            }
            case 'passport': {
                const tags = checkPassportTags(value);
                if (!tags.ok) {
                    throw new RouteError(
                        this.t(`m8.reject.${tags.rejection.code}`, { detail: tags.rejection.detail ?? '' }),
                    );
                }
                await this.savePassportSlot(payload.id, payload.owner, payload.slot, tags.tags);
                return;
            }
            case 'alias': {
                const problem = checkAlias(value);
                if (problem)
                    throw new RouteError(this.t(`m8.reject.${problem.code}`, { detail: problem.detail ?? '' }));
                const world = this.sources.world();
                if (!world) throw new RouteError(this.t('m8.error.noWorld'));
                await world.setChatAlias(value, payload.entityId);
                if (payload.keys) {
                    const current = await this.destKeys(payload.keys.dest);
                    const merged = current ? mergeKeys(current, await this.aliasKeys(value)) : null;
                    if (merged && !invalidKeys(merged).length) await this.writeKeys(payload.keys.dest, merged);
                }
                return;
            }
            case 'note':
                this.app.ui.notice(payload.text, { level: 'info' });
                return;
            case 'event':
                await this.app.bus.emit('signal', {
                    kind: 'memory.important',
                    chatId: this.app.host.chatId(),
                    messageIndex: payload.sourceMessage,
                    entity: payload.entityName,
                    data: { messageIndex: payload.sourceMessage, reason: value, source: 'revision' },
                    at: Date.now(),
                });
                return;
            case 'place': {
                const places = this.sources.places();
                const place = places?.get(payload.placeId);
                if (!places || !place) throw new RouteError(this.t('m8.error.gone'));
                const problem = checkFactText(value);
                if (problem)
                    throw new RouteError(this.t(`m8.reject.${problem.code}`, { detail: problem.detail ?? '' }));
                await places.update(place.id, { state: { ...(place.state ?? {}), [payload.key]: value } });
                return;
            }
        }
    }

    /** "Before" still matches the live data (plan §4.6). */
    async stillValid(payload: RevisionPayload): Promise<boolean> {
        try {
            switch (payload.op) {
                case 'fact': {
                    if (payload.dest.kind === 'addition')
                        return (await this.additionItem(payload.dest.comment)) === undefined;
                    return (await this.destContent(payload.dest)) === payload.before;
                }
                case 'tags': {
                    const current = await this.sources.effective(payload.world, payload.uid);
                    return !!current.entry && !current.protected && current.content === payload.before;
                }
                case 'passport': {
                    const passport = this.sources.naiApi()?.getPassport(payload.id);
                    return !!passport && (passport.slots[payload.slot] ?? '') === payload.before;
                }
                case 'alias': {
                    const world = this.sources.world();
                    if (!world) return false;
                    const mapped = world.chatAliases()[payload.value.trim()];
                    if (mapped && mapped !== payload.entityId) return false;
                    if (!payload.keys) return true;
                    const keys = await this.destKeys(payload.keys.dest);
                    return !!keys && sameList(keys, payload.keys.before);
                }
                case 'place': {
                    const place = this.sources.places()?.get(payload.placeId);
                    return !!place && (place.state?.[payload.key] ?? '') === payload.before;
                }
                default:
                    return true;
            }
        } catch (error) {
            this.log.debug('revision proposal check failed', error);
            return false;
        }
    }

    /* ---------------------------------------------------------------- undo */

    private async undoCanon(change: JournalChange): Promise<boolean> {
        const canon = this.sources.canon();
        if (!canon) return false;
        const before = typeof change.before === 'string' ? change.before : '';
        const ref = change.ref;
        if (typeof ref.itemUid === 'number') {
            await this.putItem(ref.itemUid, { content: before });
            return true;
        }
        if (typeof ref.addition === 'string') {
            const item = await this.additionItem(ref.addition);
            if (item) await canon.remove(item.uid);
            return true;
        }
        const world = ref.world;
        const uid = Number(ref.uid);
        if (typeof world !== 'string' || !Number.isFinite(uid)) return false;
        const override = this.sources.overrideOf(await this.sources.canonItems(), world, uid);
        if (!override) return true;
        const fields = override.meta.fields ?? DEFAULT_OVERRIDE_FIELDS;
        if (ref.created === true && fields.length === 1 && fields[0] === 'content') {
            await canon.remove(override.uid);
            return true;
        }
        await this.putOverride(world, uid, { content: before });
        if (change.target === TARGETS.ck) this.rescanCk();
        return true;
    }

    private async undoKeys(change: JournalChange): Promise<boolean> {
        const before = strings(change.before);
        const ref = change.ref;
        if (typeof ref.itemUid === 'number') {
            await this.putItem(ref.itemUid, { key: before });
            return true;
        }
        const world = ref.world;
        const uid = Number(ref.uid);
        if (typeof world !== 'string' || !Number.isFinite(uid)) return false;
        await this.putOverride(world, uid, { key: before });
        return true;
    }

    private async undoPassport(change: JournalChange): Promise<boolean> {
        const id = change.ref.id;
        const slot = change.ref.slot;
        if (typeof id !== 'string' || typeof slot !== 'string' || !this.sources.naiApi()) return false;
        const owner = isDict(change.ref.owner) ? (change.ref.owner as NaiPassportTarget) : null;
        await this.savePassportSlot(id, owner, slot, typeof change.before === 'string' ? change.before : '');
        return true;
    }

    private async undoAlias(change: JournalChange): Promise<boolean> {
        const world = this.sources.world();
        const alias = change.ref.alias;
        if (!world || typeof alias !== 'string') return false;
        await world.setChatAlias(alias, null);
        return true;
    }

    private async undoPlace(change: JournalChange): Promise<boolean> {
        const places = this.sources.places();
        const id = change.ref.placeId;
        const key = change.ref.key;
        if (!places || typeof id !== 'string' || typeof key !== 'string') return false;
        const place = places.get(id);
        if (!place) return false;
        const state = { ...(place.state ?? {}) };
        const before = typeof change.before === 'string' ? change.before : '';
        if (before) state[key] = before;
        else delete state[key];
        await places.update(id, { state });
        return true;
    }
}
