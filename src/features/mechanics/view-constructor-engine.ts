// M25 «Механики», constructor editors of the engine fields (plan-2 §6 п.1–5, 9–11, §6.А): consequences of a check's
// outcomes, actions and chains of threshold events, the status catalogue, the inventory and its money, formulas and
// growth of numbers, experience and levels, time rules, fights, and «Где видно» of a mechanic and of each attribute
// (preset buttons «Игровой / Книжный / Скрытый / Тайный от всех», per-place switches, the view, what the model knows
// and how it mentions changes, words by thresholds). Story words on the labels; ids and English for the model under
// «Подробнее». Each editor edits the draft in place and calls `refresh` (problems, preview) or `redraw` (structure).
import { normalizeDef, validateDef } from '../../domain/mechanics-defs';
import type { DefIssue } from '../../domain/mechanics-defs';
import { durationOf, idFromName } from '../../domain/mechanics-view';
import {
    MENTION_VISIBILITIES,
    PROMPT_VISIBILITIES,
    resolveVisibility,
    VALUE_VIEWS,
    VISIBILITY_PLACES,
    VISIBILITY_PRESETS,
    withPreset,
} from '../../domain/mechanics-visibility';
import type { WordLevel } from '../../domain/mechanics-visibility';
import { select, toggle } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type {
    AttributeDef,
    AttributeEvent,
    ChangeAction,
    ChangeOp,
    CheckDef,
    CheckEffect,
    EffectOn,
    MechanicDef,
    StatusSpec,
    TimeRule,
    VisibilityInput,
    VisibilityPreset,
} from './api';
import { listText, moreBlock, optionalNumber, textInput } from './view-inputs';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface EngineCtx {
    t: T;
    def: MechanicDef;
    /** Re-validate (problems, preview) after a value changed. */
    refresh(): void;
    /** Rebuild the editor after a structural change (rows added or removed, a kind switched). */
    redraw(): void;
}

export const ENGINE_CSS = `
.maestro-m25-defs .maestro-m25-more > summary { cursor: pointer; opacity: 0.85; }
.maestro-m25-defs .maestro-m25-more-body { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 2px; }
.maestro-m25-defs .maestro-m25-actions { display: flex; flex-direction: column; gap: 4px; }
.maestro-m25-defs .maestro-m25-action { display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    border-left: 2px solid var(--maestro-border); padding-left: 6px; }
.maestro-m25-defs .maestro-m25-action .maestro-m25-input { flex: 1 1 90px; width: auto; }
.maestro-m25-defs .maestro-m25-presets { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m25-defs .maestro-m25-presets .maestro-btn { margin: 0; }
.maestro-m25-defs .maestro-m25-places { display: flex; flex-wrap: wrap; gap: 2px 12px; }
.maestro-m25-defs .maestro-m25-verdict { font-size: 0.9em; }
.maestro-m25-defs .maestro-m25-verdict-bad { color: var(--maestro-error, inherit); }
.maestro-m25-defs .maestro-m25-part-block { border: 1px dashed var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
`;

/* ------------------------------------------------------------------ problems at a path */

/** The translated problems of the draft whose path starts with `prefix` (live verdicts next to a field). */
export function issuesAt(t: T, def: MechanicDef, prefix: string): string[] {
    const normalized = normalizeDef(def);
    if (!normalized) return [];
    return validateDef(normalized)
        .filter(
            (issue: DefIssue) =>
                issue.level === 'error' && (issue.path === prefix || issue.path.startsWith(`${prefix}.`)),
        )
        .map((issue) => t(`m25.def.issue.${issue.code}`, issue.params));
}

/** A line under a field: the first problem there, or nothing. */
export function verdict(t: T, def: MechanicDef, prefix: string, ok?: string): HTMLElement {
    const node = el('div', { class: 'maestro-m25-verdict' });
    const update = () => {
        const issues = issuesAt(t, def, prefix);
        node.textContent = issues[0] ?? ok ?? '';
        node.classList.toggle('maestro-m25-verdict-bad', issues.length > 0);
    };
    update();
    (node as HTMLElement & { update?: () => void }).update = update;
    return node;
}

function updateVerdict(node: HTMLElement): void {
    (node as HTMLElement & { update?: () => void }).update?.();
}

/* ------------------------------------------------------------------ name ↔ key lists («Скрытность -2, проверки +1») */

/** `key value` pairs from words: attribute names or ids, «проверки» (every check), check names → their keys. */
export function parseModifiers(t: T, def: MechanicDef, text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of text.split(',')) {
        const match = /^(.*?)\s*([+-]?\d+(?:[.,]\d+)?)\s*$/.exec(part.trim());
        if (!match) continue;
        const name = (match[1] ?? '').trim().replace(/[=:]$/, '').trim();
        const value = Number((match[2] ?? '').replace(',', '.'));
        if (!name || !Number.isFinite(value)) continue;
        out[modifierKey(t, def, name)] = value;
    }
    return out;
}

function modifierKey(t: T, def: MechanicDef, name: string): string {
    const key = name.toLowerCase();
    if (key === 'checks' || key === t('m25.ctor.mod.checks').toLowerCase()) return 'checks';
    const attribute = def.attributes.find((item) => item.id === key || item.name.toLowerCase() === key);
    if (attribute) return attribute.id;
    const check = def.checks.find((item) => item.id === key || item.name.toLowerCase() === key);
    if (check) return `check:${check.id}`;
    return key;
}

