// Read tools about Maestro itself (M33): its modules, allowlisted settings, health of the stack, the journal and the
// Inbox.
import type { App, HealthCheck } from '../../../../shared/contracts';
import type { DoctorApi } from '../../../doctor/api';
import type { GuardianApi } from '../../../guardian/api';
import type { ToolContext, ToolSpec } from '../../api';
import { maestroVersion } from '../knowledge';
import {
    apiOf,
    argsOf,
    boolArg,
    capList,
    compact,
    cut,
    intArg,
    isDict,
    notice,
    objectSchema,
    prop,
    readTool,
    safely,
    say,
    SENSITIVE,
    SENSITIVE_REF,
    strArg,
    when,
    withTimeout,
} from './common';
import type { Dict } from './common';

/** Module title in the app's language, the key when the string is missing. */
function titleOf(app: App, titleKey: string, fallback: string): string {
    const title = safely(() => app.i18n.t(titleKey), titleKey);
    return title && title !== titleKey ? title : fallback;
}

/** Maps a module key ('director') to its plan id ('M13'); ids pass unchanged. */
function moduleIdOf(app: App, keyOrId: string): string {
    const rows = safely(() => app.modules.list(), []);
    const lower = keyOrId.toLowerCase();
    const row = rows.find((item) => item.module.key.toLowerCase() === lower || item.module.id.toLowerCase() === lower);
    return row?.module.id ?? keyOrId;
}

/** A settings value made small: long strings cut, long arrays capped, deep objects summarised. */
function small(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return cut(value, 300);
    if (Array.isArray(value)) {
        const items = value.slice(0, 30).map((item) => small(item, depth + 1));
        return value.length > 30 ? [...items, `… +${value.length - 30}`] : items;
    }
    if (isDict(value)) {
        if (depth >= 5) return '{…}';
        const out: Dict = {};
        for (const [key, item] of Object.entries(value)) {
            if (SENSITIVE.test(key)) continue;
            out[key] = small(item, depth + 1);
        }
        return out;
    }
    return value;
}

const maestroModules = (app: App): ToolSpec =>
    readTool({
        name: 'maestro_modules',
        description:
            "List Maestro's modules: settings key, plan id, title, stage, whether it is on and running, and missing capabilities. Use it to know what is enabled before explaining or diagnosing.",
        parameters: objectSchema(),
        async run(_args, ctx) {
            const rows = safely(() => app.modules.list(), []);
            const modules = rows
                .map((row) =>
                    compact({
                        key: row.module.key,
                        id: row.module.id,
                        title: titleOf(app, row.module.titleKey, row.module.key),
                        stage: row.module.stage,
                        on: row.enabled,
                        running: row.running,
                        missing: row.missing.length ? row.missing : undefined,
                    }),
                )
                .sort((a, b) => a.stage - b.stage || a.key.localeCompare(b.key));
            const on = modules.filter((row) => row.on).length;
            return {
                data: { modules, on, total: modules.length },
                summary: say(
                    ctx,
                    `Modules: ${on} of ${modules.length} on`,
                    `Модули: включено ${on} из ${modules.length}`,
                ),
            };
        },
    });

const maestroSettings = (): ToolSpec =>
    readTool({
        name: 'maestro_settings',
        description:
            'Read the settings of one Maestro module (only the allowlisted part; secrets, profiles and addresses are never shown). Without `module` it lists the module keys whose settings can be read. Use before proposing a settings change.',
        parameters: objectSchema({
            module: prop.string('Module settings key, e.g. "director", "quality", "architect". Omit to list the keys.'),
        }),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const key = strArg(args, 'module', 64);
            const allowed = safely(() => ctx.settings.modules(), []);
            if (!key) {
                return {
                    data: { modules: allowed },
                    summary: say(
                        ctx,
                        `Settings of ${allowed.length} modules`,
                        `Настройки: модулей — ${allowed.length}`,
                    ),
                };
            }
            const settings = safely(() => ctx.settings.read(key), null);
            if (!settings) {
                return notice(ctx, `No readable settings for "${key}".`, `Нет доступных настроек модуля «${key}».`, {
                    modules: allowed,
                });
            }
            return {
                data: { module: key, settings: small(settings) },
                untrusted: true,
                summary: say(ctx, `Settings: ${key}`, `Настройки: ${key}`),
            };
        },
    });

