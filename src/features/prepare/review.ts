// Step 3 of the preparation window (plan-2 §7 п. 3): the plan by sections — «Персонажи (7) · Места (5) · …» — each item a
// card with its Russian line, key facts, a checkbox (on unless it exists already), «уже есть» with what exists, where
// the canon says otherwise, and «для чата / для персонажа»; per section: all or nothing and one scope for the whole
// section. «Стартовые сцены (N)» has a card per greeting of the card («Сцена 2 · «первые слова…»», the one in the chat
// now marked «сейчас в чате»: it is the active one once applied). The texts are edited under «Подробнее» (the name as
// the story writes it, the English canon texts). Choices and edits live in the chat's draft, so a redraw, a closed
// window or another chat loses nothing; the footer applies the chosen items.
import { FIRST_SCENES, itemTitle } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PrepareKind, PreparePlan, PrepareScope } from '../../domain/prepare-plan';
import { badge, banner, emptyState } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { PrepareUi } from './controller';
import {
    EDIT_FIELDS,
    LONG_FIELDS,
    choiceOf,
    fieldValue,
    isPersona,
    sectionsOf,
    selectionRows,
    setEdit,
} from './drafts';
import type { ChatDraft, ItemChoice } from './drafts';

const QUOTE_CHARS = 220;

