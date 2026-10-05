// Dossier actions (M7 п. 4–5, plan §8): fixes of structural findings and «Разнести» (one edit proposed to every
// store). Each change is a proposal through app.autonomy (Inbox by default), applied by its owner's rules:
// - lorebook entries change through a chat-canon override (P2); only without the canon module a key fix may patch the
//   base book (kind 'dossier.fixFile', never «auto», plan §8);
// - BunnyMo core and pack books are refused at planning and again right before the write (P13);
// - NAI passports only through NAI Studio's API (chat level), places through the place registry, chat nicknames
//   through the world model; DES aliases are DES's: the dossier only leaves an Inbox note.
// Inbox cards outlive the page: appliers re-run the stored payloads; undo handlers revert by target.
import { uniqueStrings } from '../../domain/canon-keys';
import { commitPatches } from '../../domain/doctor-fixes';
import type { BookIo } from '../../domain/doctor-fixes';
import { normName } from '../../domain/dossier-names';
import type { NaiPassport, NaiPassportTarget } from '../../adapters/nai';
import type { App, Decision, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { CanonApi, CanonItem, CanonMeta } from '../canon/api';
import type { EntitySource } from '../world/api';
import type { DossierFinding, SpreadEdit } from './api';
import { bookIo } from './book-io';
import { DOSSIER_ID } from './settings';
import type { DossierSources } from './sources';

export const FIX_KIND = 'dossier.fix';
export const FIX_FILE_KIND = 'dossier.fixFile';
export const SPREAD_KIND = 'dossier.spread';
export const NOTE_KIND = 'dossier.note';
export const ENTRY_TARGET = 'dossier-entry';
export const CANON_TARGET = 'dossier-canon';
export const PASSPORT_TARGET = 'dossier-passport';
export const PLACE_TARGET = 'dossier-place';
export const ALIAS_TARGET = 'dossier-chat-alias';
export const NOTE_TARGET = 'dossier-note';

/** The canon's default override fields (M6 store DEFAULT_OVERRIDE_FIELDS). */
const DEFAULT_OVERRIDE_FIELDS = ['content', 'key', 'keysecondary', 'comment'];

type EntryFields = { key?: string[]; content?: string };

/** Passport fields «Разнести» changes: aliases replace, slots merge. */
export interface PassportPatch {
    aliases?: string[];
    slots?: Record<string, string>;
}

/** The passport with a patch applied (a copy). */
export function patchPassport(passport: NaiPassport, patch: PassportPatch): NaiPassport {
    const next: NaiPassport = { ...passport, aliases: [...passport.aliases], slots: { ...passport.slots } };
    if (patch.aliases) next.aliases = [...patch.aliases];
    if (patch.slots) Object.assign(next.slots, patch.slots);
    return next;
}

/** What a finding's fix asks for (stored on the finding; planned against fresh data when pressed). */
export type FixRequest =
    | { op: 'addKeys'; world: string; uid: number; keys: string[] }
    | { op: 'placeEntry'; placeId: string }
    | { op: 'desAlias'; canonical: string; alias: string };

export type ActionPayload =
    | { op: 'baseKeys'; world: string; uid: number; before: string[]; after: string[] }
    | { op: 'canonOverride'; world: string; uid: number; fields: EntryFields; before: EntryFields; created: boolean }
    | { op: 'canonItem'; uid: number; fields: EntryFields; before: EntryFields }
    | { op: 'passport'; id: string; target: NaiPassportTarget | null; patch: PassportPatch; before: PassportPatch }
    | {
          op: 'place';
          placeId: string;
          patch: { name?: string; aliases?: string[] };
          before: { name?: string; aliases?: string[] };
      }
    | { op: 'placeEntry'; placeId: string }
    | { op: 'chatAlias'; alias: string; entityId: string }
    | { op: 'note'; text: string };

export class ProtectedBookError extends Error {}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** The passport holds exactly the patch's values. */
function passportHas(passport: NaiPassport, patch: PassportPatch): boolean {
    if (patch.aliases && !sameList(passport.aliases, patch.aliases)) return false;
    return Object.entries(patch.slots ?? {}).every(([slot, value]) => (passport.slots[slot] ?? '') === value);
}

function isPayload(value: unknown): value is ActionPayload {
    return isDict(value) && typeof value.op === 'string';
}

export function isFixRequest(value: unknown): value is FixRequest {
    if (!isDict(value)) return false;
    if (value.op === 'addKeys') {
        return typeof value.world === 'string' && typeof value.uid === 'number' && Array.isArray(value.keys);
    }
    if (value.op === 'placeEntry') return typeof value.placeId === 'string';
    if (value.op === 'desAlias') return typeof value.canonical === 'string' && typeof value.alias === 'string';
    return false;
}

/** Labels written into English canon content by «Разнести» (canon entries are English, P6). */
const CONTENT_LABEL: Record<string, string> = {
    appearance: 'Appearance',
    relationship: 'Relationship',
    custom: 'Note',
};

export class DossierActions {
    private readonly t: App['i18n']['t'];

    constructor(
        private readonly app: App,
        private readonly sources: DossierSources,
        private readonly log: Logger,
    ) {
        this.t = app.i18n.t.bind(app.i18n);
    }

    /** Undo handlers (permanent, like every journal target) and Inbox appliers (owned by the module). */
    install(): Unsubscribe[] {
        const journal = this.app.journal;
        journal.registerUndo(ENTRY_TARGET, (change) => this.undoEntry(change));
        journal.registerUndo(CANON_TARGET, (change) => this.undoCanon(change));
        journal.registerUndo(PASSPORT_TARGET, (change) => this.undoPassport(change));
        journal.registerUndo(PLACE_TARGET, (change) => this.undoPlace(change));
        journal.registerUndo(ALIAS_TARGET, (change) => this.undoAlias(change));
        // A note changed nothing: undoing it has nothing to revert.
        journal.registerUndo(NOTE_TARGET, async () => true);
        // Base books never become «auto» (plan §8); notes are never applied automatically either.
        this.app.autonomy.neverAuto(FIX_FILE_KIND);
        this.app.autonomy.neverAuto(NOTE_KIND);
        const applier = async (payload: unknown) => {
            if (!isPayload(payload)) throw new Error('bad dossier card');
            await this.apply(payload);
        };
        const valid = async (payload: unknown) => isPayload(payload) && (await this.stillValid(payload));
        return [FIX_KIND, FIX_FILE_KIND, SPREAD_KIND, NOTE_KIND].map((kind) =>
            this.app.inbox.registerApplier(kind, applier, valid),
        );
    }

    /* ---------------------------------------------------------------- io */

    private canon(): CanonApi | undefined {
        return this.sources.canon();
    }

    private io(): BookIo | null {
        return bookIo(this.app, this.log);
    }

    private async canonItems(): Promise<CanonItem[]> {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId()) return [];
        try {
            return await canon.list();
        } catch (error) {
            this.log.debug('canon list failed', error);
            return [];
        }
    }

    private overrideOf(items: readonly CanonItem[], world: string, uid: number): CanonItem | undefined {
        return items.find(
            (item) => item.meta.kind === 'override' && item.meta.base?.world === world && item.meta.base.uid === uid,
        );
    }

    /** Effective key and content of a base entry (the override's fields when it overrides them). */
    private async effective(
        world: string,
        uid: number,
    ): Promise<{ base: Dict | null; fields: EntryFields; override?: CanonItem; protected: boolean }> {
        const state = await this.sources.bookState(world);
        const base = state.data?.entries[String(uid)];
        const entry = isDict(base) ? base : null;
        const fields: EntryFields = { key: strings(entry?.key), content: str(entry?.content) };
        const override = this.overrideOf(await this.canonItems(), world, uid);
        if (override) {
            const overridden = override.meta.fields ?? DEFAULT_OVERRIDE_FIELDS;
            if (overridden.includes('key')) fields.key = strings(override.entry.key);
            if (overridden.includes('content')) fields.content = str(override.entry.content);
        }
        const result: { base: Dict | null; fields: EntryFields; override?: CanonItem; protected: boolean } = {
            base: entry,
            fields,
            protected: state.protected,
        };
        if (override) result.override = override;
        return result;
    }

    /* ---------------------------------------------------------------- apply */

    async apply(payload: ActionPayload): Promise<void> {
        switch (payload.op) {
            case 'baseKeys': {
                const io = this.io();
                if (!io) throw new Error(this.t('m7.error.noWorldInfo'));
                const result = await commitPatches(
                    io,
                    payload.world,
                    [{ uid: payload.uid, before: { key: payload.before }, after: { key: payload.after } }],
                    { guard: (data) => !this.sources.isProtected(payload.world, data) },
                );
                if (result.reason === 'protected')
                    throw new ProtectedBookError(this.t('m7.p13', { book: payload.world }));
                if (!result.ok) throw new Error(this.t('m7.error.stale', { book: payload.world }));
                return;
            }
            case 'canonOverride':
                await this.putOverride(payload.world, payload.uid, payload.fields);
                return;
            case 'canonItem':
                await this.putItem(payload.uid, payload.fields);
                return;
            case 'passport':
                await this.savePassport(payload.id, payload.target, payload.patch);
                return;
            case 'place': {
                const places = this.sources.places();
                if (!places) throw new Error(this.t('m7.error.noPlaces'));
                await places.update(payload.placeId, payload.patch);
                return;
            }
            case 'placeEntry': {
                const places = this.sources.places();
                if (!places) throw new Error(this.t('m7.error.noPlaces'));
                await places.ensureEntry(payload.placeId);
                return;
            }
            case 'chatAlias': {
                const world = this.sources.world();
                if (!world) throw new Error(this.t('m7.error.noWorld'));
                await world.setChatAlias(payload.alias, payload.entityId);
                return;
            }
            case 'note':
                this.app.ui.notice(payload.text, { level: 'info' });
                return;
        }
    }

    /** Writes a passport change for this chat only, through NAI Studio's API (it merges and keeps ids). */
    private async savePassport(id: string, target: NaiPassportTarget | null, patch: PassportPatch): Promise<void> {
        const api = this.sources.naiApi();
        if (!api) throw new Error(this.t('m7.error.noNaiApi'));
        const current = api.getPassport(id);
        if (!current) throw new Error(this.t('m7.error.gone'));
        await api.savePassport(patchPassport(current, patch), 'chat', target ?? undefined);
    }

    private async putOverride(world: string, uid: number, fields: EntryFields): Promise<void> {
        const canon = this.canon();
        if (!canon) throw new Error(this.t('m7.error.noCanon'));
        const state = await this.sources.bookState(world);
        if (state.protected) throw new ProtectedBookError(this.t('m7.p13', { book: world }));
        const existing = this.overrideOf(await this.canonItems(), world, uid);
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
        await canon.put({
            entry: { ...fields },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'user',
                base: { world, uid, contentHash: '' },
                fields: changed,
            },
        });
    }

    private async putItem(uid: number, fields: EntryFields): Promise<void> {
        const canon = this.canon();
        if (!canon) throw new Error(this.t('m7.error.noCanon'));
        const item = (await this.canonItems()).find((candidate) => candidate.uid === uid);
        if (!item) throw new Error(this.t('m7.error.gone'));
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

    /** "Before" still matches the live data (plan §4.6). */
    async stillValid(payload: ActionPayload): Promise<boolean> {
        try {
            switch (payload.op) {
                case 'baseKeys': {
                    const state = await this.sources.bookState(payload.world);
                    const entry = state.data?.entries[String(payload.uid)];
                    return !state.protected && isDict(entry) && sameList(strings(entry.key), payload.before);
                }
                case 'canonOverride': {
                    const current = await this.effective(payload.world, payload.uid);
                    if (current.protected || !current.base) return false;
                    if (payload.before.key && !sameList(current.fields.key, payload.before.key)) return false;
                    return payload.before.content === undefined || current.fields.content === payload.before.content;
                }
                case 'canonItem': {
                    const item = (await this.canonItems()).find((candidate) => candidate.uid === payload.uid);
                    if (!item) return false;
                    if (payload.before.key && !sameList(strings(item.entry.key), payload.before.key)) return false;
                    return payload.before.content === undefined || str(item.entry.content) === payload.before.content;
                }
                case 'passport': {
                    const current = this.sources.naiApi()?.getPassport(payload.id);
                    return !!current && passportHas(current, payload.before);
                }
                case 'place':
                    return !!this.sources.places()?.get(payload.placeId);
                case 'placeEntry': {
                    const place = this.sources.places()?.get(payload.placeId);
                    return !!place && !place.entry;
                }
                default:
                    return true;
            }
        } catch (error) {
            this.log.debug('dossier proposal check failed', error);
            return false;
        }
    }

    /* ---------------------------------------------------------------- undo */

    private async undoEntry(change: JournalChange): Promise<boolean> {
        const world = change.ref.world;
        const uid = Number(change.ref.uid);
        const io = this.io();
        if (
            typeof world !== 'string' ||
            !Number.isFinite(uid) ||
            !io ||
            !isDict(change.before) ||
            !isDict(change.after)
        ) {
            return false;
        }
        const result = await commitPatches(io, world, [{ uid, before: change.before, after: change.after }], {
            direction: 'revert',
            guard: (data) => !this.sources.isProtected(world, data),
        });
        return result.ok;
    }

    private async undoCanon(change: JournalChange): Promise<boolean> {
        const canon = this.canon();
        const ref = change.ref;
        if (!canon || !isDict(change.before)) return false;
        const before = change.before as EntryFields;
        if (typeof ref.itemUid === 'number') {
            await this.putItem(ref.itemUid, before);
            return true;
        }
        const world = ref.world;
        const uid = Number(ref.uid);
        if (typeof world !== 'string' || !Number.isFinite(uid)) return false;
        const existing = this.overrideOf(await this.canonItems(), world, uid);
        if (!existing) return true;
        if (ref.created === true) {
            await canon.remove(existing.uid);
            return true;
        }
        await this.putOverride(world, uid, before);
        return true;
    }

    private async undoPassport(change: JournalChange): Promise<boolean> {
        const id = change.ref.id;
        const target = change.ref.target;
        if (typeof id !== 'string' || !isDict(change.before) || !this.sources.naiApi()) return false;
        await this.savePassport(
            id,
            isDict(target) ? (target as NaiPassportTarget) : null,
            change.before as PassportPatch,
        );
        return true;
    }

    private async undoPlace(change: JournalChange): Promise<boolean> {
        const places = this.sources.places();
        const id = change.ref.placeId;
        if (!places || typeof id !== 'string' || !isDict(change.before) || !places.get(id)) return false;
        await places.update(id, change.before);
        return true;
    }

    private async undoAlias(change: JournalChange): Promise<boolean> {
        const world = this.sources.world();
        const alias = change.ref.alias;
        if (!world || typeof alias !== 'string') return false;
        await world.setChatAlias(alias, null);
        return true;
    }

    /* ---------------------------------------------------------------- proposals */

    private changesOf(payload: ActionPayload): JournalChange[] {
        switch (payload.op) {
            case 'baseKeys':
                return [
                    {
                        target: ENTRY_TARGET,
                        ref: { world: payload.world, uid: payload.uid },
                        before: { key: payload.before },
                        after: { key: payload.after },
                    },
                ];
            case 'canonOverride':
                return [
                    {
                        target: CANON_TARGET,
                        ref: { world: payload.world, uid: payload.uid, created: payload.created },
                        before: payload.before,
                        after: payload.fields,
                    },
                ];
            case 'canonItem':
                return [
                    {
                        target: CANON_TARGET,
                        ref: { itemUid: payload.uid },
                        before: payload.before,
                        after: payload.fields,
                    },
                ];
            case 'passport':
                return [
                    {
                        target: PASSPORT_TARGET,
                        ref: { id: payload.id, target: payload.target },
                        before: payload.before,
                        after: payload.patch,
                    },
                ];
            case 'place':
                return [
                    {
                        target: PLACE_TARGET,
                        ref: { placeId: payload.placeId },
                        before: payload.before,
                        after: payload.patch,
                    },
                ];
            case 'placeEntry':
                return [
                    { target: NOTE_TARGET, ref: { placeId: payload.placeId }, before: null, after: payload.placeId },
                ];
            case 'chatAlias':
                return [
                    {
                        target: ALIAS_TARGET,
                        ref: { alias: payload.alias },
                        before: null,
                        after: { alias: payload.alias, entity: payload.entityId },
                    },
                ];
            case 'note':
                return [{ target: NOTE_TARGET, ref: {}, before: null, after: payload.text }];
        }
    }

    private proposal(
        kind: string,
        title: string,
        description: string,
        payload: ActionPayload,
    ): Proposal<ActionPayload> {
        return {
            module: DOSSIER_ID,
            kind,
            title,
            description,
            changes: this.changesOf(payload),
            payload,
            apply: (value) => this.apply(value),
            stillValid: () => this.stillValid(payload),
        };
    }

    private async decide(kind: string, title: string, description: string, payload: ActionPayload): Promise<Decision> {
        return this.app.autonomy.decide<ActionPayload>(this.proposal(kind, title, description, payload), 'inbox');
    }

    /** DES owns aliases: an Inbox card that tells what to add in the DES Workshop (never applied by Maestro). */
    private async note(title: string, text: string): Promise<void> {
        await this.app.inbox.add(this.proposal(NOTE_KIND, title, text, { op: 'note', text }) as Proposal);
    }

    /* ---------------------------------------------------------------- fixes */

    /** Plans a finding's fix on fresh data and proposes it. 'skipped' when there is nothing left to change. */
    async fix(finding: DossierFinding): Promise<Decision> {
        const request = finding.fix?.payload;
        if (!isFixRequest(request)) return 'skipped';
        if (request.op === 'placeEntry') {
            const place = this.sources.places()?.get(request.placeId);
            if (!place || place.entry) return 'skipped';
            return this.decide(
                FIX_KIND,
                this.t('m7.fix.placeEntry.title', { name: place.name }),
                this.t('m7.fix.placeEntry.body', { name: place.name }),
                { op: 'placeEntry', placeId: place.id },
            );
        }
        if (request.op === 'desAlias') {
            await this.note(
                this.t('m7.note.alias.title', { alias: request.alias, name: request.canonical }),
                this.t('m7.note.alias.body', { alias: request.alias, name: request.canonical }),
            );
            return 'queued';
        }
        const current = await this.effective(request.world, request.uid);
        if (current.protected) throw new ProtectedBookError(this.t('m7.p13', { book: request.world }));
        if (!current.base) return 'skipped';
        const title = str(current.base.comment).trim() || `#${request.uid}`;
        const before = current.fields.key ?? [];
        const added = request.keys.filter((key) => !before.some((item) => normName(item) === normName(key)));
        if (!added.length) return 'skipped';
        const after = [...before, ...added];
        const params = { keys: added.join(', '), entry: title, book: request.world };
        if (this.canon() && this.app.host.chatId()) {
            return this.decide(FIX_KIND, this.t('m7.fix.keys.title', params), this.t('m7.fix.keys.canon', params), {
                op: 'canonOverride',
                world: request.world,
                uid: request.uid,
                fields: { key: after },
                before: { key: before },
                created: !current.override,
            });
        }
        return this.decide(FIX_FILE_KIND, this.t('m7.fix.keys.title', params), this.t('m7.fix.keys.file', params), {
            op: 'baseKeys',
            world: request.world,
            uid: request.uid,
            before: strings(current.base.key),
            after: [...strings(current.base.key), ...added],
        });
    }

    /* ---------------------------------------------------------------- spread */

    private textFields(field: SpreadEdit['field'], value: string, current: EntryFields): EntryFields | null {
        if (field === 'alias' || field === 'name') {
            const keys = current.key ?? [];
            if (keys.some((key) => normName(key) === normName(value))) return null;
            return { key: [...keys, value] };
        }
        if (field === 'description') return current.content === value ? null : { content: value };
        const line = `${CONTENT_LABEL[field] ?? 'Note'}: ${value}`;
        const content = current.content ?? '';
        if (content.includes(line)) return null;
        return { content: content.trim() ? `${content.trimEnd()}\n\n${line}` : line };
    }

    private beforeOf(fields: EntryFields, current: EntryFields): EntryFields {
        const before: EntryFields = {};
        if (fields.key) before.key = current.key ?? [];
        if (fields.content !== undefined) before.content = current.content ?? '';
        return before;
    }

    private async spreadLore(edit: SpreadEdit, world: string, uid: number, label: string): Promise<boolean> {
        if (!this.canon() || !this.app.host.chatId()) return false;
        const current = await this.effective(world, uid);
        if (current.protected) {
            this.log.info(`dossier: ${world} is a BunnyMo book; «spread» skips it (P13)`);
            return false;
        }
        if (!current.base) return false;
        const fields = this.textFields(edit.field, edit.value, current.fields);
        if (!fields) return false;
        const params = { entry: label, value: edit.value, field: this.t(`m7.spread.field.${edit.field}`) };
        await this.decide(SPREAD_KIND, this.t('m7.spread.lore.title', params), this.t('m7.spread.lore.body', params), {
            op: 'canonOverride',
            world,
            uid,
            fields,
            before: this.beforeOf(fields, current.fields),
            created: !current.override,
        });
        return true;
    }

    private async spreadCanon(edit: SpreadEdit, uid: number, label: string): Promise<boolean> {
        const item = (await this.canonItems()).find((candidate) => candidate.uid === uid);
        if (!item) return false;
        const base = item.meta.base;
        if (item.meta.kind === 'override' && base) return this.spreadLore(edit, base.world, base.uid, label);
        if (item.meta.kind !== 'addition') return false;
        const current: EntryFields = { key: strings(item.entry.key), content: str(item.entry.content) };
        const fields = this.textFields(edit.field, edit.value, current);
        if (!fields) return false;
        const params = { entry: label, value: edit.value, field: this.t(`m7.spread.field.${edit.field}`) };
        await this.decide(SPREAD_KIND, this.t('m7.spread.lore.title', params), this.t('m7.spread.canon.body', params), {
            op: 'canonItem',
            uid,
            fields,
            before: this.beforeOf(fields, current),
        });
        return true;
    }

    private async spreadPassport(edit: SpreadEdit, source: EntitySource): Promise<boolean> {
        const api = this.sources.naiApi();
        const id = source.passportId;
        if (!api || !id) return false;
        // The passport as this chat sees it (card + the chat's override): the new override is made against it.
        const passport = api.getPassport(id);
        if (!passport) return false;
        let patch: PassportPatch;
        let before: PassportPatch;
        if (edit.field === 'alias' || edit.field === 'name') {
            if (passport.aliases.some((alias) => normName(alias) === normName(edit.value))) return false;
            patch = { aliases: [...passport.aliases, edit.value] };
            before = { aliases: [...passport.aliases] };
        } else if (edit.field === 'appearance') {
            const body = passport.slots.body ?? '';
            patch = { slots: { body: body.trim() ? `${body.trim()}, ${edit.value}` : edit.value } };
            before = { slots: { body } };
        } else {
            return false;
        }
        const target: NaiPassportTarget | null = source.ref.startsWith('persona#')
            ? { persona: true }
            : source.avatar
              ? { avatar: source.avatar }
              : null;
        const params = { name: source.label, value: edit.value, field: this.t(`m7.spread.field.${edit.field}`) };
        await this.decide(SPREAD_KIND, this.t('m7.spread.nai.title', params), this.t('m7.spread.nai.body', params), {
            op: 'passport',
            id,
            target,
            patch,
            before,
        });
        return true;
    }

    private async spreadPlace(edit: SpreadEdit, placeId: string): Promise<boolean> {
        const place = this.sources.places()?.get(placeId);
        if (!place) return false;
        let payload: ActionPayload;
        if (edit.field === 'name') {
            if (place.name === edit.value) return false;
            payload = { op: 'place', placeId, patch: { name: edit.value }, before: { name: place.name } };
        } else if (edit.field === 'alias') {
            if (place.aliases.some((alias) => normName(alias) === normName(edit.value))) return false;
            payload = {
                op: 'place',
                placeId,
                patch: { aliases: [...place.aliases, edit.value] },
                before: { aliases: [...place.aliases] },
            };
        } else {
            return false;
        }
        const params = { name: place.name, value: edit.value, field: this.t(`m7.spread.field.${edit.field}`) };
        await this.decide(
            SPREAD_KIND,
            this.t('m7.spread.place.title', params),
            this.t('m7.spread.place.body', params),
            payload,
        );
        return true;
    }

    private async spreadDes(edit: SpreadEdit, source: EntitySource): Promise<boolean> {
        if (edit.field !== 'alias' && edit.field !== 'name' && edit.field !== 'relationship') return false;
        const name = source.ref || source.label;
        const params = { name, value: edit.value, alias: edit.value };
        if (edit.field === 'relationship') {
            await this.note(this.t('m7.note.relationship.title', params), this.t('m7.note.relationship.body', params));
        } else {
            await this.note(this.t('m7.note.alias.title', params), this.t('m7.note.alias.body', params));
        }
        return true;
    }

    private async spreadAlias(edit: SpreadEdit): Promise<boolean> {
        if (edit.field !== 'alias' || !this.sources.world()) return false;
        const params = { alias: edit.value, name: this.sources.entity(edit.entityId)?.name ?? edit.entityId };
        await this.decide(
            SPREAD_KIND,
            this.t('m7.spread.alias.title', params),
            this.t('m7.spread.alias.body', params),
            {
                op: 'chatAlias',
                alias: edit.value,
                entityId: edit.entityId,
            },
        );
        return true;
    }

    /** One proposal per target that can take this edit; returns how many were made. */
    async spread(edit: SpreadEdit): Promise<number> {
        const value = edit.value.trim();
        if (!value) return 0;
        const clean: SpreadEdit = { ...edit, value };
        let count = 0;
        const seen = new Set<string>();
        for (const target of edit.targets) {
            const id = `${target.kind}:${target.ref}`;
            if (seen.has(id)) continue;
            seen.add(id);
            let made = false;
            try {
                switch (target.kind) {
                    case 'lore.entry':
                        if (target.world && typeof target.uid === 'number') {
                            made = await this.spreadLore(clean, target.world, target.uid, target.label);
                        }
                        break;
                    case 'canon.entry':
                        if (typeof target.uid === 'number')
                            made = await this.spreadCanon(clean, target.uid, target.label);
                        break;
                    case 'nai.passport':
                        made = await this.spreadPassport(clean, target);
                        break;
                    case 'place':
                        made = await this.spreadPlace(clean, target.ref);
                        break;
                    case 'des.character':
                    case 'des.alias':
                        made = await this.spreadDes(clean, target);
                        break;
                    case 'chat.alias':
                        made = await this.spreadAlias(clean);
                        break;
                    default:
                        made = false;
                }
            } catch (error) {
                this.log.warn(`dossier: «spread» to ${id} failed`, error);
                made = false;
            }
            if (made) count++;
        }
        return count;
    }
}