/** The words of a modifier map («Скрытность -2, проверки +1»). */
export function modifiersText(t: T, def: MechanicDef, modifiers: Record<string, number> | undefined): string {
    return Object.entries(modifiers ?? {})
        .map(([key, value]) => {
            const sign = value > 0 ? `+${value}` : String(value);
            if (key === 'checks') return `${t('m25.ctor.mod.checks')} ${sign}`;
            if (key.startsWith('check:')) {
                const check = def.checks.find((item) => item.id === key.slice(6));
                return `${check?.name ?? key} ${sign}`;
            }
            const attribute = def.attributes.find((item) => item.id === key);
            return `${attribute?.name ?? key} ${sign}`;
        })
        .join(', ');
}

/* ------------------------------------------------------------------ actions */

const WHO = ['actor', 'target', 'persona'] as const;
const SPECIAL = ['status', 'item', 'reveal', 'combat'] as const;

function opsFor(def: MechanicDef, attr: string): ChangeOp[] {
    if (attr === 'status' || attr === 'item' || attr === 'combat') return ['push', 'pull'];
    if (attr === 'reveal') return ['set'];
    const attribute = def.attributes.find((item) => item.id === attr);
    if (!attribute) return ['add', 'sub', 'set', 'mul'];
    if (attribute.kind === 'number') return ['add', 'sub', 'set', 'mul'];
    if (attribute.kind === 'list') return ['push', 'pull', 'set'];
    if (attribute.kind === 'scale') return ['add', 'sub', 'set'];
    return ['set'];
}

/** One consequence: who, what, how, by how much (statuses and items with their own fields). */
function actionRow(ctx: EngineCtx, list: ChangeAction[], action: ChangeAction, path: string): HTMLElement {
    const { t, def } = ctx;
    const known = WHO as readonly string[];
    const whoValue = known.includes(action.who) ? action.who : 'name';
    const whoName = textInput(
        whoValue === 'name' ? action.who : '',
        (value) => {
            action.who = value.trim() || 'actor';
            ctx.refresh();
        },
        {
            label: t('m25.ctor.action.whoName'),
            placeholder: t('m25.ctor.action.whoName'),
            className: 'maestro-m25-action-who-name',
        },
    );
    whoName.hidden = whoValue !== 'name';
    const attributes = def.attributes.filter((item) => !item.formula);
    const own =
        attributes.some((item) => item.id === action.attr) || (SPECIAL as readonly string[]).includes(action.attr);
    const attrValue = own ? action.attr : 'other';
    const other = textInput(
        own ? '' : action.attr,
        (value) => {
            action.attr = value.trim().toLowerCase();
            ctx.refresh();
        },
        { label: t('m25.ctor.action.other'), placeholder: 'mechanic.attribute', className: 'maestro-m25-action-other' },
    );
    other.hidden = attrValue !== 'other';
    const ops = opsFor(def, action.attr);
    if (!ops.includes(action.op)) action.op = ops[0] as ChangeOp;
    const fields: (HTMLElement | null)[] = [];
    if (action.attr === 'status') {
        const status = action.status ?? { name: String(action.value || '') };
        action.status = status;
        fields.push(
            textInput(
                status.name,
                (value) => {
                    status.name = value.trim();
                    action.value = status.name;
                    ctx.refresh();
                },
                {
                    label: t('m25.ctor.action.statusName'),
                    placeholder: t('m25.ctor.action.statusName'),
                    className: 'maestro-m25-action-status',
                },
            ),
            action.op === 'push'
                ? optionalNumber(
                      status.duration?.turns,
                      (value) => {
                          const duration = durationOf(
                              value,
                              status.duration?.minutes ? status.duration.minutes / 60 : undefined,
                          );
                          if (duration) status.duration = duration;
                          else delete status.duration;
                          ctx.refresh();
                      },
                      t('m25.ctor.action.turns'),
                      t('m25.ctor.action.turns'),
                  )
                : null,
        );
    } else if (action.attr === 'item') {
        const item = action.item ?? { name: String(action.value || '') };
        action.item = item;
        fields.push(
            textInput(
                item.name,
                (value) => {
                    item.name = value.trim();
                    action.value = item.name;
                    ctx.refresh();
                },
                {
                    label: t('m25.ctor.action.itemName'),
                    placeholder: t('m25.ctor.action.itemName'),
                    className: 'maestro-m25-action-item',
                },
            ),
            optionalNumber(
                item.qty,
                (value) => {
                    if (value === undefined) delete item.qty;
                    else item.qty = value;
                    ctx.refresh();
                },
                t('m25.ctor.action.qty'),
                '1',
            ),
        );
    } else if (action.attr === 'reveal') {
        const hidden = def.attributes;
        fields.push(
            select<string>({
                value: String(action.value ?? ''),
                options: [
                    { value: '', label: t('m25.ctor.action.revealPick') },
                    ...hidden.map((item) => ({ value: item.id, label: item.name })),
                ],
                label: t('m25.ctor.action.reveal'),
                onChange: (value) => {
                    action.value = value;
                    ctx.refresh();
                },
            }),
        );
    } else if (action.attr !== 'combat') {
        fields.push(
            textInput(
                String(action.value ?? ''),
                (value) => {
                    const trimmed = value.trim();
                    const number = Number(trimmed);
                    action.value = trimmed !== '' && Number.isFinite(number) ? number : trimmed;
                    updateVerdict(check);
                    ctx.refresh();
                },
                {
                    label: t('m25.ctor.action.value'),
                    placeholder: t('m25.ctor.action.value.hint'),
                    className: 'maestro-m25-action-value',
                },
            ),
        );
    }
    const check = verdict(t, def, path);
    return el('div', { class: 'maestro-m25-action', data: { action: path } }, [
        select<string>({
            value: whoValue,
            options: [
                ...WHO.map((who) => ({ value: who, label: t(`m25.ctor.action.who.${who}`) })),
                { value: 'name', label: t('m25.ctor.action.who.name') },
            ],
            label: t('m25.ctor.action.who'),
            onChange: (value) => {
                action.who = value === 'name' ? whoName.value.trim() || 'actor' : value;
                whoName.hidden = value !== 'name';
                ctx.refresh();
            },
        }),
        whoName,
        select<string>({
            value: attrValue,
            options: [
                ...attributes.map((item) => ({ value: item.id, label: item.name })),
                ...SPECIAL.map((kind) => ({ value: kind, label: t(`m25.ctor.action.attr.${kind}`) })),
                { value: 'other', label: t('m25.ctor.action.attr.other') },
            ],
            label: t('m25.ctor.action.attr'),
            onChange: (value) => {
                action.attr = value === 'other' ? other.value.trim().toLowerCase() : value;
                if (value !== 'status') delete action.status;
                if (value !== 'item') delete action.item;
                action.value = value === 'reveal' || value === 'status' || value === 'item' ? '' : 0;
                ctx.redraw();
            },
        }),
        other,
        select<string>({
            value: action.op,
            options: ops.map((op) => ({
                value: op,
                label: t(`m25.ctor.action.op.${action.attr in OP_GROUP ? OP_GROUP[action.attr] : 'value'}.${op}`),
            })),
            label: t('m25.ctor.action.op'),
            onChange: (value) => {
                action.op = value as ChangeOp;
                ctx.redraw();
            },
        }),
        ...fields,
        button({
            icon: 'fa-xmark',
            title: t('m25.ctor.action.remove'),
            kind: 'ghost',
            className: 'maestro-m25-action-remove',
            onClick: () => {
                list.splice(list.indexOf(action), 1);
                ctx.redraw();
            },
        }),
        check,
    ]);
}

