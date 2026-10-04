// «Блоки» tab of the Preset Studio (research/parity-preset.md §2, M34 п. 2): the active prompt list in order with
// drag reorder (whole row on desktop) and ↑/↓ (phones, keyboard: Alt+↑/↓), on/off, search, bulk on/off, new /
// duplicate / delete / detach / insert, the prompt-list import and export in PM's own format, «reset order», token
// counts, PM's row icons (P-020), macro and flag highlighting and a preview with macros substituted.
import {
    blockKind,
    canEditBlock,
    canRemoveBlock,
    enabledCount,
    highlightSegments,
    isMarker,
    matchesSearch,
    promptDepth,
    promptName,
    promptOrder,
    promptRole,
    promptText,
    tokenTotal,
    typeProblems,
} from '../../domain/preset-ui-blocks';
import type { BlockKind } from '../../domain/preset-ui-blocks';
import { button, el, icon } from '../../ui/components/dom';
import type { ButtonOptions } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { PresetPrompt } from './store-api';

export interface BlockRow {
    identifier: string;
    enabled: boolean;
    /** null: an order entry without a block (PM skips it, P-019). */
    prompt: PresetPrompt | null;
}

export interface BlocksModel {
    rows: BlockRow[];
    /** Blocks not in the order: what «Вставить блок» offers (P-027). */
    detached: PresetPrompt[];
    tokens: ReadonlyMap<string, number>;
    /** Identifiers the user's layer touches, and those in conflict. */
    layerIds: ReadonlySet<string>;
    conflicts: ReadonlySet<string>;
    /** Blocks a character card replaced in the last assembly (P-040). */
    overridden: ReadonlySet<string>;
    openId: string | null;
    layerMode: boolean;
    /** The store can take a block out of the order (P-026). */
    canDetach: boolean;
    /** Rows may be dragged (not on touch screens: ↑/↓ there, P-017). */
    draggable: boolean;
}

export interface BlocksState {
    search: string;
    selected: Set<string>;
    expanded: Set<string>;
    /** identifier → its text with macros substituted (preview). */
    substituted: Map<string, string>;
    /** The block picked in «Вставить блок» (kept between renders like PM's footer, P-041). */
    insertChoice: string;
    focusId: string | null;
}

export interface BlocksActions {
    open(identifier: string): void;
    toggle(identifiers: string[], enabled: boolean): Promise<void>;
    move(identifier: string, toIndex: number): Promise<void>;
    add(): Promise<void>;
    duplicate(identifier: string): Promise<void>;
    remove(identifier: string): Promise<void>;
    detach(identifier: string): Promise<void>;
    insert(identifier: string): Promise<void>;
    importList(): Promise<void>;
    exportList(): void;
    resetOrder(): Promise<void>;
    substitute(identifier: string): Promise<void>;
    changed(): void;
}

export function emptyBlocksState(): BlocksState {
    return {
        search: '',
        selected: new Set(),
        expanded: new Set(),
        substituted: new Map(),
        insertChoice: '',
        focusId: null,
    };
}

const KIND_ICON: Record<BlockKind, string> = {
    inChat: 'fa-syringe',
    marker: 'fa-thumbtack',
    important: 'fa-star',
    global: 'fa-globe',
    user: 'fa-asterisk',
};

const SEARCH_DEBOUNCE_MS = 200;

/** Renders a block's text with macros, conditions and Maestro flags marked (M34 п. 2). */
export function highlighted(text: string, className = 'maestro-m34-text'): HTMLElement {
    return el(
        'div',
        { class: className },
        highlightSegments(text).map((segment) =>
            segment.kind === 'text'
                ? segment.text
                : el('span', { class: `maestro-m34-hl maestro-m34-hl-${segment.kind}`, text: segment.text }),
        ),
    );
}

/** A button the studio can give focus back to after a re-render (data-focus-key). */
function keyed(key: string, options: ButtonOptions): HTMLButtonElement {
    const node = button(options);
    node.dataset.focusKey = key;
    return node;
}

