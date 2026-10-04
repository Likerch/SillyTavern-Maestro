// R3 "zero" criteria and the remaining shares (plan §14 пп. 4-10): messages dropped from the prompt without a Qvink
// summary, assistant-role lore at depth, data-loss log lines, revision / undo / living-canon shares, BunnyMo sheet
// replies and pack file fingerprints. Pure: the metrics feature reads the chat, logs and neighbours.
import { WI_POSITION_AT_DEPTH, WI_ROLE_ASSISTANT } from './medic-lore';
import { QVINK_GAP_DEFAULTS } from './medic-qvink';
import type { QvinkGapOptions, QvinkMessageView } from './medic-qvink';
import { sheetTagBlocks, trimSheetReply } from './sheet-reply';
import type { Verdict } from './metrics-stats';

/** Criterion 7: at least 70 % of revision proposals accepted as they are; under 5 % of Maestro's actions undone. */
export const REVISION_ACCEPT_TARGET = 0.7;
export const UNDO_SHARE_TARGET = 0.05;
export const MIN_REVISION_DECISIONS = 10;
export const MIN_ACTIONS = 20;
/** Criterion 8: the user drops under 20 % of provisional facts; confirmed facts are not contradicted later. */
export const DROP_SHARE_TARGET = 0.2;
export const MIN_PROVISIONAL = 10;

const CHARS_PER_TOKEN = 3;

/* ------------------------------------------------------------------ criterion 4: Qvink */

/**
 * Prompt entries Qvink dropped ("Remove Messages") that reach the model without a summary: the medic's gap rule
 * (src/domain/medic-qvink.ts) applied to the entries that are still flagged ignored after every interceptor, the
 * gap guard (M22) included. Entries Qvink would never summarise (its own exclusions) do not count.
 */
export function droppedWithoutSummary(
    dropped: readonly QvinkMessageView[],
    options: QvinkGapOptions = QVINK_GAP_DEFAULTS,
): number {
    const minChars = Math.max(0, options.minTokens) * CHARS_PER_TOKEN;
    let count = 0;
    for (const message of dropped) {
        if (message.skip) continue;
        if (message.isSystem && !options.includeSystem) continue;
        if (message.isUser && !options.includeUser) continue;
        if (message.textLength < minChars) continue;
        if (message.record?.exclude) continue;
        if (message.record?.memory.trim()) continue;
        count++;
    }
    return count;
}

/** Qvink's exclusion settings (best effort, names from its settings object). */
export function qvinkOptions(settings: Record<string, unknown> | null | undefined): QvinkGapOptions {
    const flag = (key: string) => settings?.[key] === true;
    const threshold = Number(settings?.['message_length_threshold']);
    return {
        includeUser: flag('include_user_messages'),
        includeSystem: flag('include_system_messages'),
        minTokens: Number.isFinite(threshold) && threshold >= 0 ? threshold : QVINK_GAP_DEFAULTS.minTokens,
    };
}

/* ------------------------------------------------------------------ criterion 5: lore role */

export interface ActivationLike {
    position: number;
    role?: number;
    cut?: boolean;
}

/** Activations that reached the prompt at depth with the assistant role (after the M22 role rule). */
export function assistantAtDepth(activations: readonly ActivationLike[]): number {
    return activations.filter(
        (row) => !row.cut && Number(row.position) === WI_POSITION_AT_DEPTH && Number(row.role) === WI_ROLE_ASSISTANT,
    ).length;
}

/* ------------------------------------------------------------------ criterion 6: data losses */

export interface LogLineLike {
    at: number;
    level: string;
    scope: string;
    text: string;
}

/**
 * Warnings and errors that mean something the user made or Maestro decided was not stored: failed writes,
 * saves given up after retries, applied-but-not-journaled actions. A refused save of a stale tab is the guard
 * working, not a loss.
 */
const LOSS_RE =
    /could not (?:be )?(?:save|write)|(?:was|were) not (?:saved|journaled)|not journaled|could not be saved|after \d+ attempts|saveMetadata failed/i;
