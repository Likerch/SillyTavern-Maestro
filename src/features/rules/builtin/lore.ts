// Lore rules of stage 1 (plan M22 table, M20 п. 2, P13): role assistant → system, book cap and recursion limit,
// byte-identical pack duplicates. All of them only assign scalar fields on ST's per-scan copies.
import { findCrossBookDuplicates, isLimit, isPlainObject, planBookCaps } from '../../../domain/rules-lore';
import type { CapActivation } from '../../../domain/rules-lore';
import type { CutEntry, EntryLists, RuleChange, RuleDefinition, ScanInfo } from '../api';
import { contentOf, entriesOf } from '../env';
import type { RuleEnv } from '../env';

export const ROLE_RULE_ID = 'role.assistantToSystem';
export const CAP_RULE_ID = 'book.cap';
export const DUPLICATES_RULE_ID = 'pack.duplicates';

/** ST `world_info_position.atDepth`; roles: 0 system, 1 user, 2 assistant. */
const AT_DEPTH = 4;
const ROLE_SYSTEM = 0;
const ROLE_ASSISTANT = 2;

type Dict = Record<string, unknown>;

/**
 * Entries at depth with the assistant role (BunnyMo #64, Tell Tail «Ozone Filter», Baby Bunny archives) read to the
 * model as its own words; they become system. User-role entries stay (plan A9).
 */
export function roleRule(): RuleDefinition {
    return {
        id: ROLE_RULE_ID,
        titleKey: 'm22.rule.role.assistantToSystem.title',
        descriptionKey: 'm22.rule.role.assistantToSystem.description',
        owner: 'maestro',
        stage: 1,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded'],
        order: 10,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            for (const entry of entriesOf(lists)) {
                if (entry.disable === true) continue;
                if (
                    Number(entry.position) !== AT_DEPTH ||
                    entry.role === null ||
                    Number(entry.role) !== ROLE_ASSISTANT
                ) {
                    continue;
                }
                changes.push({
                    world: entry.world,
                    uid: entry.uid,
                    field: 'role',
                    before: entry.role,
                    after: ROLE_SYSTEM,
                });
                entry.role = ROLE_SYSTEM;
            }
        },
    };
}

/**
 * The same entry (normalised keys, identical text) in two active books — MBTI v1 and V2, Species merged and split —
 * keeps only the copy of the newest book. Text conflicts between versions are a stage 2 question.
 */
export function duplicatesRule(): RuleDefinition {
    return {
        id: DUPLICATES_RULE_ID,
        titleKey: 'm22.rule.pack.duplicates.title',
        descriptionKey: 'm22.rule.pack.duplicates.description',
        owner: 'maestro',
        stage: 1,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded'],
        order: 20,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            for (const group of findCrossBookDuplicates(entriesOf(lists))) {
                for (const entry of group.drop) {
                    changes.push({
                        world: entry.world,
                        uid: entry.uid,
                        field: 'disable',
                        before: entry.disable ?? false,
                        after: true,
                    });
                    entry.disable = true;
                }
            }
        },
    };
}

function commentOf(entry: Dict): string {
    return typeof entry.comment === 'string' ? entry.comment : '';
}

/**
 * Per-book limits (audit T4): a book with a recursion limit gets `preventRecursion` on its copies before the scan
 * (its text would otherwise feed recursion before anything could be cut); after every loop, activations deeper than
 * the limit and those above the token cap leave `activated.entries` and are marked `disable` in `sortedEntries`, so
 * later loops cannot activate them again.
 */
export function capRule(env: RuleEnv): RuleDefinition {
    return {
        id: CAP_RULE_ID,
        titleKey: 'm22.rule.book.cap.title',
        descriptionKey: 'm22.rule.book.cap.description',
        owner: 'maestro',
        stage: 1,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded', 'st.events.scanDone'],
        order: 30,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            const caps = env.settings().bookCaps;
            if (!Object.keys(caps).length) return;
            for (const entry of entriesOf(lists)) {
                if (!isLimit(caps[entry.world]?.maxRecursionLevel) || entry.preventRecursion === true) continue;
                changes.push({
                    world: entry.world,
                    uid: entry.uid,
                    field: 'preventRecursion',
                    before: entry.preventRecursion ?? false,
                    after: true,
                });
                entry.preventRecursion = true;
            }
        },
        applyScanDone(args: Record<string, unknown>, scan: ScanInfo): void {
            applyCaps(env, args, scan);
        },
    };
}

/** The SCAN_DONE half of the cap rule (exported for tests). */
export function applyCaps(env: RuleEnv, args: Record<string, unknown>, scan: ScanInfo): CutEntry[] {
    const caps = env.settings().bookCaps;
    if (!Object.keys(caps).length) return [];
    const activated = isPlainObject(args.activated) ? args.activated.entries : undefined;
    if (!(activated instanceof Map)) return [];
    const fresh = new Set<unknown>(
        isPlainObject(args.new) && Array.isArray(args.new.successful) ? args.new.successful : [],
    );
    const sorted: unknown[] = Array.isArray(args.sortedEntries) ? args.sortedEntries : [];
    let positions: Map<unknown, number> | null = null;
    const position = (entry: unknown): number => {
        positions ??= new Map(sorted.map((item, index) => [item, index]));
        return positions.get(entry) ?? Number.MAX_SAFE_INTEGER;
    };

    const capped: Dict[] = [];
    const byKey = new Map<string, Dict>();
    const activations: CapActivation[] = [];
    for (const [rawKey, entry] of activated as Map<unknown, unknown>) {
        if (!isPlainObject(entry) || typeof entry.world !== 'string' || !caps[entry.world]) continue;
        const key = String(rawKey);
        byKey.set(key, entry);
        capped.push(entry);
        activations.push({
            key,
            world: entry.world,
            order: Number(entry.order) || 0,
            priority: position(entry),
            tokens: env.tokens.get(entry),
            isNew: fresh.has(entry),
        });
    }
    if (!activations.length) return [];

    const reported: CutEntry[] = [];
    for (const cut of planBookCaps(activations, caps, scan.recursionLevel)) {
        const entry = byKey.get(cut.key);
        if (!entry) continue;
        activated.delete(cut.key);
        entry.disable = true;
        // Force-activated entries (WORLDINFO_FORCE_ACTIVATE) are other objects than their sortedEntries twin.
        if (position(entry) === Number.MAX_SAFE_INTEGER) {
            const twin = sorted.find(
                (item) => isPlainObject(item) && item.world === entry.world && item.uid === entry.uid,
            );
            if (isPlainObject(twin)) twin.disable = true;
        }
        reported.push({
            world: cut.world,
            uid: Number(entry.uid),
            comment: commentOf(entry),
            chars: contentOf(entry).length,
            tokens: env.tokens.get(entry),
            ruleId: CAP_RULE_ID,
            reason: cut.reason,
            loop: scan.loop,
        });
    }
    if (reported.length) env.reportCuts(reported);
    // Exact counts for the next scans, in the background (never on the send path).
    if (scan.final && !scan.simulated) void env.tokens.fill(capped);
    return reported;
}
