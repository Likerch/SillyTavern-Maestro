// What M21m reads from SillyTavern, the neighbours and other Maestro modules, shaped for the pure helpers in
// src/domain/metrics-*.ts. Read-only; every optional source degrades to "not measured" instead of throwing.
import { adaptersOf } from '../../adapters';
import { QVINK_KEY } from '../../adapters/qvink';
import { hash53 } from '../../domain/hash';
import type { QvinkMessageView } from '../../domain/medic-qvink';
import { droppedWithoutSummary, qvinkOptions } from '../../domain/metrics-checks';
import type { AutonomyCounts, LivingCounts, PackFingerprint, SheetMessageView } from '../../domain/metrics-checks';
import { deviceClass } from '../../domain/metrics-stats';
import type { CostSample, DeviceClass } from '../../domain/metrics-stats';
import { isImagePost } from '../../domain/text-clean';
import type { App, CostEntry } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { GuardianApi } from '../guardian/api';
import type { LivingCanonApi } from '../livingCanon/api';
import type { LoreActivation } from '../loreJournal/api';
import type { RevisionApi } from '../revision/api';
import type { RulesApi } from '../rules/api';
import type { GuardianStats, LivingCanonStats, RevisionStats } from './api';
import { METRIC_COUNTERS } from './api';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ST `IGNORE_SYMBOL` (constants.js): Qvink sets it on prompt entries it drops from the prompt. */
export const IGNORE_SYMBOL = Symbol.for('ignore');
/** M22 rule that renders BunnyMo tags in messages (src/features/rules/builtin/display.ts). */
export const TAGS_RULE_ID = 'display.bunnymoTags';

/** This tab's device class: a coarse primary pointer or a narrow window means "phone". */
export function readDevice(): DeviceClass {
    let coarsePointer: boolean;
    try {
        coarsePointer = globalThis.matchMedia?.('(pointer: coarse)').matches === true;
    } catch {
        coarsePointer = false;
    }
    const width = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : undefined;
    return deviceClass({ coarsePointer, width });
}

/* ------------------------------------------------------------------ send path */

export interface InterceptTiming {
    type: string;
    /** performance.now() when Maestro's generate interceptor started and finished. */
    startedAt: number;
    endedAt: number;
}

/**
 * Timing of the last run of Maestro's interceptor, when the turn pipeline reports it (an optional TurnHooks
 * addition, `lastIntercept()`): it covers the ephemeral producers too, which run before `generation:before`.
 */
