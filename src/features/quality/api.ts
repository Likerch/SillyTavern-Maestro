// Reply quality control (M12, stage 6): free checks first, the cheap AI judge only on suspicion, sheets skipped.
// Runs on reply:ready (after DES, DES-RU and NAI markers) BEFORE NAI Studio draws: NAI Studio waits for the
// «quality ok» signal (bus 'reply:ok' + NAI Studio's own wait, §16). Actions per defect kind: off / auto (clean,
// ask to continue, or one swipe with an exact instruction per turn) / notify (message badge with «Переделать»).
// The content boundary (§11) is a configurable rule list with a default, never hard-coded.
// Exposed as app.modules.api<QualityApi>('quality').
import type { BaseDefect, DefectKind } from '../../domain/quality-types';
import type { Unsubscribe } from '../../shared/contracts';

export type { DefectKind } from '../../domain/quality-types';

export type DefectAction = 'off' | 'auto' | 'notify';

/** A defect as the service keeps it: the checks' defect plus what the service made of it. */
export interface Defect extends BaseDefect {
    // Additions of the M12 service (optional so that the pure checks and fakes of the contract stay valid).
    /**
     * A rule hit below the judge threshold that no judge confirmed (judge off, «Экономный», no profile, timeout):
     * shown as a notice at most, never acted on automatically.
     */
    suspected?: boolean;
    /** What the service did about this defect. */
    status?: DefectStatus;
}

/**
 * - cleaned / continued / swiped / repaired: an automatic fix ran (swiped and continued: the reply is being redone);
 * - delegated: M3 «Медик» repairs the DES tracker on its own;
 * - notified: a message badge with «Переделать» / «Не брак»;
 * - dismissed: the user said «Не брак».
 */
export type DefectStatus = 'cleaned' | 'continued' | 'swiped' | 'repaired' | 'delegated' | 'notified' | 'dismissed';

export interface QualityVerdict {
    messageIndex: number;
    swipeId: number;
    ok: boolean;
    defects: Defect[];
    /** The judge was asked (suspicion) and answered. */
    judged: boolean;
    /** What was done: cleaned / continued / swiped / notified / nothing. */
    action: 'none' | 'cleaned' | 'continued' | 'swiped' | 'notified' | 'repaired';
    costUsd: number;
    at: number;
}

/** A content-boundary rule (§11): plain words/regex in English and Russian; violations are 'boundary' defects. */
export interface BoundaryRule {
    id: string;
    title: string;
    /** Regex sources (flags 'iu') or plain words; any hit is a suspicion for the judge, two hits a defect. */
    patterns: string[];
    enabled: boolean;
}

export interface QualityStats {
    kind: DefectKind;
    detected: number;
    /** The user undid an auto action or dismissed a badge as «не брак». */
    falsePositives: number;
    autoActions: number;
}

export interface QualityApi {
    /** Verdict of a message (latest swipe) if checked. */
    verdict(messageIndex: number): QualityVerdict | undefined;
    /** Re-checks a message now (pult, «Проверить ещё раз»). */
    check(messageIndex: number): Promise<QualityVerdict>;
    /** «Не брак»: marks the defect as a false positive (feeds the stats and trust). */
    dismiss(messageIndex: number, kind: DefectKind): Promise<void>;
    /** «Переделать»: swipe with the exact instruction of the defects. */
    redo(messageIndex: number): Promise<void>;
    boundary(): BoundaryRule[];
    setBoundary(rules: BoundaryRule[]): Promise<void>;
    stats(): QualityStats[];
    onVerdict(listener: (verdict: QualityVerdict) => void): Unsubscribe;
    // Additions of the M12 implementation (optional so that fakes of the stage-6 contract stay valid).
    /**
     * NAI Studio's «качество ок» wait (plan §16): true when pictures of this message may be drawn, false when the
     * reply is being redone (auto-swipe, continue). Never waits longer than 20 s (then true).
     */
    gate?(messageIndex: number): Promise<boolean>;
    /** «Тестовый режим»: runs the free checks over a pasted text as if it were the next reply; acts on nothing. */
    test?(text: string, boundary?: BoundaryRule[]): Defect[];
    /** Recent verdicts of the current chat, newest first (swiped and deleted ones included, for the pult). */
    history?(): QualityVerdict[];
}
