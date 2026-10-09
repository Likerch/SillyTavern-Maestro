// M25 «Механики», the constructor section (plan M25 п. 1–2, plan-2 §6 п.8 «Удобный конструктор», P10):
// - the list: the mechanics visible in this chat (switch for this chat, scope, edit, copy, save to a file, reset its
//   state in this chat, delete — the destructive ones ask first), «Из шаблона», «Новая», «Из файла» (a JSON file of
//   a mechanic) and «Описать словами» (the assistant builds the mechanic from the user's description);
// - the editor in story words: name, the summary and rules in the user's language (the English for the model is made
//   by a background translation after saving, or at once by «Перевести сейчас»; it stays editable under «Подробнее»),
//   scope, holders, tracking, «Где видно» (preset buttons and places), attributes (kind, sign, bounds, start value,
//   formula and growth of numbers, levels/options, tracking, own visibility, events with actions and chains), checks
//   (dice validated live, difficulty, trigger words, consequences per outcome), statuses, inventory and money, levels,
//   time rules, fights, «Сделать статами DES», a live preview of what the model gets, and the problems to fix.
//   Ids are made from names and never shown in the main text (only under «Подробнее»). Switching an attribute's kind
//   keeps its events (asks before dropping the ones that no longer fit).
// Stacked fields and wrapping rows: usable in a narrow side panel and on a phone.
import { initialValues } from '../../domain/mechanics-state';
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
    parseDice,
    scopeForNew,
    snakeId,
    TRACKING_MODES,
    uniqueId,
    validateDef,
} from '../../domain/mechanics-defs';
import type { DefIssue } from '../../domain/mechanics-defs';
import { renderRules } from '../../domain/mechanics-prompt';
import { defFromTemplate, MECHANIC_TEMPLATES } from '../../domain/mechanics-templates';
import type { MechanicTemplate as DomainTemplate } from '../../domain/mechanics-defs';
import {
    duplicateMechanic,
    eventsKeptFor,
    exportFileName,
    exportMechanic,
    importMechanic,
    interimEnglish,
    sourceHash,
    translationItems,
} from '../../domain/mechanics-view';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { field, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { AssistantApi } from '../assistant/api';
import type {
    AttributeDef,
    AttributeEvent,
    AttributeKind,
    CheckDef,
    HolderSpec,
    MechanicDef,
    MechanicScope,
    MechanicsApi,
    TrackingMode,
} from './api';
import { scopeContextOf } from './definitions';
import { offeredTemplates, replacedByEngine } from './dramatis';
import type { DefinitionsPart, PartDeps, SectionRenderer, TrackingPart } from './parts';
import type { MechanicTranslator } from './translate';
import {
    combatEditor,
    effectsEditor,
    ENGINE_CSS,
    eventExtras,
    inventoryEditor,
    numberExtras,
    progressionEditor,
    statusesEditor,
    timeEditor,
    visibilityEditor,
} from './view-constructor-engine';
import type { EngineCtx } from './view-constructor-engine';
import { listText, moreBlock, optionalNumber, textArea, textInput } from './view-inputs';

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
.maestro-m25-defs .maestro-m25-icon-input { flex: 0 0 4em; width: 4em; }
.maestro-m25-defs .maestro-m25-preview { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85em; margin: 0;
    padding: 6px; border-radius: var(--maestro-radius-sm); background: rgba(127, 127, 127, 0.12); max-height: 18em; overflow: auto; }
.maestro-m25-defs .maestro-m25-translation { font-size: 0.9em; }
${ENGINE_CSS}`;

type Mode = 'list' | 'templates' | 'edit' | 'describe';
type Definitions = DefinitionsPart & { all?(): MechanicDef[] };

/** What the constructor uses besides the parts (the public API for resets and the prompt preview, the translator). */
export interface ConstructorExtras {
    api?: MechanicsApi;
    translator?: Pick<MechanicTranslator, 'translateDraft' | 'enqueue' | 'available'>;
}

/** A file the user picked, read as text (tests replace it). */
export type FileReaderFn = (file: File) => Promise<string>;

function readFile(file: File): Promise<string> {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsText(file);
    });
}

/** Offers a JSON file to save (a link with `download`). */
export function downloadJson(name: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { attrs: { href: url, download: name } });
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** For an editor: the English summary and rules become the «own words» when there are none (older definitions). */
function withSources(def: MechanicDef): MechanicDef {
    for (const field of ['summary', 'rules'] as const) {
        const sourceKey = field === 'summary' ? 'summarySource' : 'rulesSource';
        if (def[sourceKey] || !def[field].trim()) continue;
        def[sourceKey] = def[field];
        def.translatedFrom = { ...(def.translatedFrom ?? {}), [field]: sourceHash(def[field]) };
    }
    return def;
}

export function constructorSection(
    deps: PartDeps,
    defs: Definitions,
    tracking: TrackingPart,
    extras: ConstructorExtras = {},
    read: FileReaderFn = readFile,
): SectionRenderer {
    const { app } = deps;
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);

    return (container) => {
        let alive = true;
        let mode: Mode = 'list';
        let draft: MechanicDef | null = null;
        /** A new mechanic whose id still follows its name. */
        let autoMechanicId = false;
        /** Attributes, checks and events added in this editor: their ids follow their names. */
        let autoIds = new WeakSet<object>();
        let refreshIssues: () => void = () => {};
        let translating = false;

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
                    translationItems(def).length ? badge(t('m25.ctor.translation.waiting'), 'info') : null,
                ]),
                body: [
                    def.summarySource || def.summary
                        ? el('div', { class: 'maestro-m25-summary', text: def.summarySource || def.summary })
                        : null,
                    replacedByEngine(app, def) ? banner(t('m25.def.dramatisNote'), 'muted', 'fa-masks-theater') : null,
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
                        label: t('m25.ctor.copy'),
                        icon: 'fa-copy',
                        kind: 'ghost',
                        className: 'maestro-m25-copy',
                        onClick: () =>
                            openEditor(
                                duplicateMechanic(def, t('m25.ctor.copy.name', { name: def.name }), takenIds()),
                                true,
                            ),
                    }),
                    button({
                        label: t('m25.ctor.export'),
                        icon: 'fa-file-export',
                        kind: 'ghost',
                        className: 'maestro-m25-export',
                        onClick: () => {
                            downloadJson(exportFileName(def), exportMechanic(def));
                            app.ui.notice(t('m25.ctor.exported', { name: def.name }), { urgent: true });
                        },
                    }),
                    extras.api?.reset && hasChat && enabled
                        ? button({
                              label: t('m25.win.reset'),
                              icon: 'fa-rotate-left',
                              kind: 'ghost',
                              className: 'maestro-m25-reset-state',
                              onClick: () =>
                                  run(async () => {
                                      const ok = await app.ui.confirm(
                                          t('m25.win.reset.title'),
                                          t('m25.win.reset.body', { name: def.name }),
                                      );
                                      if (!ok) return;
                                      const count = (await extras.api?.reset?.({ mechanicId: def.id })) ?? 0;
                                      app.ui.notice(
                                          count ? t('m25.win.reset.done', { count }) : t('m25.win.reset.nothing'),
                                          { urgent: true },
                                      );
                                  }),
                          })
                        : null,
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

        const importInput = (): HTMLInputElement => {
            const input = el('input', {
                class: 'maestro-m25-import-input',
                attrs: { type: 'file', accept: '.json,application/json', 'aria-label': t('m25.ctor.import') },
            });
            input.hidden = true;
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                input.value = '';
                if (!file) return;
                void run(async () => importText(await read(file)));
            });
            return input;
        };

        const importText = (text: string) => {
            const result = importMechanic(text, takenIds(), scopeForNew(scopeContextOf(app)));
            if (!result.ok) {
                app.ui.notice(t(`m25.ctor.import.${result.error}`), { level: 'warn', urgent: true });
                return;
            }
            openEditor(result.def, false);
            app.ui.notice(t('m25.ctor.imported', { name: result.def.name }), { urgent: true });
        };

        const drawList = (): HTMLElement => {
            const hasChat = !!app.host.chatId();
            const list = defs.list();
            const active = new Set(defs.active().map((def) => def.id));
            const fileInput = importInput();
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
                    fileInput,
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
                    button({
                        label: t('m25.ctor.describe'),
                        icon: 'fa-comments',
                        kind: 'ghost',
                        className: 'maestro-m25-describe',
                        onClick: () => {
                            mode = 'describe';
                            draw();
                        },
                    }),
                    button({
                        label: t('m25.ctor.import'),
                        icon: 'fa-file-import',
                        kind: 'ghost',
                        className: 'maestro-m25-import',
                        onClick: () => fileInput.click(),
                    }),
                ],
            );
        };

        /* ------------------------------------------------------------ «Описать словами» */

        const assistant = (): AssistantApi | undefined => {
            try {
                return app.modules.api<AssistantApi>('assistant');
            } catch {
                return undefined;
            }
        };

        const drawDescribe = (): HTMLElement => {
            const words = textArea('', () => {}, t('m25.ctor.describe.field'), 6, 'maestro-m25-describe-text');
            words.placeholder = t('m25.ctor.describe.placeholder');
            const helper = assistant();
            return section(
                t('m25.ctor.describe.title'),
                [
                    el('div', { class: 'maestro-hint', text: t('m25.ctor.describe.hint') }),
                    helper ? null : banner(t('m25.ctor.describe.off'), 'warn'),
                    words,
                ],
                [
                    button({
                        label: t('m25.ctor.describe.send'),
                        icon: 'fa-paper-plane',
                        kind: 'primary',
                        className: 'maestro-m25-describe-send',
                        disabled: !helper,
                        onClick: () =>
                            run(async () => {
                                const text = words.value.trim();
                                if (!text || !helper) return;
                                if (app.ui.openWindow) app.ui.openWindow('assistant');
                                else app.ui.openPult('assistant');
                                mode = 'list';
                                draw();
                                await helper.send(t('m25.ctor.describe.request', { text }));
                            }),
                    }),
                    button({
                        label: t('m25.def.cancel'),
                        icon: 'fa-xmark',
                        kind: 'ghost',
                        className: 'maestro-m25-describe-cancel',
                        onClick: () => {
                            mode = 'list';
                            draw();
                        },
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
                    offeredTemplates(app, MECHANIC_TEMPLATES).map((item) =>
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
            draft = withSources(JSON.parse(JSON.stringify(def)) as MechanicDef);
            autoMechanicId = isNew;
            autoIds = new WeakSet<object>();
            mode = 'edit';
            draw();
        }

        const trackingLabel = (value: TrackingMode) => t(`m25.def.tracking.${value}`);

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
                        def.holders = normalizeHoldersOf(kind, names);
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
            const options = TRACKING_MODES.map((item) => ({ value: item as string, label: trackingLabel(item) }));
            if (inherit)
                options.unshift({ value: '', label: t('m25.def.tracking.inherit', { mode: trackingLabel(inherit) }) });
            return select<string>({
                value: value ?? '',
                options,
                label: t('m25.def.attr.tracking'),
                onChange: (chosen) => onChange(chosen ? (chosen as TrackingMode) : undefined),
            });
        };

        const engineCtx = (def: MechanicDef): EngineCtx => ({
            t,
            def,
            refresh: () => refreshIssues(),
            redraw: () => drawEditorAgain(),
        });

        const eventRow = (
            def: MechanicDef,
            attribute: AttributeDef,
            event: AttributeEvent,
            path: string,
        ): HTMLElement => {
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
                eventExtras(engineCtx(def), event, path),
            ]);
        };

        /** The attribute's fields of a kind go, the new kind's defaults come; the events stay. */
        const resetKind = (attribute: AttributeDef, kind: AttributeKind, dropUnfit: boolean) => {
            const fits = (event: AttributeEvent) => eventsKeptFor({ events: [event] }, kind) === 1;
            attribute.kind = kind;
            for (const key of ['min', 'max', 'initial', 'levels', 'options', 'multi', 'formula', 'growth'] as const)
                delete attribute[key];
            if (kind === 'number') {
                attribute.min = 0;
                attribute.max = 100;
            } else if (kind === 'scale') {
                attribute.levels = ['low', 'medium', 'high'];
                attribute.initial = 'medium';
            } else if (kind === 'list') {
                attribute.options = [];
            }
            if (dropUnfit && attribute.events) {
                attribute.events = attribute.events.filter(fits);
                if (!attribute.events.length) delete attribute.events;
            }
        };

        /** A new kind keeps the events; when some no longer fit, he is asked whether to drop those. */
        const changeKind = (attribute: AttributeDef, kind: AttributeKind): void => {
            const events = attribute.events ?? [];
            const kept = eventsKeptFor(attribute, kind);
            if (!events.length || kept === events.length) {
                resetKind(attribute, kind, false);
                drawEditorAgain();
                return;
            }
            void run(async () => {
                const drop = await app.ui.confirm(
                    t('m25.ctor.kind.title'),
                    t('m25.ctor.kind.body', {
                        name: attribute.name || t('m25.def.attr.new'),
                        count: events.length - kept,
                    }),
                );
                resetKind(attribute, kind, drop);
                drawEditorAgain();
            });
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
            const ctx = engineCtx(def);
            return el(
                'div',
                { class: 'maestro-m25-block maestro-m25-attr', data: { attribute: attribute.id || String(index) } },
                [
                    el('div', { class: 'maestro-m25-row' }, [
                        textInput(
                            attribute.icon ?? '',
                            (value) => {
                                if (value.trim()) attribute.icon = value.trim();
                                else delete attribute.icon;
                            },
                            {
                                label: t('m25.ctor.icon'),
                                placeholder: '❤',
                                className: 'maestro-m25-icon-input maestro-m25-attr-icon',
                            },
                        ),
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
                            onChange: (kind) => changeKind(attribute, kind),
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
                        ...specific,
                        field(
                            t('m25.def.attr.tracking'),
                            trackingSelect(
                                attribute.tracking,
                                (value) => {
                                    if (value) attribute.tracking = value;
                                    else delete attribute.tracking;
                                    drawEditorAgain();
                                },
                                def.tracking,
                            ),
                        ),
                    ]),
                    attribute.kind === 'number' ? numberExtras(ctx, attribute, index) : null,
                    moreBlock(t('m25.ctor.where'), visibilityEditor(ctx, attribute), 'maestro-m25-attr-visibility'),
                    moreBlock(t('m25.ctor.more'), [
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
                    ]),
                    el('div', { class: 'maestro-m25-sub', text: t('m25.def.events') }),
                    ...events.map((event, eventIndex) =>
                        eventRow(def, attribute, event, `attributes.${index}.events.${eventIndex}`),
                    ),
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
                        field(t('m25.def.check.dice'), el('div', {}, [diceInput, verdict]), t('m25.ctor.dice.hint')),
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
                    effectsEditor(engineCtx(def), check, index),
                    moreBlock(t('m25.ctor.more'), [
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
                    ]),
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

        /** What this mechanic gives the model (its rules and one holder's start values), English as sent. */
        const previewText = (def: MechanicDef): string => {
            const normalized = normalizeDef(def);
            if (!normalized) return '';
            const sample = (() => {
                try {
                    return extras.api?.persona?.() || t('m25.ctor.preview.holder');
                } catch {
                    return t('m25.ctor.preview.holder');
                }
            })();
            const english = interimEnglish(normalized);
            const values = initialValues(english);
            return renderRules([{ mechanic: english, holders: [{ name: sample, primary: true, values }] }], {
                budget: 0,
            }).text;
        };

        const previewBlock = (def: MechanicDef): { node: HTMLElement; update: () => void } => {
            const text = el('pre', { class: 'maestro-m25-preview maestro-m25-preview-own' });
            const whole = el('pre', { class: 'maestro-m25-preview maestro-m25-preview-turn' });
            const update = () => {
                text.textContent = previewText(def) || t('m25.ctor.preview.empty');
                const next = (() => {
                    try {
                        return extras.api?.previewPrompt?.() ?? null;
                    } catch {
                        return null;
                    }
                })();
                whole.textContent = next?.text
                    ? `${next.text}${next.facts ? `\n\n${next.facts}` : ''}`
                    : t('m25.ctor.preview.noTurn');
            };
            update();
            const node = moreBlock(
                t('m25.ctor.preview'),
                [
                    el('div', { class: 'maestro-hint', text: t('m25.ctor.preview.hint') }),
                    text,
                    extras.api?.previewPrompt
                        ? moreBlock(t('m25.ctor.preview.turn'), whole, 'maestro-m25-preview-turn-block')
                        : null,
                ],
                'maestro-m25-preview-block',
            );
            return { node, update };
        };

        /** The status of the English for the model: ready, waiting for the background translation, being made now. */
        const translationStatus = (def: MechanicDef): string => {
            if (translating) return t('m25.ctor.translation.running');
            if (!def.summarySource && !def.rulesSource) return '';
            return translationItems(def).length ? t('m25.ctor.translation.pending') : t('m25.ctor.translation.ready');
        };

        const sourceFields = (def: MechanicDef): HTMLElement[] => {
            const status = el('div', { class: 'maestro-muted maestro-m25-translation', text: translationStatus(def) });
            const englishSummary = textArea(
                def.summary,
                (value) => {
                    def.summary = value;
                    // His own English counts as the translation of what he wrote.
                    if (def.summarySource)
                        def.translatedFrom = { ...(def.translatedFrom ?? {}), summary: sourceHash(def.summarySource) };
                    status.textContent = translationStatus(def);
                    refreshIssues();
                },
                t('m25.def.field.summary'),
                2,
                'maestro-m25-summary-en',
            );
            const englishRules = textArea(
                def.rules,
                (value) => {
                    def.rules = value;
                    if (def.rulesSource)
                        def.translatedFrom = { ...(def.translatedFrom ?? {}), rules: sourceHash(def.rulesSource) };
                    status.textContent = translationStatus(def);
                    refreshIssues();
                },
                t('m25.def.field.rules'),
                6,
                'maestro-m25-rules-en',
            );
            const translator = extras.translator;
            const now = translator
                ? button({
                      label: t('m25.ctor.translate'),
                      icon: 'fa-language',
                      kind: 'ghost',
                      className: 'maestro-m25-translate',
                      disabled: !translator.available(),
                      onClick: () =>
                          run(async () => {
                              if (!translationItems(def).length) {
                                  app.ui.notice(t('m25.ctor.translation.nothing'), { urgent: true });
                                  return;
                              }
                              translating = true;
                              status.textContent = translationStatus(def);
                              let result: MechanicDef | null;
                              try {
                                  result = await translator.translateDraft(def);
                              } finally {
                                  translating = false;
                              }
                              if (!result) {
                                  status.textContent = translationStatus(def);
                                  app.ui.notice(t('m25.ctor.translation.failed'), { level: 'warn', urgent: true });
                                  return;
                              }
                              Object.assign(def, result);
                              drawEditorAgain();
                          }),
                  })
                : null;
            return [
                field(
                    t('m25.ctor.summarySource'),
                    textArea(
                        def.summarySource ?? '',
                        (value) => {
                            if (value.trim()) def.summarySource = value;
                            else delete def.summarySource;
                            status.textContent = translationStatus(def);
                            refreshIssues();
                        },
                        t('m25.ctor.summarySource'),
                        2,
                        'maestro-m25-summary-source',
                    ),
                    t('m25.ctor.summarySource.hint'),
                ),
                field(
                    t('m25.ctor.rulesSource'),
                    textArea(
                        def.rulesSource ?? '',
                        (value) => {
                            if (value.trim()) def.rulesSource = value;
                            else delete def.rulesSource;
                            status.textContent = translationStatus(def);
                            refreshIssues();
                        },
                        t('m25.ctor.rulesSource'),
                        6,
                        'maestro-m25-rules-source',
                    ),
                    t('m25.ctor.rulesSource.hint'),
                ),
                el('div', { class: 'maestro-m25-row' }, [status, now]),
            ].concat(
                moreBlock(
                    t('m25.ctor.english'),
                    [
                        el('div', { class: 'maestro-hint', text: t('m25.ctor.english.hint') }),
                        field(t('m25.def.field.summary'), englishSummary),
                        field(t('m25.def.field.rules'), englishRules),
                    ],
                    'maestro-m25-english',
                ),
            );
        };

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
                // Until the background translation, the model reads what he wrote rather than old rules.
                const saved = await defs.save(interimEnglish(normalized));
                app.ui.notice(t('m25.def.saved', { name: saved.name }));
                if (extras.translator && translationItems(saved).length) {
                    const queued = await extras.translator.enqueue(saved.id);
                    const key = queued
                        ? 'm25.ctor.translation.queued'
                        : extras.translator.available()
                          ? 'm25.ctor.translation.later'
                          : 'm25.ctor.translation.noModel';
                    app.ui.notice(t(key), { importance: 'info' });
                }
                draft = null;
                mode = 'list';
                draw();
            });

        /** A section of the editor that opens when it is set up (statuses, inventory, levels, time, fights). */
        const part = (title: string, content: HTMLElement, open: boolean, className: string): HTMLElement =>
            moreBlock(title, content, `maestro-m25-part ${className}`, open);

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
            const preview = previewBlock(def);
            refreshIssues = () => {
                const normalized = normalizeDef(def);
                clear(issuesHost);
                for (const item of issueList(normalized ? validateDef(normalized) : [])) issuesHost.appendChild(item);
                preview.update();
            };
            refreshIssues();
            const ctx = engineCtx(def);
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
                ...sourceFields(def),
                scopeField(def),
                holdersField(def),
                field(
                    t('m25.def.field.tracking'),
                    trackingSelect(def.tracking, (value) => {
                        def.tracking = value ?? 'background';
                        drawEditorAgain();
                    }),
                    t('m25.def.tracking.hint'),
                ),
                el('div', { class: 'maestro-m25-sub', text: t('m25.ctor.where') }),
                visibilityEditor(ctx),
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
                part(
                    t('m25.ctor.part.statuses'),
                    statusesEditor(ctx),
                    def.statuses !== undefined,
                    'maestro-m25-part-statuses',
                ),
                part(
                    t('m25.ctor.part.inventory'),
                    inventoryEditor(ctx),
                    def.inventory !== undefined,
                    'maestro-m25-part-inventory',
                ),
                part(
                    t('m25.ctor.part.progression'),
                    progressionEditor(ctx),
                    !!def.progression,
                    'maestro-m25-part-progression',
                ),
                part(t('m25.ctor.part.time'), timeEditor(ctx), !!def.time?.length, 'maestro-m25-part-time'),
                part(t('m25.ctor.part.combat'), combatEditor(ctx), !!def.combat, 'maestro-m25-part-combat'),
                desBlock(def),
                preview.node,
                moreBlock(t('m25.ctor.more'), [
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
                ]),
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

        /** Keys of the «Подробнее» blocks: their summary and how many came before with the same one. */
        const detailsKeys = (): { node: HTMLDetailsElement; key: string }[] => {
            const seen = new Map<string, number>();
            return [...root.querySelectorAll<HTMLDetailsElement>('details')].map((node) => {
                const summary = node.querySelector(':scope > summary')?.textContent ?? '';
                const count = seen.get(summary) ?? 0;
                seen.set(summary, count + 1);
                return { node, key: `${summary}#${count}` };
            });
        };

        function draw(): void {
            if (!alive) return;
            // Open «Подробнее» blocks stay open across a redraw of the editor.
            const open = new Set(
                detailsKeys()
                    .filter((item) => item.node.open)
                    .map((item) => item.key),
            );
            clear(root);
            refreshIssues = () => {};
            if (mode === 'edit' && draft) root.appendChild(drawEditor(draft));
            else if (mode === 'templates') root.appendChild(drawTemplates());
            else if (mode === 'describe') root.appendChild(drawDescribe());
            else {
                mode = 'list';
                root.appendChild(drawList());
            }
            if (mode === 'edit') {
                for (const { node, key } of detailsKeys()) if (open.has(key)) node.setAttribute('open', '');
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

function normalizeHoldersOf(kind: HolderSpec['kind'], names: string[]): HolderSpec {
    switch (kind) {
        case 'persona':
        case 'world':
            return { kind };
        case 'named':
        case 'factions':
            return { kind, names };
        default:
            return { kind: 'characters', includePersona: true };
    }
}