const NOT_LOSS_RE = /stale tab|was refused/i;

export function isDataLoss(line: LogLineLike): boolean {
    if (line.level !== 'warn' && line.level !== 'error') return false;
    return LOSS_RE.test(line.text) && !NOT_LOSS_RE.test(line.text);
}

/** Data-loss lines newer than `since` (ms), oldest first. */
export function dataLossLines<T extends LogLineLike>(lines: readonly T[], since = 0): T[] {
    return lines.filter((line) => line.at > since && isDataLoss(line));
}

/* ------------------------------------------------------------------ criterion 7: shares */

export interface AutonomyCounts {
    kind: string;
    accepted: number;
    edited: number;
    rejected: number;
    undone: number;
}

/** Kind patterns: an entry ending with '.' or '*' is a prefix, anything else must match exactly. */
export function kindMatches(kind: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => {
        if (pattern.endsWith('*')) return kind.startsWith(pattern.slice(0, -1));
        if (pattern.endsWith('.')) return kind.startsWith(pattern);
        return kind === pattern;
    });
}

export interface RevisionShare {
    decisions: number;
    acceptedAsIs: number;
    edited: number;
    rejected: number;
    share?: number;
}

/** Decisions on revision proposals (autonomy statistics of the matching kinds). */
export function revisionShare(stats: readonly AutonomyCounts[], patterns: readonly string[]): RevisionShare {
    const result: RevisionShare = { decisions: 0, acceptedAsIs: 0, edited: 0, rejected: 0 };
    for (const row of stats) {
        if (!kindMatches(row.kind, patterns)) continue;
        result.acceptedAsIs += row.accepted;
        result.edited += row.edited;
        result.rejected += row.rejected;
    }
    result.decisions = result.acceptedAsIs + result.edited + result.rejected;
    if (result.decisions > 0) result.share = result.acceptedAsIs / result.decisions;
    return result;
}

export interface UndoShare {
    actions: number;
    undone: number;
    share?: number;
}

/** Share of journaled Maestro actions that were undone. */
export function undoShare(records: readonly { undone?: boolean }[]): UndoShare {
    const undone = records.filter((record) => record.undone === true).length;
    return records.length
        ? { actions: records.length, undone, share: undone / records.length }
        : { actions: 0, undone };
}

export function autonomyVerdict(
    revision: RevisionShare,
    undo: UndoShare,
    minDecisions = MIN_REVISION_DECISIONS,
    minActions = MIN_ACTIONS,
): Verdict {
    const parts: boolean[] = [];
    if (revision.decisions >= minDecisions && revision.share !== undefined) {
        parts.push(revision.share >= REVISION_ACCEPT_TARGET);
    }
    if (undo.actions >= minActions && undo.share !== undefined) parts.push(undo.share < UNDO_SHARE_TARGET);
    if (!parts.length) return 'none';
    return parts.every(Boolean) ? 'ok' : 'warn';
}

/* ------------------------------------------------------------------ criterion 8: living canon */

export interface LivingCounts {
    provisional: number;
    droppedByUser: number;
    confirmed?: number;
    contradictedAfterConfirm: number;
}

export function livingVerdict(counts: LivingCounts | null, minProvisional = MIN_PROVISIONAL): Verdict {
    if (!counts) return 'none';
    if (counts.contradictedAfterConfirm > 0) return 'warn';
    if (counts.provisional < minProvisional) return 'none';
    return counts.droppedByUser / counts.provisional < DROP_SHARE_TARGET ? 'ok' : 'warn';
}

/* ------------------------------------------------------------------ criterion 9: sheets */

export interface SheetMessageView {
    index: number;
    text: string;
    /** M31 marked it committed (folded and hidden from the prompt). */
    committed: boolean;
}

export interface SheetFinding {
    index: number;
    /** A scene continuation is still in the stored reply. */
    tail: boolean;
    /** DES tracker JSON is still in the stored reply. */
    tracker: boolean;
    /** Older than the last user message and not folded. */
    notCollapsed: boolean;
    /** The reply carries no `<BunnymoTags>` block, or the tag display rule is off. */
    noTags: boolean;
}

