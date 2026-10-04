// What a revision reads (plan M8 «Анализ»): the committed messages without service noise, Qvink memories of the
// range, the signals, the entities involved with compact dossiers (world model + dossier API, or the stores directly),
// the BunnyMo tag vocabulary; and the live state of the stores the routes write (lorebook entries with the chat canon
// on top, NAI passports, places). Every reader degrades: a module or neighbour that is off gives nothing.
import { adaptersOf } from '../../adapters';
import type { NaiStudioApi } from '../../adapters/nai';
import { isCharacterArchive } from '../../domain/bunnymo';
import { isBookData, isBunnyMoBook } from '../../domain/doctor-fixes';
import type { BookData } from '../../domain/doctor-fixes';
import { normName } from '../../domain/dossier-names';
import { REVISION_SLOTS, sheetTags } from '../../domain/revision-checks';
import type { EntityBrief, PromptMemory, PromptMessage } from '../../domain/revision-prompt';
import { cleanExcerptText } from '../../domain/sheet-context';
import { looksLikeSheet } from '../../domain/sheet-reply';
import { detectSheetCommand } from '../../domain/sheets';
import type { App, Logger, Signal } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { CanonApi, CanonItem } from '../canon/api';
import type { ContradictionsApi } from '../contradictions/api';
import type { DossierApi } from '../dossier/api';
import type { LivingCanonApi } from '../livingCanon/api';
import type { PlacesApi } from '../places/api';
import type { SignalsApi } from '../signals/api';
import type { Entity, WorldModelApi } from '../world/api';

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

/** The canon's default override fields (M6 store DEFAULT_OVERRIDE_FIELDS). */
export const DEFAULT_OVERRIDE_FIELDS = ['content', 'key', 'keysecondary', 'comment'];

/** Entities a run describes to the model at most. */
export const MAX_ENTITIES = 8;
const MAX_VOCABULARY_VALUES = 60;

/** A lorebook entry as the chat sees it: the base entry with the chat canon's override on top. */
export interface EffectiveEntry {
    entry: Dict | null;
    content: string;
    keys: string[];
    override?: CanonItem;
    /** BunnyMo core/pack book or a read-only role: never written (P13). */
    protected: boolean;
}

/** Living canon's intake (`propose`, optional in its contract): used when present, else a bus signal. */
export type LivingCanonIntake = LivingCanonApi;

export class RevisionSources {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /* ---------------------------------------------------------------- module APIs */