/** Word groups of the operations: statuses and items read «наложить / снять», «дать / забрать». */
const OP_GROUP: Record<string, string> = { status: 'status', item: 'item', combat: 'combat', reveal: 'reveal' };

/** A list of consequences with «Добавить изменение» (`set` stores the grown list on its owner). */
export function actionsEditor(
    ctx: EngineCtx,
    current: ChangeAction[] | undefined,
    set: (list: ChangeAction[] | undefined) => void,
    path: string,
): HTMLElement {
    const { t, def } = ctx;
    const list = current ?? [];
    return el('div', { class: 'maestro-m25-actions' }, [
        ...list.map((action, index) => actionRow(ctx, list, action, `${path}.${index}`)),
        button({
            label: t('m25.ctor.action.add'),
            icon: 'fa-plus',
            kind: 'ghost',
            className: 'maestro-m25-action-add',
            onClick: () => {
                const first = def.attributes.find((item) => item.kind === 'number' && !item.formula);
                const action: ChangeAction = first
                    ? { who: 'actor', attr: first.id, op: 'sub', value: 1 }
                    : { who: 'actor', attr: 'status', op: 'push', value: '', status: { name: '' } };
                set([...list, action]);
                ctx.redraw();
            },
        }),
    ]);
}

/* ------------------------------------------------------------------ check effects */

const EFFECT_ONS: readonly EffectOn[] = ['success', 'failure', 'critical', 'fumble', 'any'];

export function effectsEditor(ctx: EngineCtx, check: CheckDef, checkIndex: number): HTMLElement {
    const { t } = ctx;
    const effects = check.effects ?? [];
    const rows = effects.map((effect, index) => {
        const path = `checks.${checkIndex}.effects.${index}`;
        return el('div', { class: 'maestro-m25-part-block maestro-m25-effect' }, [
            el('div', { class: 'maestro-m25-row' }, [
                select<string>({
                    value: effect.on,
                    options: EFFECT_ONS.map((on) => ({ value: on, label: t(`m25.ctor.effect.on.${on}`) })),
                    label: t('m25.ctor.effect.on'),
                    onChange: (value) => {
                        effect.on = value as EffectOn;
                        ctx.refresh();
                    },
                }),
                button({
                    icon: 'fa-xmark',
                    title: t('m25.ctor.effect.remove'),
                    kind: 'ghost',
                    className: 'maestro-m25-effect-remove',
                    onClick: () => {
                        check.effects = effects.filter((item) => item !== effect);
                        if (!check.effects.length) delete check.effects;
                        ctx.redraw();
                    },
                }),
            ]),
            actionsEditor(
                ctx,
                effect.changes,
                (list) => {
                    effect.changes = list ?? [];
                },
                `${path}.changes`,
            ),
            moreBlock(t('m25.ctor.more'), [
                textInput(
                    effect.text ?? '',
                    (value) => {
                        if (value.trim()) effect.text = value.trim();
                        else delete effect.text;
                        ctx.refresh();
                    },
                    {
                        label: t('m25.ctor.effect.text'),
                        placeholder: t('m25.ctor.effect.text.hint'),
                        className: 'maestro-m25-effect-text',
                    },
                ),
            ]),
        ]);
    });
    return el('div', { class: 'maestro-m25-effects' }, [
        el('div', { class: 'maestro-m25-sub', text: t('m25.ctor.effects') }),
        el('div', { class: 'maestro-hint', text: t('m25.ctor.effects.hint') }),
        ...rows,
        button({
            label: t('m25.ctor.effect.add'),
            icon: 'fa-plus',
            kind: 'ghost',
            className: 'maestro-m25-effect-add',
            onClick: () => {
                const effect: CheckEffect = { on: 'failure', changes: [] };
                check.effects = [...effects, effect];
                ctx.redraw();
            },
        }),
    ]);
}

