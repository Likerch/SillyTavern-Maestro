// Left panel of the Lore Studio: books by role section (M35 п. 3), search, «active in this chat» filter with the
// reasons from M1 (whyActive), per-book global switch, create/import, and the bindings of this chat (global,
// character primary/extra, chat, persona — research/parity-lore.md §2.1, §2.3).
import { groupBooks } from '../../domain/lore-studio-books';
import type { SectionId, StudioRole } from '../../domain/lore-studio-books';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { CurrentCharacter } from './st-lore';
import type { RoleView } from './store';
import type { WiBindings } from './store-api';

export interface BooksModel {
    books: string[];
    roleOf(book: string): RoleView;
    bindings: WiBindings;
    /** Book → reasons it is active in this chat (M1 BookReason ids). */
    reasons: Map<string, string[]>;
    character: CurrentCharacter | null;
    canonBook: string | null;
    /** Book → DES campaign name. */
    campaignOf: Map<string, string>;
    groupChat: boolean;
    hasChat: boolean;
    /** Name the current card's embedded book would be imported under (null without one). */
    cardBook: string | null;
}

export interface BooksState {
    search: string;
    onlyActive: boolean;
    collapsed: Set<SectionId>;
    selected: string | null;
    bindingsOpen: boolean;
}

export interface BooksActions {
    select(book: string): void;
    toggleGlobal(book: string, on: boolean): Promise<void>;
    create(): Promise<void>;
    importFile(file: File): Promise<void>;
    setPrimary(name: string | null): Promise<void>;
    setExtra(names: string[]): Promise<void>;
    setChat(name: string | null): Promise<void>;
    setPersona(name: string | null): Promise<void>;
    importCardBook(): Promise<void>;
    /** UI-only state changed (search, filter, collapse): re-render the panel. */
    changed(): void;
}

export const SECTION_ICONS: Record<SectionId, string> = {
    chat: 'fa-comments',
    card: 'fa-id-card',
    world: 'fa-earth-europe',
    characters: 'fa-users',
    system: 'fa-gears',
    maestro: 'fa-wand-magic-sparkles',
    backup: 'fa-box-archive',
};

/** `m23.role.*` key of a role ('bunnymo.core' → 'bunnymoCore'). */
export function roleKey(role: StudioRole): string {
    return `m23.role.${role.replace(/\.(\w)/g, (_, letter: string) => letter.toUpperCase())}`;
}

export function reasonText(app: App, reasons: readonly string[]): string {
    return reasons.map((reason) => app.i18n.t(`m23.reason.${reason}`)).join(', ');
}

