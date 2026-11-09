// Built-in agents in the «Агенты» window (plan §2, §3.2, release 1.29): Maestro's own model tasks with their switch,
// their instruction (default / «Дополнительные указания» / the whole text, plan В2), the model and profile, the module
// settings that tune them («ручки») and their last request. What a module collects and how it applies the answer stay
// in code and are only described.
import { builtInAgents } from '../../core/builtin-agents';
import type { BuiltInAgentSpec, BuiltInGroup, BuiltInKnob } from '../../core/builtin-agents';
import { defaultChanged, textHash } from '../../domain/agents/builtin';
import type { BuiltInOverride, InstructionMode } from '../../domain/agents/builtin';
import type { App } from '../../shared/contracts';
import { badge, banner, section } from '../../ui/components/card';
import { field, numberInput, segmented, select, toggle } from '../../ui/components/controls';
import { button, clear, el, icon } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { tabs } from '../../ui/components/tabs';
import type { AgentsView } from './view';
import { connectionProfiles } from './view-editor';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ module settings by path */

export function readPath(app: App, module: string, path: string): unknown {
    let current: unknown = app.settings.module<Dict>(module);
    for (const part of path.split('.')) {
        if (!isDict(current)) return undefined;
        current = current[part];
    }
    return current;
}

export function writePath(app: App, module: string, path: string, value: unknown): void {
    const slice = app.settings.module<Dict>(module);
    const parts = path.split('.');
    let current: Dict = slice;
    for (const part of parts.slice(0, -1)) {
        if (!isDict(current[part])) current[part] = {};
        current = current[part] as Dict;
    }
    current[parts[parts.length - 1]!] = value;
    app.settings.save();
    app.settings.notify(`${module}.${path}`);
}

/** Whether the job runs: the module, a boolean setting, or always (no switch). */
export function builtinOn(app: App, spec: BuiltInAgentSpec): boolean {
    if (!app.settings.isModuleEnabled(spec.module)) return false;
    if (spec.switch && spec.switch !== 'module') return readPath(app, spec.module, spec.switch.path) !== false;
    return true;
}

async function setBuiltinOn(app: App, spec: BuiltInAgentSpec, on: boolean): Promise<void> {
    if (!spec.switch) return;
    if (spec.switch === 'module') {
        if (on) await app.modules.enable(spec.module);
        else await app.modules.disable(spec.module);
        return;
    }
    if (on && !app.settings.isModuleEnabled(spec.module)) await app.modules.enable(spec.module);
    writePath(app, spec.module, spec.switch.path, on);
}

function profileOf(app: App, id: string): string {
    return app.settings.core().profiles?.[id] ?? '';
}

function setProfile(app: App, id: string, profile: string): void {
    const core = app.settings.core();
    const profiles = { ...(core.profiles ?? {}) };
    if (profile) profiles[id] = profile;
    else delete profiles[id];
    core.profiles = profiles;
    app.settings.save();
    app.settings.notify('core.profiles');
}

/* ------------------------------------------------------------------ the list */

const GROUPS: BuiltInGroup[] = ['canon', 'story', 'quality', 'world', 'mechanics', 'button'];

export function builtinSections(view: AgentsView, repaint: () => void): HTMLElement[] {
    const specs = builtInAgents();
    if (!specs.length) return [];
    const out: HTMLElement[] = [];
    for (const group of GROUPS) {
        const list = specs.filter((spec) => spec.group === group);
        if (!list.length) continue;
        out.push(
            section(
                view.t(`m44.biGroup.${group}`),
                list.map((spec) => builtinRow(view, spec, repaint)),
            ),
        );
    }
    return out;
}

function builtinRow(view: AgentsView, spec: BuiltInAgentSpec, repaint: () => void): HTMLElement {
    const app = view.app;
    const on = builtinOn(app, spec);
    const runs = view.state.runs().filter((run) => run.agentId === spec.id);
    const last = runs[runs.length - 1];
    const changed = Boolean(view.store.builtinOverride(spec.id)) || Boolean(profileOf(app, spec.id));
    return el('div', { class: ['maestro-agent-row', on ? 'maestro-on' : null] }, [
        spec.switch
            ? toggle({
                  label: '',
                  checked: on,
                  hint: view.t('m44.bi.toggleHint'),
                  onChange: async (checked) => {
                      await setBuiltinOn(app, spec, checked);
                      repaint();
                  },
              })
            : el('span', { class: 'maestro-agent-row-fixed', title: view.t('m44.bi.noSwitch') }, [icon('fa-link')]),
        icon(spec.icon),
        el('div', { class: 'maestro-agent-row-main' }, [
            el('div', { class: 'maestro-agent-row-name' }, [
                el('strong', { text: view.t(`m44.bi.${spec.id}.title`) }),
                badge(view.t('m44.bi.builtin'), 'muted'),
                changed ? badge(view.t('m44.bi.changed'), 'info') : null,
            ]),
            el('div', { class: 'maestro-muted' }, [
                view.t(`m44.bi.${spec.id}.when`),
                last
                    ? ` · ${view.t(last.ok ? 'm44.status.ok' : 'm44.status.error')}${last.error ? ` (${view.t(`m44.error.${last.error}`)})` : ''}`
                    : '',
            ]),
        ]),
        el('div', { class: 'maestro-agent-row-actions' }, [
            button({
                icon: 'fa-pen',
                kind: 'ghost',
                title: view.t('m44.list.edit'),
                onClick: () => {
                    view.editing = `builtin:${spec.id}`;
                    repaint();
                },
            }),
        ]),
    ]);
}

