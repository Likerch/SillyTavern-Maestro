// Backgrounds (M29, stage 10): the chat background follows the place (M24). First a pick from ST's background
// library (by name, folder-tags, place state, time of day and weather from DES); when nothing fits, an offer to
// generate one in NAI Studio by a button (Anlas within the limit). The user's own background is never touched: ST
// does not tell a user-pinned background from a programmatic one, so Maestro remembers what it set itself and treats
// any other chat background as the user's. Chat background only — never the global one, never `/bg`.
// Exposed as app.modules.api<BackgroundsApi>('backgrounds').
import type { Unsubscribe } from '../../shared/contracts';

export interface BackgroundChoice {
    placeId: string;
    /** File name in ST's backgrounds library (or a generated file). */
    file: string;
    /** Variant tags matched: time of day, weather, state. */
    variant: string[];
    source: 'library' | 'generated' | 'user';
    score: number;
}

export interface BackgroundsApi {
    /** What Maestro set for the current chat (null: none, or the user's own background is on). */
    current(): BackgroundChoice | null;
    /** Best library candidates for a place now (top N). */
    candidates(placeId: string, limit?: number): Promise<BackgroundChoice[]>;
    /**
     * Binds a background to a place (the user's choice in the pult). Additions of the M29 implementation: `variant`
     * (time of day / weather / season tags, e.g. ['night'] or ['night', 'rain']) binds it as that variant
     * (place state `bg:<tags>`) instead of the main background.
     */
    bind(placeId: string, file: string, variant?: string[]): Promise<void>;
    /** Asks NAI Studio to generate one for the place (by the user's button). */
    generate(placeId: string): Promise<BackgroundChoice | null>;
    /** The user set their own background: Maestro stops changing it for this chat until released. */
    userPinned(): boolean;
    release(): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M29 implementation (optional so that fakes of the stage-10 contract stay valid).
    /** Removes the place's bound background (no variant) or one bound variant. */
    unbind?(placeId: string, variant?: string[]): Promise<void>;
    /** Sets a library file as the chat background now (the user's «Поставить»; kept while the scene stays there). */
    pick?(placeId: string, file: string): Promise<void>;
    /** Re-reads ST's background library (it is cached for the session). */
    refreshLibrary?(): Promise<void>;
}
