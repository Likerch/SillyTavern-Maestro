// «Паки» (M35 п. 6, Q25): BunnyMo packs with version and edition, the per-chat choice («all packs» or only the
// checked ones; suppressed on the fly, files untouched), the version conflicts M22 asks about, and «compare with a
// file» (diff against a new pack file; nothing is written).
import type { PackGroupInfo, RulesApi } from '../rules/api';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { diffView } from '../../ui/components/diff';
import { button, clear, el, icon } from '../../ui/components/dom';
import type { PackDiff, PackInfo } from './api';
import { errorText, loading } from './view-common';
import type { ViewContext } from './view-common';

const PACK_VERSION_RULE = 'pack.versionConflict';

function diffSection(ctx: ViewContext, current: { book: string; file: string; diff: PackDiff }): HTMLElement {
    const { t } = ctx;
    const { diff } = current;
    const list = (items: { key: string; comment: string }[]) =>
        el(
            'ul',
            { class: 'maestro-m35b-list' },
            items.map((item) => el('li', { text: [item.key, item.comment].filter(Boolean).join(' · ') })),
        );
    const same = !diff.added.length && !diff.removed.length && !diff.changed.length;
    return section(
        t('m35b.packs.diff.title', { book: current.book, file: current.file }),
        [
            same ? el('div', { class: 'maestro-muted', text: t('m35b.packs.diff.same') }) : null,
            diff.added.length
                ? el('details', { class: 'maestro-m35b-diff' }, [
                      el('summary', { text: t('m35b.packs.diff.added', { count: diff.added.length }) }),
                      list(diff.added),
                  ])
                : null,
            diff.removed.length
                ? el('details', { class: 'maestro-m35b-diff' }, [
                      el('summary', { text: t('m35b.packs.diff.removed', { count: diff.removed.length }) }),
                      list(diff.removed),
                  ])
                : null,
            diff.changed.length
                ? el('details', { class: 'maestro-m35b-diff', attrs: { open: true } }, [
                      el('summary', { text: t('m35b.packs.diff.changed', { count: diff.changed.length }) }),
                      ...diff.changed.map((item) =>
                          el('details', { class: 'maestro-m35b-diff-item' }, [
                              el('summary', { text: [item.key, item.comment].filter(Boolean).join(' · ') }),
                              diffView(item.before, item.after, ctx.t),
                          ]),
                      ),
                  ])
                : null,
            el('div', { class: 'maestro-hint', text: t('m35b.packs.diff.note') }),
        ],
        button({
            label: t('m35b.packs.diff.close'),
            icon: 'fa-xmark',
            kind: 'ghost',
            onClick: () => {
                ctx.state.packs.diff = null;
                ctx.redraw();
            },
        }),
    );
}

function fileButton(ctx: ViewContext, pack: PackInfo): HTMLElement {
    const input = el('input', {
        class: 'maestro-sr-only',
        attrs: { type: 'file', accept: '.json,.bny,application/json', 'aria-label': ctx.t('m35b.packs.compare') },
    });
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        void ctx.run(async () => {
            const diff = await ctx.service.diffWithFile(pack.book, file);
            ctx.state.packs.diff = { book: pack.book, file: file.name, diff };
            ctx.redraw();
        });
    });
    return el('label', { class: 'menu_button maestro-btn maestro-btn-ghost maestro-m35b-file' }, [
        icon('fa-code-compare'),
        el('span', { text: ctx.t('m35b.packs.compare') }),
        input,
    ]);
}

