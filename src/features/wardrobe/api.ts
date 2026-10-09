// Wardrobe and states (M27, stage 10): outfits and states of characters and places persist and are drawn the same
// way. A new outfit in the DES tracker (repeated two committed turns) becomes a named outfit in the chat-level NAI
// passport; when it shows up again it is recognised and drawn the same. Character states (wet, wounded, tired …) and
// place states (ruined, decorated, on fire, night) become passport states / place passport tags. Writes go through
// NAI Studio's API at chat scope only (the card is never changed). Exposed as app.modules.api<WardrobeApi>('wardrobe').
import type { UndressKind } from '../../domain/wardrobe-wear';
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

/** «Что надето сейчас»: what one character of the chat (or the persona) wears now. */
export interface Wearing {
    /** Record key (for «Надеть другое» / «Это новый наряд»). */
    key: string;
    name: string;
    persona: boolean;
    /** NAI passport; '' when the character has none (the record is Maestro's only). */
    passportId: string;
    /** The clothing as the tracker (or the user) writes it. */
    wording: string;
    /** English NAI tags of it. */
    tags: string;
    /** 'naked' | 'towel' | 'underwear' | 'partial' | ''. */
    undress: string;
    /** The outfit it is ('' the own clothes), null while it is new. */
    outfit: string | null;
    /** The outfit proposed and waiting for the user. */
    queued?: string;
    /** Message where this clothing first showed. */
    since: number;
    /** Last committed message that said it, and how many committed turns in a row did. */
    seen: number;
    turns: number;
    present: boolean;
    /** 'field' | 'appearance' | 'model' | 'user' | 'revision' | 'player' | 'reply'. */
    source: string;
}

/** What «Переодеть сейчас» puts on: an outfit of the passport (by name, '' the own clothes), or clothes in words. */
export interface WearNowWhat {
    outfit?: string;
    wording?: string;
    /** Undressing (naked, towel, underwear, partial) when the words do not say it themselves. */
    undress?: UndressKind;
}

/** Who asked for it: by hand, the player's message, the narration of a reply, the background model. */
export type WearNowSource = 'user' | 'player' | 'reply' | 'model';

export interface WearNowOptions {
    /** Called inside a generation (the player's message): DES's prompt slot is rebuilt, its save is not waited for. */
    generating?: boolean;
    /** The message the journal record belongs to when it is not `messageIndex` (the model reading a player's change). */
    sourceMessage?: number;
    /** The message the line under it goes to when it is not `messageIndex`. */
    stripIndex?: number;
}

export interface WearNowResult {
    /** Who, as shown. */
    who: string;
    /** Record key. */
    key: string;
    /** The outfit put on ('' the own clothes), null when no passport outfit was put on. */
    outfit: string | null;
    wording: string;
    journalId: string | null;
    /** DES's tracker got the wording. */
    des: boolean;
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
    // Release 1.11 «что надето сейчас» (optional for the same reason).
    /** What everyone of the chat wears now (or one character / the persona by name): the scene first. */
    current?(character?: string): Wearing[];
    // «Переодеть сейчас» (optional for the same reason).
    /**
     * `who` ('persona' or a character's name) wears this now: the record, the passport (outfit and looks), the DES
     * portrait and tracker, the prompt line; one journal record undoes it.
     */
    wearNow?(
        who: string,
        what: WearNowWhat,
        source?: WearNowSource,
        messageIndex?: number,
        options?: WearNowOptions,
    ): Promise<WearNowResult | null>;
}