type CheckResult = { id: string; module: string; title: string; status: string; message?: string };

async function runChecks(app: App, checks: readonly HealthCheck[]): Promise<CheckResult[]> {
    return Promise.all(
        checks.slice(0, 40).map(async (check): Promise<CheckResult> => {
            const title = titleOf(app, check.titleKey, check.id);
            // A failing check is an error result; a hanging one is skipped after 4 s.
            const running = Promise.resolve()
                .then(() => check.run())
                .catch((error: unknown) => ({
                    status: 'error' as const,
                    message: error instanceof Error ? error.message : String(error),
                }));
            const result = await withTimeout(running, 4000, { status: 'skip' as const, message: 'timeout' });
            return compact({
                id: check.id,
                module: check.module,
                title,
                status: result.status,
                message: result.message ? cut(result.message, 200) : undefined,
            });
        }),
    );
}

const RANK: Record<string, number> = { error: 0, warn: 1, skip: 2, info: 2, ok: 3 };

const maestroHealth = (app: App): ToolSpec =>
    readTool({
        name: 'maestro_health',
        description:
            "Health of Maestro and the stack: health checks (Medic, guardian, modules) with their status, failing capabilities, neighbour extensions (present, version), SillyTavern version, Chat Completion / group chat, Maestro's version and mode, the Doctor's findings and the tab guard state. Use first when something «does not work».",
        parameters: objectSchema({
            run_checks: prop.boolean('Run the health checks now (default true; false = only the static report).'),
        }),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const ui = app.ui as { healthChecks?: () => HealthCheck[] };
            const checksList = safely(() => ui.healthChecks?.() ?? [], [] as HealthCheck[]);
            const checks = boolArg(args, 'run_checks', true) ? await runChecks(app, checksList) : [];
            checks.sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4));
            const caps = safely(() => app.host.caps.report(), []);
            const failingCaps = caps
                .filter((cap) => !cap.ok)
                .slice(0, 25)
                .map((cap) => compact({ id: cap.id, detail: cap.detail ? cut(cap.detail, 120) : undefined }));
            const neighbours = Object.values(app.adapters ?? {}).map((adapter) =>
                compact({
                    id: adapter.id,
                    present: safely(() => adapter.present(), false),
                    version: safely(() => adapter.version(), undefined),
                }),
            );
            const doctor = apiOf<DoctorApi>(app, 'doctor');
            const findings = doctor ? safely(() => doctor.findings(), []) : [];
            const guardian = apiOf<GuardianApi>(app, 'guardian');
            const counts = { error: 0, warn: 0, ok: 0, skip: 0 } as Record<string, number>;
            for (const check of checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
            const data = {
                maestro: compact({
                    version: maestroVersion() ?? undefined,
                    mode: safely(() => app.settings.core().mode, undefined),
                }),
                host: {
                    sillyTavern: safely(() => app.host.version() ?? null, null),
                    chatCompletion: safely(() => app.host.isChatCompletion(), false),
                    groupChat: safely(() => app.host.isGroupChat(), false),
                    chatOpen: safely(() => app.host.chatId() !== null, false),
                },
                checks,
                capabilities: { ok: caps.filter((cap) => cap.ok).length, failing: failingCaps },
                neighbours,
                doctor: doctor
                    ? {
                          lastScan: when(safely(() => doctor.lastScanAt?.(), 0)),
                          findings: capList(
                              [...findings]
                                  .sort((a, b) => (RANK[a.severity] ?? 4) - (RANK[b.severity] ?? 4))
                                  .map((finding) =>
                                      compact({
                                          kind: finding.kind,
                                          severity: finding.severity,
                                          text: cut(
                                              safely(() => app.i18n.t(finding.messageKey, finding.params), ''),
                                              160,
                                          ),
                                      }),
                                  ),
                              12,
                          ),
                      }
                    : undefined,
                guardian: guardian
                    ? {
                          tab: safely(() => guardian.tabState(), 'unknown'),
                          baseline: safely(() => guardian.hasBaseline(), false),
                      }
                    : undefined,
            };
            const present = neighbours.filter((row) => row.present).length;
            return {
                data: compact(data),
                untrusted: true,
                summary: say(
                    ctx,
                    `Health: ${counts.error ?? 0} errors, ${counts.warn ?? 0} warnings; neighbours ${present}/${neighbours.length}`,
                    `Здоровье: ошибок ${counts.error ?? 0}, предупреждений ${counts.warn ?? 0}; соседи ${present}/${neighbours.length}`,
                ),
            };
        },
    });