function packCard(ctx: ViewContext, pack: PackInfo, onlyBooks: string[] | null, chat: boolean): HTMLElement {
    const { t } = ctx;
    const inChat = toggle({
        label: t('m35b.packs.inChat'),
        checked: !pack.offInChat,
        disabled: !chat || onlyBooks === null,
        onChange: (checked) =>
            ctx.run(async () => {
                const books = new Set(onlyBooks ?? []);
                if (checked) books.add(pack.book);
                else books.delete(pack.book);
                await ctx.service.setSelection({ mode: 'only', books: [...books] });
                ctx.redraw();
            }),
    });
    return el(
        'div',
        {
            class: ['maestro-m35b-pack', ctx.state.packs.focus === pack.book ? 'maestro-m35b-focus' : null],
            data: { book: pack.book },
        },
        [
            el('div', { class: 'maestro-m35b-pack-head' }, [
                el('span', { class: 'maestro-m35b-strong', text: pack.name }),
                pack.version
                    ? el('span', { class: 'maestro-muted', text: t('m35b.packs.version', { version: pack.version }) })
                    : null,
                badge(t(pack.active ? 'm35b.packs.active' : 'm35b.packs.inactive'), pack.active ? 'ok' : 'muted'),
                badge(t(`m35b.packs.edition.${pack.edition}`), 'info'),
            ]),
            el('div', { class: 'maestro-muted maestro-m35b-book', text: pack.book }),
            el('div', { class: 'maestro-muted', text: t('m35b.packs.entries', { count: pack.entries }) }),
            el('div', { class: 'maestro-m35b-actions' }, [inChat, fileButton(ctx, pack)]),
        ],
    );
}

function conflictsSection(ctx: ViewContext): HTMLElement | null {
    const rules = ctx.app.modules.api<RulesApi>('rules');
    const options = rules?.options?.(PACK_VERSION_RULE);
    const groups = Array.isArray(options?.groups) ? (options.groups as PackGroupInfo[]) : [];
    if (!groups.length) return null;
    return section(
        ctx.t('m35b.packs.conflicts'),
        el(
            'ul',
            { class: 'maestro-m35b-list' },
            groups.map((group) => {
                const books = group.books.join(' · ');
                const text =
                    group.choice === undefined
                        ? ctx.t('m35b.packs.conflict.open', { books })
                        : group.choice === ''
                          ? ctx.t('m35b.packs.conflict.every', { books })
                          : ctx.t('m35b.packs.conflict.chosen', { books, choice: group.choice });
                return el('li', { text });
            }),
        ),
    );
}

export async function renderPacks(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t, service, state } = ctx;
    body.appendChild(loading(t));
    let packs: PackInfo[];
    let cores: Awaited<ReturnType<typeof service.cores>>;
    try {
        [packs, cores] = await Promise.all([service.packs(), service.cores()]);
    } catch (error) {
        clear(body);
        body.appendChild(el('div', { class: 'maestro-error-text', text: errorText(error) }));
        return;
    }
    clear(body);
    if (state.packs.diff) body.appendChild(diffSection(ctx, state.packs.diff));
    for (const core of cores) {
        body.appendChild(
            el('div', { class: 'maestro-m35b-core' }, [
                icon('fa-carrot'),
                el('span', { text: t('m35b.packs.core', { book: core.book, version: core.detected }) }),
                core.active ? null : badge(t('m35b.packs.coreInactive'), 'muted'),
            ]),
        );
    }
    if (!packs.length) {
        body.appendChild(emptyState(t('m35b.packs.none'), 'fa-box-open'));
        return;
    }
    const chat = !!ctx.app.host.chatId();
    const selection = service.selection();
    const onlyBooks = selection.mode === 'only' ? selection.books : null;
    body.appendChild(
        el('div', { class: 'maestro-m35b-selection' }, [
            toggle({
                label: t('m35b.packs.allInChat'),
                checked: selection.mode === 'all',
                disabled: !chat,
                onChange: (checked) =>
                    ctx.run(async () => {
                        await service.setSelection(
                            checked
                                ? { mode: 'all' }
                                : { mode: 'only', books: packs.filter((pack) => pack.active).map((pack) => pack.book) },
                        );
                        ctx.redraw();
                    }),
            }),
            el('div', { class: 'maestro-hint', text: t('m35b.packs.allHint') }),
            chat ? null : banner(t('m35b.packs.noChat'), 'info', 'fa-circle-info'),
        ]),
    );
    body.appendChild(
        el(
            'div',
            { class: 'maestro-m35b-packs' },
            packs.map((pack) => packCard(ctx, pack, onlyBooks, chat)),
        ),
    );
    const conflicts = conflictsSection(ctx);
    if (conflicts) body.appendChild(conflicts);
    if (state.packs.focus) {
        const node = [...body.querySelectorAll<HTMLElement>('.maestro-m35b-pack')].find(
            (item) => item.dataset.book === state.packs.focus,
        );
        if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    }
}
