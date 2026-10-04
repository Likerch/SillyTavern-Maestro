// Offscreen (M16, stage 9): the world lives while the user does not look. Every N turns (default 15; 10 in «Кино»,
// off in «Экономный») or at a scene end, a short background request for up to three important ABSENT NPCs: what
// they were doing, what changed — 1–3 sentences in story time. Results go to the chat canon (type 'event', origin
// 'offscreen'), so when a character returns the model knows where they were; sometimes a rumour for present
// characters. Never contradicts canon and quests; never kills or removes important characters without the Inbox.
// Exposed as app.modules.api<OffscreenApi>('offscreen').
import type { Unsubscribe } from '../../shared/contracts';

export interface OffscreenEvent {
    id: string;
    /** Canonical name (world model). */
    character: string;
    /** English, 1–3 sentences. */
    text: string;
    /** Story time from DES when the event was generated. */
    storyTime?: string;
    /** Committed message index the event was generated after. */
    messageIndex: number;
    /** Canon item uid once saved. */
    canonUid?: number;
    /** A rumour line present characters may mention (English), optional. */
    rumour?: string;
    status: 'saved' | 'inbox' | 'rejected';
    at: number;
    // Additions of the M16 implementation (optional so that fakes of the stage-9 contract stay valid).
    /** Where the character is now, when the event moved them. */
    location?: string;
    /** The event kills, imprisons, removes or radically changes the character: it always waits in the Inbox. */
    drastic?: boolean;
    /** Contradicting canon or lore (short quotes) that sent the event to the Inbox. */
    conflict?: string;
    /** The rumour was already mentioned once (it is never repeated). */
    rumourUsed?: boolean;
}

export interface OffscreenApi {
    /** Recent events, the newest first (default 20). */
    events(limit?: number): OffscreenEvent[];
    /** Turns until the next automatic run (null when off). */
    nextIn(): number | null;
    /** Runs now for the given characters (default: the most important absent ones). */
    runNow(characters?: string[]): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M16 implementation (optional so that fakes of the stage-9 contract stay valid).
    /** Absent important characters that may get an event now, the strongest first (the pult's picker). */
    candidates?(): OffscreenCandidate[];
}

/** A character the offscreen world may pick. */
export interface OffscreenCandidate {
    name: string;
    /** Turns since last seen in a scene (null: never seen in this chat). */
    absent: number | null;
    /** Picked by the automatic run if it ran now. */
    preferred: boolean;
}