export function renderBooksPanel(app: App, model: BooksModel, state: BooksState, actions: BooksActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m23-books-panel' });

    const search = el('input', {
        class: 'text_pole maestro-m23-book-search',
        attrs: { type: 'search', placeholder: t('m23.books.search'), 'aria-label': t('m23.books.search') },
    });
    search.value = state.search;
    search.addEventListener('input', () => {
        state.search = search.value;
        renderList();
    });
    const onlyActive = el('input', { attrs: { type: 'checkbox' } });
    onlyActive.checked = state.onlyActive;
    onlyActive.addEventListener('change', () => {
        state.onlyActive = onlyActive.checked;
        renderList();
    });
    const fileInput = el('input', {
        class: 'maestro-m23-hidden-file',
        attrs: { type: 'file', accept: '.json,.lorebook,.png', 'aria-hidden': 'true', tabindex: '-1' },
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) void actions.importFile(file);
    });

    root.append(
        el('div', { class: 'maestro-m23-books-tools' }, [
            search,
            el('div', { class: 'maestro-row' }, [
                button({ icon: 'fa-plus', label: t('m23.books.create'), onClick: () => actions.create() }),
                button({
                    icon: 'fa-file-import',
                    label: t('m23.books.import'),
                    title: t('m23.books.importHint'),
                    onClick: () => fileInput.click(),
                }),
                fileInput,
            ]),
            el('label', { class: 'checkbox_label maestro-m23-only-active', title: t('m23.books.onlyActiveHint') }, [
                onlyActive,
                el('span', { text: t('m23.books.onlyActive') }),
            ]),
        ]),
    );

    const list = el('div', { class: 'maestro-m23-book-list', attrs: { role: 'list' } });
    root.append(list, renderBindings(app, model, state, actions));

    function visibleBooks(): string[] {
        const query = state.search.trim().toLowerCase();
        return model.books.filter((book) => {
            if (query && !book.toLowerCase().includes(query)) return false;
            if (state.onlyActive && !(model.reasons.get(book)?.length ?? 0)) return false;
            return true;
        });
    }

    function renderList(): void {
        list.replaceChildren();
        const books = visibleBooks();
        if (!books.length) {
            list.append(el('div', { class: 'maestro-empty', text: t('m23.books.none') }));
            return;
        }
        const extra = model.bindings.character.extra;
        const sections = groupBooks(books, (book) => model.roleOf(book).role, {
            chatBook: model.bindings.chat,
            personaBook: model.bindings.persona,
            canonBook: model.canonBook,
            characterBooks: [model.bindings.character.primary ?? '', ...extra].filter(Boolean),
        });
        for (const section of sections) {
            const details = el('details', { class: 'maestro-m23-section', data: { section: section.id } });
            // A search shows every match, also inside collapsed sections (DES hides them: not copied).
            details.open = state.search.trim() !== '' || !state.collapsed.has(section.id);
            details.addEventListener('toggle', () => {
                if (state.search.trim()) return;
                if (details.open) state.collapsed.delete(section.id);
                else state.collapsed.add(section.id);
            });
            details.append(
                el('summary', { class: 'maestro-m23-section-title' }, [
                    icon(SECTION_ICONS[section.id]),
                    el('span', { text: t(`m23.section.${section.id}`) }),
                    el('span', { class: 'maestro-m23-count', text: String(section.books.length) }),
                ]),
            );
            for (const book of section.books) details.append(bookRow(book));
            list.append(details);
        }
    }

    function bookRow(book: string): HTMLElement {
        const role = model.roleOf(book);
        const reasons = model.reasons.get(book) ?? [];
        const global = model.bindings.global.includes(book);
        const toggle = el('input', {
            attrs: { type: 'checkbox', 'aria-label': t('m23.books.globalToggle', { book }) },
        });
        toggle.checked = global;
        toggle.addEventListener('change', () => {
            void actions.toggleGlobal(book, toggle.checked);
        });
        const campaign = model.campaignOf.get(book);
        return el(
            'div',
            {
                class: [
                    'maestro-m23-book',
                    state.selected === book ? 'maestro-on' : null,
                    reasons.length ? 'maestro-m23-active' : null,
                ],
                data: { book },
                attrs: { role: 'listitem' },
            },
            [
                el(
                    'button',
                    {
                        class: 'maestro-m23-book-name',
                        title: reasons.length
                            ? t('m23.books.activeBecause', { reasons: reasonText(app, reasons) })
                            : book,
                        attrs: { type: 'button' },
                        on: { click: () => actions.select(book) },
                    },
                    [
                        el('span', {
                            class: ['maestro-m23-dot', reasons.length ? 'maestro-m23-dot-on' : null],
                            attrs: { 'aria-hidden': 'true' },
                        }),
                        el('span', { class: 'maestro-m23-book-title', text: book }),
                    ],
                ),
                el('span', { class: 'maestro-m23-book-badges' }, [
                    role.readOnly
                        ? el(
                              'span',
                              { class: 'maestro-m23-badge maestro-m23-badge-lock', title: t('m23.books.readOnly') },
                              [icon('fa-lock')],
                          )
                        : null,
                    el('span', { class: 'maestro-m23-badge', text: t(roleKey(role.role)) }),
                    campaign
                        ? el('span', { class: 'maestro-m23-badge maestro-m23-badge-campaign', text: campaign })
                        : null,
                ]),
                el('label', { class: 'maestro-m23-global', title: t('m23.books.globalHint') }, [
                    toggle,
                    icon('fa-globe'),
                ]),
            ],
        );
    }

    renderList();
    return root;
}

function bookOptions(app: App, books: readonly string[], current: string | null): HTMLOptionElement[] {
    const options = [el('option', { text: app.i18n.t('m23.bindings.none'), attrs: { value: '' } })];
    for (const book of books) options.push(el('option', { text: book, attrs: { value: book } }));
    // A link to a book that no longer exists stays visible (and can be cleared).
    if (current && !books.includes(current)) {
        options.push(
            el('option', { text: app.i18n.t('m23.bindings.missing', { book: current }), attrs: { value: current } }),
        );
    }
    for (const option of options) option.selected = option.value === (current ?? '');
    return options;
}

