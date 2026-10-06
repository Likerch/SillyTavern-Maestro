// World model (M7, plan §4.2): one entity per person, place or thing, assembled from every store of the stack and
// glued by identity resolution (DES aliases, the chat alias map, DES-RU case forms, NAI passport aliases, entry
// keys). Read model only: the facts stay in their owners (plan §2.1); the model keeps pointers to them.
// Exposed as app.modules.api<WorldModelApi>('world'). Consumers: dossier (M7), places (M24), relations (M19),
// revision and living canon (stage 4).
import type { Unsubscribe } from '../../shared/contracts';

export type EntityKind =
    | 'character'
    | 'persona'
    | 'place'
    | 'item'
    | 'faction'
    | 'event'
    | 'tradition'
    | 'promise'
    | 'secret'
    | 'quest'
    | 'mechanic';

export type SourceKind =
    | 'card'
    | 'persona'
    | 'des.character'
    | 'des.alias'
    | 'chat.alias'
    | 'lore.entry'
    | 'canon.entry'
    | 'ck.archive'
    | 'nai.passport'
    | 'qvink.memory'
    | 'place'
    | 'des.workshop';

/** Where a source lives (plan-2 §9): this chat, the chat's card, or every chat (global stores, other stories). */
export type SourceScope = 'chat' | 'card' | 'global';

/** Where something about an entity lives; enough to open it (book + uid, passport id, message index). */
export interface EntitySource {
    kind: SourceKind;
    /** Stable reference inside the source: `${world}#${uid}`, passport id, message index, place id, card avatar. */
    ref: string;
    label: string;
    world?: string;
    uid?: number;
    messageIndex?: number;
    passportId?: string;
    /** Avatar file of the character card that owns the source (passports, card books). */
    avatar?: string;
    // Additions of plan-2 §9 (optional so that fakes of the stage-3 contract stay valid).
    /** Where the data lives; missing: this chat. */
    scope?: SourceScope;
    /** Stable key of the chat's identity decisions (`lore:<book>#<uid>`, `ck:<book>#<name>`, `nai:<owner>#<id>`, `des:<name>`). */
    key?: string;
}

/** What the chat decided (or not yet) about the card/global sources answering to an entity's name (plan-2 §9). */
export interface EntityIdentity {
    /** The name is the card's own: the card or a group member, the persona, or used by the card's text or book. */
    ofCard: boolean;
    /** Card or global sources used for this entity: the card's own, or bound with «Тот же». */
    shared: EntitySource[];
    /** A namesake's sources waiting for the user's answer: not used until then. */
    pending: EntitySource[];
    /** Sources declared another one's in this chat («Другой»): never used here. */
    apart: EntitySource[];
}

export interface Entity {
    /** `${kind}:${normalised canonical name}`; places use their registry id (`place:<id>`). */
    id: string;
    kind: EntityKind;
    /** Canonical name: DES canonical when known, else the card / entry / passport name. */
    name: string;
    /** Every other known name (DES aliases, chat aliases, passport aliases, entry keys that look like names). */
    aliases: string[];
    /** Russian case forms of the name and aliases (DES-RU), for matching Russian text. */
    forms: string[];
    sources: EntitySource[];
    /** Present in the current scene (DES tracker of the last assistant message). */
    present?: boolean;
}

export type FactStatus = 'provisional' | 'active' | 'stale' | 'disputed';

/** A statement about an entity (stage 4 fills it from revision; stage 3 only from structured sources). */
export interface Fact {
    entity: string;
    text: string;
    source: EntitySource;
    /** In-story time from DES (date/time) when known. */
    storyTime?: string;
    messageIndex?: number;
    confidence: number;
    status: FactStatus;
}

/** Two entities that may be one person/place; resolved by the user in the Inbox (kind 'world.merge'). */
export interface MergeCandidate {
    a: string;
    b: string;
    reason: string;
    /** 0..1 */
    score: number;
    // Addition of the M7 implementation (optional so that fakes of the stage-3 contract stay valid).
    /** The name both entities answer to (reasons 'sharedName', 'sharedAlias', 'firstName', 'anchors'). */
    name?: string;
}

export interface WorldModelApi {
    entities(kind?: EntityKind): Entity[];
    get(id: string): Entity | undefined;
    /** Identity resolution: any name, alias or Russian case form → the entity (exact normalised match only). */
    resolve(name: string, kind?: EntityKind): Entity | undefined;
    /** Entities whose names or forms occur in a text (left Cyrillic boundary, case-insensitive). */
    mentions(text: string): Entity[];
    facts(id: string): Fact[];
    /** Rebuilds from all sources (cheap parts on every turn, lorebooks lazily). */
    rebuild(): Promise<void>;
    /** Chat-only nicknames (plan §2.1: chat alias map, a Maestro file per chat): alias → entity id. */
    chatAliases(): Record<string, string>;
    setChatAlias(alias: string, entityId: string | null): Promise<void>;
    /** Declares two entities to be one (writes a chat alias; DES canonical aliases only through DES, with consent). */
    merge(keepId: string, mergeId: string): Promise<void>;
    /** Declares two entities different (stops proposing the merge). */
    separate(aId: string, bId: string): Promise<void>;
    mergeCandidates(): MergeCandidate[];
    onChange(listener: () => void): Unsubscribe;
    // Additions of plan-2 §9 (optional so that fakes of the stage-3 contract stay valid).
    /** Card/global sources of the entity's name: used here, waiting for an answer, declared another one's. */
    identity?(entityId: string): EntityIdentity | undefined;
    /** «Это тот же»: these keys (every waiting and declared-another one when omitted) join the entity; journaled. */
    sameAs?(entityId: string, keys?: string[]): Promise<void>;
    /** «Это другой персонаж»: these card/global sources (all shared and waiting ones when omitted) leave; journaled. */
    different?(entityId: string, keys?: string[]): Promise<void>;
    /** Binds sources Maestro made for this chat («Оформить» wrote an archive): no question, no journal record. */
    bindSources?(entityId: string, keys: string[]): Promise<void>;
    /** `${book}#${uid}` of lore entries and archives not used in this chat (a namesake's: waiting or declared). */
    foreignRefs?(): string[];
}
