// «Ключи и условия»: primary keys, logic, secondary keys (ST's text mode: commas separate keys except inside a
// regex), chips with regex / Localizer badges and diagnostics (T2), the «selective» note (L-080) and the Russian
// keys action. research/parity-lore.md L-063…L-066, L-080, L-084, L-085.
import { analyzeKeys, formatKeys, parseKeyInput, stringList } from '../../../domain/lore-form-keys';
import type { KeyInfo, KeyIssue } from '../../../domain/lore-form-keys';
import { LOGIC_ORDER } from '../../../domain/lore-form-fields';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { formSection, note, row } from './controls';
import { GLOBAL_NAMES, globalValue, localizerKeys } from './env';
import type { FormEnv } from './env';
import { russianKeysButton } from './russian-keys';

const ISSUE_ORDER: KeyIssue[] = ['badRegex', 'macroBrace', 'cyrillicWholeWord', 'comma', 'duplicate', 'macro'];

function effective(env: FormEnv, field: 'caseSensitive' | 'matchWholeWords'): boolean {
    const own = env.state.draft[field];
    if (typeof own === 'boolean') return own;
    return globalValue(env.state.globals, [...GLOBAL_NAMES[field]], 'boolean') ?? false;
}

function chip(env: FormEnv, info: KeyInfo, fromLocalizer: boolean): HTMLElement {
    const t = env.t;
    const title = [
        info.kind === 'regex' ? t('m23f.keys.chipRegex') : null,
        info.kind === 'badRegex' ? t('m23f.keys.issue.badRegex') : null,
        fromLocalizer ? t('m23f.keys.chipLocalizer') : null,
    ]
        .filter(Boolean)
        .join('\n');
    return el(
        'span',
        {
            class: [
                'maestro-m23f-chip',
                info.kind === 'regex' ? 'maestro-m23f-chip-regex' : null,
                info.issues.length ? 'maestro-m23f-chip-warn' : null,
                fromLocalizer ? 'maestro-m23f-chip-ll' : null,
            ],
            title: title || undefined,
        },
        [
            info.kind === 'regex' ? el('span', { class: 'maestro-m23f-chip-icon', text: '•*' }) : null,
            el('span', { text: info.key }),
            fromLocalizer
                ? el('span', { class: 'maestro-m23f-chip-badge', text: t('m23f.keys.badgeLocalizer') })
                : null,
        ],
    );
}

function issueLines(env: FormEnv, infos: KeyInfo[]): HTMLElement[] {
    const byIssue = new Map<KeyIssue, string[]>();
    for (const info of infos) {
        for (const issue of info.issues) byIssue.set(issue, [...(byIssue.get(issue) ?? []), info.key]);
    }
    return ISSUE_ORDER.filter((issue) => byIssue.has(issue)).map((issue) =>
        note(
            env.t(`m23f.keys.issue.${issue}`, { keys: (byIssue.get(issue) ?? []).join(', ') }),
            issue === 'macro' ? 'info' : 'warn',
        ),
    );
}

/** A key list editor of the draft (`key` or `keysecondary`). */
export function keysEditor(env: FormEnv, field: 'key' | 'keysecondary', label: string): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-keys');
    const input = el('textarea', {
        class: 'text_pole maestro-m23f-keys',
        attrs: {
            id,
            rows: 2,
            name: field,
            placeholder: t('m23f.keys.placeholder'),
            spellcheck: 'false',
            autocomplete: 'off',
        },
    });
    input.value = formatKeys(stringList(env.state.draft[field]));
    const chips = el('div', { class: 'maestro-m23f-chips', attrs: { 'aria-live': 'polite' } });
    const issues = el('div', { class: 'maestro-m23f-notes' });

    input.addEventListener('input', () => {
        env.state.draft[field] = parseKeyInput(input.value);
        env.changed();
    });

    const render = () => {
        const keys = stringList(env.state.draft[field]);
        // Keys changed outside the text field (Russian keys, history): show them, without fighting the typing.
        if (formatKeys(parseKeyInput(input.value)) !== formatKeys(keys)) input.value = formatKeys(keys);
        const infos = analyzeKeys(keys, {
            matchWholeWords: effective(env, 'matchWholeWords'),
            caseSensitive: effective(env, 'caseSensitive'),
        });
        const added = localizerKeys(env.app, env.state.draft);
        chips.replaceChildren(...infos.map((info) => chip(env, info, added.has(info.key))));
        chips.hidden = !infos.length;
        issues.replaceChildren(...issueLines(env, infos));
    };
    render();
    env.sync(render);

    return row(env, {
        label,
        control: input,
        for: id,
        field,
        hint: [chips, issues],
    });
}

function logicSelect(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-logic');
    const current = typeof env.state.draft.selectiveLogic === 'number' ? env.state.draft.selectiveLogic : 0;
    const values: number[] = [...LOGIC_ORDER];
    if (!values.includes(current)) values.push(current);
    const node = el(
        'select',
        { class: 'text_pole', attrs: { id, name: 'selectiveLogic' } },
        values.map((value) =>
            el('option', {
                text: (LOGIC_ORDER as readonly number[]).includes(value)
                    ? t(`m23f.logic.${value}`)
                    : t('m23f.logic.other', { value }),
                attrs: { value: String(value) },
            }),
        ),
    );
    node.value = String(current);
    node.addEventListener('change', () => {
        env.state.draft.selectiveLogic = Number(node.value);
        env.changed();
    });
    return row(env, { label: t('m23f.logic.label'), control: node, for: id, hint: t('m23f.logic.hint') });
}

/** Note when ST's engine ignores the secondary keys now (`selective` false) — ST's editor would switch it on. */
function selectiveNote(env: FormEnv): HTMLElement {
    const holder = el('div');
    const render = () => {
        const draft = env.state.draft;
        const show = draft.selective !== true && stringList(draft.keysecondary).length > 0;
        holder.replaceChildren(
            ...(show
                ? [
                      note(
                          env.t('m23f.keys.selectiveOff'),
                          'warn',
                          env.readOnly
                              ? null
                              : button({
                                    label: env.t('m23f.keys.selectiveFix'),
                                    kind: 'ghost',
                                    onClick: () => {
                                        env.state.draft.selective = true;
                                        env.changed();
                                    },
                                }),
                      ),
                  ]
                : []),
        );
    };
    render();
    env.sync(render);
    return holder;
}

function noKeysNote(env: FormEnv): HTMLElement {
    const holder = el('div');
    const render = () => {
        const draft = env.state.draft;
        const empty = !stringList(draft.key).length && draft.constant !== true;
        holder.replaceChildren(...(empty ? [note(env.t('m23f.keys.noKeys'), 'info')] : []));
    };
    render();
    env.sync(render);
    return holder;
}

export function keysSection(env: FormEnv): HTMLElement {
    const t = env.t;
    return formSection(
        t('m23f.section.keys'),
        [
            keysEditor(env, 'key', t('m23f.keys.primary')),
            noKeysNote(env),
            russianKeysButton(env),
            logicSelect(env),
            keysEditor(env, 'keysecondary', t('m23f.keys.secondary')),
            selectiveNote(env),
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.keys.help') }),
        ],
        { id: 'keys' },
    );
}