/* ------------------------------------------------------------------ the editor */

function optionalNumber(
    value: number | undefined,
    placeholder: number,
    options: { min: number; max: number; step: number },
    onChange: (value: number | undefined) => void,
): HTMLInputElement {
    const node = el('input', {
        class: 'text_pole maestro-number',
        attrs: {
            type: 'number',
            min: options.min,
            max: options.max,
            step: options.step,
            placeholder: String(placeholder),
        },
    });
    node.value = value === undefined ? '' : String(value);
    node.addEventListener('change', () => {
        if (!node.value.trim()) return onChange(undefined);
        let next = Number(node.value);
        if (!Number.isFinite(next)) return onChange(undefined);
        next = Math.min(options.max, Math.max(options.min, next));
        node.value = String(next);
        onChange(next);
    });
    return node;
}

export class BuiltinEditor {
    private draft: BuiltInOverride;
    private dirty = false;
    private tab = 'instruction';
    private body: HTMLElement | null = null;

    constructor(
        private readonly view: AgentsView,
        private readonly spec: BuiltInAgentSpec,
        private readonly onClose: () => void,
    ) {
        const current = view.store.builtinOverride(spec.id);
        this.draft = current ? (JSON.parse(JSON.stringify(current)) as BuiltInOverride) : { mode: 'default' };
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.view.t(key, params);
    }

    private defaultText(): string {
        try {
            return this.spec.defaultInstructions()[0] ?? '';
        } catch {
            return '';
        }
    }

    private touch(): void {
        this.dirty = true;
    }

    render(container: HTMLElement): void {
        clear(container);
        const title = this.t(`m44.bi.${this.spec.id}.title`);
        container.append(
            el('div', { class: 'maestro-agent-editor-head' }, [
                button({
                    icon: 'fa-arrow-left',
                    label: this.t('m44.editor.back'),
                    kind: 'ghost',
                    onClick: () => {
                        if (!this.dirty || globalThis.confirm?.(this.t('m44.editor.unsaved')) !== false) this.onClose();
                    },
                }),
                el('strong', { text: title }),
                badge(this.t('m44.bi.builtin'), 'muted'),
                el('span', { class: 'maestro-agent-editor-spacer' }),
                button({ icon: 'fa-rotate-left', label: this.t('m44.bi.reset'), onClick: () => this.reset() }),
                button({
                    icon: 'fa-floppy-disk',
                    label: this.t('m44.editor.save'),
                    kind: 'primary',
                    onClick: () => this.save(),
                }),
            ]),
        );
        const items = [
            ['instruction', 'm44.editor.tab.instruction', 'fa-pen'],
            ['model', 'm44.editor.tab.model', 'fa-microchip'],
            ['trigger', 'm44.editor.tab.trigger', 'fa-clock'],
            ['sources', 'm44.editor.tab.sources', 'fa-eye'],
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
            el('div', { class: 'maestro-agent-editor' }, [
                el('div', { class: 'maestro-agent-editor-tabs' }, [handle.list, handle.picker]),
                this.body,
            ]),
        );
        this.paint();
    }

    private paint(): void {
        if (!this.body) return;
        clear(this.body);
        const parts =
            this.tab === 'model'
                ? this.modelTab()
                : this.tab === 'trigger'
                  ? this.triggerTab()
                  : this.tab === 'sources'
                    ? this.sourcesTab()
                    : this.tab === 'check'
                      ? this.checkTab()
                      : this.instructionTab();
        for (const part of parts) if (part) this.body.append(part as Node);
    }

