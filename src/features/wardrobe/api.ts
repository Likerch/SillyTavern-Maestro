// Wardrobe and states (M27, stage 10): outfits and states of characters and places persist and are drawn the same
// way. A new outfit in the DES tracker (repeated two committed turns) becomes a named outfit in the chat-level NAI
// passport; when it shows up again it is recognised and drawn the same. Character states (wet, wounded, tired …) and
// place states (ruined, decorated, on fire, night) become passport states / place passport tags. Writes go through
// NAI Studio's API at chat scope only (the card is never changed). Exposed as app.modules.api<WardrobeApi>('wardrobe').
import type { Unsubscribe } from '../../shared/contracts';

export interface Outfit {
    /** Passport id in NAI Studio. */
    passportId: string;
    character: string;
    /** Short name as stored in the passport (English). */
    name: string;
    /** NAI tags of the outfit. */
    tags: string;
    /** DES wording it was recognised from (any language). */
    seenAs: string[];
    firstSeen: number;
    lastSeen: number;
    active: boolean;
}

export interface StateChange {
    kind: 'character' | 'place';
    subject: string;
    /** Passport state id (characters) or place state key. */
    state: string;
    enabled: boolean;
    messageIndex: number;
    at: number;
}

/** A revision statement about an outfit (M8 'deferred.outfit'): the model's English sentence and its quote. */
export interface OutfitIntake {
    /** Who wears it, as the model wrote it (resolved through the world model). */
    entityName: string;
    /** One English sentence («Anna now wears a black leather jacket and torn jeans.»). */
    value: string;
    /** Verbatim quote from the chat (Russian allowed). */
    evidence: string;
    sourceMessage: number;
}

export interface WardrobeApi {
    /** Outfits known for a character (the dossier's library), newest first. */
    outfits(character?: string): Outfit[];
    /** State changes applied recently (pult). */
    changes(limit?: number): StateChange[];
    /** Switch the active outfit by hand (chat scope). */
    wear(passportId: string, outfit: string): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M27 implementation (optional so that fakes of the contract stay valid).
    /**
     * The revision's direct route for 'deferred.outfit' (and the intake of its parked cards): the outfit is recognised
     * or created in the character's chat-level passport and put on (unless newer outfit news is known). Resolves to
     * the outfit name ('' = the clothing slot), null when nothing was taken (no passport, no recognisable garment,
     * a removal, the outfits part switched off or refused).
     */
    intakeOutfit?(statement: OutfitIntake): Promise<string | null>;
    /** State ids Maestro keeps on a place's location passport (night, rain, ruined …): backgrounds (M29), pult. */
    placeStates?(placeId: string): string[];
}