function bookSelect(
    app: App,
    label: string,
    books: readonly string[],
    current: string | null,
    onChange: (value: string | null) => Promise<void>,
    disabled = false,
): HTMLElement {
    const select = el('select', {
        class: 'text_pole maestro-m23-binding-select',
        attrs: { 'aria-label': label, disabled },
    });
    select.append(...bookOptions(app, books, current));
    select.addEventListener('change', () => {
        void onChange(select.value || null);
    });
    return el('label', { class: 'maestro-m23-binding' }, [
        el('span', { class: 'maestro-m23-binding-label', text: label }),
        select,
    ]);
}

function renderBindings(app: App, model: BooksModel, state: BooksState, actions: BooksActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const details = el('details', { class: 'maestro-m23-bindings' });
    details.open = state.bindingsOpen;
    details.addEventListener('toggle', () => {
        state.bindingsOpen = details.open;
    });
    details.append(el('summary', {}, [icon('fa-link'), el('span', { text: t('m23.bindings.title') })]));

    // Global books: chips with removal + an «add» select.
    const chips = el('div', { class: 'maestro-m23-chips' });
    for (const book of model.bindings.global) {
        chips.append(
            el('span', { class: 'maestro-m23-chip' }, [
                el('span', { text: book }),
                button({
                    icon: 'fa-xmark',
                    kind: 'ghost',
                    title: t('m23.bindings.removeGlobal', { book }),
                    onClick: () => actions.toggleGlobal(book, false),
                }),
            ]),
        );
    }
    if (!model.bindings.global.length)
        chips.append(el('span', { class: 'maestro-muted', text: t('m23.bindings.noGlobal') }));
    const add = el('select', { class: 'text_pole', attrs: { 'aria-label': t('m23.bindings.addGlobal') } });
    add.append(el('option', { text: t('m23.bindings.addGlobal'), attrs: { value: '' } }));
    for (const book of model.books.filter((name) => !model.bindings.global.includes(name))) {
        add.append(el('option', { text: book, attrs: { value: book } }));
    }
    add.addEventListener('change', () => {
        if (add.value) void actions.toggleGlobal(add.value, true);
    });
    details.append(
        el('div', { class: 'maestro-m23-binding-group' }, [
            el('div', { class: 'maestro-m23-binding-label', text: t('m23.bindings.global') }),
            chips,
            add,
        ]),
    );

    // Character: primary (stored in the card) and additional books (ST settings, not exported with the card).
    if (model.groupChat) {
        details.append(el('p', { class: 'maestro-muted', text: t('m23.bindings.group') }));
    } else if (model.character) {
        const character = model.character;
        const extraList = el('div', { class: 'maestro-m23-extra-list' });
        const chosen = new Set(model.bindings.character.extra);
        for (const book of model.books) {
            const box = el('input', { attrs: { type: 'checkbox' } });
            box.checked = chosen.has(book);
            box.addEventListener('change', () => {
                if (box.checked) chosen.add(book);
                else chosen.delete(book);
                void actions.setExtra(model.books.filter((name) => chosen.has(name)));
            });
            extraList.append(el('label', { class: 'checkbox_label' }, [box, el('span', { text: book })]));
        }
        const extra = el('details', { class: 'maestro-m23-extra' }, [
            el('summary', {
                text: t('m23.bindings.extra', { count: model.bindings.character.extra.length }),
            }),
            extraList,
        ]);
        details.append(
            el('div', { class: 'maestro-m23-binding-group' }, [
                el('div', {
                    class: 'maestro-m23-binding-label',
                    text: t('m23.bindings.character', { name: character.name }),
                }),
                bookSelect(app, t('m23.bindings.primary'), model.books, model.bindings.character.primary, (value) =>
                    actions.setPrimary(value),
                ),
                extra,
                model.cardBook
                    ? el('div', { class: 'maestro-m23-card-book' }, [
                          el('span', {
                              class: 'maestro-muted',
                              text: t('m23.card.embedded', { book: model.cardBook }),
                          }),
                          button({
                              icon: 'fa-file-import',
                              label: t('m23.card.import'),
                              onClick: () => actions.importCardBook(),
                          }),
                      ])
                    : null,
            ]),
        );
    } else {
        details.append(el('p', { class: 'maestro-muted', text: t('m23.bindings.noCharacter') }));
    }

    details.append(
        bookSelect(
            app,
            t('m23.bindings.chat'),
            model.books,
            model.bindings.chat,
            (value) => actions.setChat(value),
            !model.hasChat,
        ),
        bookSelect(app, t('m23.bindings.persona'), model.books, model.bindings.persona, (value) =>
            actions.setPersona(value),
        ),
    );
    return details;
}
