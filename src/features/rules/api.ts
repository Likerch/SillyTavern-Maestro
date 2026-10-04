// Public API of M22 «Правила» (exposed as app.modules.api<RulesApi>('rules')).
import type { AutonomyLevel, Unsubscribe } from '../../shared/contracts';
import type { TurnLoreRecord } from '../loreJournal/api';

export type RuleKind = 'lore' | 'prompt' | 'neighbour' | 'display' | 'ui';

/** A WI entry copy as seen in WORLDINFO_ENTRIES_LOADED ({uid, world, ...entry}). Never mutate nested arrays. */
export type EntryCopy = Record<string, unknown> & { uid: number; world: string };

export interface EntryLists {
    globalLore: EntryCopy[];
    characterLore: EntryCopy[];
    chatLore: EntryCopy[];
    personaLore: EntryCopy[];
}

export interface RuleChange {
    world: string;
    uid: number;
    field: string;
    before: unknown;
    after: unknown;
}

/** Where the current WORLDINFO_SCAN_DONE loop is (computed by the engine for scan-time rules). */
export interface ScanInfo {
    /** `state.loopCount` of ST's scan (1 = initial scan). */
    loop: number;
    /** Recursion loops seen in this scan so far (0 for the initial and min-activation loops). */
    recursionLevel: number;
    /** No further loop follows (`state.next === 0`). */
    final: boolean;
    /** The scan belongs to an M1 simulation. */
    simulated: boolean;
}

export interface RuleDefinition {
    id: string;
    titleKey: string;
    descriptionKey: string;
    owner: 'maestro' | 'desru';
    stage: number;
    kind: RuleKind;
    /** Default autonomy level for enabling the rule (most rules: 'auto' after the wizard). */
    defaultLevel: AutonomyLevel;
    /** Default on/off before the user decides in the wizard. */
    enabledByDefault: boolean;
    /** Capability ids (host or adapter) the rule needs; it stays idle while one is missing. */
    requires?: string[];
    /** Order among lore rules (lower first, default 100); keeps the result deterministic. */
    order?: number;
    /**
     * May run before the first-run wizard decided about rules (display/ui rules always may). Lore, prompt and
     * neighbour rules wait for the wizard unless the user switched them explicitly.
     */
    safeBeforeWizard?: boolean;
    /** Lore rules: transform entry copies (ENTRIES_LOADED); must be deterministic and cheap. */
    applyEntries?(lists: EntryLists, changes: RuleChange[]): void;
    /** Lore rules that act after a scan loop (WORLDINFO_SCAN_DONE args). */
    applyScanDone?(args: Record<string, unknown>, scan: ScanInfo): void;
    /** Non-lore rules: start/stop side effects (CSS, formatter hooks, interceptor handlers). */
    start?(): void | Unsubscribe;
}

export interface RuleState {
    id: string;
    enabled: boolean;
    definition: RuleDefinition;
    /** Changes made on the last scan (lore rules). */
    lastChanges: RuleChange[];
    // Fields added by the M22 implementation (optional so that fakes of the stage-1 contract stay valid).
    /** Enabled but not acting yet: lore, prompt and neighbour rules wait for the first-run wizard. */
    waiting?: boolean;
    /** Every required capability is present. */
    available?: boolean;
    /** Required capabilities that are missing now. */
    missing?: string[];
    /** The user switched the rule explicitly (otherwise the default and the wizard decide). */
    explicit?: boolean;
    /** Side effects of start() are installed. */
    running?: boolean;
}

export interface RuleImpact {
    before: TurnLoreRecord;
    after: TurnLoreRecord;
    /** Entries active only before / only after, and size delta. */
    removed: { world: string; uid: number; comment: string; chars: number }[];
    added: { world: string; uid: number; comment: string; chars: number }[];
    charsDelta: number;
}

/** Per-book limits of the 'book.cap' rule (M20 п. 2). */
export interface BookCap {
    /** Tokens of this book's activated entries per scan; entries above it are cut (highest `order` kept first). */
    maxTokens?: number;
    /** Deepest recursion level an entry of this book may be activated at (0 = direct matches only). */
    maxRecursionLevel?: number;
}

/** Settings slice of M22 (`extensionSettings.maestro.modules.rules`). */
export interface RulesSettings {
    /** Explicit on/off per rule id; missing = default (and the first-run wizard). */
    enabled: Record<string, boolean>;
    bookCaps: Record<string, BookCap>;
    /** Most messages the Qvink gap guard returns to one prompt. */
    gapGuardLimit: number;
}

/** An activation removed by a Maestro rule in the latest scan (M1 marks it `cut`, `cutBy: 'maestro'`). */
export interface CutEntry {
    world: string;
    uid: number;
    comment: string;
    chars: number;
    tokens: number;
    ruleId: string;
    reason: 'tokens' | 'recursion';
    /** Scan loop that cut it. */
    loop: number;
}

export interface RulesApi {
    register(rule: RuleDefinition): Unsubscribe;
    list(): RuleState[];
    isEnabled(id: string): boolean;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    /** Simulates the current chat with and without the given rules (via M1). */
    compare(ids: string[]): Promise<RuleImpact>;
    /** True while M1 asks to suspend this rule in a simulation. */
    suspended(id: string): boolean;
    // Additions of the M22 implementation; optional so that fakes of the stage-1 contract stay valid.
    /**
     * Activations cut by Maestro rules in the latest scan (cleared when a new scan starts). M1 reads it while
     * recording a scan and marks those activations `cut: true, cutBy: 'maestro'` (M22 runs first on SCAN_DONE).
     */
    cutEntries?(): CutEntry[];
    /** Book names seen in the latest real (non-simulated) scan. */
    activeBooks?(): string[];
    bookCaps?(): Record<string, BookCap>;
    /** Sets or (with null / an empty cap) removes the limits of one book. */
    setBookCap?(book: string, cap: BookCap | null): void;
    /**
     * Rule parameters in a generic shape (used by the first-run wizard): 'book.cap' → `{ caps: {book: maxTokens},
     * recursion: {book: maxRecursionLevel} }`, 'qvink.gapGuard' → `{ limit }`; other rules → undefined.
     */
    options?(id: string): Record<string, unknown> | undefined;
    /** Sets parameters in the shape of options(); for 'book.cap' the given `caps` replace every token cap. */
    setOptions?(id: string, options: Record<string, unknown>): void | Promise<void>;
}