export function interceptTiming(app: App): InterceptTiming | null {
    const turn = app.turn as Partial<{ lastIntercept(): InterceptTiming | null }>;
    if (typeof turn.lastIntercept !== 'function') return null;
    try {
        const timing = turn.lastIntercept();
        return timing && Number.isFinite(timing.startedAt) && Number.isFinite(timing.endedAt) ? timing : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ criterion 4 */

/**
 * Prompt entries still flagged "ignored" after every interceptor ran (read after the request left, so the gap
 * guard's copies are already in place), counted by the medic's rules. Undefined when Qvink does not remove
 * messages in this chat (nothing to check).
 */
export function droppedInPrompt(app: App, chat: readonly STChatMessage[] | undefined): number | undefined {
    if (!chat) return undefined;
    const qvink = adaptersOf(app).qvink;
    try {
        if (!qvink.present() || !qvink.chatEnabled() || !qvink.removesMessages()) return undefined;
    } catch {
        return undefined;
    }
    const views: QvinkMessageView[] = [];
    for (const entry of chat) {
        const extra = entry?.extra as (Dict & Record<symbol, unknown>) | undefined;
        if (!entry || !extra || extra[IGNORE_SYMBOL] !== true) continue;
        const raw = extra[QVINK_KEY];
        views.push({
            isUser: entry.is_user === true,
            isSystem: entry.is_system === true,
            textLength: typeof entry.mes === 'string' ? entry.mes.trim().length : 0,
            skip: isImagePost(entry),
            record: isDict(raw)
                ? {
                      memory: typeof raw.memory === 'string' ? raw.memory : '',
                      exclude: raw.exclude === true,
                      remember: raw.remember === true,
                  }
                : null,
        });
    }
    return droppedWithoutSummary(views, qvinkOptions(qvink.settings()));
}

/* ------------------------------------------------------------------ lore */

/** Lore rules (M22) acting now. */
export function activeLoreRules(app: App): string[] {
    const rules = app.modules.api<RulesApi>('rules');
    if (!rules) return [];
    try {
        return rules
            .list()
            .filter((state) => state.enabled && state.definition.kind === 'lore' && state.waiting !== true)
            .map((state) => state.id);
    } catch {
        return [];
    }
}

export function loreEntries(activations: readonly LoreActivation[]): number {
    return activations.filter((row) => !row.cut).length;
}

/* ------------------------------------------------------------------ costs */

type CostRow = CostEntry & { anlas?: number };

/**
 * Today's recent cost entries when the meter exposes them (an optional CostMeter.recent(), else CostMeterImpl's
 * today().recent; newest last); null when it does not (the caller falls back to summary deltas).
 */
export function recentCosts(app: App): CostRow[] | null {
    const meter = app.cost as Partial<{ recent(): unknown; today(): { recent?: unknown } }>;
    if (typeof meter.recent !== 'function' && typeof meter.today !== 'function') return null;
    try {
        const recent = typeof meter.recent === 'function' ? meter.recent() : meter.today!().recent;
        if (!Array.isArray(recent)) return null;
        return recent.filter(
            (row): row is CostRow =>
                isDict(row) &&
                typeof row.at === 'number' &&
                typeof row.source === 'string' &&
                typeof row.usd === 'number',
        );
    } catch {
        return null;
    }
}

export function toCostSample(row: CostRow): CostSample | null {
    if (row.anlas !== undefined) return null;
    const sample: CostSample = { at: row.at, source: row.source, usd: Math.max(0, row.usd) };
    if (row.task) sample.task = row.task;
    if (row.estimated) sample.estimated = true;
    return sample;
}

export const costKey = (row: { at: number; source: string; usd: number; task?: string }): string =>
    `${row.at}|${row.source}|${row.usd}|${row.task ?? ''}`;

/* ------------------------------------------------------------------ criterion 6 */

export function guardianState(app: App): string | undefined {
    try {
        return app.modules.api<GuardianApi>('guardian')?.tabState();
    } catch {
        return undefined;
    }
}

/** Saves the guard holds or refused right now (needs GuardianApi.guardInfo, an optional addition). */
export function guardianBlocked(app: App): number | undefined {
    const api = app.modules.api<GuardianApi & GuardianStats>('guardian');
    if (typeof api?.guardInfo !== 'function') return undefined;
    try {
        const info = api.guardInfo();
        if (!info) return undefined;
        const sum = (map: Record<string, number>) =>
            Object.values(map ?? {}).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
        return sum(info.held) + sum(info.vetoed);
    } catch {
        return undefined;
    }
}

/* ------------------------------------------------------------------ criterion 7 */

export function autonomyCounts(app: App): AutonomyCounts[] {
    try {
        return app.autonomy.stats();
    } catch {
        return [];
    }
}

/** Revision decisions straight from M8 when it counts them itself (RevisionApi.stats, optional). */
export function revisionStats(app: App): ReturnType<NonNullable<RevisionStats['stats']>> | undefined {
    const api = app.modules.api<RevisionApi & RevisionStats>('revision');
    if (typeof api?.stats !== 'function') return undefined;
    try {
        return api.stats();
    } catch {
        return undefined;
    }
}

export function journalRecords(app: App): { undone?: boolean }[] {
    try {
        return app.journal.list();
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ criterion 8 */

/** M26 counts: its own stats() when exposed, else the counters it fed through MetricsApi.count(). */
export function livingCounts(app: App, counters: Readonly<Record<string, number>>): LivingCounts | null {
    const api = app.modules.api<LivingCanonApi & LivingCanonStats>('livingCanon');
    if (typeof api?.stats === 'function') {
        try {
            return api.stats();
        } catch {
            // fall back to the counters
        }
    }
    const provisional = counters[METRIC_COUNTERS.livingProvisional] ?? 0;
    const droppedByUser = counters[METRIC_COUNTERS.livingDropped] ?? 0;
    const confirmed = counters[METRIC_COUNTERS.livingConfirmed] ?? 0;
    const contradictedAfterConfirm = counters[METRIC_COUNTERS.livingContradicted] ?? 0;
    if (!api && provisional + droppedByUser + confirmed + contradictedAfterConfirm === 0) return null;
    return { provisional, droppedByUser, confirmed, contradictedAfterConfirm };
}

/* ------------------------------------------------------------------ criterion 9 */

/** Sheet replies M31 marked (`extra.maestro.sheet.part === 'reply'`) and the index of the last user message. */
export function sheetViews(app: App): { sheets: SheetMessageView[]; lastUserIndex: number; tagsShown: boolean } {
    const chat = app.host.ctx().chat ?? [];
    const sheets: SheetMessageView[] = [];
    let lastUserIndex = -1;
    chat.forEach((message, index) => {
        if (message?.is_user) lastUserIndex = index;
        const maestro = message?.extra?.maestro;
        const mark = isDict(maestro) && isDict(maestro.sheet) ? maestro.sheet : undefined;
        if (!mark || mark.part === 'command') return;
        sheets.push({
            index,
            text: typeof message.mes === 'string' ? message.mes : '',
            committed: mark.committed === true,
        });
    });
    let tagsShown: boolean;
    try {
        tagsShown = app.modules.api<RulesApi>('rules')?.isEnabled(TAGS_RULE_ID) === true;
    } catch {
        tagsShown = false;
    }
    return { sheets, lastUserIndex, tagsShown };
}

/* ------------------------------------------------------------------ criterion 10 */

/** BunnyMo core and pack books: M35 roles first, the BunnyMo adapter as a fallback. */
export function bunnymoBooks(app: App): string[] {
    const names = new Set<string>();
    try {
        for (const info of app.modules.api<BookRolesApi>('bookRoles')?.all() ?? []) {
            if (info.role === 'bunnymo.core' || info.role === 'bunnymo.pack') names.add(info.book);
        }
    } catch {
        // roles unavailable
    }
    try {
        const books = adaptersOf(app).bunnymo.books();
        for (const name of [...books.core, ...books.packs]) names.add(name);
    } catch {
        // adapter unavailable
    }
    return [...names].sort();
}

/** The book file as the server reads it now (POST /api/worldinfo/get bypasses ST's in-memory cache). */
export async function readBookText(app: App, name: string): Promise<string | null> {
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: app.host.ctx().getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!response.ok) return null;
        const text = await response.text();
        return text.trim() ? text : null;
    } catch {
        return null;
    }
}

export function fingerprint(text: string, at: number): PackFingerprint {
    return { hash: hash53(text).toString(36), bytes: new TextEncoder().encode(text).length, at };
}