/* ------------------------------------------------------------------ event actions and chains */

export function eventExtras(ctx: EngineCtx, event: AttributeEvent, path: string): HTMLElement {
    const { t, def } = ctx;
    const chains = def.attributes.flatMap((item) =>
        (item.events ?? [])
            .filter((other) => other !== event)
            .map((other) => ({ value: `${item.id}.${other.id}`, label: `${item.name}: ${eventLabel(t, other)}` })),
    );
    return el('div', { class: 'maestro-m25-event-extras' }, [
        el('div', { class: 'maestro-muted', text: t('m25.ctor.event.actions') }),
        actionsEditor(
            ctx,
            event.actions,
            (list) => {
                if (list?.length) event.actions = list;
                else delete event.actions;
            },
            `${path}.actions`,
        ),
        chains.length
            ? el('div', { class: 'maestro-m25-row' }, [
                  el('span', { class: 'maestro-muted', text: t('m25.ctor.event.chain') }),
                  select<string>({
                      value: event.chain ?? '',
                      options: [{ value: '', label: t('m25.ctor.event.chain.none') }, ...chains],
                      label: t('m25.ctor.event.chain'),
                      onChange: (value) => {
                          if (value) event.chain = value;
                          else delete event.chain;
                          ctx.refresh();
                      },
                  }),
              ])
            : null,
    ]);
}

function eventLabel(t: T, event: AttributeEvent): string {
    if (event.when.op === 'changed') return t('m25.def.event.op.changed');
    return `${event.when.op} ${String(event.when.value ?? '')}`;
}

/* ------------------------------------------------------------------ number extras: formula, growth */

export function numberExtras(ctx: EngineCtx, attribute: AttributeDef, index: number): HTMLElement {
    const { t, def } = ctx;
    const formulaVerdict = verdict(
        t,
        def,
        `attributes.${index}.formula`,
        attribute.formula ? t('m25.ctor.formula.ok') : '',
    );
    const growth = attribute.growth;
    return el('div', { class: 'maestro-m25-number-extras' }, [
        el('div', { class: 'maestro-m25-row' }, [
            textInput(
                attribute.formula ?? '',
                (value) => {
                    if (value.trim()) attribute.formula = value.trim();
                    else delete attribute.formula;
                    updateVerdict(formulaVerdict);
                    if (!formulaVerdict.classList.contains('maestro-m25-verdict-bad'))
                        formulaVerdict.textContent = attribute.formula ? t('m25.ctor.formula.ok') : '';
                    ctx.refresh();
                },
                {
                    label: t('m25.ctor.formula'),
                    placeholder: t('m25.ctor.formula.hint'),
                    className: 'maestro-m25-formula',
                },
            ),
        ]),
        formulaVerdict,
        toggle({
            label: t('m25.ctor.growth'),
            checked: !!growth,
            onChange: (checked) => {
                if (checked) attribute.growth = { perUse: 1 };
                else delete attribute.growth;
                ctx.redraw();
            },
        }),
        growth
            ? el('div', { class: 'maestro-m25-row maestro-m25-growth' }, [
                  optionalNumber(
                      growth.perUse,
                      (value) => {
                          growth.perUse = value ?? 1;
                          ctx.refresh();
                      },
                      t('m25.ctor.growth.perUse'),
                      t('m25.ctor.growth.perUse'),
                  ),
                  optionalNumber(
                      growth.cap,
                      (value) => {
                          if (value === undefined) delete growth.cap;
                          else growth.cap = value;
                          ctx.refresh();
                      },
                      t('m25.ctor.growth.cap'),
                      t('m25.ctor.growth.cap'),
                  ),
                  select<string>({
                      value: growth.on ?? 'success',
                      options: [
                          { value: 'success', label: t('m25.ctor.growth.on.success') },
                          { value: 'any', label: t('m25.ctor.growth.on.any') },
                      ],
                      label: t('m25.ctor.growth.on'),
                      onChange: (value) => {
                          if (value === 'any') growth.on = 'any';
                          else delete growth.on;
                          ctx.refresh();
                      },
                  }),
              ])
            : null,
    ]);
}

/* ------------------------------------------------------------------ statuses */

