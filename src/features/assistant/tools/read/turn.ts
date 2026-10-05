// Read tools about one turn (M33): how its prompt was made (inspector + architect), which lore fired and why not
// (lore journal + the pure explainer), and what it cost and why (treasurer + the pure cost explainer).
import { costHints, costTotals, COST_HINT_TEXT } from '../../../../domain/assistant-explain-cost';
import { explainLoreEntry, LORE_REASON_TEXT } from '../../../../domain/assistant-explain-lore';
import type { LoreEntryLike, LoreReasonCode } from '../../../../domain/assistant-explain-lore';
import { parseRegexKey } from '../../../../domain/lore-match';
import type { App } from '../../../../shared/contracts';
import type { ArchitectApi, ArchitectReport } from '../../../architect/api';
import type { CanonApi } from '../../../canon/api';
import type { InspectorApi, InspectorRecord } from '../../../inspector/api';
import type { LoreJournalApi, TurnLoreRecord } from '../../../loreJournal/api';
import type { QualityApi } from '../../../quality/api';
import type { SpendLine, TreasurerApi } from '../../../treasurer/api';
import type { WorldModelApi } from '../../../world/api';
import type { ToolContext, ToolSpec } from '../../api';
import {
    activeBooks,
    apiOf,
    argsOf,
    capList,
    chatTexts,
    compact,
    cut,
    enumArg,
    intArg,
    keysOf,
    loadBook,
    needsApi,
    notice,
    objectSchema,
    optIntArg,
    prop,
    readTool,
    safely,
    say,
    strArg,
    when,
    wiSettings,
    withTimeout,
} from './common';
import type { Dict } from './common';

const MESSAGE_INDEX = prop.integer('Assistant message index of the turn (omit for the latest turn).', { minimum: 0 });

/* ------------------------------------------------------------------ turn_prompt */

function inspectorTurn(app: App, index: number | undefined): InspectorRecord | undefined {
    const inspector = apiOf<InspectorApi>(app, 'inspector');
    if (!inspector) return undefined;
    if (index === undefined) return safely(() => inspector.last(), undefined);
    return safely(() => inspector.turns().find((record) => record.messageIndex === index), undefined);
}

function architectReport(app: App, index: number | undefined): ArchitectReport | null {
    const architect = apiOf<ArchitectApi>(app, 'architect');
    if (!architect) return null;
    const reports = safely(() => architect.reports?.() ?? [], [] as ArchitectReport[]);
    if (index !== undefined) return reports.find((report) => report.messageIndex === index) ?? null;
    return safely(() => architect.lastReport(), null);
}

function loreTurn(app: App, index: number | undefined): TurnLoreRecord | undefined {
    const journal = apiOf<LoreJournalApi>(app, 'loreJournal');
    if (!journal) return undefined;
    const turns = safely(() => journal.turns().filter((record) => !record.simulated), [] as TurnLoreRecord[]);
    if (index !== undefined) return turns.find((record) => record.messageIndex === index);
    return turns[turns.length - 1] ?? safely(() => journal.last(), undefined);
}

/** Prompt tokens by source kind (preset, card, lore, extension, history). */
function tokensByKind(record: InspectorRecord): Record<string, number> {
    const byKind: Record<string, number> = {};
    for (const source of record.sources) byKind[source.kind] = (byKind[source.kind] ?? 0) + source.tokens;
    return byKind;
}

