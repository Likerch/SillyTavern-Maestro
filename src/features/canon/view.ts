// Pult tab «Канон» (M6): the canon items of this chat grouped by kind, with status and origin, a link to the base
// entry, archive/activate/remove/promote buttons, the canon budget bar of the last turn, base drift warnings
// (base then → now, and the override) and the plain export.
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { diffView } from '../../ui/components/diff';
import { formatTime } from '../../ui/views/format';
import type { BaseDrift, CanonItem, CanonKind, CanonStatus } from './api';
import type { CanonScan } from './scan';
import type { CanonStore } from './store';

export const CANON_TAB = 'canon';
const KINDS: readonly CanonKind[] = ['override', 'addition', 'suppress', 'pin'];
const STATUS_ORDER: Record<CanonStatus, number> = { active: 0, provisional: 1, archived: 2 };
const PREVIEW_CHARS = 220;

export const CANON_CSS = `
.maestro-m6-head { display: flex; flex-direction: column; gap: 4px; }
.maestro-m6-book { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m6-budget { height: 6px; border-radius: 3px; background: var(--maestro-raised-strong); overflow: hidden; }
.maestro-m6-budget-bar { height: 100%; background: var(--maestro-accent); }
.maestro-m6-budget-bar.maestro-m6-over { background: var(--maestro-warn); }
.maestro-m6-items { display: flex; flex-direction: column; gap: 8px; }
.maestro-m6-item { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; }
.maestro-m6-item-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m6-title { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m6-base { font-size: 0.9em; overflow-wrap: anywhere; }
.maestro-m6-preview { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9em; margin: 4px 0; opacity: 0.85; }
.maestro-m6-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.maestro-m6-archived { opacity: 0.7; }
.maestro-m6-drift { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
`;

function preview(text: unknown): string {
    const value = typeof text === 'string' ? text.trim() : '';
    return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
}

function itemTitle(item: CanonItem): string {
    const comment = typeof item.entry.comment === 'string' ? item.entry.comment.trim() : '';
    if (comment) return comment;
    const key = Array.isArray(item.entry.key) ? item.entry.key.find((value) => typeof value === 'string') : undefined;
    return typeof key === 'string' && key ? key : `#${item.uid}`;
}

async function openBook(app: App, book: string): Promise<void> {
    try {
        const module = await app.host.modules.worldInfo();
        const open = module.openWorldInfoEditor;
        if (typeof open === 'function') (open as (name: string) => void)(book);
    } catch (error) {
        app.log.debug('cannot open the lorebook editor', error);
    }
}

