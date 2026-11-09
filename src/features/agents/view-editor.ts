// The agent card (plan §3.2): one editor with the tabs Поручение · Что видит · Когда · Результат · Модель · Область ·
// Проверка. It edits a copy; «Сохранить» writes it (journal, undo), «Пробный запуск» runs the copy and applies nothing.
import { blankAgent, defaultPhaseFor, defaultResult, FLAG_NAME_RE } from '../../domain/agents/def';
import { missingVars } from '../../domain/agents/request';
import { AGENT_EVENTS, AGENT_PHASES, AGENT_RESULT_TYPES } from '../../domain/agents/types';
import type {
    AgentDef,
    AgentEvent,
    AgentPhase,
    AgentResultType,
    AgentScope,
    InjectOptions,
    MaestroMode,
} from '../../domain/agents/types';
import { button, clear, el, icon } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { banner, section } from '../../ui/components/card';
import { proposalReceivers } from '../../core/proposal-receivers';
import { DEFAULT_GATE_QUESTION } from './gate';
import { tabs } from '../../ui/components/tabs';
import type { AgentsView } from './view';
import { describeOutput } from './view';

type Draft = AgentDef;

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function listText(value: readonly string[] | undefined): string {
    return (value ?? []).join(', ');
}

function parseList(text: string): string[] {
    return text
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function textArea(
    value: string,
    rows: number,
    onInput: (value: string) => void,
    placeholder?: string,
): HTMLTextAreaElement {
    const node = el('textarea', { class: 'text_pole maestro-agent-textarea', attrs: { rows, placeholder } });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

function textInput(value: string, onInput: (value: string) => void, placeholder?: string): HTMLInputElement {
    const node = el('input', { class: 'text_pole', attrs: { type: 'text', placeholder } });
    node.value = value;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

/** Connection Manager profiles (id, name). */
export function connectionProfiles(view: AgentsView): { id: string; name: string }[] {
    try {
        const ext = view.app.host.ctx().extensionSettings as unknown as { connectionManager?: { profiles?: unknown } };
        const list = Array.isArray(ext?.connectionManager?.profiles)
            ? (ext.connectionManager.profiles as Record<string, unknown>[])
            : [];
        return list
            .filter((profile) => typeof profile.id === 'string')
            .map((profile) => ({
                id: String(profile.id),
                name: typeof profile.name === 'string' ? profile.name : String(profile.id),
            }));
    } catch {
        return [];
    }
}

export class AgentEditor {
    private draft: Draft;
    private dirty = false;
    private tab = 'instruction';
    private body: HTMLElement | null = null;
    private readonly isNew: boolean;

    constructor(
        private readonly view: AgentsView,
        def: AgentDef | null,
        private readonly onClose: () => void,
    ) {
        this.isNew = def === null;
        this.draft = def ? copy(def) : blankAgent(view.t('m44.newName'), Date.now());
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.view.t(key, params);
    }

    private touch(): void {
        this.dirty = true;
    }

    canLeave(): boolean {
        return !this.dirty || globalThis.confirm?.(this.t('m44.editor.unsaved')) !== false;
    }

    render(container: HTMLElement): void {
        clear(container);
        const head = el('div', { class: 'maestro-agent-editor-head' }, [
            button({
                icon: 'fa-arrow-left',
                label: this.t('m44.editor.back'),
                kind: 'ghost',
                onClick: () => {
                    if (this.canLeave()) this.onClose();
                },
            }),
            el('strong', { text: this.isNew ? this.t('m44.editor.newTitle') : this.draft.name }),
            el('span', { class: 'maestro-agent-editor-spacer' }),
            button({
                icon: 'fa-floppy-disk',
                label: this.t('m44.editor.save'),
                kind: 'primary',
                onClick: () => this.save(),
            }),
        ]);
        const items = [
            ['instruction', 'm44.editor.tab.instruction', 'fa-pen'],
            ['sources', 'm44.editor.tab.sources', 'fa-eye'],
            ['trigger', 'm44.editor.tab.trigger', 'fa-clock'],
            ['result', 'm44.editor.tab.result', 'fa-share'],
            ['model', 'm44.editor.tab.model', 'fa-microchip'],
            ['scope', 'm44.editor.tab.scope', 'fa-layer-group'],
            ['check', 'm44.editor.tab.check', 'fa-vial'],
        ].map(([id, key, iconName]) => ({ id: id as string, label: this.t(key as string), icon: iconName }));
        const handle = tabs({
            items,
            active: this.tab,
            label: this.t('m44.editor.tabs'),
            onSelect: (id) => {
                this.tab = id;
                this.paint();
            },
        });
        this.body = el('div', { class: 'maestro-agent-editor-body' });
        container.append(
            head,
            el('div', { class: 'maestro-agent-editor' }, [
                el('div', { class: 'maestro-agent-editor-tabs' }, [handle.list, handle.picker]),
                this.body,
            ]),
        );
        this.paint();
    }

    private paint(): void {
        const body = this.body;
        if (!body) return;
        clear(body);
        const parts: Child[] = (() => {
            switch (this.tab) {
                case 'sources':
                    return this.sourcesTab();
                case 'trigger':
                    return this.triggerTab();
                case 'result':
                    return this.resultTab();
                case 'model':
                    return this.modelTab();
                case 'scope':
                    return this.scopeTab();
                case 'check':
                    return this.checkTab();
                default:
                    return this.instructionTab();
            }
        })();
        for (const part of parts) if (part) body.append(part as Node);
    }

    private async save(): Promise<void> {
        const d = this.draft;
        if (!d.name.trim()) {
            this.view.app.ui.notice(this.t('m44.editor.noName'), { level: 'warn', urgent: true });
            return;
        }
        await this.view.store.save(
            d,
            this.t(this.isNew ? 'm44.journal.created' : 'm44.journal.changed', { name: d.name }),
        );
        if (this.isNew) await this.view.store.setAgentState('chat', d.id, { on: true });
        this.dirty = false;
        this.view.app.ui.notice(this.t('m44.editor.saved', { name: d.name }), { urgent: true });
        this.onClose();
    }

    /* ------------------------------------------------------------ Поручение */

    private instructionTab(): Child[] {
        const d = this.draft;
        const missing = missingVars(d.instruction, d.vars);
        const vars = el('div', { class: 'maestro-agent-vars' });
        const paintVars = () => {
            clear(vars);
            for (const [name, value] of Object.entries(d.vars ?? {})) {
                vars.append(
                    el('div', { class: 'maestro-agent-var' }, [
                        el('code', { text: `{{agent.${name}}}` }),
                        textArea(value, 2, (text) => {
                            d.vars = { ...(d.vars ?? {}), [name]: text };
                            this.touch();
                        }),
                        button({
                            icon: 'fa-xmark',
                            kind: 'ghost',
                            title: this.t('m44.editor.remove'),
                            onClick: () => {
                                const next = { ...(d.vars ?? {}) };
                                delete next[name];
                                d.vars = Object.keys(next).length ? next : undefined;
                                this.touch();
                                paintVars();
                            },
                        }),
                    ]),
                );
            }
            vars.append(
                button({
                    icon: 'fa-plus',
                    label: this.t('m44.editor.addVar'),
                    onClick: async () => {
                        const name = await this.view.app.ui.prompt?.(this.t('m44.editor.varName'), {
                            hint: this.t('m44.editor.varHint'),
                        });
                        if (!name || !/^[a-zA-Zа-яА-ЯёЁ_][\wа-яА-ЯёЁ]{0,31}$/.test(name.trim())) return;
                        d.vars = { ...(d.vars ?? {}), [name.trim()]: '' };
                        this.touch();
                        paintVars();
                    },
                }),
            );
        };
        paintVars();
        const variants = el('div', { class: 'maestro-agent-variants' });
        const paintVariants = () => {
            clear(variants);
            for (const variant of d.variants ?? []) {
                variants.append(
                    el('div', { class: 'maestro-agent-variant' }, [
                        textInput(variant.name, (text) => {
                            variant.name = text;
                            this.touch();
                        }),
                        textArea(variant.instruction, 4, (text) => {
                            variant.instruction = text;
                            this.touch();
                        }),
                        button({
                            icon: 'fa-xmark',
                            kind: 'ghost',
                            title: this.t('m44.editor.remove'),
                            onClick: () => {
                                d.variants = (d.variants ?? []).filter((item) => item !== variant);
                                if (!d.variants.length) delete d.variants;
                                this.touch();
                                paintVariants();
                            },
                        }),
                    ]),
                );
            }
            variants.append(
                button({
                    icon: 'fa-plus',
                    label: this.t('m44.editor.addVariant'),
                    onClick: () => {
                        const list = d.variants ?? [];
                        list.push({
                            id: `v${Date.now().toString(36)}`,
                            name: this.t('m44.editor.variantName', { n: list.length + 2 }),
                            instruction: d.instruction,
                        });
                        d.variants = list;
                        this.touch();
                        paintVariants();
                    },
                }),
            );
        };
        paintVariants();
        return [
            field(
                this.t('m44.editor.name'),
                textInput(d.name, (text) => {
                    d.name = text;
                    this.touch();
                }),
            ),
            field(
                this.t('m44.editor.description'),
                textInput(
                    d.description ?? '',
                    (text) => {
                        d.description = text || undefined;
                        this.touch();
                    },
                    this.t('m44.editor.descriptionHint'),
                ),
            ),
            section(this.t('m44.editor.instruction'), [
                el('div', { class: 'maestro-hint', text: this.t('m44.editor.instructionHint') }),
                textArea(
                    d.instruction,
                    12,
                    (text) => {
                        d.instruction = text;
                        this.touch();
                    },
                    this.t('m44.editor.instructionPlaceholder'),
                ),
                missing.length ? banner(this.t('m44.editor.missingVars', { names: missing.join(', ') })) : null,
            ]),
            section(this.t('m44.editor.vars'), [
                el('div', { class: 'maestro-hint', text: this.t('m44.editor.varsHint') }),
                vars,
            ]),
            section(this.t('m44.editor.variants'), [
                el('div', { class: 'maestro-hint', text: this.t('m44.editor.variantsHint') }),
                variants,
            ]),
        ];
    }

    /* ------------------------------------------------------------ Что видит */

    private sourcesTab(): Child[] {
        const d = this.draft;
        const rows = this.view.sources.list(this.view.app).map((source) => {
            const ref = d.sources.find((item) => item.id === source.id);
            const budget = numberInput({
                value: ref?.budget ?? source.budget,
                min: 1,
                max: source.id === 'messages' ? 60 : 50_000,
                step: source.id === 'messages' ? 1 : 100,
                label: this.t('m44.editor.budget'),
                disabled: !ref,
                onChange: (value) => {
                    const item = d.sources.find((entry) => entry.id === source.id);
                    if (item) item.budget = value;
                    this.touch();
                },
            });
            return el('div', { class: 'maestro-agent-source' }, [
                toggle({
                    label: this.t(source.labelKey),
                    checked: Boolean(ref),
                    onChange: (on) => {
                        if (on && !d.sources.some((item) => item.id === source.id)) d.sources.push({ id: source.id });
                        if (!on) d.sources = d.sources.filter((item) => item.id !== source.id);
                        budget.disabled = !on;
                        this.touch();
                    },
                }),
                el('span', {
                    class: 'maestro-muted',
                    text:
                        source.id === 'messages'
                            ? this.t('m44.editor.budgetMessages')
                            : this.t('m44.editor.budgetChars'),
                }),
                budget,
            ]);
        });
        const out = el('pre', { class: 'maestro-agent-preview' });
        return [
            el('div', { class: 'maestro-hint', text: this.t('m44.editor.sourcesHint') }),
            ...rows,
            el('div', { class: 'maestro-actions' }, [
                button({
                    icon: 'fa-magnifying-glass',
                    label: this.t('m44.editor.preview'),
                    onClick: () => this.preview(out),
                }),
            ]),
            out,
        ];
    }

    private async preview(out: HTMLElement): Promise<void> {
        const preview = await this.view.runner.preview(this.draft, undefined, this.view.focusIndex());
        clear(out);
        const head = this.t('m44.editor.previewHead', {
            tokens: preview.tokens,
            chars: preview.chars,
            sources: preview.sources.map((source) => `${source.id} ${source.chars}`).join(', ') || '—',
        });
        out.textContent = `${head}\n\n${preview.messages.map((message) => `── ${message.role} ──\n${message.content}`).join('\n\n')}`;
    }

    /* ------------------------------------------------------------ Когда */

    private triggerTab(): Child[] {
        const d = this.draft;
        const trigger = d.trigger;
        const when = trigger.when ?? {};
        const commitWhen = () => {
            const clean = Object.fromEntries(
                Object.entries(when).filter(([, value]) =>
                    Array.isArray(value) ? value.length : value !== undefined && value !== false,
                ),
            );
            trigger.when = Object.keys(clean).length ? clean : undefined;
            this.touch();
        };
        const phaseSelect = select<AgentPhase>({
            value: trigger.phase,
            options: AGENT_PHASES.map((phase) => ({ value: phase, label: this.t(`m44.phase.${phase}`) })),
            label: this.t('m44.editor.phase'),
            onChange: (phase) => {
                trigger.phase = phase;
                this.touch();
                this.paint();
            },
        });
        const parts: Child[] = [
            field(this.t('m44.editor.phase'), phaseSelect, this.t(`m44.phase.${trigger.phase}.hint`)),
        ];
        if (trigger.phase === 'schedule') {
            parts.push(
                field(
                    this.t('m44.editor.every'),
                    numberInput({
                        value: trigger.everyMessages ?? 0,
                        min: 0,
                        max: 1000,
                        step: 1,
                        onChange: (value) => {
                            trigger.everyMessages = value || undefined;
                            this.touch();
                        },
                    }),
                    this.t('m44.editor.everyHint'),
                ),
                section(
                    this.t('m44.editor.events'),
                    AGENT_EVENTS.map((event: AgentEvent) =>
                        toggle({
                            label: this.t(`m44.event.${event}`),
                            checked: trigger.events?.includes(event) ?? false,
                            onChange: (on) => {
                                const set = new Set(trigger.events ?? []);
                                if (on) set.add(event);
                                else set.delete(event);
                                trigger.events = set.size ? [...set] : undefined;
                                this.touch();
                            },
                        }),
                    ),
                ),
            );
            if (trigger.events?.includes('break'))
                parts.push(
                    field(
                        this.t('m44.editor.breakHours'),
                        numberInput({
                            value: trigger.breakHours ?? 12,
                            min: 1,
                            max: 720,
                            onChange: (value) => {
                                trigger.breakHours = value;
                                this.touch();
                            },
                        }),
                    ),
                );
        }
        if (trigger.phase === 'onSend') {
            parts.push(
                banner(this.t('m44.editor.onSendWarn'), 'warn'),
                field(
                    this.t('m44.editor.timeout'),
                    numberInput({
                        value: Math.round((trigger.onSendTimeoutMs ?? 6000) / 1000),
                        min: 1,
                        max: 30,
                        onChange: (value) => {
                            trigger.onSendTimeoutMs = value * 1000;
                            this.touch();
                        },
                    }),
                ),
            );
        }
        parts.push(
            field(
                this.t('m44.editor.priority'),
                numberInput({
                    value: trigger.priority ?? 0,
                    min: -100,
                    max: 100,
                    step: 1,
                    onChange: (value) => {
                        trigger.priority = value || undefined;
                        this.touch();
                    },
                }),
                this.t('m44.editor.priorityHint'),
            ),
            section(this.t('m44.editor.gate'), [
                toggle({
                    label: this.t('m44.editor.gateOn'),
                    hint: this.t('m44.editor.gateHint'),
                    checked: Boolean(d.gate),
                    onChange: (on) => {
                        d.gate = on ? (d.gate ?? {}) : undefined;
                        this.touch();
                        this.paint();
                    },
                }),
                d.gate
                    ? field(
                          this.t('m44.editor.gateQuestion'),
                          textInput(
                              d.gate.question ?? '',
                              (text) => {
                                  d.gate = text.trim() ? { question: text } : {};
                                  this.touch();
                              },
                              DEFAULT_GATE_QUESTION,
                          ),
                          this.t('m44.editor.gateQuestionHint'),
                      )
                    : null,
            ]),
            section(this.t('m44.editor.conditions'), [
                el('div', { class: 'maestro-hint', text: this.t('m44.editor.conditionsHint') }),
                field(
                    this.t('m44.editor.words'),
                    textInput(
                        listText(when.words),
                        (text) => {
                            when.words = parseList(text);
                            commitWhen();
                        },
                        this.t('m44.editor.wordsHint'),
                    ),
                ),
                field(
                    this.t('m44.editor.scanDepth'),
                    numberInput({
                        value: when.scanDepth ?? 2,
                        min: 1,
                        max: 50,
                        step: 1,
                        onChange: (value) => {
                            when.scanDepth = value;
                            commitWhen();
                        },
                    }),
                ),
                field(
                    this.t('m44.editor.scenes'),
                    textInput(
                        listText(when.scenes),
                        (text) => {
                            when.scenes = parseList(text);
                            commitWhen();
                        },
                        this.t('m44.editor.scenesHint'),
                    ),
                ),
                el(
                    'div',
                    { class: 'maestro-row' },
                    (['economy', 'balanced', 'cinema'] as MaestroMode[]).map((mode) =>
                        toggle({
                            label: this.t(`m44.mode.${mode}`),
                            checked: !when.modes?.length || when.modes.includes(mode),
                            onChange: (on) => {
                                const set = new Set(
                                    when.modes?.length
                                        ? when.modes
                                        : (['economy', 'balanced', 'cinema'] as MaestroMode[]),
                                );
                                if (on) set.add(mode);
                                else set.delete(mode);
                                when.modes = set.size === 3 ? [] : [...set];
                                commitWhen();
                            },
                        }),
                    ),
                ),
                field(
                    this.t('m44.editor.requires'),
                    textInput(
                        listText(when.requires),
                        (text) => {
                            when.requires = parseList(text);
                            commitWhen();
                        },
                        this.t('m44.editor.requiresHint'),
                    ),
                ),
                toggle({
                    label: this.t('m44.editor.stalled'),
                    checked: when.stalled === true,
                    onChange: (on) => {
                        when.stalled = on || undefined;
                        commitWhen();
                    },
                }),
            ]),
        );
        return parts;
    }

    /* ------------------------------------------------------------ Результат */

    private resultTab(): Child[] {
        const d = this.draft;
        const typeSelect = select<AgentResultType>({
            value: d.result.type,
            options: AGENT_RESULT_TYPES.map((type) => ({ value: type, label: this.t(`m44.type.${type}`) })),
            label: this.t('m44.editor.type'),
            onChange: (type) => {
                d.result = defaultResult(type);
                if (type === 'rewrite' || type === 'verdict') d.trigger.phase = 'post';
                else if (d.trigger.phase === 'post' && (type === 'inject' || type === 'flags'))
                    d.trigger.phase = defaultPhaseFor(type);
                this.touch();
                this.paint();
            },
        });
        const parts: Child[] = [field(this.t('m44.editor.type'), typeSelect, this.t(`m44.type.${d.result.type}.hint`))];
        const result = d.result;
        const injectFields = (options: InjectOptions): Child[] => [
            field(
                this.t('m44.editor.position'),
                select({
                    value: options.position,
                    options: (['top', 'afterMain', 'depth'] as const).map((value) => ({
                        value,
                        label: this.t(`m44.position.${value}`),
                    })),
                    onChange: (value) => {
                        options.position = value;
                        this.touch();
                        this.paint();
                    },
                }),
            ),
            options.position === 'depth'
                ? field(
                      this.t('m44.editor.depth'),
                      numberInput({
                          value: options.depth,
                          min: 0,
                          max: 100,
                          step: 1,
                          onChange: (value) => {
                              options.depth = value;
                              this.touch();
                          },
                      }),
                  )
                : null,
            field(
                this.t('m44.editor.role'),
                select({
                    value: options.role,
                    options: (['system', 'user', 'assistant'] as const).map((value) => ({
                        value,
                        label: this.t(`m44.role.${value}`),
                    })),
                    onChange: (value) => {
                        options.role = value;
                        this.touch();
                    },
                }),
            ),
            field(
                this.t('m44.editor.lifetime'),
                select({
                    value: options.lifetime,
                    options: (['turn', 'untilNext'] as const).map((value) => ({
                        value,
                        label: this.t(`m44.lifetime.${value}`),
                    })),
                    onChange: (value) => {
                        options.lifetime = value;
                        this.touch();
                    },
                }),
            ),
            el('div', {
                class: 'maestro-hint',
                text: this.t('m44.editor.getvarHint', {
                    name: `maestro_agent_${d.id
                        .replace(/^u-/, '')
                        .replace(/-[a-z0-9]{5}$/, '')
                        .replace(/-/g, '_')}`,
                }),
            }),
        ];
        switch (result.type) {
            case 'inject':
                parts.push(...injectFields(result.options));
                break;
            case 'flags':
                parts.push(
                    field(
                        this.t('m44.editor.flagNames'),
                        textInput(listText(result.options.names), (text) => {
                            result.options.names = parseList(text).filter((name) => FLAG_NAME_RE.test(name));
                            this.touch();
                        }),
                        this.t('m44.editor.flagNamesHint'),
                    ),
                );
                break;
            case 'rewrite':
                parts.push(
                    toggle({
                        label: this.t('m44.editor.holdReply'),
                        hint: this.t('m44.editor.holdReplyHint'),
                        checked: result.options.holdReply,
                        onChange: (on) => {
                            result.options.holdReply = on;
                            this.touch();
                        },
                    }),
                    el('div', { class: 'maestro-hint', text: this.t('m44.editor.rewriteHint') }),
                );
                break;
            case 'verdict':
                parts.push(
                    field(
                        this.t('m44.editor.verdictAction'),
                        select({
                            value: result.options.action,
                            options: (['mark', 'offerRedo', 'swipe', 'continue'] as const).map((value) => ({
                                value,
                                label: this.t(`m44.verdict.${value}`),
                            })),
                            onChange: (value) => {
                                result.options.action = value;
                                this.touch();
                            },
                        }),
                    ),
                );
                break;
            case 'note':
                parts.push(
                    field(
                        this.t('m44.editor.noteShow'),
                        select({
                            value: result.options.show,
                            options: (['strip', 'toast'] as const).map((value) => ({
                                value,
                                label: this.t(`m44.noteShow.${value}`),
                            })),
                            onChange: (value) => {
                                result.options.show = value;
                                this.touch();
                            },
                        }),
                    ),
                );
                break;
            case 'choices':
                parts.push(
                    field(
                        this.t('m44.editor.choiceCount'),
                        numberInput({
                            value: result.options.count,
                            min: 2,
                            max: 5,
                            step: 1,
                            onChange: (value) => {
                                result.options.count = value;
                                this.touch();
                            },
                        }),
                    ),
                    toggle({
                        label: this.t('m44.editor.choiceSend'),
                        checked: result.options.send,
                        onChange: (on) => {
                            result.options.send = on;
                            this.touch();
                        },
                    }),
                );
                break;
            case 'proposals': {
                const receivers = proposalReceivers();
                parts.push(
                    section(
                        this.t('m44.editor.receivers'),
                        receivers.length
                            ? receivers.map((receiver) =>
                                  toggle({
                                      label: this.t(receiver.labelKey),
                                      checked: result.options.receivers.includes(receiver.kind),
                                      onChange: (on) => {
                                          const set = new Set(result.options.receivers);
                                          if (on) set.add(receiver.kind);
                                          else set.delete(receiver.kind);
                                          result.options.receivers = [...set];
                                          this.touch();
                                      },
                                  }),
                              )
                            : [el('div', { class: 'maestro-muted', text: this.t('m44.editor.noReceivers') })],
                    ),
                    field(
                        this.t('m44.editor.proposalsMax'),
                        numberInput({
                            value: result.options.max,
                            min: 1,
                            max: 20,
                            step: 1,
                            onChange: (value) => {
                                result.options.max = value;
                                this.touch();
                            },
                        }),
                    ),
                    el('div', { class: 'maestro-hint', text: this.t('m44.editor.proposalsHint') }),
                );
                break;
            }
            case 'memory': {
                const list = el('div', { class: 'maestro-agent-fields' });
                const paint = () => {
                    clear(list);
                    for (const memoryField of result.options.fields) {
                        list.append(
                            el('div', { class: 'maestro-agent-var' }, [
                                textInput(
                                    memoryField.name,
                                    (text) => {
                                        memoryField.name = text.trim();
                                        this.touch();
                                    },
                                    this.t('m44.editor.fieldName'),
                                ),
                                textInput(
                                    memoryField.hint ?? '',
                                    (text) => {
                                        memoryField.hint = text || undefined;
                                        this.touch();
                                    },
                                    this.t('m44.editor.fieldHint'),
                                ),
                                button({
                                    icon: 'fa-xmark',
                                    kind: 'ghost',
                                    title: this.t('m44.editor.remove'),
                                    onClick: () => {
                                        result.options.fields = result.options.fields.filter(
                                            (item) => item !== memoryField,
                                        );
                                        this.touch();
                                        paint();
                                    },
                                }),
                            ]),
                        );
                    }
                    list.append(
                        button({
                            icon: 'fa-plus',
                            label: this.t('m44.editor.addField'),
                            onClick: () => {
                                result.options.fields.push({
                                    name: this.t('m44.editor.fieldDefault', { n: result.options.fields.length + 1 }),
                                });
                                this.touch();
                                paint();
                            },
                        }),
                    );
                };
                paint();
                parts.push(
                    section(this.t('m44.editor.fields'), list),
                    toggle({
                        label: this.t('m44.editor.memoryInject'),
                        checked: result.options.inject,
                        onChange: (on) => {
                            result.options.inject = on;
                            this.touch();
                            this.paint();
                        },
                    }),
                    ...(result.options.inject ? injectFields(result.options.injectOptions) : []),
                );
                if (!d.sources.some((source) => source.id === 'ownMemory'))
                    parts.push(banner(this.t('m44.editor.memoryNoSource'), 'info', 'fa-circle-info'));
                break;
            }
        }
        return parts;
    }

    /* ------------------------------------------------------------ Модель */

    private modelTab(): Child[] {
        const d = this.draft;
        const profiles = connectionProfiles(this.view);
        return [
            toggle({
                label: this.t('m44.editor.batch'),
                hint: this.t('m44.editor.batchHint'),
                checked: d.batch === true,
                disabled: d.result.type === 'rewrite',
                onChange: (on) => {
                    d.batch = on || undefined;
                    this.touch();
                },
            }),
            el('div', {
                class: 'maestro-hint',
                text: this.t(d.result.type === 'rewrite' ? 'm44.editor.batchRewrite' : 'm44.editor.batchHint'),
            }),
            field(
                this.t('m44.editor.profile'),
                select({
                    value: d.model.profile ?? '',
                    options: [
                        { value: '', label: this.t('m44.editor.profileDefault') },
                        ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                    ],
                    onChange: (value) => {
                        d.model.profile = value || undefined;
                        this.touch();
                    },
                }),
                this.t('m44.editor.profileHint'),
            ),
            field(
                this.t('m44.editor.temperature'),
                numberInput({
                    value: d.model.temperature ?? 0.7,
                    min: 0,
                    max: 2,
                    step: 0.05,
                    onChange: (value) => {
                        d.model.temperature = value;
                        this.touch();
                    },
                }),
            ),
            field(
                this.t('m44.editor.maxTokens'),
                numberInput({
                    value: d.model.maxTokens ?? (d.result.type === 'rewrite' ? 2500 : 800),
                    min: 50,
                    max: 16_000,
                    step: 50,
                    onChange: (value) => {
                        d.model.maxTokens = value;
                        this.touch();
                    },
                }),
            ),
            field(
                this.t('m44.editor.reasoning'),
                select({
                    value: d.model.reasoning ?? 'off',
                    options: (['off', 'low', 'medium', 'high'] as const).map((value) => ({
                        value,
                        label: this.t(`m44.reasoning.${value}`),
                    })),
                    onChange: (value) => {
                        d.model.reasoning = value;
                        this.touch();
                    },
                }),
                this.t('m44.editor.reasoningHint'),
            ),
            section(this.t('m44.editor.limits'), [
                field(
                    this.t('m44.editor.perTurn'),
                    numberInput({
                        value: d.limits?.perTurn ?? 0,
                        min: 0,
                        max: 20,
                        step: 1,
                        onChange: (value) => {
                            d.limits = { ...(d.limits ?? {}), perTurn: value || undefined };
                            this.touch();
                        },
                    }),
                    this.t('m44.editor.zeroNoLimit'),
                ),
                field(
                    this.t('m44.editor.dailyUsd'),
                    numberInput({
                        value: d.limits?.dailyUsd ?? 0,
                        min: 0,
                        max: 1000,
                        step: 0.05,
                        onChange: (value) => {
                            d.limits = { ...(d.limits ?? {}), dailyUsd: value || undefined };
                            this.touch();
                        },
                    }),
                    this.t('m44.editor.zeroNoLimit'),
                ),
            ]),
        ];
    }

    /* ------------------------------------------------------------ Область */

    private scopeTab(): Child[] {
        const d = this.draft;
        const store = this.view.store;
        const context = store.context();
        const rows: Child[] = [el('div', { class: 'maestro-hint', text: this.t('m44.editor.scopeHint') })];
        if (this.isNew) rows.push(banner(this.t('m44.editor.scopeNew'), 'info', 'fa-circle-info'));
        for (const scope of ['global', 'character', 'chat'] as AgentScope[]) {
            const state = store.scopeState(scope, context);
            const owner = scope === 'character' ? context.characterName : scope === 'chat' ? context.chatId : 'all';
            if (!owner) continue;
            const override = state?.overrides[d.id];
            const value: 'inherit' | 'on' | 'off' = override?.on === undefined ? 'inherit' : override.on ? 'on' : 'off';
            const label =
                scope === 'character'
                    ? this.t('m44.scope.characterNamed', { name: context.characterName ?? '' })
                    : this.t(`m44.scope.${scope}`);
            const variantSelect = d.variants?.length
                ? select({
                      value: override?.variant ?? '',
                      options: [
                          { value: '', label: this.t('m44.editor.mainText') },
                          ...d.variants.map((variant) => ({ value: variant.id, label: variant.name })),
                      ],
                      onChange: async (variant) => {
                          await store.setAgentState(scope, d.id, { variant: variant || undefined });
                      },
                  })
                : null;
            rows.push(
                field(
                    label,
                    el('div', { class: 'maestro-row' }, [
                        select({
                            value,
                            options: [
                                { value: 'inherit', label: this.t('m44.editor.inherit') },
                                { value: 'on', label: this.t('m44.editor.on') },
                                { value: 'off', label: this.t('m44.editor.off') },
                            ],
                            disabled: this.isNew,
                            onChange: async (next) => {
                                if (next === 'inherit')
                                    await store.setAgentState(scope, d.id, { on: undefined } as never);
                                else await store.setAgentState(scope, d.id, { on: next === 'on' });
                            },
                        }),
                        variantSelect,
                    ]),
                ),
            );
        }
        if (!this.isNew && context.avatar) {
            rows.push(
                el('div', { class: 'maestro-actions' }, [
                    button({
                        icon: 'fa-id-card',
                        label: this.t('m44.editor.toCard'),
                        onClick: () => this.view.putIntoCard([d.id]),
                    }),
                ]),
                el('div', { class: 'maestro-hint', text: this.t('m44.editor.toCardHint') }),
            );
        }
        return rows;
    }

    /* ------------------------------------------------------------ Проверка */

    private checkTab(): Child[] {
        const out = el('div', { class: 'maestro-agent-test' });
        const pre = el('pre', { class: 'maestro-agent-preview' });
        return [
            el('div', { class: 'maestro-hint', text: this.t('m44.editor.checkHint') }),
            el('div', { class: 'maestro-actions' }, [
                button({
                    icon: 'fa-magnifying-glass',
                    label: this.t('m44.editor.preview'),
                    onClick: () => this.preview(pre),
                }),
                button({
                    icon: 'fa-flask',
                    label: this.t('m44.editor.test'),
                    kind: 'primary',
                    onClick: async () => {
                        const preview = await this.view.runner.preview(this.draft, undefined, this.view.focusIndex());
                        const ok = await this.view.app.ui.confirm(
                            this.t('m44.editor.testConfirm'),
                            this.t('m44.editor.testConfirmBody', { tokens: preview.tokens }),
                        );
                        if (!ok) return;
                        clear(out);
                        out.append(el('div', { class: 'maestro-muted', text: this.t('m44.editor.testing') }));
                        const outcome = await this.view.runtime.test(this.draft, this.view.focusIndex());
                        clear(out);
                        if (!outcome.run.ok) {
                            out.append(
                                banner(
                                    this.t('m44.editor.testFailed', {
                                        reason: this.t(`m44.error.${outcome.run.error ?? 'other'}`),
                                    }),
                                    'error',
                                ),
                            );
                            if (outcome.run.raw)
                                out.append(el('pre', { class: 'maestro-agent-preview', text: outcome.run.raw }));
                            return;
                        }
                        out.append(
                            el('div', { class: 'maestro-agent-would' }, [
                                icon('fa-wand-magic-sparkles'),
                                el('span', { text: describeOutput(this.view, this.draft, outcome) }),
                            ]),
                        );
                        if (outcome.output?.type === 'rewrite' && outcome.protectedReply) {
                            out.append(this.view.rewriteDiff(outcome.protectedReply.text, outcome.output.editedText));
                        }
                        out.append(
                            el('div', {
                                class: 'maestro-muted',
                                text: this.t('m44.editor.testCost', {
                                    tokens: (outcome.run.tokens?.prompt ?? 0) + (outcome.run.tokens?.completion ?? 0),
                                    cost: (outcome.run.costUsd ?? 0).toFixed(4),
                                }),
                            }),
                        );
                    },
                }),
            ]),
            out,
            pre,
        ];
    }
}
