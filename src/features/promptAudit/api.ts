// M38 «Проверка промпта» (plan-2 §2, release 1.13 second wave): conflicts between the preset and every extension that
// puts instructions into the prompt, found by cheap rules and, on request, by the background model, with fixes routed
// to whoever owns the text. Exposed as app.modules.api<PromptAuditApi>('promptAudit').
//
// Capture: the instruction map of the last real turn (preset blocks after layers and conditions, the card's system and
// post-history prompts and depth note, the author's note, every extension slot with owner/role/place, Maestro's own
// injections of that turn, instruction-like lore — BunnyMo core and filters, style rules — and the final messages'
// roles and order), kept per chat (document 'prompt-audit', size-capped) so the check works after a reload. A dry run
// («Пробная сборка») asks ST to assemble the prompt without sending it (`generate(type, {}, dryRun = true)`): ST runs
// no generation interceptors then, so the injections made there (Maestro's own, NAI Studio's markers, CarrotKernel's
// data) come from the last real turn and are marked so.
//
// The check runs only by the user's button, the slash command or the assistant's request (no background watcher, В4).
// Fixes: preset blocks → the user's layer (`presetLayer.record(base, op, scope)` + the working copy), neighbours' texts
// → `neighbourPrompts.setGlobal` / `setScoped`, Maestro's injections → its module setting (journaled here), BunnyMo
// packs never, the card, the author's note and other lore → advice only. «Исправить всё выбранное» is one journal
// record whose undo undoes every fix of the batch.
import type { AiEstimate } from '../../domain/prompt-audit-ai';
import type { FixRoute } from '../../domain/prompt-audit-fix';
import type { AuditCapture } from '../../domain/prompt-audit-map';
import type {
    AuditFix,
    AuditSeverity,
    AuditSide,
    AuditTopic,
    FixKind,
    FixScope,
} from '../../domain/prompt-audit-rules';
import type { Unsubscribe } from '../../shared/contracts';

export const PROMPT_AUDIT_KEY = 'promptAudit';

export type { AiEstimate } from '../../domain/prompt-audit-ai';
export type { AuditCapture, AuditItem, AuditOwner } from '../../domain/prompt-audit-map';
export type {
    AuditFix,
    AuditSeverity,
    AuditSide,
    AuditTopic,
    FixKind,
    FixScope,
} from '../../domain/prompt-audit-rules';

/** One conflict of a report, worded for the user. */
export interface AuditConflict {
    /** Stable within a report (the fingerprint's hash). */
    id: string;
    /** What «Не считать конфликтом» remembers. */
    fingerprint: string;
    source: 'rules' | 'ai';
    topic: AuditTopic;
    severity: AuditSeverity;
    a: AuditSide;
    b?: AuditSide;
    /** Further instructions taking part. */
    also?: AuditSide[];
    /** Short title in story words. */
    title: string;
    /** Why it matters, plain words. */
    why: string;
    /** What it does on the active model. */
    risk?: string;
    fix?: AuditFix;
    /** What the user did with it in this report. */
    status?: 'fixed' | 'skipped';
}

export interface AuditReport {
    at: number;
    /** The capture it was made from. */
    captureAt: number;
    source: 'turn' | 'dry';
    conflicts: AuditConflict[];
    /** Conflicts hidden by «Не считать конфликтом». */
    hidden: number;
    /** The last AI check of this capture. */
    ai?: { at: number; count: number; costUsd?: number; error?: string };
}

/** What a fix would do, as the report card and the assistant's card show it. */
export interface FixPlan {
    conflictId: string;
    route: FixRoute['route'];
    side: 'a' | 'b';
    kind: FixKind;
    /** What is changed, in plain words («Пресет «Marinara», блок «Task»»). */
    target: string;
    /** Before/after of the changed text (or the state for switches and roles). */
    before: string;
    after: string;
    /** Scopes the fix can be written to (empty: advice only). */
    scopes: FixScope[];
    /** Advice-only fixes: what to change by hand and where. */
    advice?: string;
    /** A risk of this fix on the active model. */
    warning?: string;
    /** Why this side. */
    reason?: string;
}

export interface FixOutcome {
    id: string;
    ok: boolean;
    /** Plain words: what was done, or why not. */
    message: string;
}

export type AuditBusy = 'check' | 'dry' | 'ai' | 'fix';

export interface PromptAuditApi {
    /** Resolves when the stored capture and report of the chat open now are loaded. */
    ready(): Promise<void>;
    /** The capture the report is made from, else the last real turn's. */
    capture(): AuditCapture | null;
    report(): AuditReport | null;
    /** The rules layer over the last real turn (dry: over a fresh test assembly). Null without a capture. */
    check(options?: { dry?: boolean }): Promise<AuditReport | null>;
    /** Size and price of the AI check of the current capture (null without one). */
    aiEstimate(): AiEstimate | null;
    /** The AI check (a user job with progress); the caller has shown the estimate. */
    runAi(): Promise<AuditReport | null>;
    /** What fixing a conflict would do (null: no fix). */
    plan(id: string, scope?: FixScope): FixPlan | null;
    fix(id: string, scope?: FixScope): Promise<FixOutcome>;
    /** Fixes several conflicts as one journal record (one undo). */
    fixMany(ids: readonly string[], scope?: FixScope): Promise<FixOutcome[]>;
    /** «Пропустить»: hidden in this report. */
    skip(id: string): void;
    /** «Не считать конфликтом»: hidden in every later report. */
    ignore(id: string): void;
    /** Shows the hidden ones again. */
    restoreIgnored(): void;
    busy(): AuditBusy | null;
    /** A test assembly can run now (Chat Completion, a character open, no generation running). */
    dryRunAvailable(): boolean;
    onChange(listener: () => void): Unsubscribe;
    /** The report view (redraws itself; the Preset Studio's «Проверка промпта» tab shows it). */
    renderReport(): HTMLElement;
}
