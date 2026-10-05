// Passports in lorebooks (M28, stage 10): a lore entry may have a visual passport in NAI Studio's format — in Maestro
// books inside the entry (`extensions.maestro.passport`), in base books in the Maestro registry (book roles sidecar,
// P2). Generated from the entry's content (NAI Studio's generator when its API offers one, else the cheap model with
// its schema). NAI Studio takes the passports of activated and mentioned entries of the scene (§16, through its scene
// provider / an API hook). Edited in the Lore Studio next to the entry text.
// Exposed as app.modules.api<LorePassportsApi>('lorePassports').
import type { Unsubscribe } from '../../shared/contracts';

export interface LorePassport {
    /** NAI Studio passport fields (kind, name, aliases, tags, slots, outfits, states, negative); unknown kept. */
    passport: Record<string, unknown>;
    /** Where it is stored. */
    storage: 'entry' | 'sidecar';
    /** Entry content hash it was made for (sidecar validity, P2). */
    contentHash?: string;
    generatedBy?: 'nai' | 'model' | 'user';
    updatedAt: number;
}

export interface LorePassportsApi {
    get(world: string, uid: number): Promise<LorePassport | null>;
    set(world: string, uid: number, passport: Record<string, unknown>, by?: LorePassport['generatedBy']): Promise<void>;
    remove(world: string, uid: number): Promise<void>;
    /** Generates a passport from the entry content (background task). */
    generate(world: string, uid: number): Promise<LorePassport | null>;
    /** Passports of the entries activated or mentioned in the last scan (what NAI Studio receives). */
    forScene(): { world: string; uid: number; name: string; passport: Record<string, unknown> }[];
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M28 implementation (optional so that fakes of the stage-10 contract stay valid).
    /** Where a passport of this book's entries is kept, or why it cannot have one (BunnyMo, no registry). */
    storageOf?(world: string): Promise<PassportPlace>;
    /** Generates without saving (the Lore Studio confirms a user-made passport itself, then calls set()). */
    propose?(world: string, uid: number): Promise<ProposedPassport | null>;
    /** Which generator generate() would use now, or why none can run. */
    generator?(): GeneratorState;
    /** What NAI Studio received last through the passport provider. */
    lastSent?(): ScenePassportsSent | null;
    /** NAI kind for the entry (its type, else the world model's entity, else its passport); null when unknown. */
    kindOf?(world: string, uid: number): Promise<string | null>;
}

export type PassportPlace = 'entry' | 'sidecar' | 'bunnymo' | 'noRegistry';

export interface ProposedPassport {
    passport: Record<string, unknown>;
    by: 'nai' | 'model';
}

export type GeneratorState =
    { kind: 'nai' | 'model' } | { kind: 'none'; reason: 'noChat' | 'notLeader' | 'noProfile' | 'cap' | 'groupChat' };

export interface ScenePassportsSent {
    at: number;
    messageIndex: number;
    passports: { world: string; uid: number; name: string; kind: string }[];
}
