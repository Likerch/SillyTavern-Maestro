// «Фильтры и триггеры»: character/tag filter (names = avatar files without extension, tags = tag ids, exclude mode;
// the field is removed when nothing is selected and exclude is off — L-093, L-094) and generation triggers (empty =
// all types, L-095). Phone-first: a searchable checkbox list instead of select2. Unknown values are kept (P12).
import {
    GENERATION_TRIGGERS,
    avatarName,
    buildCharacterFilter,
    readCharacterFilter,
    readTriggers,
} from '../../../domain/lore-form-fields';
import type { CharacterFilter } from '../../../domain/lore-form-fields';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { formSection, note, row } from './controls';
import type { FormEnv } from './env';

/** Characters shown at once in the picker; the search narrows the rest. */
export const PICKER_LIMIT = 60;

interface Choice {
    kind: 'character' | 'tag';
    /** Stored value: avatar name or tag id. */
    value: string;
    label: string;
    detail?: string;
}

function choices(env: FormEnv): Choice[] {
    const ctx = env.app.host.ctx();
    const list: Choice[] = [];
    for (const character of Array.isArray(ctx.characters) ? ctx.characters : []) {
        if (typeof character?.avatar !== 'string') continue;
        const value = avatarName(character.avatar);
        const name = typeof character.name === 'string' && character.name ? character.name : value;
        list.push({ kind: 'character', value, label: name, ...(name !== value ? { detail: value } : {}) });
    }
    const tags = (ctx as unknown as { tags?: unknown }).tags;
    for (const tag of Array.isArray(tags) ? tags : []) {
        const record = tag as { id?: unknown; name?: unknown };
        if (typeof record?.id !== 'string') continue;
        const name = typeof record.name === 'string' ? record.name : record.id;
        list.push({ kind: 'tag', value: record.id, label: env.t('m23f.filter.tag', { name }) });
    }
    return list;
}

function characterFilterBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const all = choices(env);
    let filter: CharacterFilter = readCharacterFilter(env.state.draft.characterFilter);
    const known = new Set(all.filter((item) => item.kind === 'character').map((item) => item.value));

    const commit = () => {
        const built = buildCharacterFilter(filter);
        if (built === undefined) delete env.state.draft.characterFilter;
        else {
            // Keep fields of other extensions inside the filter object.
            const previous = env.state.draft.characterFilter;
            const extra = typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {};
            env.state.draft.characterFilter = { ...extra, ...built };
        }
        env.changed();
    };

    const excludeId = domId('maestro-m23f-exclude');
    const exclude = el('input', { attrs: { type: 'checkbox', id: excludeId, name: 'characterFilterExclude' } });
    exclude.checked = filter.isExclude;
    exclude.addEventListener('change', () => {
        filter = { ...filter, isExclude: exclude.checked };
        commit();
    });

    const searchId = domId('maestro-m23f-search');
    const search = el('input', {
        class: 'text_pole',
        attrs: { id: searchId, type: 'search', placeholder: t('m23f.filter.search'), autocomplete: 'off' },
    });
    const selected = el('div', { class: 'maestro-m23f-chips' });
    const list = el('div', {
        class: 'maestro-m23f-picker',
        attrs: { role: 'group', 'aria-label': t('m23f.filter.label') },
    });

    const isOn = (choice: Choice) =>
        choice.kind === 'character' ? filter.names.includes(choice.value) : filter.tags.includes(choice.value);

    const toggle = (choice: Choice, on: boolean) => {
        const key = choice.kind === 'character' ? 'names' : 'tags';
        const current = filter[key].filter((value) => value !== choice.value);
        filter = { ...filter, [key]: on ? [...current, choice.value] : current };
        commit();
        renderSelected();
    };

    const renderSelected = () => {
        const chips: HTMLElement[] = [];
        for (const name of filter.names) {
            const choice = all.find((item) => item.kind === 'character' && item.value === name);
            chips.push(
                el('span', { class: ['maestro-m23f-chip', known.has(name) ? null : 'maestro-m23f-chip-warn'] }, [
                    el('span', { text: choice?.label ?? name }),
                    known.has(name)
                        ? null
                        : el('span', { class: 'maestro-m23f-chip-badge', text: t('m23f.filter.missing') }),
                    env.readOnly
                        ? null
                        : el('button', {
                              class: 'maestro-m23f-chip-x',
                              text: '×',
                              attrs: { type: 'button', 'aria-label': t('m23f.filter.remove', { name }) },
                              on: { click: () => toggle({ kind: 'character', value: name, label: name }, false) },
                          }),
                ]),
            );
        }
        for (const id of filter.tags) {
            const choice = all.find((item) => item.kind === 'tag' && item.value === id);
            chips.push(
                el('span', { class: 'maestro-m23f-chip' }, [
                    el('span', { text: choice?.label ?? t('m23f.filter.tag', { name: id }) }),
                    env.readOnly
                        ? null
                        : el('button', {
                              class: 'maestro-m23f-chip-x',
                              text: '×',
                              attrs: {
                                  type: 'button',
                                  'aria-label': t('m23f.filter.remove', { name: choice?.label ?? id }),
                              },
                              on: { click: () => toggle({ kind: 'tag', value: id, label: id }, false) },
                          }),
                ]),
            );
        }
        selected.replaceChildren(
            ...(chips.length ? chips : [el('span', { class: 'maestro-m23f-hint', text: t('m23f.filter.nobody') })]),
        );
    };

    const renderList = () => {
        const query = search.value.trim().toLowerCase();
        const matching = all.filter(
            (item) =>
                !query ||
                item.label.toLowerCase().includes(query) ||
                (item.detail ?? '').toLowerCase().includes(query) ||
                item.value.toLowerCase().includes(query),
        );
        const shown = matching.slice(0, PICKER_LIMIT);
        const nodes: (HTMLElement | null)[] = [
            ...shown.map((choice) => {
                const id = domId('maestro-m23f-pick');
                const box = el('input', {
                    attrs: { type: 'checkbox', id, disabled: env.readOnly },
                    data: { kind: choice.kind, value: choice.value },
                });
                box.checked = isOn(choice);
                box.addEventListener('change', () => toggle(choice, box.checked));
                return el('label', { class: 'checkbox_label maestro-m23f-pick', attrs: { for: id } }, [
                    box,
                    el('span', { text: choice.label }),
                    choice.detail ? el('small', { class: 'maestro-muted', text: choice.detail }) : null,
                ]);
            }),
            matching.length > shown.length
                ? el('div', {
                      class: 'maestro-m23f-hint',
                      text: t('m23f.filter.more', { count: matching.length - shown.length }),
                  })
                : null,
            all.length ? null : el('div', { class: 'maestro-m23f-hint', text: t('m23f.filter.empty') }),
        ];
        list.replaceChildren(...nodes.filter((node): node is HTMLElement => node !== null));
    };
    search.addEventListener('input', renderList);
    renderSelected();
    renderList();

    const missing = () => filter.names.filter((name) => !known.has(name));
    const cleanup = env.readOnly
        ? null
        : button({
              label: t('m23f.filter.dropMissing'),
              kind: 'ghost',
              onClick: () => {
                  filter = { ...filter, names: filter.names.filter((name) => known.has(name)) };
                  commit();
                  renderSelected();
                  renderList();
              },
          });
    const cleanupHolder = el('div');
    const renderCleanup = () => {
        cleanupHolder.replaceChildren(
            ...(missing().length && all.length ? [note(t('m23f.filter.missingNote'), 'warn', cleanup)] : []),
        );
    };
    renderCleanup();
    env.sync(renderCleanup);

    return el('div', { class: 'maestro-m23f-filter' }, [
        el('div', { class: 'maestro-m23f-check' }, [
            el('label', { class: 'checkbox_label', attrs: { for: excludeId } }, [
                exclude,
                el('span', { text: t('m23f.filter.exclude') }),
            ]),
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.filter.excludeHint') }),
        ]),
        row(env, { label: t('m23f.filter.label'), control: search, for: searchId, hint: t('m23f.filter.hint') }),
        selected,
        cleanupHolder,
        list,
    ]);
}

function triggersBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const initial = readTriggers(env.state.draft.triggers);
    const chosen = new Set<string>(initial.known);
    const commit = () => {
        const next = [...GENERATION_TRIGGERS.filter((item) => chosen.has(item)), ...initial.unknown];
        if (!next.length && env.state.stored.triggers === undefined) delete env.state.draft.triggers;
        else env.state.draft.triggers = next;
        env.changed();
    };
    const boxes = GENERATION_TRIGGERS.map((trigger) => {
        const id = domId('maestro-m23f-trigger');
        const box = el('input', { attrs: { type: 'checkbox', id, name: 'triggers' }, data: { trigger } });
        box.checked = chosen.has(trigger);
        box.addEventListener('change', () => {
            if (box.checked) chosen.add(trigger);
            else chosen.delete(trigger);
            commit();
        });
        return el('label', { class: 'checkbox_label maestro-m23f-pick', attrs: { for: id } }, [
            box,
            el('span', { text: t(`m23f.trigger.${trigger}`) }),
        ]);
    });
    return el('div', { class: 'maestro-m23f-triggers' }, [
        el('div', { class: 'maestro-m23f-label', text: t('m23f.trigger.label') }),
        el('div', { class: 'maestro-m23f-picker maestro-m23f-picker-inline' }, boxes),
        el('div', { class: 'maestro-m23f-hint', text: t('m23f.trigger.hint') }),
        initial.unknown.length ? note(t('m23f.trigger.unknown', { values: initial.unknown.join(', ') }), 'warn') : null,
    ]);
}

export function filtersSection(env: FormEnv): HTMLElement {
    const draft = env.state.draft;
    const filter = readCharacterFilter(draft.characterFilter);
    const open =
        filter.isExclude ||
        filter.names.length > 0 ||
        filter.tags.length > 0 ||
        readTriggers(draft.triggers).known.length > 0;
    return formSection(env.t('m23f.section.filters'), [characterFilterBlock(env), triggersBlock(env)], {
        id: 'filters',
        open,
    });
}