export interface SheetSummary {
    sheets: number;
    tail: number;
    tracker: number;
    notCollapsed: number;
    noTags: number;
    findings: SheetFinding[];
}

/** Sheet replies as they are stored now; `lastUserIndex` decides which ones should already be folded. */
export function sheetSummary(
    sheets: readonly SheetMessageView[],
    lastUserIndex: number,
    tagsShown: boolean,
): SheetSummary {
    const summary: SheetSummary = {
        sheets: sheets.length,
        tail: 0,
        tracker: 0,
        notCollapsed: 0,
        noTags: 0,
        findings: [],
    };
    for (const sheet of sheets) {
        const trimmed = trimSheetReply(sheet.text);
        const finding: SheetFinding = {
            index: sheet.index,
            tail: trimmed.tail.length > 0,
            tracker: trimmed.trackerBlocks > 0,
            notCollapsed: sheet.index < lastUserIndex && !sheet.committed,
            noTags: !tagsShown || sheetTagBlocks(sheet.text).length === 0,
        };
        if (finding.tail) summary.tail++;
        if (finding.tracker) summary.tracker++;
        if (finding.notCollapsed) summary.notCollapsed++;
        if (finding.noTags) summary.noTags++;
        if (finding.tail || finding.tracker || finding.notCollapsed || finding.noTags) summary.findings.push(finding);
    }
    return summary;
}

export function sheetVerdict(summary: SheetSummary): Verdict {
    if (!summary.sheets) return 'none';
    return summary.findings.length ? 'warn' : 'ok';
}

/* ------------------------------------------------------------------ criterion 10: pack files */

export interface PackFingerprint {
    hash: string;
    bytes: number;
    at: number;
}

export interface PackComparison {
    checked: number;
    same: string[];
    changed: string[];
    /** In the baseline but not readable now (renamed or deleted). */
    missing: string[];
    /** Read now but without a baseline yet. */
    added: string[];
}

/** Compares fingerprints taken now with the stored ones (book name → fingerprint; null = unreadable). */
export function comparePacks(
    baseline: Readonly<Record<string, PackFingerprint>>,
    current: Readonly<Record<string, PackFingerprint | null>>,
): PackComparison {
    const result: PackComparison = { checked: 0, same: [], changed: [], missing: [], added: [] };
    const names = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
    for (const name of names) {
        const before = baseline[name];
        const now = current[name];
        if (!before) {
            if (now) result.added.push(name);
            continue;
        }
        if (now === undefined) continue;
        result.checked++;
        if (now === null) result.missing.push(name);
        else if (now.hash === before.hash && now.bytes === before.bytes) result.same.push(name);
        else result.changed.push(name);
    }
    return result;
}

export function packVerdict(comparison: PackComparison | null): Verdict {
    if (!comparison || comparison.checked === 0) return 'none';
    return comparison.changed.length || comparison.missing.length ? 'warn' : 'ok';
}

/* ------------------------------------------------------------------ zero counters */

export interface TurnCounts {
    /** Turns where the check applied. */
    turns: number;
    /** Turns with at least one occurrence. */
    turnsWith: number;
    /** Most occurrences in one turn (the same old message is dropped again on every later turn). */
    max: number;
    total: number;
}

/** Per-turn occurrences (undefined = the check did not apply on that turn). */
export function turnCounts(values: readonly (number | undefined)[]): TurnCounts {
    const result: TurnCounts = { turns: 0, turnsWith: 0, max: 0, total: 0 };
    for (const value of values) {
        if (value === undefined || !Number.isFinite(value)) continue;
        result.turns++;
        result.total += value;
        if (value > 0) result.turnsWith++;
        result.max = Math.max(result.max, value);
    }
    return result;
}

/** "Zero" criteria: any occurrence fails; nothing observed yet → no verdict. */
export function zeroVerdict(observed: number, occurrences: number): Verdict {
    if (occurrences > 0) return 'warn';
    return observed > 0 ? 'ok' : 'none';
}
