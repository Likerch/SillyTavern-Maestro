// Chronicle, auto-memory and «Ранее в истории…» (M9, stage 4). Chapters are canon additions (M6, type 'chapter',
// AND-keys: two characteristic keys or an explicit mention), made from Qvink memories that fell out of the long
// memory budget; Maestro is the only owner of Qvink's «remember» flag (set on every swipe of a message).
// Exposed as app.modules.api<ChronicleApi>('chronicle').
import type { Unsubscribe } from '../../shared/contracts';

export interface Chapter {
    uid: number;
    title: string;
    /** Message range the chapter covers. */
    from: number;
    to: number;
    /** Primary and secondary keys (AND logic). */
    keys: string[];
    secondary: string[];
    chars: number;
    // Addition of the M9 implementation (optional so that fakes of the stage-4 contract stay valid).
    /** Canon status: 'archived' chapters come back only when their keys are mentioned. */
    status?: string;
}

export interface RecapSettings {
    /** Hours of absence before the recap is shown. */
    afterHours: number;
    /** Where it goes: only to the user (default), also into the first prompt, or off. */
    target: 'user' | 'userAndPrompt' | 'off';
    /** Source: Qvink + canon (free) or a background model summary. */
    source: 'memory' | 'ai';
}

export interface ChronicleApi {
    chapters(): Promise<Chapter[]>;
    /** Messages Maestro marked «remember» in Qvink, with the reason. */
    remembered(): { messageIndex: number; reason: string }[];
    /** Builds and shows the recap now (ignores the absence timer). */
    recapNow(): Promise<string>;
    onChange(listener: () => void): Unsubscribe;
}