/** A change's values for the model, unless the target or locator looks sensitive. */
function changeView(change: { target: string; ref: Dict; before: unknown; after: unknown }): Dict {
    const sensitive = SENSITIVE_REF.test(change.target) || SENSITIVE_REF.test(JSON.stringify(change.ref ?? {}));
    const view: Dict = { target: change.target };
    if (sensitive) return view;
    const show = (value: unknown) => (typeof value === 'string' ? cut(value, 120) : cut(JSON.stringify(value), 120));
    if (change.before !== undefined) view.before = show(change.before);
    if (change.after !== undefined) view.after = show(change.after);
    return view;
}

const journalRecent = (app: App): ToolSpec =>
    readTool({
        name: 'journal_recent',
        description:
            'The newest records of Maestro\'s journal (what Maestro or the user changed, with before/after and whether it was undone), newest first. Filter by module key or plan id (e.g. "canon" or "M6").',
        parameters: objectSchema({
            limit: prop.integer('How many records (1-40, default 15).', { minimum: 1, maximum: 40 }),
            module: prop.string('Only records of this module (settings key like "director" or plan id like "M13").'),
        }),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const limit = intArg(args, 'limit', 15, 1, 40);
            const module = strArg(args, 'module', 40);
            const filter: { module?: string; limit: number } = { limit };
            if (module) filter.module = moduleIdOf(app, module);
            const records = safely(() => app.journal.list(filter), [])
                .slice(-limit)
                .reverse();
            const items = records.map((record) =>
                compact({
                    id: record.id,
                    at: when(record.at),
                    module: record.module,
                    kind: record.kind,
                    summary: cut(record.summary, 200),
                    undone: record.undone ? true : undefined,
                    message: record.sourceMessage,
                    changes: record.changes.length,
                    details: record.changes.slice(0, 3).map(changeView),
                }),
            );
            return {
                data: { records: items },
                untrusted: true,
                summary: say(ctx, `Journal: ${items.length} records`, `Журнал: записей — ${items.length}`),
            };
        },
    });

const inboxList = (app: App): ToolSpec =>
    readTool({
        name: 'inbox_list',
        description:
            "Cards waiting in Maestro's Inbox (proposals: canon facts, merges, drift, outfits…) with their module, kind, title, number of changes and source message. Newest first.",
        parameters: objectSchema({
            limit: prop.integer('How many cards (1-40, default 15).', { minimum: 1, maximum: 40 }),
        }),
        async run(rawArgs, ctx: ToolContext) {
            const args = argsOf(rawArgs);
            const limit = intArg(args, 'limit', 15, 1, 40);
            await withTimeout(Promise.resolve(app.inbox.load?.()), 3000, undefined);
            const cards = [...safely(() => app.inbox.list(), [])].sort((a, b) => b.createdAt - a.createdAt);
            const list = capList(cards, limit);
            const items = list.items.map((card) =>
                compact({
                    id: card.id,
                    module: card.module,
                    kind: card.kind,
                    title: cut(card.title, 160),
                    description: card.description ? cut(card.description, 200) : undefined,
                    changes: card.changes.length,
                    targets: [...new Set(card.changes.map((change) => change.target))],
                    created: when(card.createdAt),
                    message: card.sourceMessage,
                    deferred: card.deferred ? true : undefined,
                }),
            );
            return {
                data: { cards: items, total: list.total },
                untrusted: true,
                summary: say(ctx, `Inbox: ${list.total} cards`, `Входящие: карточек — ${list.total}`),
            };
        },
    });

export function maestroTools(app: App): ToolSpec[] {
    return [maestroModules(app), maestroSettings(), maestroHealth(app), journalRecent(app), inboxList(app)];
}
