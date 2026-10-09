// M3 health checks (Pult → Health): neighbours, lorebooks, preset and Maestro's own dependencies (plan M3, §4.14).
import { adaptersOf } from '../../adapters';
import { desSwipeRecord } from '../../domain/des-tracker';
import {
    emptyKeyFieldNames,
    hasEmptyDetailKeys,
    hasFencedJson,
    hasRawNaiMarker,
    trackerMissing,
} from '../../domain/medic-des';
import { assistantDepthEntries, bookEntries, missingAddedKeys } from '../../domain/medic-lore';
import { findQvinkGaps } from '../../domain/medic-qvink';
import type { App, HealthCheck } from '../../shared/contracts';
import type { RulesApi } from '../rules/api';
import { detectPrefill } from './prefill';
import type { PrefillFix } from './prefill';
import { activeBookNames, lastStoryReply, loadBook, qvinkGapOptions, qvinkViews } from './sources';
import type { TrackerRepair } from './tracker-repair';
import { expectsTracker, preparedStart } from './tracker-repair';

type Dict = Record<string, unknown>;
type Translate = (key: string, params?: Record<string, string | number>) => string;
type Result = Awaited<ReturnType<HealthCheck['run']>>;

export const RULE_QVINK_GAPS = 'qvink.gapGuard';
export const RULE_ASSISTANT_ROLE = 'role.assistantToSystem';

/** ST capabilities whose absence switches off parts of Maestro (reported separately: st.cm, st.chatCompletion). */
const SEPARATE_CAPS = new Set(['st.cm', 'st.chatCompletion']);
const MAX_LISTED = 5;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nested(source: unknown, ...path: string[]): unknown {
    let current = source;
    for (const key of path) current = isDict(current) ? current[key] : undefined;
    return current;
}

/** "Книга: 3, Другая: 1 …" */
function listCounts(counts: Map<string, number>): string {
    const items = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = items.slice(0, MAX_LISTED).map(([name, count]) => `${name}: ${count}`);
    if (items.length > MAX_LISTED) shown.push('…');
    return shown.join(', ');
}

export interface HealthDeps {
    app: App;
    t: Translate;
    repair: TrackerRepair;
    prefill: PrefillFix;
}

/** Offers to switch on an M22 rule (when M22 runs and knows it). */
function ruleFix(app: App, ruleId: string): (() => Promise<void>) | undefined {
    const rules = app.modules.api<RulesApi>('rules');
    if (!rules || rules.isEnabled(ruleId) || !rules.list().some((rule) => rule.id === ruleId)) return undefined;
    return () => rules.setEnabled(ruleId, true);
}

function ruleOn(app: App, ruleId: string): boolean {
    return app.modules.api<RulesApi>('rules')?.isEnabled(ruleId) === true;
}

