// «Листы» (M35 п. 7–8): character archives by book, and the sheet editor — tag chips from the dictionary with the tag
// check and suggestions, the MBTI archetype with its H/U switch, the Linguistics block and the prose sections. One entry
// is one character and `<Name:…>` never changes. Sheet commands stay with the sheet scenario (M31): the editor shows
// the character's sheets in this chat and how to run a command.
import { INFO_CATEGORIES, MBTI_CATEGORY } from '../../domain/bunnymo-mode-tags';
import { MBTI_TYPES } from '../../domain/bunnymo-mode-sheet';
import type { SheetsApi } from '../sheets/api';
import { banner, emptyState, section } from '../../ui/components/card';
import { segmented, uid as uniqueId } from '../../ui/components/controls';
import { append, button, clear, el } from '../../ui/components/dom';
import type { ArchiveSheet, TagDictionary, TagValidation } from './api';
import { copySheet, errorText, loading, tagText } from './view-common';
import type { SheetEditorState, ViewContext } from './view-common';

const TEXT_TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;

function sameSheet(a: ArchiveSheet, b: ArchiveSheet): boolean {
    const pick = (sheet: ArchiveSheet) => ({
        tags: sheet.tags,
        mbti: sheet.mbti ?? null,
        linguistics: sheet.linguistics ?? null,
        sections: sheet.sections,
    });
    return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
}

/** Tags written in the prose (Linguistics, sections): they pull packs through recursion too. */
function textTags(sheet: ArchiveSheet): string[] {
    const found = new Set<string>();
    for (const text of [sheet.linguistics ?? '', ...sheet.sections.map((item) => item.text)]) {
        for (const match of text.matchAll(TEXT_TAG_RE)) found.add(`<${match[1]}:${(match[2] ?? '').trim()}>`);
    }
    return [...found];
}

async function openEditor(ctx: ViewContext, book: string, uid: number): Promise<SheetEditorState | null> {
    const sheet = await ctx.service.readSheet(book, uid);
    if (!sheet) return null;
    return { book, uid, original: sheet, draft: copySheet(sheet), editIndex: null, category: '', value: '' };
}

async function renderList(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t } = ctx;
    const archives = await ctx.service.archives();
    clear(body);
    if (!archives.length) {
        body.appendChild(emptyState(t('m35b.sheets.none'), 'fa-id-card'));
        return;
    }
    for (const group of archives) {
        body.appendChild(
            section(
                group.book,
                el(
                    'div',
                    { class: 'maestro-m35b-archives' },
                    group.items.map((item) =>
                        button({
                            label: `${item.name || t('m35b.sheets.noName')} · ${t('m35b.sheets.tags', { count: item.tags })}`,
                            icon: 'fa-id-card',
                            kind: 'ghost',
                            className: 'maestro-m35b-archive',
                            title: item.title,
                            onClick: () =>
                                ctx.run(async () => {
                                    const editor = await openEditor(ctx, group.book, item.uid);
                                    if (!editor) throw new Error(t('m35b.sheets.notFound'));
                                    ctx.state.sheets.editor = editor;
                                    ctx.redraw();
                                }),
                        }),
                    ),
                ),
            ),
        );
    }
}

function categoriesOf(dictionary: TagDictionary): string[] {
    const set = new Set<string>(INFO_CATEGORIES);
    for (const category of dictionary.categories) if (!category.flag) set.add(category.id);
    for (const skip of ['NAME', MBTI_CATEGORY, 'SECTION']) set.delete(skip);
    return [...set].sort();
}

function valuesOf(dictionary: TagDictionary, category: string): string[] {
    return dictionary.tags
        .filter((tag) => tag.category === category && tag.value !== null && tag.entries.length > 0)
        .map((tag) => tag.value as string);
}

