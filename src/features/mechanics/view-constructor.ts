// M25 «Механики», the constructor section of the pult tab (plan M25 п. 1–2, P10): the mechanics visible in this chat
// (switch for this chat, scope, edit, delete with a confirmation), the template picker and the editor — name, summary
// and rules for the model, scope, holders, default tracking, attributes (kind, bounds, start value, levels/options,
// tracking, visibility, events; add/remove/reorder), checks (dice validated live with parseDice, difficulty, trigger
// words) and «Сделать статами DES». Stacked fields and wrapping rows: usable on a phone.
import {
    cleanList,
    criticalsDefault,
    criticalsOf,
    desStatsAttributes,
    diceAttributes,
    EVENT_OPS,
    HOLDER_KINDS,
    newMechanicId,
    normalizeDef,
    normalizeHolders,
    parseDice,
    scopeForNew,
    snakeId,
    TRACKING_MODES,
    uniqueId,
    validateDef,
} from '../../domain/mechanics-defs';
import type { DefIssue } from '../../domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES } from '../../domain/mechanics-templates';
import type { MechanicTemplate as DomainTemplate } from '../../domain/mechanics-defs';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { field, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type {
    AttributeDef,
    AttributeEvent,
    AttributeKind,
    CheckDef,
    HolderSpec,
    MechanicDef,
    MechanicScope,
    TrackingMode,
} from './api';
import { scopeContextOf } from './definitions';
import type { DefinitionsPart, PartDeps, SectionRenderer, TrackingPart } from './parts';

export const MECHANICS_DEF_CSS = `
.maestro-m25-defs .maestro-m25-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.maestro-m25-defs .maestro-m25-list { display: flex; flex-direction: column; gap: 8px; }
.maestro-m25-defs .maestro-m25-grid { display: grid; gap: 6px 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.maestro-m25-defs .maestro-m25-grid > .maestro-field { grid-template-columns: minmax(0, 1fr); min-width: 0; }
.maestro-m25-defs .maestro-m25-grid .maestro-field-control > * { max-width: 100%; box-sizing: border-box; }
.maestro-m25-defs .maestro-m25-block { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.maestro-m25-defs .maestro-m25-event { border-left: 2px solid var(--maestro-border); padding-left: 8px;
    display: flex; flex-direction: column; gap: 4px; }
.maestro-m25-defs .maestro-m25-sub { font-weight: 600; margin-top: 6px; }
.maestro-m25-defs .maestro-m25-input, .maestro-m25-defs textarea.maestro-m25-input { width: 100%; box-sizing: border-box; }
.maestro-m25-defs .maestro-m25-dice-ok { color: var(--maestro-ok, inherit); font-size: 0.9em; }
.maestro-m25-defs .maestro-m25-dice-bad { color: var(--maestro-error, inherit); font-size: 0.9em; }
.maestro-m25-defs .maestro-m25-issue-error { color: var(--maestro-error, inherit); }
.maestro-m25-defs .maestro-m25-issue-warn { opacity: 0.85; }
.maestro-m25-defs .maestro-m25-summary { font-size: 0.9em; opacity: 0.85; overflow-wrap: anywhere; }
.maestro-m25-defs .maestro-m25-name { flex: 1 1 160px; min-width: 0; }
`;

type Mode = 'list' | 'templates' | 'edit';
type Definitions = DefinitionsPart & { all?(): MechanicDef[] };

interface InputOptions {
    label: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}

function textInput(value: string, onInput: (value: string) => void, options: InputOptions): HTMLInputElement {
    const node = el('input', {
        class: ['text_pole', 'maestro-m25-input', options.className],
        attrs: {
            type: 'text',
            'aria-label': options.label,
            placeholder: options.placeholder,
            disabled: options.disabled === true,
        },
    });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

function textArea(value: string, onInput: (value: string) => void, label: string, rows = 3): HTMLTextAreaElement {
    const node = el('textarea', {
        class: ['text_pole', 'maestro-m25-input'],
        attrs: { rows, 'aria-label': label },
    });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

/** A number input where empty means "none" (bounds, difficulty). */
function optionalNumber(
    value: number | null | undefined,
    onInput: (value: number | undefined) => void,
    label: string,
    placeholder?: string,
): HTMLInputElement {
    const node = el('input', {
        class: ['text_pole', 'maestro-m25-input', 'maestro-number'],
        attrs: { type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': label, placeholder },
    });
    node.value = value === null || value === undefined ? '' : String(value);
    node.addEventListener('input', () => {
        const raw = node.value.trim();
        const parsed = raw === '' ? undefined : Number(raw);
        onInput(parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
    });
    return node;
}

function listText(value: string[] | undefined): string {
    return (value ?? []).join(', ');
}

export function constructorSection(deps: PartDeps, defs: Definitions, tracking: TrackingPart): SectionRenderer {
    const { app } = deps;
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);

    return (container) => {
        let alive = true;
        let mode: Mode = 'list';
        let draft: MechanicDef | null = null;
        /** A new mechanic whose id still follows its name. */
        let autoMechanicId = false;
        /** Attributes and checks added in this editor: their ids follow their names until edited. */
        let autoIds = new WeakSet<object>();
        let refreshIssues: () => void = () => {};

        const root = el('div', { class: 'maestro-m25-defs' });
        container.appendChild(root);

        const run = async (job: () => Promise<unknown>): Promise<void> => {
            try {
                await job();
            } catch (error) {
                app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn' });
            }
        };

        const takenIds = (): string[] => [...(defs.all?.() ?? []), ...defs.list()].map((def) => def.id);

        /* ------------------------------------------------------------ list */

        const scopeBadge = (scope: MechanicScope) => badge(t(`m25.def.scope.${scope.kind}`), 'muted');

        const defCard = (def: MechanicDef, enabled: boolean, hasChat: boolean): HTMLElement =>
            card({
                className: 'maestro-m25-def',
                title: def.name,
                subtitle: el('div', { class: 'maestro-m25-row' }, [
                    scopeBadge(def.scope),
                    el('span', {
                        class: 'maestro-muted',
                        text: t('m25.def.counts', { attributes: def.attributes.length, checks: def.checks.length }),
                    }),
                ]),
                body: [
                    def.summary ? el('div', { class: 'maestro-m25-summary', text: def.summary }) : null,
                    toggle({
                        label: t('m25.def.enabled'),
                        checked: enabled,
                        disabled: !hasChat,
                        onChange: (checked) => run(() => defs.setEnabledInChat(def.id, checked)),
                    }),
                ],
                actions: [
                    button({
                        label: t('m25.def.edit'),
                        icon: 'fa-pen',
                        className: 'maestro-m25-edit',
                        onClick: () => openEditor(def, false),
                    }),
                    button({
                        label: t('m25.def.delete'),
                        icon: 'fa-trash',
                        kind: 'danger',
                        className: 'maestro-m25-delete',
                        onClick: () =>
                            run(async () => {
                                const ok = await app.ui.confirm(
                                    t('m25.def.delete.title'),
                                    t('m25.def.delete.body', { name: def.name, book: def.book ?? '' }),
                                );
                                if (!ok) return;
                                await defs.remove(def.id);
                                app.ui.notice(t('m25.def.deleted', { name: def.name }));
                            }),
                    }),
                ],
            });

        const drawList = (): HTMLElement => {
            const hasChat = !!app.host.chatId();
            const list = defs.list();
            const active = new Set(defs.active().map((def) => def.id));
            return section(
                t('m25.def.section'),
                [
                    el('div', { class: 'maestro-hint', text: t('m25.def.hint') }),
                    hasChat ? null : banner(t('m25.def.noChat'), 'muted', 'fa-circle-info'),
                    list.length
                        ? el(
                              'div',
                              { class: 'maestro-m25-list' },
                              list.map((def) => defCard(def, active.has(def.id), hasChat)),
                          )
                        : emptyState(t('m25.def.empty'), 'fa-dice-d20'),
                ],
                [
                    button({
                        label: t('m25.def.fromTemplate'),
                        icon: 'fa-wand-magic-sparkles',
                        kind: 'primary',
                        className: 'maestro-m25-from-template',
                        onClick: () => {
                            mode = 'templates';
                            draw();
                        },
                    }),
                    button({
                        label: t('m25.def.new'),
                        icon: 'fa-plus',
                        className: 'maestro-m25-new',
                        onClick: () => openEditor(blankDef(), true),
                    }),
                ],
            );
        };

        /* ------------------------------------------------------------ templates */

        const createFrom = (item: DomainTemplate) => {
            const scope = scopeForNew(scopeContextOf(app));
            openEditor(defFromTemplate(item, app.i18n.locale(), scope, takenIds()), false);
        };

        const drawTemplates = (): HTMLElement =>
            section(
                t('m25.def.templates.title'),
                el(
                    'div',
                    { class: 'maestro-m25-list' },
                    MECHANIC_TEMPLATES.map((item) =>
                        card({
                            className: 'maestro-m25-template',
                            title: t(item.titleKey),
                            body: el('div', { class: 'maestro-m25-summary', text: t(item.descriptionKey) }),
                            actions: button({
                                label: t('m25.def.templates.use'),
                                icon: 'fa-plus',
                                kind: 'primary',
                                className: 'maestro-m25-use',
                                onClick: () => createFrom(item),
                            }),
                        }),
                    ),
                ),
                button({
                    label: t('m25.def.templates.close'),
                    icon: 'fa-xmark',
                    kind: 'ghost',
                    className: 'maestro-m25-close',
                    onClick: () => {
                        mode = 'list';
                        draw();
                    },
                }),
            );

        /* ------------------------------------------------------------ editor */

        function blankDef(): MechanicDef {
            const name = t('m25.def.new');
            return {
                id: newMechanicId('mechanic', takenIds()),
                name,
                summary: '',
                rules: '',
                attributes: [],
                holders: { kind: 'characters', includePersona: true },
                checks: [],
                tracking: 'background',
                scope: scopeForNew(scopeContextOf(app)),
            };
        }

        function openEditor(def: MechanicDef, isNew: boolean): void {
            draft = JSON.parse(JSON.stringify(def)) as MechanicDef;
            autoMechanicId = isNew;
            autoIds = new WeakSet<object>();
            mode = 'edit';
            draw();
        }

        const trackingLabel = (mode: TrackingMode) => t(`m25.def.tracking.${mode}`);

        const scopeField = (def: MechanicDef): HTMLElement => {
            const context = scopeContextOf(app);
            const avatar = def.scope.kind === 'card' ? def.scope.avatar : context.avatars[0];
            const chatId = def.scope.kind === 'chat' ? def.scope.chatId : context.chatId;
            const options: { value: MechanicScope['kind']; label: string }[] = [
                { value: 'global', label: t('m25.def.scope.global') },
            ];
            if (avatar) options.push({ value: 'card', label: t('m25.def.scope.card') });
            if (chatId) options.push({ value: 'chat', label: t('m25.def.scope.chat') });
            return field(
                t('m25.def.field.scope'),
                select({
                    value: def.scope.kind,
                    options,
                    label: t('m25.def.field.scope'),
                    onChange: (kind) => {
                        def.scope =
                            kind === 'card' && avatar
                                ? { kind, avatar }
                                : kind === 'chat' && chatId
                                  ? { kind, chatId }
                                  : { kind: 'global' };
                        refreshIssues();
                    },
                }),
            );
        };

        const holdersField = (def: MechanicDef): HTMLElement => {
            const holders = def.holders;
            const names = holders.kind === 'named' || holders.kind === 'factions' ? holders.names : [];
            const controls: HTMLElement[] = [
                select<HolderSpec['kind']>({
                    value: holders.kind,
                    options: HOLDER_KINDS.map((kind) => ({ value: kind, label: t(`m25.def.holders.${kind}`) })),
                    label: t('m25.def.field.holders'),
                    onChange: (kind) => {
                        def.holders = normalizeHolders({ kind, names, includePersona: true });
                        drawEditorAgain();
                    },
                }),
            ];
            if (holders.kind === 'named' || holders.kind === 'factions') {
                controls.push(
                    textInput(
                        listText(holders.names),
                        (value) => {
                            holders.names = cleanList(value);
                            refreshIssues();
                        },
                        {
                            label: t('m25.def.holders.names'),
                            placeholder: t('m25.def.holders.names'),
                            className: 'maestro-m25-names',
                        },
                    ),
                );
            }
            if (holders.kind === 'characters') {
                controls.push(
                    toggle({
                        label: t('m25.def.holders.includePersona'),
                        checked: holders.includePersona === true,
                        onChange: (checked) => {
                            if (checked) holders.includePersona = true;
                            else delete holders.includePersona;
                        },
                    }),
                );
            }
            return field(t('m25.def.field.holders'), el('div', { class: 'maestro-m25-list' }, controls));
        };

        const trackingSelect = (
            value: TrackingMode | undefined,
            onChange: (mode: TrackingMode | undefined) => void,
            inherit?: TrackingMode,
        ): HTMLSelectElement => {
            const options = TRACKING_MODES.map((mode) => ({ value: mode as string, label: trackingLabel(mode) }));
            if (inherit)
                options.unshift({ value: '', label: t('m25.def.tracking.inherit', { mode: trackingLabel(inherit) }) });
            return select<string>({
                value: value ?? '',
                options,
                label: t('m25.def.attr.tracking'),
                onChange: (chosen) => onChange(chosen ? (chosen as TrackingMode) : undefined),
            });
        };

        const eventRow = (attribute: AttributeDef, event: AttributeEvent): HTMLElement => {
            const ops =
                attribute.kind === 'number' || attribute.kind === 'scale' ? EVENT_OPS : (['=', 'changed'] as const);
            const opSelect = select<string>({
                value: event.when.op,
                options: ops.map((op) => ({ value: op, label: op === 'changed' ? t('m25.def.event.op.changed') : op })),
                label: t('m25.def.event.op'),
                onChange: (op) => {
                    event.when = {
                        op: op as AttributeEvent['when']['op'],
                        ...(op === 'changed' ? {} : { value: event.when.value }),
                    };
                    if (op !== 'changed' && event.when.value === undefined) {
                        event.when.value = attribute.kind === 'number' ? 0 : (attribute.levels?.[0] ?? '');
                    }
                    drawEditorAgain();
                },
            });
            let valueControl: HTMLElement | null = null;
            if (event.when.op !== 'changed') {
                if (attribute.kind === 'number') {
                    valueControl = optionalNumber(
                        typeof event.when.value === 'number' ? event.when.value : undefined,
                        (value) => {
                            if (value === undefined) delete event.when.value;
                            else event.when.value = value;
                            refreshIssues();
                        },
                        t('m25.def.event.value'),
                    );
                } else if (attribute.kind === 'scale') {
                    const levels = attribute.levels ?? [];
                    valueControl = select<string>({
                        value: typeof event.when.value === 'string' ? event.when.value : (levels[0] ?? ''),
                        options: levels.map((level) => ({ value: level, label: level })),
                        label: t('m25.def.event.value'),
                        onChange: (level) => {
                            event.when.value = level;
                            refreshIssues();
                        },
                    });
                } else {
                    valueControl = textInput(
                        String(event.when.value ?? ''),
                        (value) => {
                            event.when.value = value.trim();
                            refreshIssues();
                        },
                        { label: t('m25.def.event.value'), placeholder: t('m25.def.event.value') },
                    );
                }
            }
            return el('div', { class: 'maestro-m25-event' }, [
                el('div', { class: 'maestro-m25-row' }, [
                    el('span', { class: 'maestro-muted', text: t('m25.def.event.op') }),
                    opSelect,
                    valueControl,
                    el('span', { class: 'maestro-grow' }),
                    button({
                        icon: 'fa-xmark',
                        title: t('m25.def.event.remove'),
                        kind: 'ghost',
                        className: 'maestro-m25-event-remove',
                        onClick: () => {
                            attribute.events = (attribute.events ?? []).filter((item) => item !== event);
                            if (!attribute.events.length) delete attribute.events;
                            drawEditorAgain();
                        },
                    }),
                ]),
                textInput(
                    event.text,
                    (value) => {
                        event.text = value;
                        refreshIssues();
                    },
                    {
                        label: t('m25.def.event.text'),
                        placeholder: t('m25.def.event.text'),
                        className: 'maestro-m25-event-text',
                    },
                ),
                toggle({
                    label: t('m25.def.event.once'),
                    checked: event.once !== false,
                    onChange: (checked) => {
                        if (checked) delete event.once;
                        else event.once = false;
                    },
                }),
            ]);
        };

        const resetKind = (attribute: AttributeDef, kind: AttributeKind) => {
            attribute.kind = kind;
            for (const key of ['min', 'max', 'initial', 'levels', 'options', 'multi'] as const) delete attribute[key];
            if (kind === 'number') {
                attribute.min = 0;
                attribute.max = 100;
            } else if (kind === 'scale') {
                attribute.levels = ['low', 'medium', 'high'];
                attribute.initial = 'medium';
            } else if (kind === 'list') {
                attribute.options = [];
            }
            delete attribute.events;
        };

        const attributeIdsExcept = (def: MechanicDef, attribute: AttributeDef) =>
            def.attributes.filter((item) => item !== attribute).map((item) => item.id);

        const attributeBlock = (def: MechanicDef, attribute: AttributeDef, index: number): HTMLElement => {
            const idInput = textInput(
                attribute.id,
                (value) => {
                    attribute.id = value.trim();
                    autoIds.delete(attribute);
                    refreshIssues();
                },
                { label: t('m25.def.attr.id'), className: 'maestro-m25-attr-id' },
            );
            const followName = () => {
                if (!autoIds.has(attribute)) return;
                attribute.id = uniqueId(
                    snakeId(attribute.promptName || attribute.name, 'attr'),
                    attributeIdsExcept(def, attribute),
                );
                idInput.value = attribute.id;
            };
            const move = (delta: number) => {
                const target = index + delta;
                if (target < 0 || target >= def.attributes.length) return;
                const list = def.attributes;
                [list[index], list[target]] = [list[target] as AttributeDef, list[index] as AttributeDef];
                drawEditorAgain();
            };
            const specific: HTMLElement[] = [];
            if (attribute.kind === 'number') {
                specific.push(
                    field(
                        t('m25.def.attr.min'),
                        optionalNumber(
                            attribute.min,
                            (value) => {
                                if (value === undefined) delete attribute.min;
                                else attribute.min = value;
                                refreshIssues();
                            },
                            t('m25.def.attr.min'),
                            t('m25.def.attr.bound.none'),
                        ),
                    ),
                    field(
                        t('m25.def.attr.max'),
                        optionalNumber(
                            attribute.max,
                            (value) => {
                                if (value === undefined) delete attribute.max;
                                else attribute.max = value;
                                refreshIssues();
                            },
                            t('m25.def.attr.max'),
                            t('m25.def.attr.bound.none'),
                        ),
                    ),
                    field(
                        t('m25.def.attr.initial'),
                        optionalNumber(
                            typeof attribute.initial === 'number' ? attribute.initial : undefined,
                            (value) => {
                                if (value === undefined) delete attribute.initial;
                                else attribute.initial = value;
                                refreshIssues();
                            },
                            t('m25.def.attr.initial'),
                        ),
                    ),
                );
            } else if (attribute.kind === 'scale') {
                const levels = attribute.levels ?? [];
                const levelsInput = textInput(listText(levels), () => {}, {
                    label: t('m25.def.attr.levels'),
                    className: 'maestro-m25-levels',
                });
                levelsInput.addEventListener('change', () => {
                    attribute.levels = cleanList(levelsInput.value);
                    if (typeof attribute.initial !== 'string' || !attribute.levels.includes(attribute.initial)) {
                        attribute.initial = attribute.levels[0];
                        if (attribute.initial === undefined) delete attribute.initial;
                    }
                    drawEditorAgain();
                });
                specific.push(
                    field(t('m25.def.attr.levels'), levelsInput),
                    field(
                        t('m25.def.attr.initial'),
                        select<string>({
                            value: typeof attribute.initial === 'string' ? attribute.initial : (levels[0] ?? ''),
                            options: levels.map((level) => ({ value: level, label: level })),
                            label: t('m25.def.attr.initial'),
                            onChange: (level) => {
                                attribute.initial = level;
                                refreshIssues();
                            },
                        }),
                    ),
                );
            } else if (attribute.kind === 'list') {
                const optionsInput = textInput(listText(attribute.options), () => {}, {
                    label: t('m25.def.attr.options'),
                    className: 'maestro-m25-options',
                });
                optionsInput.addEventListener('change', () => {
                    attribute.options = cleanList(optionsInput.value);
                    drawEditorAgain();
                });
                specific.push(
                    field(t('m25.def.attr.options'), optionsInput),
                    toggle({
                        label: t('m25.def.attr.multi'),
                        checked: attribute.multi === true,
                        onChange: (checked) => {
                            if (checked) attribute.multi = true;
                            else delete attribute.multi;
                            refreshIssues();
                        },
                    }),
                    field(
                        t('m25.def.attr.initial'),
                        textInput(
                            listText(Array.isArray(attribute.initial) ? attribute.initial : []),
                            (value) => {
                                attribute.initial = cleanList(value);
                                refreshIssues();
                            },
                            { label: t('m25.def.attr.initial'), className: 'maestro-m25-initial' },
                        ),
                    ),
                );
            } else {
                specific.push(
                    field(
                        t('m25.def.attr.initial'),
                        textArea(
                            typeof attribute.initial === 'string' ? attribute.initial : '',
                            (value) => {
                                attribute.initial = value;
                                refreshIssues();
                            },
                            t('m25.def.attr.initial'),
                            2,
                        ),
                    ),
                );
            }
            const events = attribute.events ?? [];
            const newEvent = (): AttributeEvent => {
                const id = uniqueId(
                    'event',
                    events.map((item) => item.id),
                );
                if (attribute.kind === 'number') return { id, when: { op: '<=', value: attribute.min ?? 0 }, text: '' };
                if (attribute.kind === 'scale')
                    return { id, when: { op: '=', value: attribute.levels?.[0] ?? '' }, text: '' };
                return { id, when: { op: 'changed' }, text: '' };
            };
            return el(
                'div',
                { class: 'maestro-m25-block maestro-m25-attr', data: { attribute: attribute.id || String(index) } },
                [
                    el('div', { class: 'maestro-m25-row' }, [
                        textInput(
                            attribute.name,
                            (value) => {
                                attribute.name = value;
                                followName();
                                refreshIssues();
                            },
                            {
                                label: t('m25.def.attr.name'),
                                placeholder: t('m25.def.attr.name'),
                                className: 'maestro-m25-name maestro-m25-attr-name',
                            },
                        ),
                        select<AttributeKind>({
                            value: attribute.kind,
                            options: (['number', 'scale', 'list', 'text'] as AttributeKind[]).map((kind) => ({
                                value: kind,
                                label: t(`m25.def.kind.${kind}`),
                            })),
                            label: t('m25.def.attr.kind'),
                            onChange: (kind) => {
                                resetKind(attribute, kind);
                                drawEditorAgain();
                            },
                        }),
                        button({
                            icon: 'fa-arrow-up',
                            title: t('m25.def.attr.up'),
                            kind: 'ghost',
                            className: 'maestro-m25-up',
                            disabled: index === 0,
                            onClick: () => move(-1),
                        }),
                        button({
                            icon: 'fa-arrow-down',
                            title: t('m25.def.attr.down'),
                            kind: 'ghost',
                            className: 'maestro-m25-down',
                            disabled: index === def.attributes.length - 1,
                            onClick: () => move(1),
                        }),
                        button({
                            icon: 'fa-trash',
                            title: t('m25.def.attr.remove'),
                            kind: 'ghost',
                            className: 'maestro-m25-attr-remove',
                            onClick: () => {
                                def.attributes = def.attributes.filter((item) => item !== attribute);
                                drawEditorAgain();
                            },
                        }),
                    ]),
                    el('div', { class: 'maestro-m25-grid' }, [
                        field(
                            t('m25.def.attr.promptName'),
                            textInput(
                                attribute.promptName,
                                (value) => {
                                    attribute.promptName = value;
                                    followName();
                                    refreshIssues();
                                },
                                { label: t('m25.def.attr.promptName'), className: 'maestro-m25-attr-prompt' },
                            ),
                        ),
                        field(t('m25.def.attr.id'), idInput),
                        ...specific,
                        field(
                            t('m25.def.attr.tracking'),
                            trackingSelect(
                                attribute.tracking,
                                (mode) => {
                                    if (mode) attribute.tracking = mode;
                                    else delete attribute.tracking;
                                    drawEditorAgain();
                                },
                                def.tracking,
                            ),
                        ),
                    ]),
                    toggle({
                        label: t('m25.def.attr.visible'),
                        checked: attribute.visible !== false,
                        onChange: (checked) => {
                            if (checked) delete attribute.visible;
                            else attribute.visible = false;
                        },
                    }),
                    el('div', { class: 'maestro-m25-sub', text: t('m25.def.events') }),
                    ...events.map((event) => eventRow(attribute, event)),
                    el('div', { class: 'maestro-m25-row' }, [
                        button({
                            label: t('m25.def.events.add'),
                            icon: 'fa-bolt',
                            kind: 'ghost',
                            className: 'maestro-m25-event-add',
                            onClick: () => {
                                attribute.events = [...events, newEvent()];
                                drawEditorAgain();
                            },
                        }),
                    ]),
                ],
            );
        };

        /** Live verdict on a dice formula: the canonical roll, or what is wrong with it. */
        const diceVerdict = (def: MechanicDef, dice: string): { ok: boolean; text: string } => {
            const formula = parseDice(dice);
            if (!formula) return { ok: false, text: t('m25.def.check.diceBad') };
            for (const attribute of diceAttributes(formula)) {
                const found = def.attributes.find((item) => item.id === attribute);
                if (!found) return { ok: false, text: t('m25.def.issue.diceUnknown', { check: dice, attribute }) };
                if (found.kind !== 'number')
                    return { ok: false, text: t('m25.def.issue.diceKind', { check: dice, attribute }) };
            }
            return {
                ok: true,
                text: t(formula.under ? 'm25.def.check.diceUnder' : 'm25.def.check.diceOk', { text: formula.text }),
            };
        };

        const checkBlock = (def: MechanicDef, check: CheckDef, index: number): HTMLElement => {
            const idInput = textInput(
                check.id,
                (value) => {
                    check.id = value.trim();
                    autoIds.delete(check);
                    refreshIssues();
                },
                { label: t('m25.def.check.id'), className: 'maestro-m25-check-id' },
            );
            const followName = () => {
                if (!autoIds.has(check)) return;
                const others = def.checks.filter((item) => item !== check).map((item) => item.id);
                check.id = uniqueId(snakeId(check.promptName || check.name, 'check'), others);
                idInput.value = check.id;
            };
            const verdict = el('div', { class: 'maestro-m25-dice-verdict' });
            const showVerdict = () => {
                const result = diceVerdict(def, check.dice);
                verdict.textContent = result.text;
                verdict.className = `maestro-m25-dice-verdict ${result.ok ? 'maestro-m25-dice-ok' : 'maestro-m25-dice-bad'}`;
            };
            showVerdict();
            const diceInput = textInput(
                check.dice,
                (value) => {
                    check.dice = value.trim();
                    showVerdict();
                    refreshIssues();
                },
                { label: t('m25.def.check.dice'), placeholder: '1d20+mod(@skill)', className: 'maestro-m25-dice' },
            );
            return el(
                'div',
                { class: 'maestro-m25-block maestro-m25-check', data: { check: check.id || String(index) } },
                [
                    el('div', { class: 'maestro-m25-row' }, [
                        textInput(
                            check.name,
                            (value) => {
                                check.name = value;
                                followName();
                                refreshIssues();
                            },
                            {
                                label: t('m25.def.check.name'),
                                placeholder: t('m25.def.check.name'),
                                className: 'maestro-m25-name maestro-m25-check-name',
                            },
                        ),
                        button({
                            icon: 'fa-trash',
                            title: t('m25.def.check.remove'),
                            kind: 'ghost',
                            className: 'maestro-m25-check-remove',
                            onClick: () => {
                                def.checks = def.checks.filter((item) => item !== check);
                                drawEditorAgain();
                            },
                        }),
                    ]),
                    el('div', { class: 'maestro-m25-grid' }, [
                        field(
                            t('m25.def.check.promptName'),
                            textInput(
                                check.promptName,
                                (value) => {
                                    check.promptName = value;
                                    followName();
                                    refreshIssues();
                                },
                                { label: t('m25.def.check.promptName'), className: 'maestro-m25-check-prompt' },
                            ),
                        ),
                        field(t('m25.def.check.id'), idInput),
                        field(
                            t('m25.def.check.dice'),
                            el('div', {}, [diceInput, verdict]),
                            t('m25.def.check.dice.hint'),
                        ),
                        field(
                            t('m25.def.check.difficulty'),
                            optionalNumber(
                                check.difficulty,
                                (value) => {
                                    check.difficulty = value ?? null;
                                    refreshIssues();
                                },
                                t('m25.def.check.difficulty'),
                            ),
                            t('m25.def.check.difficulty.hint'),
                        ),
                    ]),
                    field(
                        t('m25.def.check.triggers'),
                        textInput(
                            listText(check.triggers),
                            (value) => {
                                check.triggers = cleanList(value);
                                refreshIssues();
                            },
                            { label: t('m25.def.check.triggers'), className: 'maestro-m25-triggers' },
                        ),
                        t('m25.def.check.triggers.hint'),
                    ),
                    toggle({
                        label: t('m25.def.check.criticals'),
                        // The truth for any dice: the check's own switch, else the default (one d20 or d100).
                        checked: criticalsOf(check),
                        onChange: (checked) => {
                            const formula = parseDice(check.dice);
                            if (formula && checked === criticalsDefault(formula)) delete check.criticals;
                            else check.criticals = checked;
                        },
                    }),
                ],
            );
        };

        const desBlock = (def: MechanicDef): HTMLElement | null => {
            const normalized = normalizeDef(def);
            if (!normalized || !desStatsAttributes(normalized).length) return null;
            const body: HTMLElement[] = [el('div', { class: 'maestro-hint', text: t('m25.def.des.hint') })];
            if (def.uid === undefined) {
                body.push(el('div', { class: 'maestro-muted maestro-m25-des-save', text: t('m25.def.des.saveFirst') }));
                return section(t('m25.def.des.title'), body);
            }
            let status: { attribute: string; inDes: boolean }[] = [];
            try {
                status = tracking.desStatsStatus(normalized);
            } catch (error) {
                deps.log.debug('mechanics: DES stats status failed', error);
            }
            const names = new Map(normalized.attributes.map((item) => [item.id, item.name]));
            body.push(
                el(
                    'div',
                    { class: 'maestro-m25-list maestro-m25-des-status' },
                    status.map((item) =>
                        el('div', { class: 'maestro-m25-row' }, [
                            el('span', { text: names.get(item.attribute) ?? item.attribute }),
                            badge(t(item.inDes ? 'm25.def.des.in' : 'm25.def.des.missing'), item.inDes ? 'ok' : 'warn'),
                        ]),
                    ),
                ),
            );
            return section(
                t('m25.def.des.title'),
                body,
                button({
                    label: t('m25.def.des.button'),
                    icon: 'fa-chart-simple',
                    kind: 'primary',
                    className: 'maestro-m25-des',
                    disabled: status.length > 0 && status.every((item) => item.inDes),
                    onClick: () =>
                        run(async () => {
                            const ok = await tracking.enableDesStats(normalized);
                            app.ui.notice(t(ok ? 'm25.def.des.done' : 'm25.def.des.notDone'), {
                                level: ok ? 'info' : 'warn',
                            });
                            drawEditorAgain();
                        }),
                }),
            );
        };

        const issueList = (issues: DefIssue[]): HTMLElement[] =>
            issues.map((issue) =>
                el('li', {
                    class: issue.level === 'error' ? 'maestro-m25-issue-error' : 'maestro-m25-issue-warn',
                    text: t(`m25.def.issue.${issue.code}`, issue.params),
                }),
            );

        const save = (def: MechanicDef) =>
            run(async () => {
                const normalized = normalizeDef(def);
                const issues = normalized ? validateDef(normalized) : [];
                const error = issues.find((issue) => issue.level === 'error');
                if (!normalized || error) {
                    refreshIssues();
                    throw new Error(
                        t('m25.def.error.invalid', {
                            issue: error ? t(`m25.def.issue.${error.code}`, error.params) : t('m25.def.issue.id'),
                        }),
                    );
                }
                const saved = await defs.save(normalized);
                app.ui.notice(t('m25.def.saved', { name: saved.name }));
                draft = null;
                mode = 'list';
                draw();
            });

        const drawEditor = (def: MechanicDef): HTMLElement => {
            const isSaved = def.uid !== undefined;
            const idInput = textInput(
                def.id,
                (value) => {
                    def.id = value.trim();
                    autoMechanicId = false;
                    refreshIssues();
                },
                { label: t('m25.def.field.id'), disabled: isSaved, className: 'maestro-m25-def-id' },
            );
            const issuesHost = el('ul', { class: 'maestro-m25-issues' });
            refreshIssues = () => {
                const normalized = normalizeDef(def);
                clear(issuesHost);
                for (const item of issueList(normalized ? validateDef(normalized) : [])) issuesHost.appendChild(item);
            };
            refreshIssues();
            return section(isSaved ? t('m25.def.editor.edit', { name: def.name }) : t('m25.def.editor.new'), [
                field(
                    t('m25.def.field.name'),
                    textInput(
                        def.name,
                        (value) => {
                            def.name = value;
                            if (autoMechanicId && !isSaved) {
                                def.id = newMechanicId(
                                    value || 'mechanic',
                                    takenIds().filter((id) => id !== def.id),
                                );
                                idInput.value = def.id;
                            }
                            refreshIssues();
                        },
                        { label: t('m25.def.field.name'), className: 'maestro-m25-def-name' },
                    ),
                ),
                field(t('m25.def.field.id'), idInput, t('m25.def.field.id.hint', { id: def.id })),
                field(
                    t('m25.def.field.promptName'),
                    textInput(
                        def.promptName ?? '',
                        (value) => {
                            if (value.trim()) def.promptName = value.trim();
                            else delete def.promptName;
                            refreshIssues();
                        },
                        { label: t('m25.def.field.promptName'), className: 'maestro-m25-def-prompt-name' },
                    ),
                    t('m25.def.field.promptName.hint'),
                ),
                field(
                    t('m25.def.field.summary'),
                    textArea(
                        def.summary,
                        (value) => {
                            def.summary = value;
                            refreshIssues();
                        },
                        t('m25.def.field.summary'),
                        2,
                    ),
                    t('m25.def.field.summary.hint'),
                ),
                field(
                    t('m25.def.field.rules'),
                    textArea(
                        def.rules,
                        (value) => {
                            def.rules = value;
                            refreshIssues();
                        },
                        t('m25.def.field.rules'),
                        6,
                    ),
                    t('m25.def.field.rules.hint'),
                ),
                scopeField(def),
                holdersField(def),
                field(
                    t('m25.def.field.tracking'),
                    trackingSelect(def.tracking, (mode) => {
                        def.tracking = mode ?? 'background';
                        drawEditorAgain();
                    }),
                    t('m25.def.tracking.hint'),
                ),
                el('div', { class: 'maestro-m25-sub', text: t('m25.def.attributes') }),
                def.attributes.length
                    ? el(
                          'div',
                          { class: 'maestro-m25-list' },
                          def.attributes.map((item, index) => attributeBlock(def, item, index)),
                      )
                    : el('div', { class: 'maestro-muted', text: t('m25.def.attributes.empty') }),
                el('div', { class: 'maestro-m25-row' }, [
                    button({
                        label: t('m25.def.attributes.add'),
                        icon: 'fa-plus',
                        className: 'maestro-m25-attr-add',
                        onClick: () => {
                            const attribute: AttributeDef = {
                                id: uniqueId(
                                    'attr',
                                    def.attributes.map((item) => item.id),
                                ),
                                name: '',
                                promptName: '',
                                kind: 'number',
                                min: 0,
                                max: 100,
                            };
                            autoIds.add(attribute);
                            def.attributes.push(attribute);
                            drawEditorAgain();
                        },
                    }),
                ]),
                el('div', { class: 'maestro-m25-sub', text: t('m25.def.checks') }),
                def.checks.length
                    ? el(
                          'div',
                          { class: 'maestro-m25-list' },
                          def.checks.map((item, index) => checkBlock(def, item, index)),
                      )
                    : el('div', { class: 'maestro-muted', text: t('m25.def.checks.empty') }),
                el('div', { class: 'maestro-m25-row' }, [
                    button({
                        label: t('m25.def.checks.add'),
                        icon: 'fa-dice-d20',
                        className: 'maestro-m25-check-add',
                        onClick: () => {
                            const check: CheckDef = {
                                id: uniqueId(
                                    'check',
                                    def.checks.map((item) => item.id),
                                ),
                                name: '',
                                promptName: '',
                                dice: '1d20',
                                difficulty: 12,
                                triggers: [],
                            };
                            autoIds.add(check);
                            def.checks.push(check);
                            drawEditorAgain();
                        },
                    }),
                ]),
                desBlock(def),
                el('div', { class: 'maestro-m25-sub', text: t('m25.def.issues') }),
                issuesHost,
                el('div', { class: 'maestro-m25-row' }, [
                    button({
                        label: t('m25.def.save'),
                        icon: 'fa-floppy-disk',
                        kind: 'primary',
                        className: 'maestro-m25-save',
                        onClick: () => save(def),
                    }),
                    button({
                        label: t('m25.def.cancel'),
                        icon: 'fa-xmark',
                        kind: 'ghost',
                        className: 'maestro-m25-cancel',
                        onClick: () => {
                            draft = null;
                            mode = 'list';
                            draw();
                        },
                    }),
                ]),
            ]);
        };

        /* ------------------------------------------------------------ drawing */

        function draw(): void {
            if (!alive) return;
            clear(root);
            refreshIssues = () => {};
            if (mode === 'edit' && draft) root.appendChild(drawEditor(draft));
            else if (mode === 'templates') root.appendChild(drawTemplates());
            else {
                mode = 'list';
                root.appendChild(drawList());
            }
        }

        /** Structural changes of the draft (kind, rows added or removed) rebuild the editor. */
        function drawEditorAgain(): void {
            if (mode === 'edit') draw();
        }

        // Several changes in one tick (our save, then WORLDINFO_UPDATED) draw once; the editor is never redrawn under
        // the user's hands.
        let pending = false;
        const off = defs.onChange(() => {
            if (pending || !alive) return;
            pending = true;
            queueMicrotask(() => {
                pending = false;
                if (alive && mode !== 'edit') draw();
            });
        });
        draw();
        return () => {
            alive = false;
            off();
            root.remove();
        };
    };
}