export function canonTab(app: App, store: CanonStore, scan: CanonScan): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: CANON_TAB,
        titleKey: 'm6.tab',
        icon: 'fa-scroll',
        order: 35,
        render(container) {
            let alive = true;
            let drift: BaseDrift[] | null = null;
            let note = '';
            const root = el('div', { class: 'maestro-view maestro-m6' });
            container.appendChild(root);

            const run = async (job: () => Promise<unknown>) => {
                try {
                    await job();
                } catch (error) {
                    note = error instanceof Error ? error.message : String(error);
                    app.ui.notice(note, { level: 'error' });
                }
                if (alive) void draw();
            };

            const budgetView = (): HTMLElement => {
                const budget = scan.budget();
                const report = scan.lastScan();
                const percent =
                    budget.limitChars > 0 ? Math.min(100, Math.round((budget.usedChars / budget.limitChars) * 100)) : 0;
                const bar = el('div', { class: 'maestro-m6-budget', attrs: { role: 'presentation' } }, [
                    el('div', {
                        class: ['maestro-m6-budget-bar', report && report.cut > 0 ? 'maestro-m6-over' : null],
                        attrs: { style: `width: ${percent}%` },
                    }),
                ]);
                return el('div', { class: 'maestro-m6-head' }, [
                    el('div', {
                        text:
                            budget.limitChars > 0
                                ? t('m6.budget.line', { used: budget.usedChars, limit: budget.limitChars })
                                : t('m6.budget.unlimited', { used: budget.usedChars }),
                    }),
                    budget.limitChars > 0 ? bar : null,
                    report
                        ? el('div', {
                              class: 'maestro-muted',
                              text: t('m6.scan.report', {
                                  time: formatTime(report.at, app.i18n),
                                  added: report.added,
                                  replaced: report.replaced,
                                  suppressed: report.suppressed,
                                  pinned: report.pinned,
                                  dormant: report.dormant,
                                  cut: report.cut,
                              }),
                          })
                        : el('div', { class: 'maestro-muted', text: t('m6.scan.none') }),
                    report && report.missing > 0
                        ? el('div', {
                              class: 'maestro-warn-text',
                              text: t('m6.scan.missing', { count: report.missing }),
                          })
                        : null,
                ]);
            };

            const driftView = (): HTMLElement | null => {
                if (!drift?.length) return null;
                return el(
                    'div',
                    { class: 'maestro-m6-drift' },
                    drift.map((row) =>
                        el('details', {}, [
                            el('summary', {}, [
                                banner(
                                    t('m6.drift.item', {
                                        title: itemTitle(row.item),
                                        book: row.item.meta.base?.world ?? '',
                                    }),
                                    'warn',
                                ),
                            ]),
                            el('div', { class: 'maestro-muted', text: t('m6.drift.base') }),
                            diffView(row.baseThen, row.baseNow, t),
                            row.item.meta.kind === 'override'
                                ? el('div', { class: 'maestro-muted', text: t('m6.drift.override') })
                                : null,
                            row.item.meta.kind === 'override'
                                ? el('div', { class: 'maestro-m6-preview', text: preview(row.item.entry.content) })
                                : null,
                        ]),
                    ),
                );
            };

            const itemView = (item: CanonItem): HTMLElement => {
                const base = item.meta.base;
                const archived = item.meta.status === 'archived';
                const actions: Child[] = [
                    button({
                        label: t(archived ? 'm6.action.activate' : 'm6.action.archive'),
                        icon: archived ? 'fa-box-open' : 'fa-box-archive',
                        onClick: () => run(() => store.setStatus(item.uid, archived ? 'active' : 'archived')),
                    }),
                ];
                if (item.meta.status === 'provisional') {
                    actions.push(
                        button({
                            label: t('m6.action.confirm'),
                            icon: 'fa-check',
                            onClick: () => run(() => store.setStatus(item.uid, 'active')),
                        }),
                    );
                }
                if (item.meta.kind === 'override' || item.meta.kind === 'suppress') {
                    actions.push(
                        button({
                            label: t('m6.action.promote'),
                            icon: 'fa-arrow-up-from-bracket',
                            title: t('m6.action.promoteHint'),
                            onClick: () => run(() => store.promote(item.uid)),
                        }),
                    );
                }
                actions.push(
                    button({
                        label: t('m6.action.remove'),
                        icon: 'fa-trash-can',
                        kind: 'danger',
                        onClick: () =>
                            run(async () => {
                                if (
                                    await app.ui.confirm(
                                        t('m6.remove.title'),
                                        t('m6.remove.body', { title: itemTitle(item) }),
                                    )
                                ) {
                                    await store.remove(item.uid);
                                }
                            }),
                    }),
                );
                return el('div', { class: ['maestro-m6-item', archived ? 'maestro-m6-archived' : null] }, [
                    el('div', { class: 'maestro-m6-item-head' }, [
                        el('span', { class: 'maestro-m6-title', text: itemTitle(item) }),
                        badge(
                            t(`m6.status.${item.meta.status}`),
                            archived ? 'muted' : item.meta.status === 'active' ? 'ok' : 'info',
                        ),
                        badge(t(`m6.origin.${item.meta.origin}`), 'muted'),
                        item.meta.type ? badge(item.meta.type, 'muted') : null,
                    ]),
                    base
                        ? el('div', { class: 'maestro-m6-base' }, [
                              el('span', {
                                  class: 'maestro-muted',
                                  text: t('m6.base', { book: base.world, uid: base.uid }),
                              }),
                              ' ',
                              button({
                                  icon: 'fa-book',
                                  kind: 'ghost',
                                  title: t('m6.base.open'),
                                  onClick: () => openBook(app, base.world),
                              }),
                          ])
                        : null,
                    item.meta.kind === 'addition' || item.meta.kind === 'override'
                        ? el('div', { class: 'maestro-m6-preview', text: preview(item.entry.content) })
                        : null,
                    el('div', { class: 'maestro-m6-actions' }, actions),
                ]);
            };

            const draw = async () => {
                const name = store.bookName();
                const items = name ? await store.list() : [];
                if (!alive) return;
                clear(root);
                const exists = name ? (store.peek(name)?.exists ?? false) : false;
                root.appendChild(
                    section(
                        t('m6.title'),
                        [
                            el('div', {
                                class: 'maestro-m6-book',
                                text: name || t('m6.noChat'),
                            }),
                            name && !exists ? el('div', { class: 'maestro-muted', text: t('m6.noBook') }) : null,
                            el('div', { class: 'maestro-hint', text: t('m6.hint') }),
                            budgetView(),
                            note ? el('div', { class: 'maestro-error-text', text: note }) : null,
                        ],
                        [
                            button({
                                label: t('m6.drift.check'),
                                icon: 'fa-code-compare',
                                disabled: !items.length,
                                onClick: () =>
                                    run(async () => {
                                        drift = await store.baseDrift();
                                        if (!drift.length) app.ui.notice(t('m6.drift.none'));
                                    }),
                            }),
                            button({
                                label: t('m6.export.action'),
                                icon: 'fa-file-export',
                                disabled: !items.length,
                                title: t('m6.export.hint'),
                                onClick: () =>
                                    run(async () => {
                                        const exported = await store.exportPlain();
                                        app.ui.notice(t('m6.export.done', { book: exported }), { urgent: true });
                                    }),
                            }),
                        ],
                    ),
                );
                const driftBlock = driftView();
                if (driftBlock) root.appendChild(section(t('m6.drift.title'), driftBlock));
                if (!items.length) {
                    root.appendChild(emptyState(t('m6.empty'), 'fa-scroll'));
                    return;
                }
                for (const kind of KINDS) {
                    const group = items
                        .filter((item) => item.meta.kind === kind)
                        .sort(
                            (a, b) =>
                                STATUS_ORDER[a.meta.status] - STATUS_ORDER[b.meta.status] ||
                                b.meta.updatedAt - a.meta.updatedAt ||
                                a.uid - b.uid,
                        );
                    if (!group.length) continue;
                    root.appendChild(
                        section(
                            t(`m6.group.${kind}`, { count: group.length }),
                            el('div', { class: 'maestro-m6-items' }, group.map(itemView)),
                        ),
                    );
                }
            };

            const offStore = store.onChange(() => alive && void draw());
            const offScan = scan.onReport(() => alive && void draw());
            void draw();
            return () => {
                alive = false;
                offStore();
                offScan();
            };
        },
    };
}
