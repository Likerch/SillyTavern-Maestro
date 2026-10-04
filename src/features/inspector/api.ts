// Public API of M2 «Инспектор хода» (exposed as app.modules.api<InspectorApi>('inspector')).
import type { InspectorSource, RoleChars } from '../../domain/lore-inspector';
import type { Unsubscribe } from '../../shared/contracts';

export type { InspectorSource, RoleChars, SlotOwner, SourceKind } from '../../domain/lore-inspector';

/** One real turn: how the prompt was put together (weights are reconstructed, audit T15). */
export interface InspectorRecord {
    /** Assistant message the prompt produced. */
    messageIndex: number;
    at: number;
    generationType: string;
    /** Messages in the final Chat Completion prompt. */
    messages: number;
    chars: RoleChars;
    totalTokens: number;
    /** Token counts came from the Prompt Manager (true) or from Maestro's estimate (false). */
    exact: boolean;
    sources: InspectorSource[];
    /** Lore is split by book (M1 was on); otherwise it is one "lore" source. */
    loreByBook: boolean;
}

export interface InspectorApi {
    /** Stored turns of the current chat, oldest first. */
    turns(limit?: number): InspectorRecord[];
    last(): InspectorRecord | undefined;
    onTurn(listener: (record: InspectorRecord) => void): Unsubscribe;
}