    world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }
    canon(): CanonApi | undefined {
        return this.app.modules.api<CanonApi>('canon');
    }
    dossier(): DossierApi | undefined {
        return this.app.modules.api<DossierApi>('dossier');
    }
    places(): PlacesApi | undefined {
        return this.app.modules.api<PlacesApi>('places');
    }
    signals(): SignalsApi | undefined {
        return this.app.modules.api<SignalsApi>('signals');
    }
    contradictions(): ContradictionsApi | undefined {
        return this.app.modules.api<ContradictionsApi>('contradictions');
    }
    bunnymo(): BunnyMoModeApi | undefined {
        return this.app.modules.api<BunnyMoModeApi>('bunnymoMode');
    }
    bookRoles(): BookRolesApi | undefined {
        return this.app.modules.api<BookRolesApi>('bookRoles');
    }
    livingCanon(): LivingCanonIntake | undefined {
        return this.app.modules.api<LivingCanonIntake>('livingCanon');
    }

    naiApi(): NaiStudioApi | undefined {
        try {
            return adaptersOf(this.app).nai.api();
        } catch {
            return undefined;
        }
    }

    /* ---------------------------------------------------------------- chat */

    chat(): STChatMessage[] {
        const chat = this.app.host.ctx().chat;
        return Array.isArray(chat) ? chat : [];
    }

    /**
     * Story messages of a range: no system messages (CK cards, notes), no sheet commands and sheet replies, no picture
     * posts; text without tracker JSON, folded blocks, HTML, CK dumps and image placeholders.
     */
    messages(from: number, to: number): PromptMessage[] {
        const chat = this.chat();
        const out: PromptMessage[] = [];
        for (let index = Math.max(0, from); index <= to && index < chat.length; index++) {
            const message = chat[index];
            if (!message || message.is_system) continue;
            const raw = str(message.mes);
            if (message.is_user ? detectSheetCommand(raw) : looksLikeSheet(raw)) continue;
            const text = cleanExcerptText(message);
            if (!text) continue;
            out.push({ index, name: str(message.name) || (message.is_user ? 'User' : 'Character'), text });
        }
        return out;
    }

    /** Qvink summaries of the range (the memory text only). */
    memories(from: number, to: number): PromptMemory[] {
        const out: PromptMemory[] = [];
        let qvink: ReturnType<typeof adaptersOf>['qvink'];
        try {
            qvink = adaptersOf(this.app).qvink;
            if (typeof qvink.memoryOf !== 'function' || (typeof qvink.present === 'function' && !qvink.present())) {
                return out;
            }
        } catch {
            return out;
        }
        for (let index = Math.max(0, from); index <= to; index++) {
            try {
                const memory = qvink.memoryOf(index);
                const text = memory?.memory.trim();
                if (text && !memory?.exclude) out.push({ index, text });
            } catch (error) {
                this.log.debug('Qvink memory is not readable', error);
                break;
            }
        }
        return out;
    }

    /* ---------------------------------------------------------------- lorebooks */

    async book(world: string): Promise<BookData | null> {
        const ctx = this.app.host.ctx();
        if (typeof ctx.loadWorldInfo !== 'function') return null;
        try {
            const data: unknown = await ctx.loadWorldInfo(world);
            return isBookData(data) ? data : null;
        } catch (error) {
            this.log.debug(`lorebook ${world} is not readable`, error);
            return null;
        }
    }

    isProtected(world: string, data: BookData | null): boolean {
        try {
            if (this.bookRoles()?.roleOf(world)?.readOnly) return true;
        } catch (error) {
            this.log.debug('book roles are not readable', error);
        }
        return data !== null && isBunnyMoBook(world, data);
    }

    async canonItems(): Promise<CanonItem[]> {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId()) return [];
        try {
            return await canon.list();
        } catch (error) {
            this.log.debug('canon list failed', error);
            return [];
        }
    }

    overrideOf(items: readonly CanonItem[], world: string, uid: number): CanonItem | undefined {
        return items.find(
            (item) => item.meta.kind === 'override' && item.meta.base?.world === world && item.meta.base.uid === uid,
        );
    }

    /** Content and keys of a base entry as the chat sees them (the override's fields when it overrides them). */
    async effective(world: string, uid: number): Promise<EffectiveEntry> {
        const data = await this.book(world);
        const raw = data?.entries[String(uid)];
        const entry = isDict(raw) ? raw : null;
        const result: EffectiveEntry = {
            entry,
            content: str(entry?.content),
            keys: strings(entry?.key),
            protected: this.isProtected(world, data),
        };
        const override = this.overrideOf(await this.canonItems(), world, uid);
        if (override) {
            const fields = override.meta.fields ?? DEFAULT_OVERRIDE_FIELDS;
            if (fields.includes('content')) result.content = str(override.entry.content);
            if (fields.includes('key')) result.keys = strings(override.entry.key);
            result.override = override;
        }
        return result;
    }

    /* ---------------------------------------------------------------- entities */

    /** An entity by a name as the model wrote it: the world model first, then the run's entities by name/alias/form. */
    resolve(name: string, known: readonly Entity[] = []): Entity | undefined {
        const world = this.world();
        try {
            const found = world?.resolve(name);
            if (found) return found;
        } catch (error) {
            this.log.debug('world model resolve failed', error);
        }
        const wanted = normName(name);
        return known.find((entity) =>
            [entity.name, ...entity.aliases, ...entity.forms].some((item) => normName(item) === wanted),
        );
    }

    /** Entities of a run: named in signals, present in the scene, mentioned in the messages (at most MAX_ENTITIES). */
    involved(signals: readonly Signal[], messages: readonly PromptMessage[]): Entity[] {
        const world = this.world();
        if (!world) return [];
        const found = new Map<string, Entity>();
        const add = (entity: Entity | undefined) => {
            if (entity && !found.has(entity.id)) found.set(entity.id, entity);
        };
        try {
            for (const signal of signals) {
                if (signal.entity) add(world.resolve(signal.entity) ?? world.get(signal.entity));
            }
            for (const entity of world.entities()) if (entity.present) add(entity);
            for (const entity of world.mentions(messages.map((message) => message.text).join('\n'))) add(entity);
        } catch (error) {
            this.log.debug('world model is not readable', error);
        }
        return [...found.values()].slice(0, MAX_ENTITIES);
    }

    /** Compact dossier of an entity for the prompt. */
    async brief(entity: Entity): Promise<EntityBrief> {
        const brief: EntityBrief = {
            name: entity.name,
            kind: entity.kind,
            aliases: [...new Set(entity.aliases.filter((alias) => alias && alias !== entity.name))].slice(0, 10),
            canon: [],
        };
        const dossier = this.dossier();
        if (dossier) {
            try {
                return this.briefFromDossier(brief, await dossier.build(entity.id));
            } catch (error) {
                this.log.debug(`dossier of ${entity.id} failed; reading the stores`, error);
            }
        }
        return this.briefFromStores(brief, entity);
    }

    private briefFromDossier(brief: EntityBrief, page: Awaited<ReturnType<DossierApi['build']>>): EntityBrief {
        const canon: string[] = [];
        const lore: string[] = [];
        for (const section of page.sections) {
            const text = section.text.trim();
            if (section.kind === 'canon' && text) canon.push(text);
            else if (section.kind === 'lore' && text) lore.push(text);
            else if (section.kind === 'tags' && text) brief.ckTags = text.split(/\s+/).filter(Boolean);
            else if (section.kind === 'nai' && section.fields) {
                const slots: Record<string, string> = {};
                for (const slot of REVISION_SLOTS) {
                    const value = section.fields[`slot.${slot}`];
                    if (value) slots[slot] = value;
                }
                if (Object.keys(slots).length && !brief.appearance) brief.appearance = slots;
            } else if (section.kind === 'place' && section.fields) {
                const state: Record<string, string> = {};
                for (const [key, value] of Object.entries(section.fields)) {
                    if (key.startsWith('state.')) state[key.slice(6)] = value;
                }
                if (Object.keys(state).length) brief.state = state;
            }
        }
        // The chat canon first: an override replaces the base text it is shown with.
        brief.canon = [...canon, ...lore];
        return brief;
    }

    private async briefFromStores(brief: EntityBrief, entity: Entity): Promise<EntityBrief> {
        for (const source of entity.sources) {
            try {
                if (
                    (source.kind === 'lore.entry' || source.kind === 'ck.archive') &&
                    source.world &&
                    source.uid !== undefined
                ) {
                    const entry = await this.effective(source.world, source.uid);
                    if (!entry.entry || !entry.content.trim()) continue;
                    if (source.kind === 'ck.archive' || isCharacterArchive(entry.entry)) {
                        const tags = sheetTags(entry.content);
                        if (tags.length) brief.ckTags = tags;
                    } else {
                        brief.canon.push(entry.content);
                    }
                } else if (source.kind === 'canon.entry' && source.uid !== undefined) {
                    const item = (await this.canonItems()).find((candidate) => candidate.uid === source.uid);
                    const text = str(item?.entry.content).trim();
                    if (text) brief.canon.unshift(text);
                } else if (source.kind === 'nai.passport' && source.passportId && !brief.appearance) {
                    const passport = this.naiApi()?.getPassport(source.passportId);
                    if (passport) {
                        const slots: Record<string, string> = {};
                        for (const slot of REVISION_SLOTS) if (passport.slots[slot]) slots[slot] = passport.slots[slot];
                        if (Object.keys(slots).length) brief.appearance = slots;
                    }
                } else if (source.kind === 'place') {
                    const state = this.places()?.get(source.ref)?.state;
                    if (state && Object.keys(state).length) brief.state = { ...state };
                }
            } catch (error) {
                this.log.debug(`source ${source.kind}:${source.ref} is not readable`, error);
            }
        }
        return brief;
    }

    /** Allowed CK tag values by category (pack entries that pull lore), for the prompt. */
    async vocabulary(): Promise<Record<string, string[]> | undefined> {
        const api = this.bunnymo();
        if (!api) return undefined;
        try {
            const dictionary = await api.dictionary();
            const out: Record<string, string[]> = {};
            for (const tag of dictionary.tags) {
                if (tag.value === null || !tag.entries.some((entry) => entry.kind === 'pull')) continue;
                const list = (out[tag.category] ??= []);
                if (list.length < MAX_VOCABULARY_VALUES && !list.includes(tag.value)) list.push(tag.value);
            }
            for (const list of Object.values(out)) list.sort();
            return out;
        } catch (error) {
            this.log.debug('BunnyMo dictionary is not available', error);
            return undefined;
        }
    }
}
