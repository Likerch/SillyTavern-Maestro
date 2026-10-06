// Pult tab «Доктор»: findings grouped by severity and kind (with target links, «Включить правило», «Исправить в
// файле» and regex actions), the active books, the regex inventory with enable/disable/delete and the test bench.
// A finding an enabled M22 rule already handles reads «исправляется правилом на лету».
import { REGEX_PLACEMENT, regexMode } from '../../domain/doctor-regex';
import type { RegexScriptInfo } from '../../domain/doctor-regex';
import { packGroupId } from '../../domain/rules-packs';
import type { App, Decision, PultTab, Ui } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { numberInput, segmented, select } from '../../ui/components/controls';
import { button, clear, el, prefersReducedMotion } from '../../ui/components/dom';
import { diffView } from '../../ui/components/diff';
import { table } from '../../ui/components/table';
import { formatTime } from '../../ui/views/format';
import type { BookStat, Finding, FindingKind, FindingSeverity, RegexAction, RegexInfo } from './api';
import { fileFixOffered } from './fixes';
import type { BookFacts, FileFixOutcome } from './fixes';
import { regexRoute } from './regex-fix';
import { ENABLE_RULE_KIND, ENABLE_RULE_LEVEL, enableRule, ruleState, rulesApi } from './rules';
import type { DoctorService } from './service';
import { chatSample, openBook } from './sources';

export const DOCTOR_TAB = 'doctor';
const SEVERITIES: readonly FindingSeverity[] = ['error', 'warn', 'info'];
const LEVEL: Record<FindingSeverity, 'error' | 'warn' | 'info'> = { error: 'error', warn: 'warn', info: 'info' };

interface BenchState {
    scriptId: string;
    source: 'last' | 'custom';
    count: number;
    custom: string;
    output: HTMLElement | null;
}

/** Numbers grouped by thousands and regex scopes translated; other params pass through. */
export function localizeParams(
    app: App,
    params: Record<string, string | number> | undefined,
): Record<string, string | number> {
    const t = app.i18n.t.bind(app.i18n);
    const locale = app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US';
    const result: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params ?? {})) {
        if (key === 'type' && typeof value === 'string') result[key] = t(`m5.regexType.${value}`);
        else if (typeof value === 'number' && Math.abs(value) >= 1000) result[key] = value.toLocaleString(locale);
        else result[key] = value;
    }
    return result;
}

export function findingText(app: App, finding: Finding): string {
    return app.i18n.t(finding.messageKey, localizeParams(app, finding.params));
}

function closePult(ui: Ui): void {
    // UiImpl has closePult(); the contract does not (yet).
    (ui as Ui & { closePult?: () => void }).closePult?.();
}

/** Which regex action a finding offers, for which of its scripts (dead scripts are only ever disabled). */
export function regexFixFor(finding: Finding): { action: RegexAction; position: number; note?: string } | null {
    switch (finding.kind) {
        case 'regex.breaksJson':
        case 'regex.breaksMarkers':
        case 'regex.stripsTags':
            return { action: 'disable', position: 0 };
        case 'regex.conflict':
            // The later script never finds anything: the first one already replaced it.
            return { action: 'disable', position: 1 };
        case 'regex.duplicate':
            return { action: 'delete', position: 1 };
        case 'regex.dead':
            if (finding.messageKey === 'm5.f.regexDead')
                return { action: 'disable', position: 0, note: 'm5.regexFix.deadNote' };
            if (finding.messageKey === 'm5.f.regexInvalid') return { action: 'disable', position: 0 };
            return null;
        default:
            return null;
    }
}

function placementText(app: App, placement: number[]): string {
    return placement.map((place) => app.i18n.t(`m5.place.${place}`)).join(', ') || '—';
}

function depthText(app: App, info: RegexInfo): string {
    const min = info.minDepth ?? null;
    const max = info.maxDepth ?? null;
    if (min === null && max === null) return app.i18n.t('m5.depthAny');
    return `${min ?? 0}–${max ?? '∞'}`;
}

