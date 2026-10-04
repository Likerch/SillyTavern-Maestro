// «Словарь тегов» (M35 п. 5): every tag of the loaded BunnyMo books with search and a category filter; a tag card
// shows the pack entries it pulls, the archives using it, duplicates, version conflicts and orphans.
import { badge, emptyState } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import type { TagDictionary, TagInfo } from './api';
import { DICTIONARY_PAGE, FLAGS_FILTER, errorText, loading } from './view-common';
import type { ViewContext } from './view-common';

function matches(tag: TagInfo, query: string): boolean {
    if (!query) return true;
    if (tag.tag.toLowerCase().includes(query)) return true;
    if (tag.entries.some((entry) => entry.comment.toLowerCase().includes(query))) return true;
    return tag.usedBy.some((use) => use.name.toLowerCase().includes(query));
}

function filtered(dictionary: TagDictionary, query: string, category: string): TagInfo[] {
    const flags = new Set(dictionary.categories.filter((item) => item.flag).map((item) => item.id));
    const needle = query.trim().toLowerCase();
    return dictionary.tags.filter((tag) => {
        if (category === FLAGS_FILTER ? !flags.has(tag.category) : category && tag.category !== category) return false;
        return matches(tag, needle);
    });
}

function tagCard(ctx: ViewContext, tag: TagInfo, info: boolean): HTMLElement {
    const { t } = ctx;
    const entries = tag.entries.length
        ? el(
              'ul',
              { class: 'maestro-m35b-list' },
              tag.entries.map((entry) =>
                  el('li', {}, [
                      el('span', { class: 'maestro-m35b-strong', text: entry.comment || `#${entry.uid}` }),
                      ' ',
                      el('span', {
                          class: 'maestro-muted',
                          text: `${t('m35b.dict.entry', { book: entry.book, uid: entry.uid })} · ${t('m35b.dict.chars', { chars: entry.chars })}`,
                      }),
                      ' ',
                      badge(t(`m35b.dict.kind.${entry.kind}`), entry.kind === 'pull' ? 'ok' : 'muted'),
                  ]),
              ),
          )
        : el('div', { class: 'maestro-muted', text: t(info ? 'm35b.dict.infoTag' : 'm35b.dict.noEntries') });
    const used = tag.usedBy.length
        ? el(
              'div',
              { class: 'maestro-m35b-chips' },
              tag.usedBy.map((use) =>
                  button({
                      label: use.name || `#${use.uid}`,
                      icon: 'fa-id-card',
                      kind: 'ghost',
                      title: t('m35b.dict.openSheet', { name: use.name || `#${use.uid}` }),
                      onClick: () => {
                          ctx.state.sheets.pending = { book: use.book, uid: use.uid };
                          ctx.state.sheets.editor = null;
                          ctx.go('sheets');
                      },
                  }),
              ),
          )
        : el('div', { class: 'maestro-muted', text: t('m35b.dict.unused') });
    return el('div', { class: 'maestro-m35b-card' }, [
        tag.conflict ? el('div', { class: 'maestro-warn-text', text: t('m35b.dict.conflictHint') }) : null,
        tag.duplicate ? el('div', { class: 'maestro-muted', text: t('m35b.dict.duplicateHint') }) : null,
        el('div', { class: 'maestro-m35b-label', text: t('m35b.dict.pulls') }),
        entries,
        el('div', { class: 'maestro-m35b-label', text: t('m35b.dict.usedBy') }),
        used,
    ]);
}

function tagRow(ctx: ViewContext, tag: TagInfo, info: boolean): HTMLElement {
    const { t, state } = ctx;
    const details = el('details', { class: 'maestro-m35b-tag', data: { tag: tag.tag } }, [
        el('summary', {}, [
            el('code', { class: 'maestro-m35b-code', text: tag.tag }),
            tag.conflict ? badge(t('m35b.dict.badge.conflict'), 'warn') : null,
            tag.duplicate ? badge(t('m35b.dict.badge.duplicate'), 'muted') : null,
            tag.orphan ? badge(t('m35b.dict.badge.orphan'), 'error') : null,
            !tag.entries.length && info ? badge(t('m35b.dict.badge.info'), 'muted') : null,
            el('span', {
                class: 'maestro-muted maestro-m35b-counts',
                text: `${tag.entries.length} · ${tag.usedBy.length}`,
            }),
        ]),
    ]);
    let filled = false;
    const fill = () => {
        if (filled) return;
        filled = true;
        details.appendChild(tagCard(ctx, tag, info));
    };
    if (state.dict.open === tag.tag) {
        details.open = true;
        fill();
    }
    details.addEventListener('toggle', () => {
        if (details.open) {
            state.dict.open = tag.tag;
            fill();
        } else if (state.dict.open === tag.tag) state.dict.open = null;
    });
    return details;
}