export function formatTokens(value: number | undefined): string {
    return typeof value === 'number' && value > 0 ? value.toLocaleString() : '–';
}

export function renderBlocksPanel(
    app: App,
    model: BlocksModel,
    state: BlocksState,
    actions: BlocksActions,
): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-blocks' });
    const searching = state.search.trim() !== '';
    const visible = model.rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => matchesSearch(row.prompt, row.identifier, state.search));

    /* ------------------------------------------------------------ toolbar */
    const search = el('input', {
        class: 'text_pole maestro-m34-search',
        attrs: { type: 'search', placeholder: t('m34.blocks.search'), 'aria-label': t('m34.blocks.search') },
        data: { focusKey: 'search' },
    });
    search.value = state.search;
    let timer: ReturnType<typeof setTimeout> | null = null;
    search.addEventListener('input', () => {
        state.search = search.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            actions.changed();
        }, SEARCH_DEBOUNCE_MS);
    });

    const insert = el('select', {
        class: 'text_pole maestro-m34-insert-select',
        attrs: { 'aria-label': t('m34.blocks.insertPick') },
    });
    insert.append(el('option', { text: t('m34.blocks.insertPick'), attrs: { value: '' } }));
    for (const prompt of model.detached) {
        insert.append(el('option', { text: promptName(prompt), attrs: { value: prompt.identifier } }));
    }
    insert.value = model.detached.some((prompt) => prompt.identifier === state.insertChoice) ? state.insertChoice : '';
    insert.disabled = !model.detached.length;
    insert.addEventListener('change', () => {
        state.insertChoice = insert.value;
    });

    const orderRows = model.rows.map((row) => ({
        item: { identifier: row.identifier, enabled: row.enabled },
        prompt: row.prompt,
    }));
    const counts = enabledCount(orderRows);
    const total = tokenTotal(orderRows, model.tokens);
    root.append(
        el('div', { class: 'maestro-m34-toolbar' }, [
            search,
            button({
                icon: 'fa-plus',
                label: t('m34.blocks.new'),
                kind: 'primary',
                className: 'maestro-m34-new',
                onClick: () => actions.add(),
            }),
            el('span', { class: 'maestro-m34-insert' }, [
                insert,
                button({
                    icon: 'fa-link',
                    title: t('m34.blocks.insert'),
                    className: 'maestro-m34-insert-btn',
                    disabled: !model.detached.length,
                    onClick: async () => {
                        if (insert.value) await actions.insert(insert.value);
                    },
                }),
            ]),
            button({
                icon: 'fa-file-import',
                title: t('m34.blocks.importList'),
                className: 'maestro-m34-import-list',
                onClick: () => actions.importList(),
            }),
            button({
                icon: 'fa-file-export',
                title: t('m34.blocks.exportList'),
                className: 'maestro-m34-export-list',
                onClick: () => actions.exportList(),
            }),
            button({
                icon: 'fa-arrow-rotate-left',
                title: t('m34.blocks.resetOrder'),
                className: 'maestro-m34-reset-order',
                onClick: () => actions.resetOrder(),
            }),
        ]),
        el('div', { class: 'maestro-m34-summary-line' }, [
            el('span', {
                class: 'maestro-m34-count',
                text: t('m34.blocks.enabled', { enabled: counts.enabled, total: counts.total }),
            }),
            el('span', { class: 'maestro-muted', text: t('m34.blocks.tokens', { count: formatTokens(total) }) }),
            model.layerMode
                ? el('span', { class: 'maestro-m34-badge maestro-m34-badge-layer', text: t('m34.blocks.toLayer') })
                : null,
            searching ? el('span', { class: 'maestro-muted', text: t('m34.blocks.dragOff') }) : null,
        ]),
    );

    /* ------------------------------------------------------------ bulk bar */
    const selected = [...state.selected].filter((identifier) =>
        model.rows.some((row) => row.identifier === identifier),
    );
    const bulk = el('div', {
        class: 'maestro-m34-bulk',
        attrs: { role: 'toolbar', 'aria-label': t('m34.bulk.title') },
    });
    bulk.hidden = !selected.length;
    if (selected.length) {
        bulk.append(
            el('span', { class: 'maestro-m34-bulk-count', text: t('m34.bulk.selected', { count: selected.length }) }),
            button({
                label: t('m34.bulk.selectAll'),
                kind: 'ghost',
                onClick: () => {
                    for (const { row } of visible) state.selected.add(row.identifier);
                    actions.changed();
                },
            }),
            button({
                label: t('m34.bulk.clear'),
                kind: 'ghost',
                onClick: () => {
                    state.selected.clear();
                    actions.changed();
                },
            }),
            button({
                icon: 'fa-toggle-on',
                label: t('m34.bulk.enable'),
                className: 'maestro-m34-bulk-on',
                onClick: () => actions.toggle(selected, true),
            }),
            button({
                icon: 'fa-toggle-off',
                label: t('m34.bulk.disable'),
                className: 'maestro-m34-bulk-off',
                onClick: () => actions.toggle(selected, false),
            }),
        );
    }
    root.append(bulk);

    /* ------------------------------------------------------------ list */
    const list = el('div', { class: 'maestro-m34-block-list', attrs: { role: 'list' } });
    root.append(list);
    if (!model.rows.length) {
        list.append(el('div', { class: 'maestro-empty', text: t('m34.blocks.empty') }));
        return root;
    }
    if (!visible.length) {
        list.append(el('div', { class: 'maestro-empty', text: t('m34.blocks.noMatch') }));
        return root;
    }
    const movable = !searching;
    let dragged: string | null = null;

    for (const { row, index } of visible) list.append(renderRow(row, index));

    if (state.focusId) {
        const focus = state.focusId;
        const node = [...list.querySelectorAll<HTMLElement>('.maestro-m34-block')].find(
            (item) => item.dataset.id === focus,
        );
        node?.classList.add('maestro-m34-flash');
        node?.scrollIntoView?.({ block: 'nearest' });
        node?.querySelector<HTMLElement>('.maestro-m34-block-name')?.focus();
        state.focusId = null;
    }
    return root;

    function renderRow(row: BlockRow, index: number): HTMLElement {
        const prompt = row.prompt;
        const identifier = row.identifier;
        const name = prompt ? promptName(prompt) : identifier;
        const select = el('input', {
            attrs: { type: 'checkbox', 'aria-label': t('m34.blocks.select', { name }) },
            data: { focusKey: `select:${identifier}` },
        });
        select.checked = state.selected.has(identifier);
        select.addEventListener('change', () => {
            if (select.checked) state.selected.add(identifier);
            else state.selected.delete(identifier);
            actions.changed();
        });
        const last = model.rows.length - 1;
        const node = el(
            'div',
            {
                class: [
                    'maestro-m34-block',
                    row.enabled ? null : 'maestro-m34-off',
                    prompt ? null : 'maestro-m34-missing',
                    model.openId === identifier ? 'maestro-on' : null,
                ],
                data: { id: identifier },
                attrs: { role: 'listitem', draggable: movable && model.draggable ? 'true' : undefined },
            },
            [
                el('div', { class: 'maestro-m34-block-main' }, [
                    select,
                    movable && model.draggable
                        ? el('span', { class: 'maestro-m34-handle', title: t('m34.blocks.drag'), text: '☰' })
                        : null,
                    movable
                        ? keyed(`up:${identifier}`, {
                              icon: 'fa-arrow-up',
                              kind: 'ghost',
                              title: t('m34.blocks.up'),
                              className: 'maestro-m34-up',
                              disabled: index === 0,
                              onClick: () => actions.move(identifier, index - 1),
                          })
                        : null,
                    movable
                        ? keyed(`down:${identifier}`, {
                              icon: 'fa-arrow-down',
                              kind: 'ghost',
                              title: t('m34.blocks.down'),
                              className: 'maestro-m34-down',
                              disabled: index === last,
                              onClick: () => actions.move(identifier, index + 1),
                          })
                        : null,
                    keyed(`toggle:${identifier}`, {
                        icon: row.enabled ? 'fa-toggle-on' : 'fa-toggle-off',
                        kind: 'ghost',
                        title: row.enabled ? t('m34.blocks.disable') : t('m34.blocks.enable'),
                        className: 'maestro-m34-toggle',
                        disabled: !prompt,
                        onClick: () => actions.toggle([identifier], !row.enabled),
                    }),
                    prompt ? kindIcon(prompt) : el('span', { class: 'maestro-m34-kind' }, [icon('fa-link-slash')]),
                    el(
                        'button',
                        {
                            class: 'maestro-m34-block-name',
                            attrs: { type: 'button', disabled: !prompt },
                            data: { focusKey: `name:${identifier}` },
                            title: prompt && canEditBlock(prompt) ? t('m34.blocks.openHint') : t('m34.blocks.viewHint'),
                            on: { click: () => actions.open(identifier) },
                        },
                        [
                            el('span', { class: 'maestro-m34-block-title', text: name }),
                            el('span', {
                                class: 'maestro-m34-block-meta',
                                text: prompt ? meta(prompt) : t('m34.blocks.missing'),
                            }),
                        ],
                    ),
                    el('span', { class: 'maestro-m34-block-badges' }, prompt ? badges(prompt) : []),
                    el('span', {
                        class: 'maestro-m34-tokens',
                        title: t('m34.blocks.tokensHint'),
                        text: formatTokens(model.tokens.get(identifier)),
                    }),
                    prompt
                        ? keyed(`expand:${identifier}`, {
                              icon: state.expanded.has(identifier) ? 'fa-chevron-up' : 'fa-chevron-down',
                              kind: 'ghost',
                              title: t('m34.blocks.preview'),
                              className: 'maestro-m34-expand',
                              onClick: () => {
                                  if (state.expanded.has(identifier)) state.expanded.delete(identifier);
                                  else state.expanded.add(identifier);
                                  actions.changed();
                              },
                          })
                        : null,
                    el('span', { class: 'maestro-m34-block-actions' }, [
                        prompt && !isMarker(prompt)
                            ? button({
                                  icon: 'fa-paste',
                                  kind: 'ghost',
                                  title: t('m34.blocks.duplicate'),
                                  className: 'maestro-m34-duplicate',
                                  onClick: () => actions.duplicate(identifier),
                              })
                            : null,
                        model.canDetach && (!prompt || canRemoveBlock(prompt))
                            ? button({
                                  icon: 'fa-link-slash',
                                  kind: 'ghost',
                                  title: t('m34.blocks.detach'),
                                  className: 'maestro-m34-detach',
                                  onClick: () => actions.detach(identifier),
                              })
                            : null,
                        prompt && canRemoveBlock(prompt)
                            ? button({
                                  icon: 'fa-trash-can',
                                  kind: 'ghost',
                                  title: t('m34.blocks.delete'),
                                  className: 'maestro-m34-delete',
                                  onClick: () => actions.remove(identifier),
                              })
                            : null,
                    ]),
                ]),
                prompt && state.expanded.has(identifier) ? preview(prompt) : null,
            ],
        );
        node.addEventListener('keydown', (event) => {
            if (!movable || !event.altKey) return;
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const target = event.key === 'ArrowUp' ? index - 1 : index + 1;
            if (target < 0 || target > last) return;
            state.focusId = identifier;
            void actions.move(identifier, target);
        });
        if (movable && model.draggable) bindDrag(node, identifier);
        return node;
    }

    function meta(prompt: PresetPrompt): string {
        const role = t(`m34.role.${promptRole(prompt)}`);
        if (prompt.injection_position === 1) {
            return t('m34.blocks.metaInChat', { role, depth: promptDepth(prompt), order: promptOrder(prompt) });
        }
        return t('m34.blocks.metaRelative', { role });
    }

    function kindIcon(prompt: PresetPrompt): HTMLElement {
        const kind = blockKind(prompt);
        const label = t(`m34.kind.${kind}`);
        const role = promptRole(prompt);
        return el('span', { class: ['maestro-m34-kind', `maestro-m34-kind-${kind}`], title: label }, [
            icon(KIND_ICON[kind]),
            role === 'assistant' ? icon('fa-robot') : role === 'user' ? icon('fa-user') : null,
            el('span', { class: 'maestro-sr-only', text: label }),
        ]);
    }

    function badges(prompt: PresetPrompt): HTMLElement[] {
        const list: HTMLElement[] = [];
        const identifier = prompt.identifier;
        if (model.conflicts.has(identifier)) {
            list.push(
                el('span', { class: 'maestro-m34-badge maestro-m34-badge-conflict', text: t('m34.blocks.conflict') }),
            );
        } else if (model.layerIds.has(identifier)) {
            list.push(
                el('span', { class: 'maestro-m34-badge maestro-m34-badge-layer', text: t('m34.blocks.inLayer') }),
            );
        }
        if (model.overridden.has(identifier)) {
            list.push(
                el('span', {
                    class: 'maestro-m34-badge',
                    title: t('m34.blocks.overriddenHint'),
                    text: t('m34.blocks.overridden'),
                }),
            );
        }
        if (typeProblems(prompt).length) {
            list.push(
                el('span', {
                    class: 'maestro-m34-badge maestro-m34-badge-warn',
                    title: t('m34.blocks.typesHint'),
                    text: t('m34.blocks.types'),
                }),
            );
        }
        return list;
    }

    function preview(prompt: PresetPrompt): HTMLElement {
        const identifier = prompt.identifier;
        if (isMarker(prompt)) {
            return el('div', { class: 'maestro-m34-preview' }, [
                el('div', { class: 'maestro-muted', text: t('m34.blocks.markerPreview') }),
            ]);
        }
        const text = promptText(prompt);
        const substituted = state.substituted.get(identifier);
        return el('div', { class: 'maestro-m34-preview' }, [
            text ? highlighted(text) : el('div', { class: 'maestro-muted', text: t('m34.blocks.emptyText') }),
            el('div', { class: 'maestro-row' }, [
                button({
                    icon: 'fa-wand-magic-sparkles',
                    label: t('m34.blocks.substitute'),
                    kind: 'ghost',
                    className: 'maestro-m34-substitute',
                    disabled: !text,
                    onClick: () => actions.substitute(identifier),
                }),
            ]),
            substituted !== undefined
                ? el('div', { class: 'maestro-m34-substituted' }, [
                      el('div', { class: 'maestro-field-hint', text: t('m34.blocks.substituted') }),
                      el('div', { class: 'maestro-m34-text', text: substituted }),
                  ])
                : null,
        ]);
    }

    function bindDrag(node: HTMLElement, identifier: string): void {
        node.addEventListener('dragstart', (event) => {
            dragged = identifier;
            event.dataTransfer?.setData('text/plain', identifier);
            node.classList.add('maestro-m34-dragging');
        });
        node.addEventListener('dragend', () => {
            dragged = null;
            node.classList.remove('maestro-m34-dragging');
        });
        node.addEventListener('dragover', (event) => {
            if (dragged === null || dragged === identifier) return;
            event.preventDefault();
        });
        node.addEventListener('drop', (event) => {
            event.preventDefault();
            const from = dragged;
            dragged = null;
            if (from === null || from === identifier) return;
            const to = model.rows.findIndex((row) => row.identifier === identifier);
            if (to >= 0) void actions.move(from, to);
        });
    }
}