    private async save(): Promise<void> {
        const draft = { ...this.draft };
        if (draft.mode === 'full') {
            const base = this.defaultText();
            if (!draft.baseHash) {
                draft.baseHash = textHash(base);
                draft.baseText = base;
            }
        }
        await this.view.store.setBuiltinOverride(
            this.spec.id,
            draft,
            this.t('m44.journal.builtin', { name: this.t(`m44.bi.${this.spec.id}.title`) }),
        );
        this.dirty = false;
        this.view.app.ui.notice(this.t('m44.editor.saved', { name: this.t(`m44.bi.${this.spec.id}.title`) }), {
            urgent: true,
        });
        this.onClose();
    }

    private async reset(): Promise<void> {
        const ok = await this.view.app.ui.confirm(this.t('m44.bi.reset'), this.t('m44.bi.resetBody'));
        if (!ok) return;
        await this.view.store.setBuiltinOverride(
            this.spec.id,
            null,
            this.t('m44.journal.builtinReset', { name: this.t(`m44.bi.${this.spec.id}.title`) }),
        );
        this.dirty = false;
        this.onClose();
    }

    /* ------------------------------------------------------------ Поручение */

    private instructionTab(): Child[] {
        const draft = this.draft;
        const base = this.defaultText();
        const parts: Child[] = [
            el('div', { class: 'maestro-hint', text: this.t(`m44.bi.${this.spec.id}.desc`) }),
            el('div', { class: 'maestro-hint', text: this.t('m44.bi.instructionHint') }),
            field(
                this.t('m44.bi.mode'),
                segmented<InstructionMode>({
                    value: draft.mode,
                    label: this.t('m44.bi.mode'),
                    options: (['default', 'addition', 'full'] as const).map((value) => ({
                        value,
                        label: this.t(`m44.bi.mode.${value}`),
                    })),
                    onChange: (mode) => {
                        draft.mode = mode;
                        if (mode === 'full' && !draft.full) {
                            draft.full = base;
                            draft.baseHash = textHash(base);
                            draft.baseText = base;
                        }
                        this.touch();
                        this.paint();
                    },
                }),
            ),
        ];
        if (draft.mode === 'addition') {
            const area = el('textarea', {
                class: 'text_pole maestro-agent-textarea',
                attrs: { rows: 8, placeholder: this.t('m44.bi.additionPlaceholder') },
            });
            area.value = draft.addition ?? '';
            area.addEventListener('input', () => {
                draft.addition = area.value;
                this.touch();
            });
            parts.push(
                section(this.t('m44.bi.addition'), [
                    el('div', { class: 'maestro-hint', text: this.t('m44.bi.additionHint') }),
                    area,
                ]),
            );
        }
        if (draft.mode === 'full') {
            if (defaultChanged(draft, base)) {
                parts.push(
                    banner(this.t('m44.bi.defaultChanged'), 'warn'),
                    draft.baseText ? this.view.rewriteDiff(draft.baseText, base) : null,
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            label: this.t('m44.bi.takeNew'),
                            onClick: () => {
                                draft.full = base;
                                draft.baseHash = textHash(base);
                                draft.baseText = base;
                                this.touch();
                                this.paint();
                            },
                        }),
                        button({
                            label: this.t('m44.bi.keepMine'),
                            onClick: () => {
                                draft.baseHash = textHash(base);
                                draft.baseText = base;
                                this.touch();
                                this.paint();
                            },
                        }),
                    ]),
                );
            }
            const area = el('textarea', { class: 'text_pole maestro-agent-textarea', attrs: { rows: 16 } });
            area.value = draft.full ?? base;
            area.addEventListener('input', () => {
                draft.full = area.value;
                this.touch();
            });
            parts.push(
                section(this.t('m44.bi.full'), [
                    el('div', { class: 'maestro-hint', text: this.t('m44.bi.fullHint') }),
                    area,
                ]),
            );
        }
        parts.push(
            el('details', { class: 'maestro-agent-default' }, [
                el('summary', { text: this.t('m44.bi.defaultText') }),
                el('pre', { class: 'maestro-agent-preview', text: base || '—' }),
            ]),
        );
        return parts;
    }

    /* ------------------------------------------------------------ Модель */

    private modelTab(): Child[] {
        const draft = this.draft;
        const app = this.view.app;
        const profiles = connectionProfiles(this.view);
        return [
            field(
                this.t('m44.editor.profile'),
                select({
                    value: profileOf(app, this.spec.id),
                    options: [
                        { value: '', label: this.t('m44.bi.profileDefault') },
                        ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                    ],
                    onChange: (value) => setProfile(app, this.spec.id, value),
                }),
                this.t('m44.bi.profileHint'),
            ),
            field(
                this.t('m44.editor.temperature'),
                optionalNumber(
                    draft.temperature,
                    this.spec.defaults.temperature,
                    { min: 0, max: 2, step: 0.05 },
                    (value) => {
                        draft.temperature = value;
                        this.touch();
                    },
                ),
                this.t('m44.bi.emptyDefault'),
            ),
            field(
                this.t('m44.editor.maxTokens'),
                optionalNumber(
                    draft.maxTokens,
                    this.spec.defaults.maxTokens,
                    { min: 50, max: 16_000, step: 50 },
                    (value) => {
                        draft.maxTokens = value;
                        this.touch();
                    },
                ),
                this.t('m44.bi.emptyDefault'),
            ),
            field(
                this.t('m44.editor.reasoning'),
                select({
                    value: draft.reasoning ?? '',
                    options: [
                        { value: '', label: this.t('m44.bi.reasoningDefault') },
                        ...(['off', 'low', 'medium', 'high'] as const).map((value) => ({
                            value,
                            label: this.t(`m44.reasoning.${value}`),
                        })),
                    ],
                    onChange: (value) => {
                        draft.reasoning = value ? (value as BuiltInOverride['reasoning']) : undefined;
                        this.touch();
                    },
                }),
                this.t('m44.editor.reasoningHint'),
            ),
        ];
    }

    /* ------------------------------------------------------------ Когда */

    private triggerTab(): Child[] {
        const app = this.view.app;
        const parts: Child[] = [el('div', { class: 'maestro-hint', text: this.t(`m44.bi.${this.spec.id}.when`) })];
        if (this.spec.switch) {
            parts.push(
                toggle({
                    label: this.t('m44.bi.on'),
                    checked: builtinOn(app, this.spec),
                    onChange: (on) => setBuiltinOn(app, this.spec, on),
                }),
            );
        }
        for (const knob of this.spec.knobs ?? []) parts.push(this.knob(knob));
        if (!this.spec.knobs?.length) parts.push(el('div', { class: 'maestro-muted', text: this.t('m44.bi.noKnobs') }));
        parts.push(el('div', { class: 'maestro-hint', text: this.t('m44.bi.knobsHint') }));
        return parts;
    }

    private knob(knob: BuiltInKnob): Child {
        const app = this.view.app;
        const value = readPath(app, this.spec.module, knob.path);
        const label = this.t(knob.labelKey);
        if (knob.kind === 'toggle')
            return toggle({
                label,
                checked: value === true,
                onChange: (on) => writePath(app, this.spec.module, knob.path, on),
            });
        if (knob.kind === 'select')
            return field(
                label,
                select({
                    value: typeof value === 'string' ? value : (knob.options?.[0]?.value ?? ''),
                    options: (knob.options ?? []).map((option) => ({
                        value: option.value,
                        label: this.t(option.labelKey),
                    })),
                    onChange: (next) => writePath(app, this.spec.module, knob.path, next),
                }),
            );
        return field(
            label,
            numberInput({
                value: typeof value === 'number' ? value : (knob.min ?? 0),
                min: knob.min,
                max: knob.max,
                step: knob.step,
                onChange: (next) => writePath(app, this.spec.module, knob.path, next),
            }),
        );
    }

    /* ------------------------------------------------------------ Что видит, Проверка */

    private sourcesTab(): Child[] {
        return [
            el('div', { text: this.t(`m44.bi.${this.spec.id}.sources`) }),
            el('div', { class: 'maestro-hint', text: this.t('m44.bi.sourcesHint') }),
        ];
    }

    private checkTab(): Child[] {
        const runs = this.view.state.runs().filter((run) => run.agentId === this.spec.id);
        const last = runs[runs.length - 1];
        if (!last) return [el('div', { class: 'maestro-muted', text: this.t('m44.bi.noRuns') })];
        return [
            el('div', {
                text: this.t('m44.bi.lastRun', {
                    time: new Date(last.startedAt).toLocaleString(),
                    status: this.t(last.ok ? 'm44.status.ok' : 'm44.status.error'),
                    cost: (last.costUsd ?? 0).toFixed(4),
                }),
            }),
            last.request
                ? el('pre', {
                      class: 'maestro-agent-preview',
                      text: last.request.map((message) => `── ${message.role} ──\n${message.content}`).join('\n\n'),
                  })
                : null,
            last.raw !== undefined
                ? el('details', {}, [
                      el('summary', { text: this.t('m44.log.raw') }),
                      el('pre', { class: 'maestro-agent-preview', text: last.raw }),
                  ])
                : null,
            el('div', { class: 'maestro-hint', text: this.t('m44.bi.checkHint') }),
        ];
    }
}