export function statusesEditor(ctx: EngineCtx): HTMLElement {
    const { t, def } = ctx;
    const on = def.statuses !== undefined;
    const list = def.statuses ?? [];
    const row = (status: StatusSpec, index: number) =>
        el('div', { class: 'maestro-m25-part-block maestro-m25-status-def', data: { status: String(index) } }, [
            el('div', { class: 'maestro-m25-row' }, [
                textInput(
                    status.icon ?? '',
                    (value) => {
                        if (value.trim()) status.icon = value.trim();
                        else delete status.icon;
                    },
                    { label: t('m25.ctor.icon'), placeholder: '☠', className: 'maestro-m25-icon-input' },
                ),
                textInput(
                    status.name,
                    (value) => {
                        status.name = value;
                        ctx.refresh();
                    },
                    {
                        label: t('m25.ctor.status.name'),
                        placeholder: t('m25.ctor.status.name'),
                        className: 'maestro-m25-name maestro-m25-status-name',
                    },
                ),
                optionalNumber(
                    status.duration?.turns,
                    (value) => {
                        const duration = durationOf(
                            value,
                            status.duration?.minutes ? status.duration.minutes / 60 : undefined,
                        );
                        if (duration) status.duration = duration;
                        else delete status.duration;
                    },
                    t('m25.ctor.status.turns'),
                    t('m25.ctor.status.turns'),
                ),
                optionalNumber(
                    status.duration?.minutes ? status.duration.minutes / 60 : undefined,
                    (value) => {
                        const duration = durationOf(status.duration?.turns, value);
                        if (duration) status.duration = duration;
                        else delete status.duration;
                    },
                    t('m25.ctor.status.hours'),
                    t('m25.ctor.status.hours'),
                ),
                button({
                    icon: 'fa-xmark',
                    title: t('m25.ctor.status.remove'),
                    kind: 'ghost',
                    className: 'maestro-m25-status-def-remove',
                    onClick: () => {
                        def.statuses = list.filter((item) => item !== status);
                        ctx.redraw();
                    },
                }),
            ]),
            textInput(
                modifiersText(t, def, status.modifiers),
                (value) => {
                    const parsed = parseModifiers(t, def, value);
                    if (Object.keys(parsed).length) status.modifiers = parsed;
                    else delete status.modifiers;
                },
                {
                    label: t('m25.ctor.status.mods'),
                    placeholder: t('m25.ctor.status.mods.hint'),
                    className: 'maestro-m25-status-mods',
                },
            ),
            moreBlock(t('m25.ctor.more'), [
                textInput(
                    status.promptName ?? '',
                    (value) => {
                        if (value.trim()) status.promptName = value.trim();
                        else delete status.promptName;
                    },
                    {
                        label: t('m25.ctor.promptName'),
                        placeholder: t('m25.ctor.promptName'),
                        className: 'maestro-m25-status-prompt',
                    },
                ),
                textInput(
                    status.text ?? '',
                    (value) => {
                        if (value.trim()) status.text = value.trim();
                        else delete status.text;
                    },
                    {
                        label: t('m25.ctor.status.text'),
                        placeholder: t('m25.ctor.status.text'),
                        className: 'maestro-m25-status-text',
                    },
                ),
                optionalNumber(
                    status.maxStacks,
                    (value) => {
                        if (value === undefined || value <= 1) delete status.maxStacks;
                        else status.maxStacks = Math.round(value);
                    },
                    t('m25.ctor.status.stacks'),
                    '1',
                ),
            ]),
        ]);
    return el('div', { class: 'maestro-m25-statuses-def' }, [
        toggle({
            label: t('m25.ctor.statuses.on'),
            checked: on,
            onChange: (checked) => {
                if (checked) def.statuses = [];
                else delete def.statuses;
                ctx.redraw();
            },
        }),
        on ? el('div', { class: 'maestro-hint', text: t('m25.ctor.statuses.hint') }) : null,
        ...(on ? list.map(row) : []),
        on
            ? button({
                  label: t('m25.ctor.status.add'),
                  icon: 'fa-plus',
                  kind: 'ghost',
                  className: 'maestro-m25-status-def-add',
                  onClick: () => {
                      def.statuses = [...list, { name: '' }];
                      ctx.redraw();
                  },
              })
            : null,
    ]);
}

/* ------------------------------------------------------------------ inventory */

export function inventoryEditor(ctx: EngineCtx): HTMLElement {
    const { t, def } = ctx;
    const numbers = def.attributes.filter((item) => item.kind === 'number' && !item.formula);
    const money = def.inventory?.money ?? '';
    const ownMoney = !money || numbers.some((item) => item.id === money);
    return el('div', { class: 'maestro-m25-inventory-def' }, [
        toggle({
            label: t('m25.ctor.inventory.on'),
            checked: def.inventory !== undefined,
            onChange: (checked) => {
                if (checked) def.inventory = {};
                else delete def.inventory;
                ctx.redraw();
            },
        }),
        def.inventory
            ? el('div', { class: 'maestro-m25-row' }, [
                  el('span', { class: 'maestro-muted', text: t('m25.ctor.inventory.money') }),
                  select<string>({
                      value: ownMoney ? money : '__other',
                      options: [
                          { value: '', label: t('m25.ctor.inventory.noMoney') },
                          ...numbers.map((item) => ({ value: item.id, label: item.name })),
                          { value: '__other', label: t('m25.ctor.inventory.otherMoney') },
                      ],
                      label: t('m25.ctor.inventory.money'),
                      onChange: (value) => {
                          if (!def.inventory) return;
                          if (value === '__other') return ctx.redraw();
                          if (value) def.inventory.money = value;
                          else delete def.inventory.money;
                          ctx.redraw();
                      },
                  }),
                  ownMoney
                      ? null
                      : textInput(
                            money,
                            (value) => {
                                if (!def.inventory) return;
                                if (value.trim()) def.inventory.money = value.trim().toLowerCase();
                                else delete def.inventory.money;
                                ctx.refresh();
                            },
                            {
                                label: t('m25.ctor.inventory.otherMoney'),
                                placeholder: 'money.coins',
                                className: 'maestro-m25-money-other',
                            },
                        ),
              ])
            : null,
        def.inventory ? verdict(t, def, 'inventory.money') : null,
    ]);
}