function clip(text: string, max = QUOTE_CHARS): string {
    const value = text.trim().replace(/\s+/g, ' ');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function names(list: readonly string[], max = 6): string {
    const clean = list.map((name) => name.trim()).filter(Boolean);
    return clean.length > max ? `${clean.slice(0, max).join(', ')}…` : clean.join(', ');
}

/** The item's title as the window shows it (an edited name wins; a scene by its greeting's first words). */
export function titleOf(
    ui: PrepareUi,
    item: AnyPrepareItem,
    choice?: ItemChoice,
    openings?: readonly string[],
): string {
    if (item.kind === 'scene') {
        const n = item.data.greeting + 1;
        const opening = openings?.[item.data.greeting]?.trim();
        if (opening) return ui.t('m37.ui.sceneTitle', { n, opening });
        const place = fieldValue(item, choice, 'place').trim();
        return place ? ui.t('m37.sceneTitle', { n, place }) : ui.t('m37.sceneNumber', { n });
    }
    if (EDIT_FIELDS[item.kind].includes('name')) {
        const name = fieldValue(item, choice, 'name').trim();
        if (name) return name;
    }
    return itemTitle(item) || ui.t(`m37.section.${item.kind}`);
}

/** Short facts of a card in story words: names, places, counts — never the English canon prose. */
export function factsOf(ui: PrepareUi, item: AnyPrepareItem): string[] {
    const t = ui.t.bind(ui);
    const facts: string[] = [];
    const add = (key: string, params?: Record<string, string | number>) => facts.push(t(key, params));
    switch (item.kind) {
        case 'character': {
            if (item.data.persona && item.exists?.where !== 'persona') add('m37.fact.persona');
            if (item.data.present) add('m37.fact.present');
            const forms = item.data.forms.filter((form) => form !== item.data.name);
            if (forms.length) add('m37.fact.forms', { list: names(forms, 4) });
            break;
        }
        case 'place':
            if (item.data.parent) add('m37.fact.parent', { name: item.data.parent });
            break;
        case 'faction':
            if (item.data.leader) add('m37.fact.leader', { name: item.data.leader });
            break;
        case 'item':
            if (item.data.owner) add('m37.fact.owner', { name: item.data.owner });
            break;
        case 'time':
            if (item.data.calendar) add('m37.fact.calendar');
            break;
        case 'secret':
            if (item.data.knownBy.length) add('m37.fact.knownBy', { list: names(item.data.knownBy) });
            if (item.data.hiddenFrom.length) add('m37.fact.hiddenFrom', { list: names(item.data.hiddenFrom) });
            break;
        case 'promise':
            if (item.data.who.length || item.data.toWhom.length) {
                add('m37.fact.promise', { who: names(item.data.who) || '—', whom: names(item.data.toWhom) || '—' });
            }
            if (item.data.due) add('m37.fact.due', { due: item.data.due });
            break;
        case 'scene':
            if (item.data.place) add('m37.fact.place', { name: item.data.place });
            if (item.data.date || item.data.time) {
                add('m37.fact.date', { date: [item.data.date, item.data.time].filter(Boolean).join(', ') });
            }
            if (item.data.present.length) add('m37.fact.presentList', { list: names(item.data.present) });
            if (item.data.outfits.length) {
                add('m37.fact.outfits', { list: names(item.data.outfits.map((row) => row.name)) });
            }
            if (item.data.firstScene) add('m37.fact.firstScene', { type: t(`m37.scene.${item.data.firstScene}`) });
            break;
        case 'mechanic': {
            const attributes = item.data.attributes.map((row) => row.name || row.english);
            if (attributes.length) add('m37.fact.attributes', { list: names(attributes, 5) });
            add(`m37.fact.holders.${item.data.holders}`);
            if (item.data.initial.length) add('m37.fact.values', { count: item.data.initial.length });
            break;
        }
        case 'direction':
            if (item.data.firstScene) add('m37.fact.firstScene', { type: t(`m37.scene.${item.data.firstScene}`) });
            break;
        default:
            break;
    }
    return facts;
}

interface ItemRefs {
    item: AnyPrepareItem;
    card: HTMLElement;
    box: HTMLInputElement;
    scope: HTMLSelectElement;
    title: HTMLElement;
    edited: HTMLElement;
}

interface SectionRefs {
    kind: PrepareKind;
    box: HTMLInputElement;
    scope: HTMLSelectElement;
    items: ItemRefs[];
}

const MIXED = 'mixed';

function scopeSelect(ui: PrepareUi, value: PrepareScope | typeof MIXED, label: string): HTMLSelectElement {
    const node = el('select', { class: 'text_pole maestro-select maestro-m37w-scope', attrs: { 'aria-label': label } });
    node.appendChild(
        el('option', { text: ui.t('m37.ui.scopeMixed'), attrs: { value: MIXED, hidden: true, disabled: true } }),
    );
    for (const scope of ['chat', 'character'] as const) {
        node.appendChild(el('option', { text: ui.t(`m37.scope.${scope}`), attrs: { value: scope } }));
    }
    node.value = value;
    return node;
}

export interface ReviewOptions {
    eligible: boolean;
    /** Back to the first step to analyse again. */
    onAgain(): void;
    onDiscard(): Promise<void>;
}

/** The review step: banners, the section line, the sections with their cards, the footer. */
export function reviewStep(ui: PrepareUi, plan: PreparePlan, draft: ChatDraft, options: ReviewOptions): HTMLElement[] {
    const t = ui.t.bind(ui);
    const out: HTMLElement[] = [];
    if (plan.partial) out.push(banner(t('m37.view.partial'), 'warn'));
    if (plan.failedChunks) out.push(banner(t('m37.view.failedParts', { count: plan.failedChunks }), 'warn'));
    if (plan.reused) out.push(banner(t('m37.ui.reused'), 'info', 'fa-clock-rotate-left'));
    if (!plan.items.length) {
        out.push(emptyState(t('m37.ui.empty'), 'fa-wand-magic-sparkles'));
        out.push(footerOf(ui, plan, draft, options, null));
        return out;
    }

    const sources = new Map(plan.sources.map((source) => [source.id, source.label]));
    const sections = sectionsOf(plan.items);
    const view: SceneContext = { openings: plan.openings ?? [], shown: ui.engine.startScenes().shown };
    const refs: SectionRefs[] = [];
    const counter = el('span', { class: 'maestro-m37w-count' });
    const applyButton = button({
        label: t('m37.ui.apply'),
        icon: 'fa-check',
        kind: 'primary',
        onClick: async () => {
            await ui.apply(selectionRows(plan, draft), plan.card.name);
        },
    });

    const refresh = () => {
        let chosen = 0;
        for (const section of refs) {
            const usable = section.items.filter((row) => !isPersona(row.item));
            const on = usable.filter((row) => choiceOf(draft, row.item).checked).length;
            section.box.checked = usable.length > 0 && on === usable.length;
            section.box.indeterminate = on > 0 && on < usable.length;
            const scopes = new Set(section.items.map((row) => choiceOf(draft, row.item).scope));
            section.scope.value = scopes.size === 1 ? [...scopes][0]! : MIXED;
            for (const row of section.items) {
                const choice = choiceOf(draft, row.item);
                if (choice.checked) chosen++;
                row.box.checked = choice.checked;
                row.scope.value = choice.scope;
                row.card.classList.toggle('maestro-m37w-off', !choice.checked);
                row.edited.hidden = !Object.keys(choice.edits).length;
            }
        }
        counter.textContent = t('m37.ui.selected', { count: chosen, total: plan.items.length });
        applyButton.disabled = chosen === 0;
    };

    const nav = el('nav', { class: 'maestro-m37w-nav', attrs: { 'aria-label': t('m37.view.plan') } });
    const body = el('div', { class: 'maestro-m37w-sections' });
    for (const section of sections) {
        const label = t(`m37.section.${section.kind}`);
        const head = `${label} (${section.items.length})`;
        const sectionRefs: SectionRefs = {
            kind: section.kind,
            box: el('input', { attrs: { type: 'checkbox', 'aria-label': t('m37.ui.allSection', { section: label }) } }),
            scope: scopeSelect(ui, 'chat', t('m37.ui.scopeSection', { section: label })),
            items: [],
        };
        sectionRefs.box.addEventListener('change', () => {
            for (const row of sectionRefs.items) {
                if (!isPersona(row.item)) choiceOf(draft, row.item).checked = sectionRefs.box.checked;
            }
            refresh();
        });
        sectionRefs.scope.addEventListener('change', () => {
            const value = sectionRefs.scope.value;
            if (value !== 'chat' && value !== 'character') return;
            for (const row of sectionRefs.items) choiceOf(draft, row.item).scope = value;
            refresh();
        });
        const list = el('div', { class: 'maestro-m37w-items' });
        if (section.kind === 'scene') {
            list.appendChild(el('div', { class: 'maestro-hint', text: t('m37.ui.scenesHint') }));
        }
        for (const item of section.items) {
            const row = itemCard(ui, draft, item, sources, view, refresh);
            sectionRefs.items.push(row);
            list.appendChild(row.card);
        }
        refs.push(sectionRefs);
        const block = el('section', { class: 'maestro-section maestro-m37w-section', data: { kind: section.kind } }, [
            el('div', { class: 'maestro-m37w-section-head' }, [
                el('label', { class: 'maestro-m37w-check' }, [
                    sectionRefs.box,
                    el('h4', { class: 'maestro-section-title', text: head }),
                ]),
                sectionRefs.scope,
            ]),
            list,
        ]);
        body.appendChild(block);
        nav.appendChild(
            button({
                label: head,
                kind: 'ghost',
                className: 'maestro-m37w-jump',
                onClick: () => block.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
            }),
        );
    }
    out.push(nav, body, footerOf(ui, plan, draft, options, { counter, applyButton }));
    refresh();
    return out;
}

/** What the cards need beyond the item: the greetings' first words, the greeting shown now. */
interface SceneContext {
    openings: readonly string[];
    shown: number | null;
}

function itemCard(
    ui: PrepareUi,
    draft: ChatDraft,
    item: AnyPrepareItem,
    sources: ReadonlyMap<string, string>,
    view: SceneContext,
    refresh: () => void,
): ItemRefs {
    const t = ui.t.bind(ui);
    const choice = choiceOf(draft, item);
    const title = el('span', { class: 'maestro-m37w-title', text: titleOf(ui, item, choice, view.openings) });
    const box = el('input', { attrs: { type: 'checkbox' } });
    box.checked = choice.checked;
    box.addEventListener('change', () => {
        choiceOf(draft, item).checked = box.checked;
        refresh();
    });
    const scope = scopeSelect(ui, choice.scope, t('m37.ui.scope'));
    scope.addEventListener('change', () => {
        if (scope.value === 'chat' || scope.value === 'character') choiceOf(draft, item).scope = scope.value;
        refresh();
    });
    const edited = badge(t('m37.ui.edited'), 'info');
    edited.hidden = !Object.keys(choice.edits).length;

    const marks: HTMLElement[] = [];
    if (item.kind === 'scene' && item.data.greeting === view.shown) marks.push(badge(t('m37.ui.sceneShown'), 'ok'));
    if (item.exists) {
        const where = t(`m37.exists.${item.exists.where}`);
        const label = item.exists.label && item.exists.label !== titleOf(ui, item) ? item.exists.label : '';
        marks.push(badge(label ? t('m37.ui.exists', { where, label }) : where, 'muted'));
    }
    if (item.conflicts?.length) marks.push(badge(t('m37.ui.conflictBadge'), 'warn'));
    if (item.saved) marks.push(badge(t('m37.ui.savedItem'), 'info'));

    const describe = ui.engine.describe(item);
    const facts = factsOf(ui, item);
    const card = el(
        'div',
        {
            class: [
                'maestro-m37w-item',
                item.conflicts?.length ? 'maestro-m37w-conflict' : null,
                item.kind === 'scene' && item.data.greeting === view.shown ? 'maestro-m37w-shown' : null,
            ],
            data: { item: item.id },
        },
        [
            el('div', { class: 'maestro-m37w-head' }, [
                el('label', { class: 'maestro-m37w-check' }, [box, title]),
                ...marks,
                edited,
                scope,
            ]),
            describe && describe !== title.textContent
                ? el('div', { class: 'maestro-m37w-line', text: describe })
                : null,
            facts.length
                ? el(
                      'div',
                      { class: 'maestro-m37w-facts' },
                      facts.map((fact) => el('span', { class: 'maestro-m37w-fact', text: fact })),
                  )
                : null,
            item.conflicts?.length
                ? el(
                      'div',
                      { class: 'maestro-m37w-conflicts' },
                      item.conflicts.map((conflict) =>
                          el('div', {}, [
                              el('div', {
                                  text: t('m37.ui.conflict', {
                                      with: conflict.with,
                                      field: t(`m37.conflictField.${conflict.field}`),
                                  }),
                              }),
                              el('div', { class: 'maestro-m37w-quote', text: `«${clip(conflict.existing)}»` }),
                          ]),
                      ),
                  )
                : null,
            detailsOf(ui, draft, item, sources, () => {
                title.textContent = titleOf(ui, item, choiceOf(draft, item), view.openings);
                refresh();
            }),
        ],
    );
    return { item, card, box, scope, title, edited };
}

/** «Подробнее»: the texts to edit and where the item was read; built when first opened. */
function detailsOf(
    ui: PrepareUi,
    draft: ChatDraft,
    item: AnyPrepareItem,
    sources: ReadonlyMap<string, string>,
    onEdit: () => void,
): HTMLElement {
    const t = ui.t.bind(ui);
    const details = el('details', { class: 'maestro-details maestro-m37w-details' }, [
        el('summary', { text: t('m37.ui.details') }),
    ]);
    const box = el('div', { class: 'maestro-m37w-edit' });
    details.appendChild(box);
    let built = false;
    const build = () => {
        clear(box);
        const choice = choiceOf(draft, item);
        box.appendChild(el('div', { class: 'maestro-hint', text: t('m37.ui.editHint') }));
        for (const field of EDIT_FIELDS[item.kind]) {
            const value = fieldValue(item, choice, field);
            const label = t(`m37.edit.${field}`);
            let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
            if (field === 'firstScene') {
                const select = el('select', { class: 'text_pole maestro-select', attrs: { 'aria-label': label } });
                select.appendChild(el('option', { text: t('m37.ui.sceneAuto'), attrs: { value: '' } }));
                for (const type of FIRST_SCENES) {
                    select.appendChild(el('option', { text: t(`m37.scene.${type}`), attrs: { value: type } }));
                }
                select.value = value;
                control = select;
            } else if (LONG_FIELDS.has(field)) {
                control = el('textarea', { class: 'text_pole', attrs: { rows: 3, 'aria-label': label } });
                control.value = value;
            } else {
                control = el('input', { class: 'text_pole', attrs: { type: 'text', 'aria-label': label } });
                control.value = value;
            }
            const input = control;
            const commit = () => {
                setEdit(item, choiceOf(draft, item), field, input.value);
                onEdit();
            };
            input.addEventListener(field === 'firstScene' ? 'change' : 'input', commit);
            box.appendChild(el('label', { class: 'maestro-m37w-field' }, [el('span', { text: label }), input]));
        }
        if (item.kind === 'scene' && item.data.outfits.length) {
            const list = item.data.outfits.map((row) => `${row.name}: ${row.wearing}`).join('; ');
            box.appendChild(el('div', { class: 'maestro-hint', text: t('m37.ui.sceneOutfits', { list }) }));
        }
        const from = item.sources.map((id) => sources.get(id) ?? '').filter(Boolean);
        if (from.length)
            box.appendChild(el('div', { class: 'maestro-hint', text: t('m37.ui.sources', { list: names(from, 8) }) }));
        box.appendChild(
            el('div', { class: 'maestro-actions' }, [
                button({
                    label: t('m37.ui.reset'),
                    kind: 'ghost',
                    onClick: () => {
                        const current = choiceOf(draft, item);
                        current.edits = {};
                        build();
                        onEdit();
                    },
                }),
            ]),
        );
    };
    details.addEventListener('toggle', () => {
        if (details.open && !built) {
            built = true;
            build();
        }
    });
    // Opened by default only when the user has edits to see (a redraw keeps them visible).
    if (Object.keys(choiceOf(draft, item).edits).length) {
        built = true;
        build();
        details.open = true;
    }
    return details;
}

function footerOf(
    ui: PrepareUi,
    plan: PreparePlan,
    draft: ChatDraft,
    options: ReviewOptions,
    apply: { counter: HTMLElement; applyButton: HTMLButtonElement } | null,
): HTMLElement {
    const t = ui.t.bind(ui);
    const passports = draft.passports ?? ui.settings().passports;
    const hasCharacters = plan.items.some((item) => item.kind === 'character' && !isPersona(item));
    return el('div', { class: 'maestro-m37w-footer' }, [
        apply ? apply.counter : null,
        hasCharacters
            ? toggle({
                  label: t('m37.ui.passports'),
                  checked: passports,
                  onChange: (checked) => {
                      draft.passports = checked;
                  },
              })
            : null,
        el('div', { class: 'maestro-actions maestro-m37w-buttons' }, [
            apply ? apply.applyButton : null,
            options.eligible
                ? button({
                      label: t('m37.ui.again'),
                      icon: 'fa-rotate',
                      kind: 'ghost',
                      onClick: () => options.onAgain(),
                  })
                : null,
            button({ label: t('m37.view.discard'), icon: 'fa-trash-can', kind: 'ghost', onClick: options.onDiscard }),
        ]),
    ]);
}