export function doctorTab(app: App, service: DoctorService): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const bench: BenchState = { scriptId: '', source: 'last', count: 3, custom: '', output: null };
    /** A reply to his click in this tab: always shown, whatever the notification level. */
    const reply = (text: string, level?: 'warn'): void =>
        app.ui.notice(text, level ? { level, urgent: true } : { urgent: true });

    return {
        id: DOCTOR_TAB,
        titleKey: 'm5.tab',
        icon: 'fa-stethoscope',
        order: 65,
        badge: () =>
            service.isStale() ? 0 : (service.last()?.findings.filter((f) => f.severity === 'error').length ?? 0),
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-m5' });
            container.appendChild(root);

            const rescan = async () => {
                await service.scan();
            };

            const header = (): HTMLElement => {
                const result = service.last();
                const scanning = service.isScanning();
                const status = scanning
                    ? t('m5.scanning')
                    : result
                      ? t('m5.lastScan', {
                            time: formatTime(result.at, app.i18n),
                            books: result.books.length,
                            entries: result.entries,
                            scripts: result.scripts.length,
                        })
                      : t('m5.neverScanned');
                return el('div', { class: 'maestro-m5-head' }, [
                    el('div', { class: 'maestro-row' }, [
                        button({
                            label: result ? t('m5.rescan') : t('m5.scan'),
                            icon: 'fa-stethoscope',
                            kind: 'primary',
                            disabled: scanning,
                            onClick: rescan,
                        }),
                        el('span', { class: 'maestro-muted', text: status }),
                    ]),
                    service.isStale() ? banner(t('m5.staleChat'), 'warn', 'fa-clock-rotate-left') : null,
                    ...(result?.notes ?? []).map((note) => banner(t(note), 'info', 'fa-circle-info')),
                ]);
            };

            /** The stored answer of rule 'pack.versionConflict' for the books of a finding. */
            const packAnswer = (finding: Finding): string | undefined => {
                const books = Array.isArray(finding.target.books)
                    ? finding.target.books.filter((book): book is string => typeof book === 'string')
                    : [];
                let options: Record<string, unknown> | undefined;
                try {
                    options = finding.fixRule ? rulesApi(app)?.options?.(finding.fixRule) : undefined;
                } catch {
                    options = undefined;
                }
                const choices = options?.choices;
                const value =
                    typeof choices === 'object' && choices !== null
                        ? (choices as Record<string, unknown>)[packGroupId(books)]
                        : undefined;
                return typeof value === 'string' ? value : undefined;
            };

            const ruleControl = (finding: Finding): HTMLElement | null => {
                if (!finding.fixRule) return null;
                if (!rulesApi(app)) return null;
                const state = ruleState(app, finding.fixRule);
                if (!state) return el('span', { class: 'maestro-muted', text: t('m5.ruleLater') });
                if (state.enabled && state.waiting) return badge(t('m5.ruleWaits'), 'muted');
                if (state.enabled && state.available === false) {
                    return badge(t('m5.ruleUnavailable', { missing: (state.missing ?? []).join(', ') }), 'warn');
                }
                if (state.enabled && finding.kind === 'pack.versionConflict') {
                    // The rule suppresses nothing until the one question is answered.
                    const answer = packAnswer(finding);
                    if (answer === undefined) return badge(t('m5.rulePackPending'), 'muted');
                    if (answer === '') return badge(t('m5.rulePackKeepsAll'), 'muted');
                }
                if (state.enabled) return badge(t('m5.ruleHandles'), 'ok');
                return button({
                    label: t('m5.enableRule'),
                    icon: 'fa-wand-magic-sparkles',
                    title: t('m5.ruleTitle', { rule: t(state.definition.titleKey) }),
                    onClick: async () => {
                        const rule = t(state.definition.titleKey);
                        // 'auto' announces «Включил правило …» itself (with undo): no second notice then.
                        const auto = app.autonomy.level(ENABLE_RULE_KIND, ENABLE_RULE_LEVEL) === 'auto';
                        const decision = await enableRule(app, state, finding, findingText(app, finding));
                        if (decision === 'applied' && !auto) reply(t('m5.enableRuleDone', { rule }));
                        else if (decision === 'queued') reply(t('m5.enableRuleQueued', { rule }));
                        if (alive) draw();
                    },
                });
            };

            const fileFixNotice = (outcome: FileFixOutcome | null): void => {
                if (!outcome) return;
                const book = outcome.book;
                if (outcome.status === 'decided') {
                    if (outcome.decision === 'applied') {
                        reply(t('m5.fixFile.done', { book, count: outcome.count }));
                    } else if (outcome.decision === 'queued') {
                        reply(t('m5.fixFile.queued', { book }));
                    }
                } else if (outcome.status === 'nothing') {
                    reply(t('m5.fixFile.none', { book }));
                } else if (outcome.status === 'protected') {
                    reply(t('m5.bunnyBook'), 'warn');
                } else {
                    reply(t('m5.fixFile.unavailable'), 'warn');
                }
            };

            const fileFixControl = (finding: Finding, facts: BookFacts | undefined): HTMLElement | null => {
                if (!facts || !fileFixOffered(finding, facts)) return null;
                return button({
                    label: t('m5.fixFile'),
                    icon: 'fa-file-pen',
                    title: t('m5.fixFile.hint'),
                    onClick: async () => {
                        fileFixNotice(await service.fixFinding(finding.id));
                        if (alive) draw();
                    },
                });
            };

            const regexNotice = (decision: Decision, action: RegexAction, name: string, auto: boolean): void => {
                if (decision === 'applied' && !auto) reply(t(`m5.regexFix.done.${action}`, { name }));
                else if (decision === 'queued') reply(t('m5.regexFix.queued', { name }));
            };

            const runRegexAction = async (script: RegexScriptInfo, action: RegexAction, note?: string) => {
                const name = script.name || t('m5.regex.unnamed');
                // 'auto' announces the change itself (with undo): no second notice then.
                const route = regexRoute(script, action);
                const auto = app.autonomy.level(route.kind, route.fallback) === 'auto';
                const decision = await service.regexAction(script.id, action, note ? t(note) : undefined);
                regexNotice(decision, action, name, auto);
                if (alive) draw();
            };

            const regexControl = (finding: Finding, scripts: RegexScriptInfo[]): HTMLElement[] => {
                const fix = regexFixFor(finding);
                const targets = Array.isArray(finding.target.scripts) ? finding.target.scripts : [];
                const target = fix ? (targets[fix.position] as { id?: unknown } | undefined) : undefined;
                const script = scripts.find((item) => item.id === target?.id);
                if (!fix || !script || script.disabled) return [];
                const name = script.name || t('m5.regex.unnamed');
                const label =
                    fix.action === 'delete'
                        ? t('m5.regexFix.deleteCopy', { name })
                        : fix.position > 0
                          ? t('m5.regexFix.disableNamed', { name })
                          : t('m5.regexFix.disable');
                const controls: HTMLElement[] = [
                    button({
                        label,
                        icon: fix.action === 'delete' ? 'fa-trash-can' : 'fa-toggle-off',
                        kind: fix.action === 'delete' ? 'danger' : 'default',
                        onClick: () => runRegexAction(script, fix.action, fix.note),
                    }),
                ];
                if (fix.note) controls.push(el('span', { class: 'maestro-muted', text: t(fix.note) }));
                return controls;
            };

            const showRegex = (id: string) => {
                const cell = [...root.querySelectorAll<HTMLElement>('[data-regex-id]')].find(
                    (node) => node.dataset.regexId === id,
                );
                const row = cell?.closest('tr') ?? cell;
                if (!row) return;
                row.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
                row.classList.add('maestro-m5-flash');
                setTimeout(() => row.classList.remove('maestro-m5-flash'), 1600);
            };

            const targetLinks = (finding: Finding): HTMLElement[] => {
                const target = finding.target;
                const books = Array.isArray(target.books)
                    ? target.books.filter((book): book is string => typeof book === 'string')
                    : typeof target.book === 'string'
                      ? [target.book]
                      : [];
                const links = books.map((book) =>
                    button({
                        label: t('m5.openBook', { book }),
                        icon: 'fa-book-atlas',
                        kind: 'ghost',
                        onClick: async () => {
                            if (await openBook(app, book)) closePult(app.ui);
                        },
                    }),
                );
                const scripts = Array.isArray(target.scripts) ? target.scripts : [];
                const first = scripts[0] as { id?: unknown } | undefined;
                if (typeof first?.id === 'string') {
                    const id = first.id;
                    links.push(
                        button({
                            label: t('m5.showRegex'),
                            icon: 'fa-code',
                            kind: 'ghost',
                            onClick: () => showRegex(id),
                        }),
                    );
                }
                return links;
            };

            const bunnyNote = (finding: Finding, books: Map<string, BookStat>): HTMLElement | null => {
                const book = typeof finding.target.book === 'string' ? books.get(finding.target.book) : undefined;
                return finding.fileFix === false && book?.bunnymo
                    ? el('span', { class: 'maestro-muted', text: t('m5.bunnyBook') })
                    : null;
            };

            const findingsView = (
                findings: Finding[],
                books: Map<string, BookStat>,
                facts: BookFacts | undefined,
                scripts: RegexScriptInfo[],
            ): HTMLElement => {
                if (!findings.length) return emptyState(t('m5.noFindings'));
                const blocks: HTMLElement[] = [];
                for (const severity of SEVERITIES) {
                    const list = findings.filter((finding) => finding.severity === severity);
                    if (!list.length) continue;
                    const kinds = new Map<FindingKind, Finding[]>();
                    for (const finding of list) kinds.set(finding.kind, [...(kinds.get(finding.kind) ?? []), finding]);
                    blocks.push(
                        el('div', { class: ['maestro-m5-severity', `maestro-level-${LEVEL[severity]}`] }, [
                            el('h5', { class: 'maestro-m5-severity-title', text: t(`m5.severity.${severity}`) }),
                            ...[...kinds].map(([kind, items]) =>
                                el('details', { class: 'maestro-m5-kind', attrs: { open: severity !== 'info' } }, [
                                    el('summary', {}, [
                                        el('span', { text: t(`m5.kind.${kind}`) }),
                                        ' ',
                                        badge(items.length, LEVEL[severity]),
                                    ]),
                                    ...items.map((finding) =>
                                        el('div', { class: 'maestro-m5-finding', data: { finding: finding.id } }, [
                                            el('div', { class: 'maestro-m5-message', text: findingText(app, finding) }),
                                            el('div', { class: 'maestro-actions' }, [
                                                ...targetLinks(finding),
                                                ruleControl(finding),
                                                fileFixControl(finding, facts),
                                                ...regexControl(finding, scripts),
                                                bunnyNote(finding, books),
                                            ]),
                                        ]),
                                    ),
                                ]),
                            ),
                        ]),
                    );
                }
                return el('div', { class: 'maestro-m5-findings' }, blocks);
            };

            const summary = (findings: Finding[]): HTMLElement =>
                el(
                    'div',
                    { class: 'maestro-row maestro-m5-summary' },
                    SEVERITIES.map((severity) =>
                        badge(
                            t(`m5.summary.${severity}`, {
                                count: findings.filter((finding) => finding.severity === severity).length,
                            }),
                            LEVEL[severity],
                        ),
                    ),
                );

            const booksView = (books: BookStat[]): HTMLElement =>
                table(
                    [
                        { key: 'book', label: t('m5.books.book'), cell: (row: BookStat) => row.book },
                        {
                            key: 'entries',
                            label: t('m5.books.entries'),
                            numeric: true,
                            cell: (row: BookStat) => String(row.entries),
                        },
                        {
                            key: 'chars',
                            label: t('m5.books.chars'),
                            numeric: true,
                            cell: (row: BookStat) =>
                                row.chars.toLocaleString(app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US'),
                        },
                        {
                            key: 'links',
                            label: t('m5.books.links'),
                            numeric: true,
                            cell: (row: BookStat) => String(row.links),
                        },
                        {
                            key: 'depth',
                            label: t('m5.books.depth'),
                            numeric: true,
                            cell: (row: BookStat) => String(row.maxDepth),
                        },
                        {
                            key: 'role',
                            label: t('m5.books.role'),
                            cell: (row: BookStat) => (row.bunnymo ? t(`m5.books.${row.bunnymo}`) : '—'),
                        },
                    ],
                    [...books].sort((a, b) => b.chars - a.chars),
                    { empty: t('m5.notes.noBooks'), caption: t('m5.books.title') },
                );

            const regexActions = (info: RegexInfo, scripts: RegexScriptInfo[]): HTMLElement => {
                const script = scripts.find((item) => item.id === info.id);
                if (!script) return el('span');
                return el('div', { class: 'maestro-row maestro-m5-regex-actions' }, [
                    button({
                        label: info.disabled ? t('m5.regexFix.enable') : t('m5.regexFix.disable'),
                        icon: info.disabled ? 'fa-toggle-on' : 'fa-toggle-off',
                        kind: 'ghost',
                        onClick: () => runRegexAction(script, info.disabled ? 'enable' : 'disable'),
                    }),
                    button({
                        title: t('m5.regexFix.delete'),
                        icon: 'fa-trash-can',
                        kind: 'ghost',
                        onClick: () => runRegexAction(script, 'delete'),
                    }),
                ]);
            };

            const regexView = (
                inventory: RegexInfo[],
                extensionOff: boolean,
                scripts: RegexScriptInfo[],
            ): (HTMLElement | null)[] => [
                extensionOff ? banner(t('m5.regex.extensionOff'), 'warn') : null,
                table(
                    [
                        {
                            key: 'name',
                            label: t('m5.regex.name'),
                            cell: (info: RegexInfo) =>
                                el('span', { data: { regexId: info.id }, text: info.name || t('m5.regex.unnamed') }),
                        },
                        {
                            key: 'type',
                            label: t('m5.regex.type'),
                            cell: (info: RegexInfo) => t(`m5.regexType.${info.type}`),
                        },
                        {
                            key: 'owner',
                            label: t('m5.regex.owner'),
                            cell: (info: RegexInfo) => t(`m5.owner.${info.owner}`),
                        },
                        {
                            key: 'where',
                            label: t('m5.regex.where'),
                            cell: (info: RegexInfo) => placementText(app, info.placement),
                        },
                        {
                            key: 'mode',
                            label: t('m5.regex.mode'),
                            cell: (info: RegexInfo) => t(`m5.mode.${regexMode(info)}`),
                        },
                        { key: 'depth', label: t('m5.regex.depth'), cell: (info: RegexInfo) => depthText(app, info) },
                        {
                            key: 'state',
                            label: t('m5.regex.state'),
                            cell: (info: RegexInfo) =>
                                info.disabled
                                    ? badge(t('m5.state.off'), 'muted')
                                    : info.allowed === false
                                      ? badge(t('m5.state.notAllowed'), 'warn')
                                      : badge(t('m5.state.on'), 'ok'),
                        },
                        {
                            key: 'actions',
                            label: t('m5.regex.actions'),
                            cell: (info: RegexInfo) => regexActions(info, scripts),
                        },
                        {
                            key: 'test',
                            label: '',
                            cell: (info: RegexInfo) =>
                                button({
                                    label: t('m5.bench.try'),
                                    icon: 'fa-flask',
                                    kind: 'ghost',
                                    disabled: !app.host.caps.has('st.regex'),
                                    onClick: () => {
                                        bench.scriptId = info.id;
                                        bench.output = null;
                                        draw();
                                        root.querySelector('.maestro-m5-bench')?.scrollIntoView({ block: 'start' });
                                    },
                                }),
                        },
                    ],
                    inventory,
                    { empty: t('m5.regex.empty'), caption: t('m5.regex.title') },
                ),
            ];

            const samplesFor = (info: RegexInfo): { label: string; text: string }[] => {
                if (bench.source === 'custom')
                    return bench.custom ? [{ label: t('m5.bench.customLabel'), text: bench.custom }] : [];
                const wantUser = info.placement.includes(REGEX_PLACEMENT.USER_INPUT);
                const wantAi = info.placement.includes(REGEX_PLACEMENT.AI_OUTPUT);
                const wantReasoning = info.placement.includes(REGEX_PLACEMENT.REASONING);
                const any = !wantUser && !wantAi && !wantReasoning;
                const picked: { label: string; text: string }[] = [];
                for (const message of chatSample(app, 100).messages) {
                    const label = t('m5.bench.message', { index: message.index });
                    if (any || (message.isUser ? wantUser : wantAi)) picked.push({ label, text: message.text });
                    if (wantReasoning && message.reasoning) picked.push({ label, text: message.reasoning });
                }
                return picked.filter((item) => item.text).slice(-bench.count);
            };

            const runBench = async (inventory: RegexInfo[]) => {
                const info = inventory.find((item) => item.id === bench.scriptId);
                if (!info) return;
                const samples = samplesFor(info);
                const output = el('div', { class: 'maestro-m5-bench-output' });
                if (!samples.length) output.appendChild(emptyState(t('m5.bench.noMessages'), 'fa-comment-slash'));
                for (const item of samples) {
                    let after: string | null = null;
                    try {
                        after = await service.testRegex(info.id, item.text);
                    } catch (error) {
                        app.log.warn('regex bench failed', error);
                    }
                    output.appendChild(
                        el('div', { class: 'maestro-m5-sample' }, [
                            el('div', { class: 'maestro-muted', text: item.label }),
                            after === null
                                ? el('div', { class: 'maestro-error-text', text: t('m5.bench.failed') })
                                : after === item.text
                                  ? el('div', { class: 'maestro-muted', text: t('m5.bench.unchanged') })
                                  : diffView(item.text, after, t),
                        ]),
                    );
                }
                bench.output = output;
                if (alive) draw();
            };

            const benchView = (inventory: RegexInfo[]): HTMLElement => {
                if (!app.host.caps.has('st.regex'))
                    return el('div', { class: 'maestro-m5-bench' }, [banner(t('m5.bench.noEngine'), 'info')]);
                if (!inventory.some((item) => item.id === bench.scriptId)) bench.scriptId = inventory[0]?.id ?? '';
                const textarea = el('textarea', {
                    class: 'text_pole maestro-m5-custom',
                    attrs: { rows: 4, placeholder: t('m5.bench.placeholder'), 'aria-label': t('m5.bench.custom') },
                });
                textarea.value = bench.custom;
                textarea.addEventListener('input', () => {
                    bench.custom = textarea.value;
                });
                return el('div', { class: 'maestro-m5-bench' }, [
                    el('div', { class: 'maestro-hint', text: t('m5.bench.hint') }),
                    el('div', { class: 'maestro-row' }, [
                        select({
                            value: bench.scriptId,
                            label: t('m5.bench.script'),
                            options: inventory.map((item) => ({
                                value: item.id,
                                label: `${item.name || t('m5.regex.unnamed')} (${t(`m5.regexType.${item.type}`)})`,
                            })),
                            onChange: (value) => {
                                bench.scriptId = value;
                                bench.output = null;
                            },
                        }),
                        segmented({
                            value: bench.source,
                            label: t('m5.bench.source'),
                            options: [
                                { value: 'last', label: t('m5.bench.last') },
                                { value: 'custom', label: t('m5.bench.custom') },
                            ],
                            onChange: (value) => {
                                bench.source = value;
                                draw();
                            },
                        }),
                        bench.source === 'last'
                            ? numberInput({
                                  value: bench.count,
                                  min: 1,
                                  max: 10,
                                  step: 1,
                                  label: t('m5.bench.count'),
                                  onChange: (value) => {
                                      bench.count = Math.round(value);
                                  },
                              })
                            : null,
                        button({
                            label: t('m5.bench.run'),
                            icon: 'fa-play',
                            kind: 'primary',
                            disabled: !bench.scriptId,
                            onClick: () => runBench(inventory),
                        }),
                    ]),
                    bench.source === 'custom' ? textarea : null,
                    bench.output,
                ]);
            };

            function draw(): void {
                if (!alive) return;
                const result = service.last();
                const books = new Map((result?.books ?? []).map((book) => [book.book, book]));
                clear(root);
                root.append(header());
                if (!result) return;
                root.append(
                    section(t('m5.findings'), [
                        summary(result.findings),
                        !rulesApi(app) && result.findings.some((finding) => finding.fixRule)
                            ? banner(t('m5.ruleMissing'), 'info', 'fa-circle-info')
                            : null,
                        findingsView(result.findings, books, result.facts, result.scripts),
                    ]),
                    section(t('m5.books.title'), booksView(result.books)),
                    section(t('m5.regex.title'), regexView(result.inventory, result.regexExtensionOff, result.scripts)),
                    section(t('m5.bench.title'), benchView(result.inventory)),
                );
            }

            const off = service.onChange(() => draw());
            draw();
            if (!service.last() && !service.isScanning()) {
                void service.scan().catch((error: unknown) => app.log.error('doctor scan failed', error));
            }
            return () => {
                alive = false;
                off();
            };
        },
    };
}

export const DOCTOR_CSS = `
.maestro-m5-head { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); margin-bottom: var(--maestro-gap); }
.maestro-m5-summary { margin-bottom: var(--maestro-gap-sm); }
.maestro-m5-severity { margin-bottom: var(--maestro-gap); }
.maestro-m5-severity-title { margin: var(--maestro-gap-sm) 0; color: var(--maestro-level, inherit); }
.maestro-m5-kind { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: var(--maestro-gap-sm) var(--maestro-gap); margin-bottom: var(--maestro-gap-sm); background: var(--maestro-raised); }
.maestro-m5-kind > summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m5-finding { padding: var(--maestro-gap-sm) 0; border-top: 1px solid var(--maestro-border); }
.maestro-m5-finding:first-of-type { border-top: none; }
.maestro-m5-message { overflow-wrap: anywhere; margin-bottom: var(--maestro-gap-sm); }
.maestro-m5-bench { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m5-custom { width: 100%; min-height: 6em; }
.maestro-m5-sample { margin-top: var(--maestro-gap-sm); }
.maestro-m5-flash { outline: 2px solid var(--maestro-accent); outline-offset: -2px; }
.maestro-m5-regex-actions { flex-wrap: nowrap; gap: 2px; }
`;