/* ------------------------------------------------------------------ progression */

export function progressionEditor(ctx: EngineCtx): HTMLElement {
    const { t, def } = ctx;
    const numbers = def.attributes.filter((item) => item.kind === 'number' && !item.formula);
    const progression = def.progression;
    const pick = (value: string, label: string, onChange: (value: string) => void) =>
        select<string>({
            value,
            options: [{ value: '', label: '—' }, ...numbers.map((item) => ({ value: item.id, label: item.name }))],
            label,
            onChange,
        });
    return el('div', { class: 'maestro-m25-progression-def' }, [
        toggle({
            label: t('m25.ctor.progression.on'),
            checked: !!progression,
            onChange: (checked) => {
                if (checked) {
                    def.progression = {
                        xp: numbers[0]?.id ?? '',
                        level: numbers[1]?.id ?? numbers[0]?.id ?? '',
                        thresholds: [100, 300, 600],
                    };
                } else delete def.progression;
                ctx.redraw();
            },
        }),
        progression
            ? el('div', { class: 'maestro-m25-part-block' }, [
                  el('div', { class: 'maestro-m25-row' }, [
                      el('span', { class: 'maestro-muted', text: t('m25.ctor.progression.xp') }),
                      pick(progression.xp, t('m25.ctor.progression.xp'), (value) => {
                          progression.xp = value;
                          ctx.refresh();
                      }),
                      el('span', { class: 'maestro-muted', text: t('m25.ctor.progression.level') }),
                      pick(progression.level, t('m25.ctor.progression.level'), (value) => {
                          progression.level = value;
                          ctx.refresh();
                      }),
                  ]),
                  textInput(
                      listText(progression.thresholds.map(String)),
                      (value) => {
                          progression.thresholds = value
                              .split(/[,;\s]+/)
                              .map((item) => Number(item))
                              .filter((item) => Number.isFinite(item) && item > 0);
                          ctx.refresh();
                      },
                      {
                          label: t('m25.ctor.progression.thresholds'),
                          placeholder: '100, 300, 600',
                          className: 'maestro-m25-thresholds',
                      },
                  ),
                  verdict(t, def, 'progression'),
                  el('div', { class: 'maestro-muted', text: t('m25.ctor.progression.levelUp') }),
                  actionsEditor(
                      ctx,
                      progression.onLevelUp,
                      (list) => {
                          if (list?.length) progression.onLevelUp = list;
                          else delete progression.onLevelUp;
                      },
                      'progression.onLevelUp',
                  ),
              ])
            : null,
    ]);
}

/* ------------------------------------------------------------------ time */

export function timeEditor(ctx: EngineCtx): HTMLElement {
    const { t, def } = ctx;
    const numbers = def.attributes.filter((item) => item.kind === 'number' && !item.formula);
    const rules = def.time ?? [];
    const row = (rule: TimeRule, index: number) =>
        el('div', { class: 'maestro-m25-action maestro-m25-time-rule', data: { rule: String(index) } }, [
            select<string>({
                value: rule.attr,
                options: numbers.map((item) => ({ value: item.id, label: item.name })),
                label: t('m25.ctor.time.attr'),
                onChange: (value) => {
                    rule.attr = value;
                    ctx.refresh();
                },
            }),
            textInput(
                String(rule.amount),
                (value) => {
                    const trimmed = value.trim();
                    const number = Number(trimmed);
                    rule.amount = trimmed !== '' && Number.isFinite(number) ? number : trimmed;
                    ctx.refresh();
                },
                { label: t('m25.ctor.time.amount'), placeholder: '+10', className: 'maestro-m25-time-amount' },
            ),
            select<string>({
                value: rule.per,
                options: (['turn', 'hour', 'day'] as const).map((per) => ({
                    value: per,
                    label: t(`m25.ctor.time.per.${per}`),
                })),
                label: t('m25.ctor.time.per'),
                onChange: (value) => {
                    rule.per = value as TimeRule['per'];
                    ctx.refresh();
                },
            }),
            select<string>({
                value: rule.when ?? 'always',
                options: (['always', 'rest', 'awake'] as const).map((when) => ({
                    value: when,
                    label: t(`m25.ctor.time.when.${when}`),
                })),
                label: t('m25.ctor.time.when'),
                onChange: (value) => {
                    if (value === 'rest' || value === 'awake') rule.when = value;
                    else delete rule.when;
                    ctx.refresh();
                },
            }),
            button({
                icon: 'fa-xmark',
                title: t('m25.ctor.time.remove'),
                kind: 'ghost',
                className: 'maestro-m25-time-remove',
                onClick: () => {
                    def.time = rules.filter((item) => item !== rule);
                    if (!def.time.length) delete def.time;
                    ctx.redraw();
                },
            }),
            verdict(t, def, `time.${index}`),
        ]);
    return el('div', { class: 'maestro-m25-time-def' }, [
        el('div', { class: 'maestro-hint', text: t('m25.ctor.time.hint') }),
        ...rules.map(row),
        numbers.length
            ? button({
                  label: t('m25.ctor.time.add'),
                  icon: 'fa-plus',
                  kind: 'ghost',
                  className: 'maestro-m25-time-add',
                  onClick: () => {
                      def.time = [...rules, { attr: numbers[0]?.id ?? '', amount: 1, per: 'hour' }];
                      ctx.redraw();
                  },
              })
            : el('div', { class: 'maestro-muted', text: t('m25.ctor.time.noNumbers') }),
    ]);
}