const turnPrompt = (app: App): ToolSpec =>
    readTool({
        name: 'turn_prompt',
        description:
            "How the prompt of a turn was assembled (Turn inspector): total tokens, messages, tokens by source (preset blocks, card, lore by book, extension injections of DES/CK/Qvink/NAI/DES-RU/Maestro, chat history) and what was cut (lore over budget, the architect's budget trims, damped entries). Use for «why is the prompt so big», «where did X go».",
        parameters: objectSchema({ message_index: MESSAGE_INDEX }),
        available: needsApi('inspector'),
        async run(rawArgs, ctx) {
            const index = optIntArg(argsOf(rawArgs), 'message_index');
            const record = inspectorTurn(app, index);
            if (!record) return notice(ctx, 'No inspected turn yet.', 'Пока нет разобранного хода.');
            const sources = [...record.sources].sort((a, b) => b.tokens - a.tokens);
            const list = capList(
                sources.map((source) =>
                    compact({
                        id: source.id,
                        kind: source.kind,
                        owner: source.owner,
                        name: source.name,
                        tokens: source.tokens,
                    }),
                ),
                30,
            );
            const lore = loreTurn(app, record.messageIndex);
            const report = architectReport(app, record.messageIndex);
            const cutLore = (lore?.activations ?? [])
                .filter((activation) => activation.cut)
                .slice(0, 15)
                .map((activation) =>
                    compact({
                        book: activation.world,
                        uid: activation.uid,
                        title: cut(activation.comment, 60),
                        tokens: activation.tokens,
                        by: activation.cutBy ?? 'other',
                    }),
                );
            const architect = report
                ? compact({
                      budgets: report.budgets
                          .filter((budget) => budget.limit > 0 || (budget.status && budget.status !== 'off'))
                          .map((budget) => compact({ ...budget })),
                      trims: report.trims?.slice(0, 10),
                      cuts: report.cuts?.slice(0, 10).map((item) => ({ ...item, comment: cut(item.comment, 60) })),
                      damped: report.damped.length || undefined,
                      pinned: report.pinned?.length || undefined,
                      effects: report.effects,
                  })
                : undefined;
            return {
                data: compact({
                    messageIndex: record.messageIndex,
                    at: when(record.at),
                    type: record.generationType,
                    totalTokens: record.totalTokens,
                    exact: record.exact,
                    messages: record.messages,
                    byKind: tokensByKind(record),
                    sources: list,
                    loreCut: cutLore.length ? cutLore : undefined,
                    loreBudget: lore?.budgetTokens,
                    loreOverflow: lore?.overflow || undefined,
                    architect,
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Prompt of turn #${record.messageIndex}: ${record.totalTokens} tokens`,
                    `Промпт хода №${record.messageIndex}: ${record.totalTokens} токенов`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ lore_turn */

interface Candidate {
    book: string;
    uid: number;
    entry: Dict;
}

function norm(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е').trim();
}

/** Lore entries about a name: the world model's sources first, then entries whose keys or title name it. */
async function entriesAbout(app: App, name: string, limit: number): Promise<Candidate[]> {
    const found: Candidate[] = [];
    const seen = new Set<string>();
    const books = new Map<string, { entries: Record<string, Dict> } | null>();
    const book = async (world: string) => {
        if (!books.has(world)) books.set(world, await loadBook(app, world));
        return books.get(world) ?? null;
    };
    const add = (world: string, uid: number, entry: Dict) => {
        const id = `${world}#${uid}`;
        if (seen.has(id) || found.length >= limit) return;
        seen.add(id);
        found.push({ book: world, uid, entry });
    };
    const world = apiOf<WorldModelApi>(app, 'world');
    const entity = world ? safely(() => world.resolve(name), undefined) : undefined;
    const names = new Set([norm(name)]);
    if (entity) {
        for (const alias of [entity.name, ...entity.aliases, ...entity.forms]) names.add(norm(alias));
        for (const source of entity.sources) {
            if ((source.kind !== 'lore.entry' && source.kind !== 'canon.entry') || !source.world) continue;
            if (source.uid === undefined) continue;
            const data = await book(source.world);
            const entry = data?.entries[String(source.uid)];
            if (entry) add(source.world, source.uid, entry);
        }
    }
    const wanted = [...names].filter((item) => item.length >= 3);
    for (const name of await activeBooks(app)) {
        if (found.length >= limit) break;
        const data = await book(name);
        if (!data) continue;
        for (const [uid, entry] of Object.entries(data.entries)) {
            const rawKeys = keysOf(entry.key);
            const keys = rawKeys.map(norm);
            const regexes = rawKeys.map((key) => parseRegexKey(key)).filter((regex): regex is RegExp => !!regex);
            const title = norm(typeof entry.comment === 'string' ? entry.comment : '');
            const hit = wanted.some(
                (item) =>
                    keys.some((key) => key === item || key.includes(item)) ||
                    title.includes(item) ||
                    regexes.some((regex) => {
                        regex.lastIndex = 0;
                        return regex.test(item);
                    }),
            );
            if (hit) add(name, Number(uid), entry);
        }
    }
    return found;
}

const loreTurnTool = (app: App): ToolSpec =>
    readTool({
        name: 'lore_turn',
        description:
            'Which lorebook entries reached the prompt of a turn (Lore journal): key that matched, recursion, tokens, entries cut by the budget or a rule. With `name` it also finds the entries about that character/place/thing and explains for each one why it did NOT fire (no key in the scanned messages, said earlier than the scan depth, another Russian case form, secondary keys, probability, group, filters, timers). Use for «why did the heroine not recognise her sister?».',
        parameters: objectSchema({
            message_index: MESSAGE_INDEX,
            name: prop.string('A character, place or thing to explain (any name, alias or case form).'),
        }),
        available: needsApi('loreJournal'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const journal = apiOf<LoreJournalApi>(app, 'loreJournal');
            const index = optIntArg(args, 'message_index');
            const raw = loreTurn(app, index);
            if (!journal || !raw) return notice(ctx, 'No lore turn recorded yet.', 'Журнал лора ещё пуст.');
            const record = await withTimeout(journal.attributeKeys(raw), 3000, raw);
            const activations = [...record.activations].sort((a, b) => b.tokens - a.tokens);
            const list = capList(
                activations.map((activation) =>
                    compact({
                        book: activation.world,
                        uid: activation.uid,
                        title: cut(activation.comment, 60),
                        tokens: activation.tokens,
                        key: activation.key ? cut(activation.key, 60) : undefined,
                        recursion: activation.recursionLevel || undefined,
                        via: activation.via ? `${activation.via.world}#${activation.via.uid}` : undefined,
                        constant: activation.tags.includes('constant') || undefined,
                        cut: activation.cut ? (activation.cutBy ?? 'other') : undefined,
                        tags: activation.tags.filter((tag) => tag !== 'constant'),
                    }),
                ),
                // Fewer rows when the entries about a name follow (the result stays within the core's cap).
                strArg(args, 'name', 80) ? 25 : 40,
            );
            const data: Dict = {
                messageIndex: record.messageIndex,
                at: when(record.at),
                type: record.generationType,
                totalTokens: record.totalTokens,
                budgetTokens: record.budgetTokens,
                overflow: record.overflow || undefined,
                activations: list,
                cut: record.activations.filter((activation) => activation.cut).length,
            };
            const canon = apiOf<CanonApi>(app, 'canon');
            const scan = canon ? safely(() => canon.lastScan?.() ?? null, null) : null;
            if (scan) data.canonScan = { ...scan, at: when(scan.at) };
            const name = strArg(args, 'name', 80);
            if (name) {
                const settings = await wiSettings(app);
                const messages = chatTexts(app, 300);
                const candidates = await entriesAbout(app, name, 8);
                const codes = new Set<LoreReasonCode>();
                data.about = {
                    name,
                    scanDepth: settings.depth,
                    entries: candidates.map((candidate) => {
                        const activation = record.activations.find(
                            (item) => item.world === candidate.book && item.uid === candidate.uid,
                        );
                        const explanation = explainLoreEntry(candidate.entry as LoreEntryLike, {
                            messages,
                            depth: settings.depth,
                            globals: { caseSensitive: settings.caseSensitive, matchWholeWords: settings.wholeWords },
                            activation: activation ? { cut: activation.cut, cutBy: activation.cutBy } : null,
                        });
                        return compact({
                            book: candidate.book,
                            uid: candidate.uid,
                            title: cut(candidate.entry.comment, 60),
                            keys: keysOf(candidate.entry.key).slice(0, 8),
                            fired: explanation.fired,
                            reasons: explanation.reasons.map((reason) => {
                                codes.add(reason.code);
                                return compact({
                                    code: reason.code,
                                    detail: reason.detail ? cut(reason.detail, 120) : undefined,
                                });
                            }),
                        });
                    }),
                };
                // Each reason explained once, in the user's language.
                (data.about as Dict).reasonTexts = Object.fromEntries(
                    [...codes].map((code) => [code, LORE_REASON_TEXT[ctx.locale][code]]),
                );
                if (!candidates.length) {
                    (data.about as Dict).note =
                        'No entry about this name was found in the active lorebooks (the character may have no lore at all).';
                }
            }
            return {
                data: compact(data),
                untrusted: true,
                summary: say(
                    ctx,
                    `Lore of turn #${record.messageIndex}: ${record.activations.length} entries${name ? `, about «${name}»` : ''}`,
                    `Лор хода №${record.messageIndex}: записей ${record.activations.length}${name ? `, о «${name}»` : ''}`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ cost_turn, cost_summary */

function lineView(line: SpendLine): Dict {
    const prompt = line.tokens.prompt;
    return compact({
        source: line.source,
        usd: Math.round(line.usd * 10000) / 10000,
        requests: line.requests,
        prompt,
        completion: line.tokens.completion,
        cached: line.tokens.cached,
        cacheShare:
            prompt > 0 && line.tokens.cached !== undefined
                ? Math.round((line.tokens.cached / prompt) * 100) / 100
                : undefined,
        anlas: line.anlas,
        estimated: line.estimated || undefined,
    });
}

const costTurn = (app: App): ToolSpec =>
    readTool({
        name: 'cost_turn',
        description:
            "What a turn cost and why (Treasurer): spend by source (main model, regenerations, auto-swipes, Qvink, Maestro tasks, NAI Anlas), tokens, provider cache share, the prompt's weight by source kind, quality-check retries, and reasons (retries, low cache, big prompt, lore/history heavy, background work, pictures, long reply, above the recent average). Use for «why was this turn expensive?».",
        parameters: objectSchema({ message_index: MESSAGE_INDEX }),
        available: needsApi('treasurer'),
        async run(rawArgs, ctx) {
            const treasurer = apiOf<TreasurerApi>(app, 'treasurer');
            const index = optIntArg(argsOf(rawArgs), 'message_index');
            const turns = treasurer ? safely(() => treasurer.turns(30), []) : [];
            const turn =
                index === undefined ? turns[turns.length - 1] : turns.find((item) => item.messageIndex === index);
            if (!turn) return notice(ctx, 'No spend recorded for this turn.', 'Для этого хода расходов не записано.');
            const others = turns.filter((item) => item !== turn);
            const averageUsd = others.length
                ? others.reduce((sum, item) => sum + costTotals(item.lines).usd, 0) / others.length
                : undefined;
            const record = inspectorTurn(app, turn.messageIndex);
            const byKind = record ? tokensByKind(record) : undefined;
            const hints = costHints({ lines: turn.lines, promptByKind: byKind, averageUsd });
            const quality = apiOf<QualityApi>(app, 'quality');
            const verdict = quality ? safely(() => quality.verdict(turn.messageIndex), undefined) : undefined;
            const architect = apiOf<ArchitectApi>(app, 'architect');
            const cache = architect ? safely(() => architect.cache(), null) : null;
            const totals = costTotals(turn.lines);
            return {
                data: compact({
                    messageIndex: turn.messageIndex,
                    at: when(turn.at),
                    totals,
                    lines: turn.lines.map(lineView),
                    promptByKind: byKind,
                    averageUsd: averageUsd === undefined ? undefined : Math.round(averageUsd * 10000) / 10000,
                    quality: verdict
                        ? compact({
                              ok: verdict.ok,
                              action: verdict.action,
                              defects: verdict.defects.map((defect) => defect.kind),
                              judgeUsd: verdict.costUsd || undefined,
                          })
                        : undefined,
                    providerCache: cache
                        ? { hitRate: Math.round(cache.hitRate * 100) / 100, firstChangeAt: cache.firstChangeAt }
                        : undefined,
                    reasons: hints.map((hint) =>
                        compact({
                            code: hint.code,
                            detail: hint.detail || undefined,
                            text: COST_HINT_TEXT[ctx.locale][hint.code],
                        }),
                    ),
                }),
                summary: say(
                    ctx,
                    `Turn #${turn.messageIndex}: $${totals.usd}${hints.length ? `, ${hints.length} reasons` : ''}`,
                    `Ход №${turn.messageIndex}: $${totals.usd}${hints.length ? `, причин: ${hints.length}` : ''}`,
                ),
            };
        },
    });

const PERIODS = ['turn', 'session', 'day', 'days'] as const;

const costSummary = (app: App): ToolSpec =>
    readTool({
        name: 'cost_summary',
        description:
            'Spending totals: the last turn, this session, today (by source, with Anlas) or the last N days. Works from the core cost meter when the Treasurer is off (today only).',
        parameters: objectSchema({
            period: prop.enum('Period (default "day").', PERIODS),
            days: prop.integer('For period "days": how many days (1-14, default 7).', { minimum: 1, maximum: 14 }),
        }),
        async run(rawArgs, ctx: ToolContext) {
            const args = argsOf(rawArgs);
            const period = enumArg(args, 'period', PERIODS, 'day') ?? 'day';
            const treasurer = apiOf<TreasurerApi>(app, 'treasurer');
            const core = safely(() => app.cost.summary(), null);
            const coreView = core
                ? {
                      todayUsd: Math.round(core.todayUsd * 10000) / 10000,
                      bySource: core.todayBySource,
                      backgroundTodayUsd: Math.round(core.backgroundTodayUsd * 10000) / 10000,
                      anlasToday: core.anlasToday,
                      backgroundCapReached: safely(() => app.cost.backgroundCapReached(), false),
                  }
                : undefined;
            if (!treasurer) {
                return {
                    data: compact({
                        period: 'day',
                        core: coreView,
                        note: "Treasurer is off: only today's core totals.",
                    }),
                    summary: say(ctx, `Today: $${coreView?.todayUsd ?? 0}`, `Сегодня: $${coreView?.todayUsd ?? 0}`),
                };
            }
            if (period === 'days') {
                const days = await withTimeout(treasurer.days(intArg(args, 'days', 7, 1, 14)), 4000, []);
                const rows = days.map((day) => ({
                    day: when(day.from)?.slice(0, 10),
                    usd: Math.round(day.totalUsd * 10000) / 10000,
                    anlas: day.totalAnlas || undefined,
                }));
                const total = rows.reduce((sum, row) => sum + row.usd, 0);
                return {
                    data: { period, days: rows, totalUsd: Math.round(total * 10000) / 10000 },
                    summary: say(
                        ctx,
                        `${rows.length} days: $${total.toFixed(2)}`,
                        `Дней ${rows.length}: $${total.toFixed(2)}`,
                    ),
                };
            }
            const summary = safely(() => treasurer.summary(period), null);
            if (!summary) return notice(ctx, 'No spending data.', 'Нет данных о расходах.');
            return {
                data: compact({
                    period,
                    from: when(summary.from),
                    to: when(summary.to),
                    totalUsd: Math.round(summary.totalUsd * 10000) / 10000,
                    totalAnlas: summary.totalAnlas || undefined,
                    lines: summary.lines.map(lineView),
                    core: period === 'day' ? coreView : undefined,
                }),
                summary: say(
                    ctx,
                    `Spending (${period}): $${summary.totalUsd.toFixed(3)}`,
                    `Расходы (${{ turn: 'ход', session: 'сессия', day: 'день' }[period]}): $${summary.totalUsd.toFixed(3)}`,
                ),
            };
        },
    });

export function turnTools(app: App): ToolSpec[] {
    return [turnPrompt(app), loreTurnTool(app), costTurn(app), costSummary(app)];
}
