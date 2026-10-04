// Places (M24, stage 3): the chat's place registry is the owner of a place's identity — id, name, aliases with
// case forms, nesting (city → district → building → room), history (plan §2.1). The description for the model is
// an entry of type 'place' (canon or a Maestro book); state and background come at stage 10, transitions at
// stage 8. NAI Studio continuity binds to the place id (§16). Exposed as app.modules.api<PlacesApi>('places').
import type { Unsubscribe } from '../../shared/contracts';

export interface PlaceVisit {
    /** First and last assistant message index of the stay; `to` null while it lasts. */
    from: number;
    to: number | null;
    /** Characters present (DES tracker), canonical names. */
    present: string[];
    storyDate?: string;
    /** Short notes: DES recent events, Qvink memories of the stay (stage 4 adds chronicle links). */
    events: string[];
}

export interface Place {
    id: string;
    name: string;
    aliases: string[];
    /** Russian case forms of the name and aliases. */
    forms: string[];
    parent: string | null;
    createdAt: number;
    /** Message index where the place was first seen. */
    firstSeen: number;
    lastSeen: number;
    visits: PlaceVisit[];
    /** The description entry (type 'place'): canon or a Maestro book. */
    entry?: { world: string; uid: number };
    /** NAI Studio location passport bound to this place. */
    passportId?: string;
    /** Stage 10: state (intact/ruined, night, season) and background. */
    state?: Record<string, string>;
    background?: string;
}

/** A DES location string not yet registered; becomes a place after two turns in a row (plan §4.4). */
export interface PlaceCandidate {
    label: string;
    seen: number[];
    /** Existing places that may be the same one (Inbox kind 'places.merge'). */
    similar: string[];
    // Additions of the M24 implementation (optional so that fakes of the stage-3 contract stay valid).
    /** Normalised name of the most specific unknown part: the candidate's identity. */
    key?: string;
    /** The future place's name (the most specific unknown part as DES wrote it). */
    name?: string;
    /** The most specific known place of the latest label (the future parent). */
    parent?: string | null;
    /** Already sent to the Inbox as a possible duplicate. */
    proposed?: boolean;
}

export interface PlacesApi {
    list(): Place[];
    get(id: string): Place | undefined;
    /** Current place (from the last committed DES location). */
    current(): Place | null;
    /** Name, alias or case form → place; also tries "District, City" splits against the nesting. */
    resolve(label: string): Place | undefined;
    candidates(): PlaceCandidate[];
    create(name: string, parent?: string | null): Promise<Place>;
    update(id: string, patch: Partial<Omit<Place, 'id' | 'visits'>>): Promise<void>;
    merge(keepId: string, mergeId: string): Promise<void>;
    remove(id: string): Promise<void>;
    /** Creates or opens the 'place' description entry (canon by default). */
    ensureEntry(id: string): Promise<{ world: string; uid: number }>;
    onChange(listener: () => void): Unsubscribe;
    /** Fires when the current place changes (after the turn is committed). */
    onEnter(listener: (place: Place | null, previous: Place | null) => void): Unsubscribe;
    // Additions of the M24 implementation (optional so that fakes of the stage-3 contract stay valid).
    /** Names from the top place down to this one («Порт-Ройал › Таверна › Зал»). */
    path?(id: string): string[];
    /** A candidate becomes a place now (with its unknown containers); current if DES still says so. */
    createCandidate?(key: string): Promise<Place>;
    /** A candidate is another name of a known place: its name becomes an alias. */
    mergeCandidate?(key: string, placeId: string): Promise<void>;
    /** «Not a place»: the candidate goes and its name is never collected again in this chat. */
    dismissCandidate?(key: string): Promise<void>;
}