/* ------------------------------------------------------------------ the fight */

export function combatEditor(ctx: EngineCtx): HTMLElement {
    const { t, def } = ctx;
    const combat = def.combat;
    return el('div', { class: 'maestro-m25-combat-def' }, [
        toggle({
            label: t('m25.ctor.combat.on'),
            checked: !!combat,
            onChange: (checked) => {
                if (checked) def.combat = {};
                else delete def.combat;
                ctx.redraw();
            },
        }),
        combat
            ? el('div', { class: 'maestro-m25-part-block' }, [
                  el('div', { class: 'maestro-m25-row' }, [
                      el('span', { class: 'maestro-muted', text: t('m25.ctor.combat.initiative') }),
                      select<string>({
                          value: combat.initiative ?? '',
                          options: [
                              { value: '', label: t('m25.ctor.combat.initiative.none') },
                              ...def.checks.map((check) => ({ value: check.id, label: check.name || check.id })),
                          ],
                          label: t('m25.ctor.combat.initiative'),
                          onChange: (value) => {
                              if (value) combat.initiative = value;
                              else delete combat.initiative;
                              ctx.refresh();
                          },
                      }),
                  ]),
                  textInput(
                      modifiersText(t, def, combat.enemy).replace(/ \+/g, ' '),
                      (value) => {
                          const parsed = parseModifiers(t, def, value.replace(/=/g, ' '));
                          if (Object.keys(parsed).length) combat.enemy = parsed;
                          else delete combat.enemy;
                      },
                      {
                          label: t('m25.ctor.combat.enemy'),
                          placeholder: t('m25.ctor.combat.enemy.hint'),
                          className: 'maestro-m25-combat-enemy',
                      },
                  ),
                  verdict(t, def, 'combat'),
              ])
            : null,
    ]);
}

/* ------------------------------------------------------------------ «Где видно» */

/** The stored visibility of the mechanic or of an attribute (the object the editor writes to). */
function ownVisibility(target: { visibility?: VisibilityInput }): VisibilityInput {
    if (!target.visibility) target.visibility = {};
    return target.visibility;
}

/**
 * The visibility editor: preset buttons (an attribute also «как у механики»), then under «Подробнее» the places, the
 * view, what the model knows and how it mentions changes, the words by thresholds; the mechanic also says whether the
 * model reads its narrator messages.
 */