export function medicHealthChecks(deps: HealthDeps): HealthCheck[] {
    const { app, t, repair, prefill } = deps;
    const adapters = () => adaptersOf(app);
    const check = (id: string, run: () => Promise<Result> | Result): HealthCheck => ({
        id: `medic.${id}`,
        module: 'M3',
        titleKey: `m3.check.${id}`,
        run: async () => run(),
    });

    return [
        check('deps', () => {
            const problems: string[] = [];
            if (app.host.isGroupChat()) problems.push(t('m3.deps.group'));
            if (!app.host.isChatCompletion()) problems.push(t('m3.deps.textCompletion'));
            if (!app.host.caps.has('st.cm')) problems.push(t('m3.deps.cm'));
            const report = app.host.caps.report();
            const missing = report.filter((cap) => cap.id.startsWith('st.') && !cap.ok && !SEPARATE_CAPS.has(cap.id));
            if (missing.length) {
                const ids = missing.slice(0, MAX_LISTED).map((cap) => cap.id);
                if (missing.length > MAX_LISTED) ids.push('…');
                problems.push(t('m3.deps.caps', { count: missing.length, list: ids.join(', ') }));
            }
            if (problems.length) return { status: 'warn', message: problems.join(' ') };
            const ok = report.filter((cap) => cap.ok).length;
            return { status: 'ok', message: t('m3.deps.ok', { ok, total: report.length }) };
        }),

        check('desTracker', () => {
            const des = adapters().des;
            if (!des.present() || !des.enabled()) return { status: 'skip', message: t('m3.des.absent') };
            if (des.generationMode() !== 'together' || !expectsTracker(des.settings()))
                return { status: 'skip', message: t('m3.tracker.notTogether') };
            const index = lastStoryReply(app);
            if (index < 0) return { status: 'skip', message: t('m3.noReply') };
            // The greeting with the tracker «Подготовить к игре» prepared (M37, 1.18): nothing to repair.
            if (preparedStart(app, index)) return { status: 'ok', message: t('m3.tracker.prepared') };
            const message = app.host.ctx().chat[index];
            if (!trackerMissing(desSwipeRecord(message))) return { status: 'ok', message: t('m3.tracker.ok') };
            return {
                status: 'warn',
                message: t('m3.tracker.missing', { index }),
                fix: async () => {
                    await repair.manual(index);
                },
            };
        }),

        check('regexDamage', () => {
            const des = adapters().des;
            if (!des.present() || !des.enabled() || des.generationMode() !== 'together')
                return { status: 'skip', message: t('m3.tracker.notTogether') };
            const index = lastStoryReply(app);
            if (index < 0) return { status: 'skip', message: t('m3.noReply') };
            const message = app.host.ctx().chat[index];
            const damaged = trackerMissing(desSwipeRecord(message)) && hasFencedJson(message?.mes);
            return damaged
                ? { status: 'warn', message: t('m3.regex.damage', { index }) }
                : { status: 'ok', message: t('m3.regex.ok') };
        }),

        check('desFieldKeys', () => {
            const ad = adapters();
            if (!ad.des.present()) return { status: 'skip', message: t('m3.des.absent') };
            const config = ad.des.settings()?.trackerConfig;
            const names = [
                ...emptyKeyFieldNames(nested(config, 'presentCharacters', 'customFields')),
                ...emptyKeyFieldNames(nested(config, 'infoBox', 'customFields')),
            ];
            const fixOn =
                ad.desru.present() &&
                ad.desru.moduleEnabled('fixes') &&
                nested(ad.desru.settings(), 'modules', 'fixes', 'fieldKeys') !== false;
            const index = lastStoryReply(app);
            const record = index >= 0 ? desSwipeRecord(app.host.ctx().chat[index]) : null;
            if (record && hasEmptyDetailKeys(record.characterThoughts)) {
                return {
                    status: 'warn',
                    message: t(fixOn ? 'm3.fieldKeys.broken' : 'm3.fieldKeys.noFix', {
                        names: names.join(', ') || '""',
                    }),
                };
            }
            if (names.length && !fixOn)
                return { status: 'warn', message: t('m3.fieldKeys.noFix', { names: names.join(', ') }) };
            if (names.length) return { status: 'ok', message: t('m3.fieldKeys.fixed', { names: names.join(', ') }) };
            return { status: 'ok', message: t('m3.fieldKeys.ok') };
        }),

        check('naiMarkers', () => {
            if (!adapters().nai.present()) return { status: 'skip', message: t('m3.nai.absent') };
            const index = lastStoryReply(app);
            if (index < 0) return { status: 'skip', message: t('m3.noReply') };
            return hasRawNaiMarker(app.host.ctx().chat[index]?.mes)
                ? { status: 'warn', message: t('m3.nai.raw', { index }) }
                : { status: 'ok', message: t('m3.nai.ok') };
        }),

        check('qvinkGaps', () => {
            const qvink = adapters().qvink;
            if (!qvink.present()) return { status: 'skip', message: t('m3.qvink.absent') };
            if (!qvink.chatEnabled()) return { status: 'skip', message: t('m3.qvink.off') };
            if (!qvink.removesMessages()) return { status: 'ok', message: t('m3.qvink.keeps') };
            const gaps = findQvinkGaps(qvinkViews(app.host.ctx().chat), qvinkGapOptions(qvink.settings()));
            if (!gaps.length) return { status: 'ok', message: t('m3.qvink.ok') };
            if (ruleOn(app, RULE_QVINK_GAPS)) {
                return { status: 'ok', message: t('m3.qvink.guarded', { count: gaps.length }) };
            }
            const fix = ruleFix(app, RULE_QVINK_GAPS);
            return {
                status: 'warn',
                message: t('m3.qvink.gaps', { count: gaps.length, first: (gaps[0] ?? 0) + 1 }),
                ...(fix ? { fix } : {}),
            };
        }),

        check('assistantDepth', async () => {
            const counts = new Map<string, number>();
            for (const name of await activeBookNames(app)) {
                const found = assistantDepthEntries(bookEntries(await loadBook(app, name))).length;
                if (found) counts.set(name, found);
            }
            if (!counts.size) return { status: 'ok', message: t('m3.lore.assistantOk') };
            const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
            if (ruleOn(app, RULE_ASSISTANT_ROLE))
                return { status: 'ok', message: t('m3.lore.assistantFixed', { count: total }) };
            const fix = ruleFix(app, RULE_ASSISTANT_ROLE);
            return {
                status: 'warn',
                message: t('m3.lore.assistant', { count: total, list: listCounts(counts) }),
                ...(fix ? { fix } : {}),
            };
        }),

        check('localizerKeys', async () => {
            const localizer = adapters().localizer;
            if (!localizer.present()) return { status: 'skip', message: t('m3.localizer.absent') };
            const counts = new Map<string, number>();
            for (const name of await activeBookNames(app)) {
                let broken = 0;
                for (const entry of bookEntries(await loadBook(app, name))) {
                    const marker = localizer.markerOf(entry);
                    if (!marker) continue;
                    const missing = Object.values(marker.languages).some(
                        (state) => missingAddedKeys(entry, state.added).length > 0,
                    );
                    if (missing) broken++;
                }
                if (broken) counts.set(name, broken);
            }
            if (!counts.size) return { status: 'ok', message: t('m3.localizer.ok') };
            const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
            return { status: 'warn', message: t('m3.localizer.missing', { count: total, list: listCounts(counts) }) };
        }),

        check('prefill', () => {
            if (!app.host.isChatCompletion()) return { status: 'skip', message: t('m3.deps.textCompletion') };
            const hit = detectPrefill(app);
            if (!hit) return { status: 'ok', message: t('m3.prefill.ok') };
            return {
                status: 'warn',
                message: t(hit.placement === 'depth' ? 'm3.prefill.foundDepth' : 'm3.prefill.found', {
                    name: hit.name,
                }),
                fix: async () => {
                    await prefill.propose(hit);
                },
            };
        }),
    ];
}