function renderEditor(ctx: ViewContext, body: HTMLElement, editor: SheetEditorState, dictionary: TagDictionary): void {
    const { t, state } = ctx;
    const draft = editor.draft;
    const blocked = (editor.original.blocks ?? 1) > 1;

    const chips = el('div', { class: 'maestro-m35b-chips', attrs: { role: 'list' } });
    const problems = el('div', { class: 'maestro-m35b-problems', attrs: { 'aria-live': 'polite' } });
    let validations = new Map<string, TagValidation>();
    let checkToken = 0;

    const validate = async () => {
        const token = ++checkToken;
        const own = draft.tags.map(tagText);
        const mbti = draft.mbti ? [`<${draft.mbti.type}-${draft.mbti.variant}>`] : [];
        const inText = textTags(draft).filter((tag) => !own.includes(tag));
        const list = [`<Name:${draft.name}>`, ...own, ...mbti, ...inText].filter((tag) => tag !== '<Name:>');
        let results: TagValidation[];
        try {
            results = await ctx.service.validateTags(list);
        } catch (error) {
            ctx.app.log.warn('tag check failed', error);
            return;
        }
        if (token !== checkToken || !ctx.alive()) return;
        validations = new Map(list.map((tag, index) => [tag, results[index] as TagValidation]));
        drawChips();
        clear(problems);
        const bad = results.filter((result) => !result.ok);
        if (!bad.length) {
            problems.appendChild(el('div', { class: 'maestro-muted', text: t('m35b.sheets.checkOk') }));
            return;
        }
        for (const [index, result] of results.entries()) {
            if (result.ok) continue;
            const written = list[index] ?? result.tag;
            const ownIndex = own.indexOf(written);
            problems.appendChild(
                el('div', { class: 'maestro-m35b-problem' }, [
                    el('code', { class: 'maestro-m35b-code', text: written }),
                    el('span', { text: ` — ${result.message ?? result.reason ?? ''}` }),
                    ...(ownIndex >= 0
                        ? (result.suggestions ?? []).map((suggestion) =>
                              button({
                                  label: t('m35b.sheets.suggest', { tag: suggestion }),
                                  kind: 'ghost',
                                  onClick: () => {
                                      const match = /^<([^:<>]+):([^<>]+)>$/.exec(suggestion);
                                      if (!match?.[1] || !match[2]) return;
                                      draft.tags[ownIndex] = { key: match[1], value: match[2] };
                                      drawChips();
                                      void validate();
                                  },
                              }),
                          )
                        : []),
                ]),
            );
        }
    };

    const drawChips = () => {
        clear(chips);
        if (!draft.tags.length) chips.appendChild(el('div', { class: 'maestro-muted', text: t('m35b.sheets.noTags') }));
        draft.tags.forEach((tag, index) => {
            const text = tagText(tag);
            const check = validations.get(text);
            chips.appendChild(
                el(
                    'span',
                    {
                        class: [
                            'maestro-m35b-chip',
                            check && !check.ok
                                ? check.reason === 'noPack' || check.reason === 'unknownValue'
                                    ? 'maestro-m35b-chip-warn'
                                    : 'maestro-m35b-chip-bad'
                                : null,
                            editor.editIndex === index ? 'maestro-on' : null,
                        ],
                        attrs: { role: 'listitem' },
                    },
                    [
                        el('button', {
                            class: 'maestro-m35b-chip-text',
                            text,
                            attrs: { type: 'button', 'aria-label': t('m35b.sheets.edit', { tag: text }) },
                            on: {
                                click: () => {
                                    editor.editIndex = index;
                                    editor.category = tag.key.toUpperCase();
                                    editor.value = tag.value;
                                    drawAddRow();
                                    drawChips();
                                },
                            },
                        }),
                        el('button', {
                            class: 'maestro-m35b-chip-remove',
                            text: '×',
                            attrs: { type: 'button', 'aria-label': t('m35b.sheets.remove', { tag: text }) },
                            on: {
                                click: () => {
                                    draft.tags.splice(index, 1);
                                    if (editor.editIndex === index) editor.editIndex = null;
                                    else if (editor.editIndex !== null && editor.editIndex > index) editor.editIndex--;
                                    drawAddRow();
                                    drawChips();
                                    void validate();
                                },
                            },
                        }),
                    ],
                ),
            );
        });
    };

    // Add / replace row: category from the dictionary, value with the category's known values.
    const addRow = el('div', { class: 'maestro-m35b-addrow' });
    const categories = categoriesOf(dictionary);
    const drawAddRow = () => {
        clear(addRow);
        const listId = uniqueId('maestro-m35b-values');
        const category = el('select', {
            class: 'text_pole maestro-select',
            attrs: { 'aria-label': t('m35b.sheets.category') },
        });
        for (const item of categories) category.appendChild(el('option', { text: item, attrs: { value: item } }));
        if (!editor.category || !categories.includes(editor.category)) {
            if (editor.category) {
                category.appendChild(el('option', { text: editor.category, attrs: { value: editor.category } }));
            } else {
                editor.category = categories[0] ?? 'TRAIT';
            }
        }
        category.value = editor.category;
        const datalist = el('datalist', { attrs: { id: listId } });
        const fillValues = () => {
            clear(datalist);
            for (const value of valuesOf(dictionary, editor.category)) {
                datalist.appendChild(el('option', { attrs: { value } }));
            }
        };
        fillValues();
        const value = el('input', {
            class: 'text_pole maestro-m35b-value',
            attrs: {
                type: 'text',
                list: listId,
                placeholder: t('m35b.sheets.value'),
                'aria-label': t('m35b.sheets.value'),
            },
        });
        value.value = editor.value;
        category.addEventListener('change', () => {
            editor.category = category.value;
            fillValues();
        });
        value.addEventListener('input', () => {
            editor.value = value.value;
        });
        const commit = () => {
            const text = value.value.trim().toUpperCase().replace(/\s+/g, '_');
            if (!text) return;
            const original = editor.editIndex !== null ? draft.tags[editor.editIndex] : undefined;
            // Keep the key as written when only the value changes (`Dere` stays `Dere`).
            const key = original && original.key.toUpperCase() === editor.category ? original.key : editor.category;
            const tag = { key, value: original && original.value.toUpperCase() === text ? original.value : text };
            if (editor.editIndex !== null && original) draft.tags[editor.editIndex] = tag;
            else draft.tags.push(tag);
            editor.editIndex = null;
            editor.value = '';
            drawAddRow();
            drawChips();
            void validate();
        };
        value.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            }
        });
        append(addRow, [
            category,
            value,
            datalist,
            button({
                label: t(editor.editIndex !== null ? 'm35b.sheets.replace' : 'm35b.sheets.add'),
                icon: editor.editIndex !== null ? 'fa-pen' : 'fa-plus',
                onClick: commit,
            }),
            editor.editIndex !== null
                ? button({
                      label: t('m35b.sheets.cancelEdit'),
                      kind: 'ghost',
                      onClick: () => {
                          editor.editIndex = null;
                          editor.value = '';
                          drawAddRow();
                          drawChips();
                      },
                  })
                : null,
        ]);
    };

    // MBTI archetype with the H/U switch.
    const mbtiType = el('select', {
        class: 'text_pole maestro-select',
        attrs: { 'aria-label': t('m35b.sheets.mbti') },
    });
    mbtiType.appendChild(el('option', { text: t('m35b.sheets.mbtiNone'), attrs: { value: '' } }));
    for (const type of MBTI_TYPES) mbtiType.appendChild(el('option', { text: type, attrs: { value: type } }));
    mbtiType.value = draft.mbti?.type ?? '';
    const variantHolder = el('span', { class: 'maestro-m35b-variant' });
    const drawVariant = () => {
        clear(variantHolder);
        if (!draft.mbti) return;
        variantHolder.appendChild(
            segmented<'H' | 'U'>({
                value: draft.mbti.variant,
                label: t('m35b.sheets.mbti'),
                options: [
                    { value: 'H', label: t('m35b.sheets.healthy') },
                    { value: 'U', label: t('m35b.sheets.unhealthy') },
                ],
                onChange: (variant) => {
                    if (draft.mbti) draft.mbti = { ...draft.mbti, variant };
                    void validate();
                },
            }),
        );
    };
    mbtiType.addEventListener('change', () => {
        if (!mbtiType.value) delete draft.mbti;
        else draft.mbti = { type: mbtiType.value, variant: draft.mbti?.variant ?? 'U' };
        drawVariant();
        void validate();
    });

    // Linguistics and prose sections (as written).
    const textArea = (value: string, label: string, onInput: (text: string) => void) => {
        const area = el('textarea', { class: 'text_pole maestro-m35b-text', attrs: { rows: 4, 'aria-label': label } });
        area.value = value;
        area.addEventListener('input', () => onInput(area.value));
        area.addEventListener('change', () => void validate());
        return area;
    };
    const linguistics = textArea(draft.linguistics ?? '', t('m35b.sheets.linguistics'), (text) => {
        if (text || editor.original.linguistics !== undefined) draft.linguistics = text;
        else delete draft.linguistics;
    });
    const sections = draft.sections.map((item, index) =>
        el('label', { class: 'maestro-m35b-field' }, [
            el('span', { class: 'maestro-m35b-label', text: item.title || t('m35b.sheets.untitled') }),
            textArea(item.text, item.title || t('m35b.sheets.untitled'), (text) => {
                const target = draft.sections[index];
                if (target) target.text = text;
            }),
        ]),
    );

    // Sheets of this character in the chat (M31): shown, never duplicated here.
    const sheetsApi = ctx.app.modules.api<SheetsApi>('sheets');
    const chatSheets = draft.name && sheetsApi ? sheetsApi.sheetsFor(draft.name) : [];

    const save = button({
        label: t('m35b.sheets.save'),
        icon: 'fa-floppy-disk',
        kind: 'primary',
        disabled: blocked,
        onClick: () =>
            ctx.run(async () => {
                if (sameSheet(draft, editor.original)) {
                    ctx.app.ui.notice(t('m35b.sheets.unchanged'));
                    return;
                }
                await ctx.service.saveSheet(draft);
                const fresh = await ctx.service.readSheet(editor.book, editor.uid);
                if (fresh) {
                    editor.original = fresh;
                    editor.draft = copySheet(fresh);
                }
                ctx.app.ui.notice(t('m35b.sheets.saved', { name: draft.name || `#${editor.uid}` }), { level: 'info' });
                ctx.redraw();
            }),
    });

    append(body, [
        el('div', { class: 'maestro-m35b-toolbar' }, [
            button({
                label: t('m35b.sheets.back'),
                icon: 'fa-arrow-left',
                kind: 'ghost',
                onClick: () => {
                    state.sheets.editor = null;
                    ctx.redraw();
                },
            }),
        ]),
        el('div', { class: 'maestro-m35b-sheet-head' }, [
            el('div', { class: 'maestro-m35b-name', text: draft.name || t('m35b.sheets.noName') }),
            el('div', { class: 'maestro-muted', text: `${editor.book} · #${editor.uid}` }),
            el('div', { class: 'maestro-hint', text: t('m35b.sheets.nameLocked') }),
        ]),
        blocked ? banner(t('m35b.sheets.multiBlock', { count: editor.original.blocks ?? 2 }), 'error') : null,
        section(t('m35b.sheets.tagsTitle'), [chips, addRow]),
        section(t('m35b.sheets.mbti'), el('div', { class: 'maestro-m35b-mbti' }, [mbtiType, variantHolder])),
        section(t('m35b.sheets.check'), problems),
        section(t('m35b.sheets.linguistics'), linguistics),
        sections.length ? section(t('m35b.sheets.sections'), sections) : null,
        chatSheets.length
            ? section(
                  t('m35b.sheets.chatSheets'),
                  el(
                      'ul',
                      { class: 'maestro-m35b-list' },
                      chatSheets.map((item) => el('li', { text: t('m35b.sheets.chatSheet', item) })),
                  ),
              )
            : null,
        el('div', { class: 'maestro-hint', text: t('m35b.sheets.commands') }),
        el('div', { class: 'maestro-m35b-actions maestro-m35b-save' }, [
            save,
            button({
                label: t('m35b.sheets.reset'),
                kind: 'ghost',
                onClick: () => {
                    editor.draft = copySheet(editor.original);
                    editor.editIndex = null;
                    editor.value = '';
                    ctx.redraw();
                },
            }),
        ]),
    ]);
    drawAddRow();
    drawChips();
    drawVariant();
    void validate();
}

export async function renderSheets(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t, state } = ctx;
    body.appendChild(loading(t));
    try {
        const pending = state.sheets.pending;
        if (pending) {
            state.sheets.pending = null;
            state.sheets.editor = await openEditor(ctx, pending.book, pending.uid);
            if (!state.sheets.editor) ctx.app.ui.notice(t('m35b.sheets.notFound'), { level: 'warn' });
        }
        const editor = state.sheets.editor;
        if (!editor) {
            await renderList(ctx, body);
            return;
        }
        const dictionary = await ctx.service.dictionary();
        clear(body);
        renderEditor(ctx, body, editor, dictionary);
    } catch (error) {
        clear(body);
        body.appendChild(el('div', { class: 'maestro-error-text', text: errorText(error) }));
    }
}
