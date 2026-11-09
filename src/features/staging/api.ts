// M45 «Мизансцена» (release 1.32): poses and positions per reply. Exposed as app.modules.api<StagingApi>('staging').
import type { StagingEntry } from '../../domain/staging';
import type { Unsubscribe } from '../../shared/contracts';

export interface StagingApi {
    /** The staging in force now (the latest reply with a record). */
    current(): StagingEntry[];
    /** The prompt line «кто где и как» ('' when nothing is known). */
    text(): string;
    /** The user's edit of the current staging (journaled with undo). */
    setCurrent(entries: StagingEntry[]): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
}
