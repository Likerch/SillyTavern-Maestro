// Centre panel of the Lore Studio: the entries of one book (research/parity-lore.md §3.1, §4): search (ST's fuzzy
// search with the «Search» sort), the 14 sort options, pages, manual order by drag or up/down, open/close all
// previews, «Apply current sorting as Order», «Fill empty titles», multi-select with bulk actions, per-row toggle,
// status, duplicate, move/copy, delete and badges (canon, doctor findings, last activation from M1).
import { entryStatus, entryTitle, normalizedEntry, positionLabel, stringList } from '../../domain/lore-studio-entries';
import type { EntryStatus, LoreBook, LoreEntry } from '../../domain/lore-studio-entries';
import {
    CUSTOM_SORT_ID,
    PAGE_SIZES,
    SEARCH_SORT_ID,
    SORT_OPTIONS,
    moveItem,
    pageOfIndex,
    paginate,
    sortEntries,
} from '../../domain/lore-studio-sort';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import { reasonText, roleKey } from './view-books';
import type { RoleView } from './store';

export interface EntriesModel {
    book: string;
    data: LoreBook | null;
    role: RoleView;
    /** uid → canon kinds that point at this entry (override, suppress, pin). */
    canon: Map<number, string[]>;
    /** uid → doctor findings. */
    findings: Map<number, number>;
    /** uid → message index of the last turn it was active in (M1). */
    lastSeen: Map<number, number>;
    /** Why the book is active in this chat. */
    reasons: string[];
    campaign: string | null;
    workshop: string[];
    /** Other books an entry can be moved or copied to. */
    targets: string[];
    /** Lorebook Localizer's API is there (0.2+): Russian keys for the whole book (L-172). */
    localizer?: boolean;
}

export interface EntriesState {
    search: string;
    sort: number;
    pageSize: number;
    page: number;
    selected: Set<number>;
    expanded: Set<number>;
    /** uid → search score (lower is better) for the current search; null without a search. */
    scores: Map<number, number> | null;
    /** Entry to show (its page) and highlight after the next render. */
    focusUid: number | null;
    /** Entry open in the form. */
    openUid: number | null;
}

export interface EntriesActions {
    open(uid: number): void;
    create(): Promise<void>;
    duplicate(uid: number): Promise<void>;
    remove(uids: number[]): Promise<void>;
    moveCopy(uids: number[]): Promise<void>;
    setDisabled(uids: number[], disabled: boolean): Promise<void>;
    setStatus(uid: number, status: EntryStatus): Promise<void>;
    reorder(pageOrder: number[]): Promise<void>;
    applyOrder(sorted: LoreEntry[]): Promise<void>;
    backfill(): Promise<void>;
    bulkEdit(uids: number[]): Promise<void>;
    search(term: string): void;
    setSort(id: number): void;
    setPageSize(size: number): void;
    refresh(): Promise<void>;
    renameBook(): Promise<void>;
    duplicateBook(): Promise<void>;
    exportBook(): Promise<void>;
    deleteBook(): Promise<void>;
    localizeBook(): Promise<void>;
    openClassic(): void;
    back(): void;
}

const STATUS_ICON: Record<EntryStatus, string> = { constant: '🔵', normal: '🟢', vectorized: '🔗' };
const NEXT_STATUS: Record<EntryStatus, EntryStatus> = {
    normal: 'constant',
    constant: 'vectorized',
    vectorized: 'normal',
};
const SEARCH_DEBOUNCE_MS = 300;

/** Entries of the book in display order (search filter + sort), as normalized copies. */
export function visibleEntries(model: EntriesModel, state: EntriesState): LoreEntry[] {
    const all = Object.values(model.data?.entries ?? {}).map(normalizedEntry);
    const searching = state.search.trim() !== '' && state.scores !== null;
    const list = searching ? all.filter((entry) => state.scores?.has(entry.uid)) : all;
    return sortEntries(list, searching ? SEARCH_SORT_ID : state.sort, state.scores ?? undefined);
}