export async function renderDictionary(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t, state } = ctx;
    body.appendChild(loading(t));
    let dictionary: TagDictionary;
    try {
        dictionary = await ctx.service.dictionary();
    } catch (error) {
        clear(body);
        body.appendChild(el('div', { class: 'maestro-error-text', text: errorText(error) }));
        return;
    }
    clear(body);
    if (!dictionary.tags.length) {
        body.appendChild(emptyState(t('m35b.dict.empty'), 'fa-carrot'));
        return;
    }
    const infoCategories = new Set(dictionary.categories.filter((item) => item.info).map((item) => item.id));
    const search = el('input', {
        class: 'text_pole maestro-m35b-search',
        attrs: { type: 'search', placeholder: t('m35b.dict.search'), 'aria-label': t('m35b.dict.search') },
    });
    search.value = state.dict.search;
    const category = el('select', {
        class: 'text_pole maestro-select',
        attrs: { 'aria-label': t('m35b.dict.category') },
    });
    category.appendChild(el('option', { text: t('m35b.dict.allCategories'), attrs: { value: '' } }));
    category.appendChild(el('option', { text: t('m35b.dict.flags'), attrs: { value: FLAGS_FILTER } }));
    for (const item of [...dictionary.categories]
        .filter((entry) => !entry.flag)
        .sort((a, b) => a.id.localeCompare(b.id))) {
        category.appendChild(el('option', { text: `${item.id} (${item.tags})`, attrs: { value: item.id } }));
    }
    category.value = state.dict.category;
    const conflicts = dictionary.tags.filter((tag) => tag.conflict).length;
    const orphans = dictionary.tags.filter((tag) => tag.orphan).length;
    const summary = el('div', {
        class: 'maestro-muted',
        text: t('m35b.dict.summary', {
            tags: dictionary.tags.length,
            categories: dictionary.categories.filter((item) => !item.flag).length,
            conflicts,
            orphans,
        }),
    });
    const list = el('div', { class: 'maestro-m35b-tags' });
    const drawList = () => {
        clear(list);
        const rows = filtered(dictionary, state.dict.search, state.dict.category);
        if (!rows.length) {
            list.appendChild(emptyState(t('m35b.dict.none'), 'fa-magnifying-glass'));
            return;
        }
        for (const tag of rows.slice(0, state.dict.limit)) {
            list.appendChild(tagRow(ctx, tag, infoCategories.has(tag.category)));
        }
        const rest = rows.length - state.dict.limit;
        if (rest > 0) {
            list.appendChild(
                button({
                    label: t('m35b.dict.more', { count: Math.min(rest, DICTIONARY_PAGE) }),
                    kind: 'ghost',
                    onClick: () => {
                        state.dict.limit += DICTIONARY_PAGE;
                        drawList();
                    },
                }),
            );
        }
    };
    search.addEventListener('input', () => {
        state.dict.search = search.value;
        state.dict.limit = DICTIONARY_PAGE;
        drawList();
    });
    category.addEventListener('change', () => {
        state.dict.category = category.value;
        state.dict.limit = DICTIONARY_PAGE;
        drawList();
    });
    body.append(el('div', { class: 'maestro-m35b-controls' }, [search, category]), summary, list);
    drawList();
    if (state.dict.open) {
        const open = [...list.querySelectorAll<HTMLElement>('.maestro-m35b-tag')].find(
            (node) => node.dataset.tag === state.dict.open,
        );
        if (typeof open?.scrollIntoView === 'function') open.scrollIntoView({ block: 'nearest' });
    }
}