export function visibilityEditor(ctx: EngineCtx, attribute?: AttributeDef): HTMLElement {
    const { t, def } = ctx;
    const target: { visibility?: VisibilityInput } = attribute ?? def;
    const effective = resolveVisibility(def, attribute);
    const inherits = !!attribute && !attribute.visibility?.preset && attribute.visible !== false;
    const current: VisibilityPreset | 'inherit' = inherits ? 'inherit' : effective.preset;
    const presets: (VisibilityPreset | 'inherit')[] = attribute
        ? ['inherit', ...VISIBILITY_PRESETS]
        : [...VISIBILITY_PRESETS];
    const setPreset = (preset: VisibilityPreset | 'inherit') => {
        if (preset === 'inherit') {
            const words = target.visibility?.words;
            delete target.visibility;
            if (words) target.visibility = { words };
        } else {
            target.visibility = withPreset(preset, target.visibility);
        }
        // The old «visible» switch is the «secret» set now: a chosen set replaces it.
        if (attribute) delete attribute.visible;
        ctx.redraw();
    };
    const fields: (HTMLElement | null)[] = [
        el(
            'div',
            { class: 'maestro-m25-places' },
            VISIBILITY_PLACES.map((place) =>
                toggle({
                    label: t(`m25.visibility.place.${place}`),
                    checked: effective.places[place],
                    onChange: (checked) => {
                        const own = ownVisibility(target);
                        own.places = { ...(own.places ?? {}), [place]: checked };
                        if (!own.preset && attribute === undefined) own.preset = effective.preset;
                        ctx.refresh();
                    },
                }),
            ),
        ),
        el('div', { class: 'maestro-m25-row' }, [
            el('span', { class: 'maestro-muted', text: t('m25.ctor.vis.view') }),
            select<string>({
                value: effective.view,
                options: VALUE_VIEWS.map((view) => ({ value: view, label: t(`m25.ctor.vis.view.${view}`) })),
                label: t('m25.ctor.vis.view'),
                onChange: (value) => {
                    ownVisibility(target).view = value as typeof effective.view;
                    ctx.redraw();
                },
            }),
        ]),
        el('div', { class: 'maestro-m25-row' }, [
            el('span', { class: 'maestro-muted', text: t('m25.ctor.vis.prompt') }),
            select<string>({
                value: effective.prompt,
                options: PROMPT_VISIBILITIES.map((value) => ({ value, label: t(`m25.ctor.vis.prompt.${value}`) })),
                label: t('m25.ctor.vis.prompt'),
                onChange: (value) => {
                    ownVisibility(target).prompt = value as typeof effective.prompt;
                    ctx.refresh();
                },
            }),
        ]),
        el('div', { class: 'maestro-m25-row' }, [
            el('span', { class: 'maestro-muted', text: t('m25.ctor.vis.mention') }),
            select<string>({
                value: effective.mention,
                options: MENTION_VISIBILITIES.map((value) => ({ value, label: t(`m25.ctor.vis.mention.${value}`) })),
                label: t('m25.ctor.vis.mention'),
                onChange: (value) => {
                    ownVisibility(target).mention = value as typeof effective.mention;
                    ctx.refresh();
                },
            }),
        ]),
        attribute && (attribute.kind === 'number' || attribute.kind === 'scale') ? wordsEditor(ctx, attribute) : null,
        attribute
            ? null
            : toggle({
                  label: t('m25.ctor.vis.narratorToModel'),
                  checked: def.narratorToModel === true,
                  onChange: (checked) => {
                      if (checked) def.narratorToModel = true;
                      else delete def.narratorToModel;
                  },
              }),
    ];
    return el('div', { class: 'maestro-m25-visibility', data: { visibility: attribute?.id ?? 'mechanic' } }, [
        el(
            'div',
            { class: 'maestro-m25-presets', attrs: { role: 'group', 'aria-label': t('m25.ctor.vis.title') } },
            presets.map((preset) =>
                button({
                    label: preset === 'inherit' ? t('m25.ctor.vis.inherit') : t(`m25.visibility.${preset}`),
                    kind: preset === current ? 'primary' : 'ghost',
                    className: `maestro-m25-preset maestro-m25-preset-${preset}`,
                    onClick: () => setPreset(preset),
                }),
            ),
        ),
        el('div', {
            class: 'maestro-hint',
            text: t(`m25.ctor.vis.hint.${current === 'inherit' ? effective.preset : current}`),
        }),
        moreBlock(t('m25.ctor.vis.more'), fields, 'maestro-m25-vis-more'),
    ]);
}

/** Words by thresholds: numbers by «до N», scales by level; the player's word and the model's (English). */
function wordsEditor(ctx: EngineCtx, attribute: AttributeDef): HTMLElement {
    const { t } = ctx;
    const own = () => ownVisibility(attribute);
    const words = attribute.visibility?.words ?? [];
    const save = (next: WordLevel[]) => {
        const target = own();
        if (next.length) target.words = next;
        else delete target.words;
        ctx.refresh();
    };
    const row = (word: WordLevel) =>
        el('div', { class: 'maestro-m25-action maestro-m25-word' }, [
            attribute.kind === 'scale'
                ? select<string>({
                      value: word.level ?? '',
                      options: (attribute.levels ?? []).map((level) => ({ value: level, label: level })),
                      label: t('m25.ctor.words.level'),
                      onChange: (value) => {
                          word.level = value;
                          save(words);
                      },
                  })
                : optionalNumber(
                      word.upTo,
                      (value) => {
                          if (value === undefined) delete word.upTo;
                          else word.upTo = value;
                          save(words);
                      },
                      t('m25.ctor.words.upTo'),
                      t('m25.ctor.words.upTo'),
                  ),
            textInput(
                word.display ?? '',
                (value) => {
                    if (value.trim()) word.display = value.trim();
                    else delete word.display;
                    save(words);
                },
                {
                    label: t('m25.ctor.words.display'),
                    placeholder: t('m25.ctor.words.display.hint'),
                    className: 'maestro-m25-word-display',
                },
            ),
            textInput(
                word.label,
                (value) => {
                    word.label = value.trim() || word.display || '';
                    save(words);
                },
                {
                    label: t('m25.ctor.words.label'),
                    placeholder: t('m25.ctor.words.label.hint'),
                    className: 'maestro-m25-word-label',
                },
            ),
            button({
                icon: 'fa-xmark',
                title: t('m25.ctor.words.remove'),
                kind: 'ghost',
                className: 'maestro-m25-word-remove',
                onClick: () => {
                    save(words.filter((item) => item !== word));
                    ctx.redraw();
                },
            }),
        ]);
    return el('div', { class: 'maestro-m25-words' }, [
        el('div', { class: 'maestro-muted', text: t('m25.ctor.words') }),
        ...words.map(row),
        button({
            label: t('m25.ctor.words.add'),
            icon: 'fa-plus',
            kind: 'ghost',
            className: 'maestro-m25-word-add',
            onClick: () => {
                const word: WordLevel =
                    attribute.kind === 'scale'
                        ? { level: attribute.levels?.[0] ?? '', label: '' }
                        : { upTo: attribute.min ?? 0, label: '' };
                own().words = [...words, word];
                ctx.redraw();
            },
        }),
    ]);
}

/* ------------------------------------------------------------------ ids */

/** An id for a new part from its name, unique among the others (never shown in the main text). */
export function partId(name: string, fallback: string, taken: Iterable<string>): string {
    return idFromName(name, fallback, taken);
}