export function renderEntriesPanel(
    app: App,
    model: EntriesModel,
    state: EntriesState,
    actions: EntriesActions,
): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const readOnly = model.role.readOnly;
    const root = el('div', { class: 'maestro-m23-entries-panel' });

    /* ------------------------------------------------------------ header: book and its actions */
    const header = el('div', { class: 'maestro-m23-entries-head' }, [
        button({
            icon: 'fa-arrow-left',
            kind: 'ghost',
            title: t('m23.nav.books'),
            className: 'maestro-m23-back',
            onClick: () => actions.back(),
        }),
        el('div', { class: 'maestro-m23-book-heading' }, [
            el('h3', { class: 'maestro-m23-book-heading-title', text: model.book }),
            el('div', { class: 'maestro-m23-book-heading-meta' }, [
                el('span', { class: 'maestro-m23-badge', text: t(roleKey(model.role.role)) }),
                readOnly
                    ? el('span', { class: 'maestro-m23-badge maestro-m23-badge-lock', text: t('m23.entries.readOnly') })
                    : null,
                el('span', {
                    class: 'maestro-muted',
                    text: model.reasons.length
                        ? t('m23.books.activeBecause', { reasons: reasonText(app, model.reasons) })
                        : t('m23.entries.inactive'),
                }),
                model.campaign
                    ? el('span', { class: 'maestro-m23-badge maestro-m23-badge-campaign', text: model.campaign })
                    : null,
                model.workshop.length
                    ? el('span', {
                          class: 'maestro-muted',
                          text: t('m23.entries.workshop', { names: model.workshop.join(', ') }),
                      })
                    : null,
            ]),
        ]),
        el('div', { class: 'maestro-m23-book-actions' }, [
            button({
                icon: 'fa-pen',
                title: t('m23.book.rename'),
                disabled: readOnly,
                onClick: () => actions.renameBook(),
            }),
            button({ icon: 'fa-paste', title: t('m23.book.duplicate'), onClick: () => actions.duplicateBook() }),
            button({ icon: 'fa-file-export', title: t('m23.book.export'), onClick: () => actions.exportBook() }),
            model.localizer && !readOnly && model.role.info?.localizable !== false
                ? button({ icon: 'fa-language', title: t('m23.book.localize'), onClick: () => actions.localizeBook() })
                : null,
            button({ icon: 'fa-book-atlas', title: t('m23.book.classic'), onClick: () => actions.openClassic() }),
            button({
                icon: 'fa-trash-can',
                kind: 'danger',
                title: t('m23.book.delete'),
                onClick: () => actions.deleteBook(),
            }),
        ]),
    ]);

    /* ------------------------------------------------------------ toolbar */
    const search = el('input', {
        class: 'text_pole maestro-m23-entry-search',
        attrs: { type: 'search', placeholder: t('m23.entries.search'), 'aria-label': t('m23.entries.search') },
    });
    search.value = state.search;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    search.addEventListener('input', () => {
        // Kept at once: a refresh arriving before the debounce must not wipe what is being typed.
        state.search = search.value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchTimer = null;
            actions.search(search.value);
        }, SEARCH_DEBOUNCE_MS);
    });
    const sort = el('select', { class: 'text_pole maestro-m23-sort', attrs: { 'aria-label': t('m23.entries.sort') } });
    const searching = state.search.trim() !== '';
    for (const option of SORT_OPTIONS) {
        if (option.id === SEARCH_SORT_ID && !searching) continue;
        sort.append(el('option', { text: t(option.labelKey), attrs: { value: String(option.id) } }));
    }
    sort.value = String(searching ? SEARCH_SORT_ID : state.sort);
    sort.disabled = searching;
    sort.addEventListener('change', () => actions.setSort(Number(sort.value)));
    const size = el('select', {
        class: 'text_pole maestro-m23-page-size',
        attrs: { 'aria-label': t('m23.entries.pageSize') },
    });
    for (const value of PAGE_SIZES)
        size.append(
            el('option', { text: t('m23.entries.perPage', { count: value }), attrs: { value: String(value) } }),
        );
    size.value = String(state.pageSize);
    size.addEventListener('change', () => actions.setPageSize(Number(size.value)));

    const entries = visibleEntries(model, state);
    const toolbar = el('div', { class: 'maestro-m23-entries-tools' }, [
        search,
        sort,
        size,
        el('div', { class: 'maestro-row' }, [
            button({
                icon: 'fa-plus',
                label: t('m23.entries.new'),
                kind: 'primary',
                disabled: readOnly,
                onClick: () => actions.create(),
            }),
            button({
                icon: 'fa-arrow-down-9-1',
                title: t('m23.entries.applyOrder'),
                disabled: readOnly || !entries.length,
                onClick: () => actions.applyOrder(sortForApply()),
            }),
            button({
                icon: 'fa-pencil',
                title: t('m23.entries.backfill'),
                disabled: readOnly,
                onClick: () => actions.backfill(),
            }),
            button({
                icon: 'fa-angles-down',
                title: t('m23.entries.expandAll'),
                onClick: () => {
                    for (const entry of pageEntries()) state.expanded.add(entry.uid);
                    renderList();
                },
            }),
            button({
                icon: 'fa-angles-up',
                title: t('m23.entries.collapseAll'),
                onClick: () => {
                    for (const entry of pageEntries()) state.expanded.delete(entry.uid);
                    renderList();
                },
            }),
            button({ icon: 'fa-arrows-rotate', title: t('m23.entries.refresh'), onClick: () => actions.refresh() }),
        ]),
    ]);

    const bulk = el('div', {
        class: 'maestro-m23-bulk',
        attrs: { role: 'toolbar', 'aria-label': t('m23.bulk.title') },
    });
    const pager = el('div', { class: 'maestro-m23-pager' });
    const list = el('div', { class: 'maestro-m23-entry-list', attrs: { role: 'list' } });
    root.append(header, toolbar, bulk, pager, list);

    /** «Apply current sorting as Order» works on the whole book in the current order (L-114). */
    function sortForApply(): LoreEntry[] {
        const all = Object.values(model.data?.entries ?? {}).map(normalizedEntry);
        const scores = searching ? (state.scores ?? undefined) : undefined;
        return sortEntries(all, searching ? SEARCH_SORT_ID : state.sort, scores);
    }

    function pageEntries(): LoreEntry[] {
        const info = paginate(entries.length, state.page, state.pageSize);
        return entries.slice(info.start, info.end);
    }

    function renderBulk(): void {
        bulk.replaceChildren();
        const selected = [...state.selected].filter((uid) => model.data?.entries[String(uid)]);
        bulk.hidden = selected.length === 0;
        if (!selected.length) return;
        bulk.append(
            el('span', { class: 'maestro-m23-bulk-count', text: t('m23.bulk.selected', { count: selected.length }) }),
            button({
                label: t('m23.bulk.selectPage'),
                kind: 'ghost',
                onClick: () => {
                    for (const entry of pageEntries()) state.selected.add(entry.uid);
                    renderList();
                },
            }),
            button({
                label: t('m23.bulk.selectAll'),
                kind: 'ghost',
                onClick: () => {
                    for (const entry of entries) state.selected.add(entry.uid);
                    renderList();
                },
            }),
            button({
                label: t('m23.bulk.clear'),
                kind: 'ghost',
                onClick: () => {
                    state.selected.clear();
                    renderList();
                },
            }),
            button({
                icon: 'fa-sliders',
                label: t('m23.bulk.edit'),
                disabled: readOnly,
                onClick: () => actions.bulkEdit(selected),
            }),
            button({
                icon: 'fa-toggle-on',
                title: t('m23.bulk.enable'),
                disabled: readOnly,
                onClick: () => actions.setDisabled(selected, false),
            }),
            button({
                icon: 'fa-toggle-off',
                title: t('m23.bulk.disable'),
                disabled: readOnly,
                onClick: () => actions.setDisabled(selected, true),
            }),
            button({ icon: 'fa-right-left', title: t('m23.bulk.moveCopy'), onClick: () => actions.moveCopy(selected) }),
            button({
                icon: 'fa-trash-can',
                kind: 'danger',
                title: t('m23.bulk.delete'),
                disabled: readOnly,
                onClick: () => actions.remove(selected),
            }),
        );
    }

    function renderPager(info: ReturnType<typeof paginate>): void {
        pager.replaceChildren();
        if (!entries.length) return;
        pager.append(
            button({
                icon: 'fa-chevron-left',
                kind: 'ghost',
                title: t('m23.entries.prevPage'),
                disabled: info.page === 0,
                onClick: () => {
                    state.page = info.page - 1;
                    renderList();
                },
            }),
            el('span', {
                class: 'maestro-m23-pager-text',
                text: t('m23.entries.range', { from: info.start + 1, to: info.end, total: entries.length }),
            }),
            button({
                icon: 'fa-chevron-right',
                kind: 'ghost',
                title: t('m23.entries.nextPage'),
                disabled: info.page >= info.pages - 1,
                onClick: () => {
                    state.page = info.page + 1;
                    renderList();
                },
            }),
        );
    }

    function renderList(): void {
        if (state.focusUid !== null) {
            const index = entries.findIndex((entry) => entry.uid === state.focusUid);
            if (index >= 0) state.page = pageOfIndex(index, state.pageSize);
        }
        const info = paginate(entries.length, state.page, state.pageSize);
        state.page = info.page;
        renderPager(info);
        renderBulk();
        list.replaceChildren();
        if (!model.data) {
            list.append(el('div', { class: 'maestro-empty', text: t('m23.entries.loading') }));
            return;
        }
        if (!entries.length) {
            list.append(
                el('div', {
                    class: 'maestro-empty',
                    text: searching ? t('m23.entries.noMatch') : t('m23.entries.empty'),
                }),
            );
            return;
        }
        const page = entries.slice(info.start, info.end);
        const custom = !searching && state.sort === CUSTOM_SORT_ID && !readOnly;
        page.forEach((entry, index) => list.append(row(entry, index, page, custom)));
        if (state.focusUid !== null) {
            const node = list.querySelector<HTMLElement>(`[data-uid="${state.focusUid}"]`);
            node?.classList.add('maestro-m23-flash');
            node?.scrollIntoView?.({ block: 'nearest' });
            state.focusUid = null;
        }
    }

    function row(entry: LoreEntry, index: number, page: LoreEntry[], custom: boolean): HTMLElement {
        const uid = entry.uid;
        const status = entryStatus(entry);
        const disabled = entry.disable === true;
        const title = entryTitle(entry) || t('m23.entries.untitled', { uid });
        const select = el('input', { attrs: { type: 'checkbox', 'aria-label': t('m23.entries.select', { title }) } });
        select.checked = state.selected.has(uid);
        select.addEventListener('change', () => {
            if (select.checked) state.selected.add(uid);
            else state.selected.delete(uid);
            renderBulk();
        });
        const badges: HTMLElement[] = [];
        for (const kind of model.canon.get(uid) ?? []) {
            badges.push(
                el('span', { class: 'maestro-m23-badge maestro-m23-badge-canon', title: t(`m23.canon.${kind}`) }, [
                    icon('fa-scroll'),
                ]),
            );
        }
        const findings = model.findings.get(uid) ?? 0;
        if (findings) {
            badges.push(
                el(
                    'span',
                    {
                        class: 'maestro-m23-badge maestro-m23-badge-doctor',
                        title: t('m23.entries.findings', { count: findings }),
                    },
                    [icon('fa-stethoscope'), el('span', { text: String(findings) })],
                ),
            );
        }
        const seen = model.lastSeen.get(uid);
        if (seen !== undefined) {
            badges.push(
                el('span', {
                    class: 'maestro-m23-badge',
                    title: t('m23.entries.lastSeenHint'),
                    text: t('m23.entries.lastSeen', { index: seen }),
                }),
            );
        }
        const probability = Number(entry.probability ?? 100);
        const meta = [
            positionLabel(entry),
            t('m23.entries.order', { value: Number(entry.order ?? 0) }),
            entry.useProbability !== false && probability < 100 ? `${probability}%` : '',
            `#${uid}`,
        ].filter(Boolean);

        const node = el(
            'div',
            {
                class: [
                    'maestro-m23-entry',
                    disabled ? 'maestro-m23-disabled' : null,
                    state.openUid === uid ? 'maestro-on' : null,
                ],
                data: { uid },
                attrs: { role: 'listitem', draggable: custom ? 'true' : undefined },
            },
            [
                el('div', { class: 'maestro-m23-entry-main' }, [
                    select,
                    custom
                        ? el('span', { class: 'maestro-m23-handle', title: t('m23.entries.drag'), text: '☰' })
                        : null,
                    custom
                        ? button({
                              icon: 'fa-arrow-up',
                              kind: 'ghost',
                              title: t('m23.entries.up'),
                              disabled: index === 0,
                              onClick: () => actions.reorder(moveItem(page, index, index - 1).map((item) => item.uid)),
                          })
                        : null,
                    custom
                        ? button({
                              icon: 'fa-arrow-down',
                              kind: 'ghost',
                              title: t('m23.entries.down'),
                              disabled: index === page.length - 1,
                              onClick: () => actions.reorder(moveItem(page, index, index + 1).map((item) => item.uid)),
                          })
                        : null,
                    button({
                        icon: disabled ? 'fa-toggle-off' : 'fa-toggle-on',
                        kind: 'ghost',
                        title: disabled ? t('m23.entries.enable') : t('m23.entries.disable'),
                        disabled: readOnly,
                        className: 'maestro-m23-toggle',
                        onClick: () => actions.setDisabled([uid], !disabled),
                    }),
                    el('button', {
                        class: 'maestro-m23-status',
                        text: STATUS_ICON[status],
                        title: t(`m23.status.${status}`),
                        attrs: { type: 'button', disabled: readOnly, 'aria-label': t(`m23.status.${status}`) },
                        on: { click: () => void actions.setStatus(uid, NEXT_STATUS[status]) },
                    }),
                    el(
                        'button',
                        {
                            class: 'maestro-m23-entry-title',
                            attrs: { type: 'button' },
                            title: t('m23.entries.openHint'),
                            on: { click: () => actions.open(uid) },
                        },
                        [
                            el('span', { class: 'maestro-m23-entry-name', text: title }),
                            el('span', { class: 'maestro-m23-entry-meta', text: meta.join(' · ') }),
                        ],
                    ),
                    el('span', { class: 'maestro-m23-entry-badges' }, badges),
                    button({
                        icon: state.expanded.has(uid) ? 'fa-chevron-up' : 'fa-chevron-down',
                        kind: 'ghost',
                        title: t('m23.entries.preview'),
                        onClick: () => {
                            if (state.expanded.has(uid)) state.expanded.delete(uid);
                            else state.expanded.add(uid);
                            renderList();
                        },
                    }),
                    el('span', { class: 'maestro-m23-entry-actions' }, [
                        button({
                            icon: 'fa-paste',
                            kind: 'ghost',
                            title: t('m23.entries.duplicate'),
                            disabled: readOnly,
                            onClick: () => actions.duplicate(uid),
                        }),
                        button({
                            icon: 'fa-right-left',
                            kind: 'ghost',
                            title: t('m23.entries.moveCopy'),
                            onClick: () => actions.moveCopy([uid]),
                        }),
                        button({
                            icon: 'fa-trash-can',
                            kind: 'ghost',
                            title: t('m23.entries.delete'),
                            disabled: readOnly,
                            onClick: () => actions.remove([uid]),
                        }),
                    ]),
                ]),
                state.expanded.has(uid) ? preview(entry) : null,
            ],
        );
        if (custom) bindDrag(node, uid, page);
        return node;
    }

    function preview(entry: LoreEntry): HTMLElement {
        const keys = stringList(entry.key);
        const secondary = stringList(entry.keysecondary);
        const content = typeof entry.content === 'string' ? entry.content : '';
        return el('div', { class: 'maestro-m23-entry-preview' }, [
            el('div', {
                class: 'maestro-m23-preview-keys',
                text: t('m23.entries.keys', { keys: keys.join(', ') || '—' }),
            }),
            secondary.length
                ? el('div', {
                      class: 'maestro-m23-preview-keys',
                      text: t('m23.entries.secondary', { keys: secondary.join(', ') }),
                  })
                : null,
            el('div', {
                class: 'maestro-m23-preview-content',
                text: content.length > 600 ? `${content.slice(0, 600)}…` : content,
            }),
        ]);
    }

    let dragged: number | null = null;
    function bindDrag(node: HTMLElement, uid: number, page: LoreEntry[]): void {
        node.addEventListener('dragstart', (event) => {
            dragged = uid;
            event.dataTransfer?.setData('text/plain', String(uid));
            node.classList.add('maestro-m23-dragging');
        });
        node.addEventListener('dragend', () => {
            dragged = null;
            node.classList.remove('maestro-m23-dragging');
        });
        node.addEventListener('dragover', (event) => {
            if (dragged === null || dragged === uid) return;
            event.preventDefault();
        });
        node.addEventListener('drop', (event) => {
            event.preventDefault();
            if (dragged === null || dragged === uid) return;
            const from = page.findIndex((item) => item.uid === dragged);
            const to = page.findIndex((item) => item.uid === uid);
            dragged = null;
            if (from < 0 || to < 0) return;
            void actions.reorder(moveItem(page, from, to).map((item) => item.uid));
        });
    }

    renderList();
    return root;
}
