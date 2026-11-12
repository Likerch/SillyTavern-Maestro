// The «Агенты» window (plan §3.1): sections Агенты (list and the editor), Вставки хода, Записи, Журнал запусков,
// Шаблоны, Наборы, Расходы; the strip lines under messages (notes, checks, variants, «Показать исходный»); the card
// agents question (plan §3.7, В6).
import { capabilitiesOf, newAgentId, sanitizeAgent, setFromStates } from '../../domain/agents/def';
import type { AgentOutput } from '../../domain/agents/output';
import { estimateTurn } from '../../domain/agents/cost';
import { AGENT_TEMPLATES } from '../../domain/agents/templates';
import type { TemplateGroup } from '../../domain/agents/templates';
import type { AgentDef, AgentRun, AgentScope, AgentSet } from '../../domain/agents/types';
import { stableHash } from '../../domain/hash';
import type { App, MessageStripProvider, PultTab, StripItem, Unsubscribe } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { field, select, toggle } from '../../ui/components/controls';
import { renderParts, wordDiff } from '../../ui/components/diff';
import { append, button, clear, el, icon } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import type { AgentsChatState, MessageResult } from './chat-state';
import type { AgentRunner, RunOutcome } from './runner';
import type { AgentRuntime } from './runtime';
import type { SourceRegistry } from './sources';
import { readCardAgents } from './store';
import type { AgentStore } from './store';
import { builtInAgent } from '../../core/builtin-agents';
import { BuiltinEditor, builtinSections } from './view-builtin';
import { AgentEditor } from './view-editor';

export const AGENTS_WINDOW = 'agents';
export const AGENTS_GROUP = 'agents';

/** What the views share. */
export class AgentsView {
    /** The editor open in the list section (agent id, or 'new'), kept while the window lives. */
    editing: string | null = null;

    constructor(
        readonly app: App,
        readonly store: AgentStore,
        readonly state: AgentsChatState,
        readonly runtime: AgentRuntime,
        readonly runner: AgentRunner,
        readonly sources: SourceRegistry,
    ) {}

    t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /** The reply a preview or a test works on: the last assistant message. */
    focusIndex(): number | undefined {
        const chat = this.app.host.ctx().chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i]?.is_user && !chat[i]?.is_system) return i;
        return undefined;
    }

    templateName(templateId: string): string {
        return this.t(`m44.tpl.${templateId}.name`);
    }

    newId(name: string): string {
        return newAgentId(name);
    }

    rewriteDiff(before: string, after: string): HTMLElement {
        return el('div', { class: 'maestro-diff maestro-agent-diff' }, [
            renderParts(wordDiff(before, after), (key) => this.t(key)),
        ]);
    }

    /** Puts agents (and the states in force for them) into the open card: `data.extensions.maestro.agents`. */
    async putIntoCard(agentIds: string[]): Promise<void> {
        const ctx = this.app.host.ctx();
        const id = ctx.characterId;
        if (id === undefined || id === '' || this.app.host.isGroupChat()) return;
        const cardData = ctx.characters[Number(id)] as unknown as { data?: { extensions?: Record<string, unknown> } };
        const defs = agentIds
            .map((agentId) => this.store.get(agentId))
            .filter((def): def is AgentDef => def !== undefined);
        if (!defs.length) return;
        const ok = await this.app.ui.confirm(
            this.t('m44.card.putTitle'),
            this.t('m44.card.putBody', { names: defs.map((def) => def.name).join(', ') }),
        );
        if (!ok) return;
        const existing = cardData?.data?.extensions?.maestro;
        const maestro =
            typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
        const states = this.store.states();
        const set: AgentSet = { id: 'card', name: 'card', agents: {} };
        for (const def of defs) set.agents[def.id] = { on: states.get(def.id)?.on ?? true };
        maestro.agents = { agents: defs, set };
        const write = (
            ctx as unknown as {
                writeExtensionField?: (id: number | string, key: string, value: unknown) => Promise<void>;
            }
        ).writeExtensionField;
        if (typeof write !== 'function') {
            this.app.ui.notice(this.t('m44.card.cannot'), { level: 'warn', urgent: true });
            return;
        }
        await write(id, 'maestro', maestro);
        this.app.ui.notice(this.t('m44.card.put', { count: defs.length }), { urgent: true });
    }

    /** Card agents of the open card that the user has not decided about: asks, imports on «да» (plan В6). */
    async checkCardAgents(): Promise<void> {
        const ctx = this.app.host.ctx();
        const id = ctx.characterId;
        if (id === undefined || id === '' || this.app.host.isGroupChat()) return;
        const raw = ctx.characters[Number(id)] as unknown;
        const avatar = (raw as { avatar?: string } | undefined)?.avatar;
        const found = readCardAgents(raw, Date.now());
        if (!found || !avatar) return;
        const hash = stableHash(
            JSON.stringify(found.agents.map((def) => [def.id, def.instruction, def.result, def.trigger])),
        );
        const decided = this.store.cardDecision(avatar);
        if (decided === hash) return;
        const lines = found.agents.map(
            (def) =>
                `${def.name}: ${def.capabilities.map((cap) => this.t(`m44.cap.${cap.split('.')[0]}`, { what: cap.split('.').slice(1).join('.') })).join(', ')}`,
        );
        this.app.ui.notice(this.t('m44.card.found', { count: found.agents.length }), {
            importance: 'important',
            action: {
                label: this.t('m44.card.review'),
                run: async () => {
                    const body = el('div', {}, [
                        el('p', { text: this.t('m44.card.reviewBody') }),
                        el(
                            'ul',
                            {},
                            lines.map((line) => el('li', { text: line })),
                        ),
                    ]);
                    const ok = await this.app.ui.confirm(this.t('m44.card.reviewTitle'), body);
                    await this.store.setCardDecision(avatar, hash);
                    if (!ok) return;
                    for (const def of found.agents) {
                        const copy = sanitizeAgent(
                            {
                                ...def,
                                origin: `card:${avatar}`,
                                id: this.store.get(def.id) ? newAgentId(def.name) : def.id,
                            },
                            Date.now(),
                        );
                        if (!copy) continue;
                        copy.capabilities = capabilitiesOf(copy);
                        await this.store.save(copy, this.t('m44.journal.fromCard', { name: copy.name }));
                        const on = found.set?.agents[def.id]?.on ?? true;
                        await this.store.setAgentState('character', copy.id, { on });
                    }
                    this.app.ui.notice(this.t('m44.card.imported', { count: found.agents.length }), { urgent: true });
                },
            },
        });
    }
}

/* ------------------------------------------------------------------ words for results */

/** What a result does, in words (a test run: «вставил бы…», «правка: …»). */
export function describeOutput(view: AgentsView, def: AgentDef, outcome: RunOutcome): string {
    const output: AgentOutput | undefined = outcome.output;
    if (!output || output.type === 'none') return view.t('m44.would.none');
    switch (output.type) {
        case 'inject':
            return view.t('m44.would.inject', { text: output.text });
        case 'note':
            return view.t('m44.would.note', { text: output.text });
        case 'flags':
            return view.t('m44.would.flags', {
                flags: Object.entries(output.flags)
                    .map(([key, value]) => `${key} = ${String(value)}`)
                    .join(', '),
            });
        case 'choices':
            return view.t('m44.would.choices', { choices: output.choices.join(' · ') });
        case 'memory':
            return view.t('m44.would.memory', {
                fields: Object.entries(output.fields)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('; '),
            });
        case 'verdict':
            return output.ok
                ? view.t('m44.would.verdictOk')
                : view.t('m44.would.verdict', { problems: output.problems.map((problem) => problem.issue).join('; ') });
        case 'rewrite':
            return view.t('m44.would.rewrite', { changes: output.changes.join('; ') || '—' });
    }
    return def.name;
}

function runStatus(run: AgentRun | undefined): 'ok' | 'warn' | 'error' | 'off' {
    if (!run) return 'off';
    if (run.ok) return 'ok';
    return run.error === 'limit' || run.error === 'cap' || run.error === 'aborted' ? 'warn' : 'error';
}

function money(usd: number): string {
    return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/* ------------------------------------------------------------------ Агенты: the list */

function scopePicker(view: AgentsView, value: AgentScope, onChange: (scope: AgentScope) => void): HTMLElement {
    const context = view.store.context();
    const options: { value: AgentScope; label: string }[] = [{ value: 'global', label: view.t('m44.scope.global') }];
    if (context.avatar)
        options.push({
            value: 'character',
            label: view.t('m44.scope.characterNamed', { name: context.characterName ?? '' }),
        });
    if (context.chatId) options.push({ value: 'chat', label: view.t('m44.scope.chat') });
    return field(view.t('m44.list.scope'), select({ value, options, onChange }), view.t('m44.list.scopeHint'));
}

function agentRow(view: AgentsView, def: AgentDef, scope: AgentScope, repaint: () => void): HTMLElement {
    const states = view.store.states();
    const on = states.get(def.id)?.on ?? false;
    const runs = view.state.runs().filter((run) => run.agentId === def.id);
    const last = runs[runs.length - 1];
    const paid = runs.filter((run) => run.costUsd !== undefined).slice(-10);
    const avg = paid.length ? paid.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) / paid.length : null;
    const scopeState = view.store.scopeState(scope);
    const pointed = scopeState?.overrides[def.id]?.on !== undefined;
    const status = runStatus(last);
    return el('div', { class: ['maestro-agent-row', on ? 'maestro-on' : null] }, [
        toggle({
            label: '',
            checked: on,
            hint: view.t('m44.list.toggleHint'),
            onChange: async (checked) => {
                await view.store.setAgentState(scope, def.id, { on: checked });
                repaint();
            },
        }),
        icon(def.icon ?? 'fa-robot'),
        el('div', { class: 'maestro-agent-row-main' }, [
            el('div', { class: 'maestro-agent-row-name' }, [
                el('strong', { text: def.name }),
                pointed ? badge(view.t('m44.list.pointed'), 'muted') : null,
            ]),
            el('div', { class: 'maestro-muted' }, [
                `${view.t(`m44.phase.${def.trigger.phase}`)} · ${view.t(`m44.type.${def.result.type}`)}`,
                avg !== null ? ` · ≈ ${money(avg)} ${view.t('m44.list.perRun')}` : '',
                last
                    ? ` · ${view.t(`m44.status.${status}`)}${last.error ? ` (${view.t(`m44.error.${last.error}`)})` : ''}`
                    : '',
            ]),
        ]),
        el('div', { class: 'maestro-agent-row-actions' }, [
            def.trigger.phase === 'manual' || on
                ? button({
                      icon: 'fa-play',
                      kind: 'ghost',
                      title: view.t('m44.list.run'),
                      onClick: async () => {
                          await view.runtime.runManual(def.id);
                          repaint();
                      },
                  })
                : null,
            pointed
                ? button({
                      icon: 'fa-rotate-left',
                      kind: 'ghost',
                      title: view.t('m44.list.backToSet'),
                      onClick: async () => {
                          await view.store.setAgentState(scope, def.id, { on: undefined });
                          repaint();
                      },
                  })
                : null,
            button({
                icon: 'fa-pen',
                kind: 'ghost',
                title: view.t('m44.list.edit'),
                onClick: () => {
                    view.editing = def.id;
                    repaint();
                },
            }),
        ]),
    ]);
}

export function agentsListTab(view: AgentsView): PultTab {
    let scope: AgentScope = 'chat';
    return {
        id: 'agents',
        titleKey: 'm44.tab.agents',
        icon: 'fa-robot',
        order: 10,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            let editor: AgentEditor | BuiltinEditor | null = null;
            const paint = () => {
                clear(container);
                const builtinId = view.editing?.startsWith('builtin:') ? view.editing.slice('builtin:'.length) : null;
                const spec = builtinId ? builtInAgent(builtinId) : undefined;
                if (spec) {
                    editor = new BuiltinEditor(view, spec, () => {
                        view.editing = null;
                        editor = null;
                        paint();
                    });
                    editor.render(container);
                    return;
                }
                if (view.editing) {
                    const def = view.editing === 'new' ? null : (view.store.get(view.editing) ?? null);
                    editor = new AgentEditor(view, def, () => {
                        view.editing = null;
                        editor = null;
                        paint();
                    });
                    editor.render(container);
                    return;
                }
                const context = view.store.context();
                if (!context.chatId && scope !== 'global') scope = 'global';
                const agents = view.store.list();
                const head = el('div', { class: 'maestro-actions' }, [
                    button({
                        icon: 'fa-plus',
                        label: view.t('m44.list.new'),
                        kind: 'primary',
                        onClick: () => {
                            view.editing = 'new';
                            paint();
                        },
                    }),
                    button({
                        icon: 'fa-file-import',
                        label: view.t('m44.list.import'),
                        onClick: () => importAgents(view).then(paint),
                    }),
                    agents.length
                        ? button({
                              icon: 'fa-file-export',
                              label: view.t('m44.list.export'),
                              onClick: () => exportAgents(view, agents),
                          })
                        : null,
                ]);
                const estimate = estimateTurn(
                    view.state.runs(),
                    view.store.activeAgents().map(({ def }) => ({ id: def.id, trigger: def.trigger })),
                );
                const parts: Child[] = [
                    el('div', { class: 'maestro-hint', text: view.t('m44.list.hint') }),
                    estimate.counted || estimate.unknown
                        ? el('div', {
                              class: 'maestro-agent-estimate',
                              text:
                                  view.t('m44.list.estimate', { usd: money(estimate.usd) }) +
                                  (estimate.unknown
                                      ? ` ${view.t('m44.list.estimateUnknown', { count: estimate.unknown })}`
                                      : ''),
                          })
                        : null,
                    view.app.host.isGroupChat() ? banner(view.t('m44.group')) : null,
                    scopePicker(view, scope, (next) => {
                        scope = next;
                        paint();
                    }),
                    setLine(view, scope, paint),
                    head,
                ];
                if (!agents.length) parts.push(emptyState(view.t('m44.list.empty'), 'fa-robot'));
                const phases = ['prefetch', 'onSend', 'parallel', 'post', 'commit', 'schedule', 'manual'] as const;
                for (const phase of phases) {
                    const list = agents.filter((def) => def.trigger.phase === phase);
                    if (!list.length) continue;
                    parts.push(
                        section(
                            view.t(`m44.phase.${phase}`),
                            list.map((def) => agentRow(view, def, scope, paint)),
                        ),
                    );
                }
                const builtins = builtinSections(view, paint);
                if (builtins.length) {
                    parts.push(el('h3', { class: 'maestro-agent-subhead', text: view.t('m44.bi.heading') }));
                    parts.push(el('div', { class: 'maestro-hint', text: view.t('m44.bi.hint') }));
                    parts.push(...builtins);
                }
                for (const part of parts) if (part) container.append(part as Node);
            };
            paint();
            const off = view.store.onChange(() => {
                if (!editor) paint();
            });
            return () => off();
        },
    };
}

/** «Набор здесь: …» with a picker (the set of the chosen scope). */
function setLine(view: AgentsView, scope: AgentScope, repaint: () => void): HTMLElement {
    const state = view.store.scopeState(scope);
    const sets = view.store.sets();
    const value = state?.set ?? '';
    return field(
        view.t('m44.list.set'),
        select({
            value,
            options: [
                { value: '', label: view.t('m44.list.setNone') },
                ...sets.map((set) => ({ value: set.id, label: set.name })),
            ],
            onChange: async (setId) => {
                if (!setId) await view.store.clearSet(scope);
                else
                    await view.store.applySet(
                        scope,
                        setId,
                        (templateId) => view.templateName(templateId),
                        (name) => view.newId(name),
                    );
                repaint();
            },
        }),
        view.t('m44.list.setHint'),
    );
}

/* ------------------------------------------------------------------ import and export */

function download(name: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { attrs: { href: url, download: name } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAgents(view: AgentsView, agents: AgentDef[]): void {
    download('maestro-agents.json', { maestroAgents: 1, agents });
    view.app.ui.notice(view.t('m44.exported', { count: agents.length }), { urgent: true });
}

function pickFile(): Promise<string | null> {
    return new Promise((resolve) => {
        const input = el('input', { attrs: { type: 'file', accept: '.json,application/json' } });
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            file.text().then(resolve, () => resolve(null));
        });
        input.click();
    });
}

/** Import (plan §3.10): every agent gets a new id; the user sees what each may do and confirms. */
async function importAgents(view: AgentsView): Promise<void> {
    const text = await pickFile();
    if (!text) return;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        view.app.ui.notice(view.t('m44.import.bad'), { level: 'error', urgent: true });
        return;
    }
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { agents?: unknown })?.agents)
          ? (raw as { agents: unknown[] }).agents
          : [raw];
    const defs = list
        .map((item) => sanitizeAgent({ ...(item as object), id: undefined, origin: 'import' }, Date.now()))
        .filter((def): def is AgentDef => def !== null);
    if (!defs.length) {
        view.app.ui.notice(view.t('m44.import.none'), { level: 'warn', urgent: true });
        return;
    }
    const body = el('div', {}, [
        el('p', { text: view.t('m44.import.body') }),
        el(
            'ul',
            {},
            defs.map((def) =>
                el('li', {
                    text: `${def.name}: ${def.capabilities.map((cap) => view.t(`m44.cap.${cap.split('.')[0]}`, { what: cap.split('.').slice(1).join('.') })).join(', ')}`,
                }),
            ),
        ),
    ]);
    if (!(await view.app.ui.confirm(view.t('m44.import.title', { count: defs.length }), body))) return;
    for (const def of defs) await view.store.save(def, view.t('m44.journal.imported', { name: def.name }));
    view.app.ui.notice(view.t('m44.import.done', { count: defs.length }), { urgent: true });
}

/* ------------------------------------------------------------------ Вставки хода */

export function turnTab(view: AgentsView): PultTab {
    return {
        id: 'agents-turn',
        titleKey: 'm44.tab.turn',
        icon: 'fa-syringe',
        order: 20,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.turn.hint') }));
                const anchor = view.runtime.anchorNext();
                const doc = view.state.doc;
                const rows: HTMLElement[] = [];
                for (const { def } of view.store.activeAgents()) {
                    const prepared = doc.prepared[def.id];
                    const standing = doc.standing[def.id];
                    const memoryInject = def.result.type === 'memory' && def.result.options.inject;
                    if (
                        !prepared &&
                        !standing &&
                        !memoryInject &&
                        def.result.type !== 'inject' &&
                        def.result.type !== 'flags'
                    )
                        continue;
                    const fresh = prepared ? prepared.anchor === anchor.index && prepared.hash === anchor.hash : false;
                    const text =
                        prepared?.text ??
                        (prepared?.flags ? JSON.stringify(prepared.flags) : undefined) ??
                        standing?.text ??
                        '';
                    const area = el('textarea', { class: 'text_pole maestro-agent-textarea', attrs: { rows: 3 } });
                    area.value = memoryInject
                        ? Object.entries(view.state.memory(def.id).fields)
                              .map(([key, value]) => `${key}: ${value}`)
                              .join('\n')
                        : text;
                    area.disabled = memoryInject === true;
                    rows.push(
                        card({
                            title: def.name,
                            subtitle: memoryInject
                                ? view.t('m44.turn.memory')
                                : prepared
                                  ? view.t(fresh ? 'm44.turn.ready' : 'm44.turn.stale')
                                  : standing
                                    ? view.t('m44.turn.standing')
                                    : view.t('m44.turn.empty'),
                            level: prepared && !fresh ? 'warn' : 'info',
                            body: area,
                            actions: [
                                !memoryInject
                                    ? button({
                                          icon: 'fa-floppy-disk',
                                          label: view.t('m44.turn.save'),
                                          onClick: () => {
                                              if (prepared)
                                                  view.state.setPrepared({
                                                      ...prepared,
                                                      text: area.value,
                                                      edited: true,
                                                      anchor: anchor.index,
                                                      hash: anchor.hash,
                                                  });
                                              else view.state.setStanding(def.id, area.value, Date.now());
                                          },
                                      })
                                    : null,
                                button({
                                    icon: 'fa-rotate',
                                    label: view.t('m44.turn.recompute'),
                                    onClick: () => view.runtime.recompute(def.id).then(paint),
                                }),
                                prepared || standing
                                    ? button({
                                          icon: 'fa-xmark',
                                          label: view.t('m44.turn.drop'),
                                          onClick: () => {
                                              view.state.dropPrepared(def.id);
                                              view.state.setStanding(def.id, null, Date.now());
                                              paint();
                                          },
                                      })
                                    : null,
                            ],
                        }),
                    );
                }
                if (!rows.length) container.append(emptyState(view.t('m44.turn.none'), 'fa-syringe'));
                container.append(...rows);
            };
            paint();
            const off = view.state.onChange(() => paint());
            const off2 = view.store.onChange(() => paint());
            return () => {
                off();
                off2();
            };
        },
    };
}

/* ------------------------------------------------------------------ Записи */

export function memoryTab(view: AgentsView): PultTab {
    return {
        id: 'agents-memory',
        titleKey: 'm44.tab.memory',
        icon: 'fa-note-sticky',
        order: 30,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.memory.hint') }));
                const agents = view.store.list().filter((def) => def.result.type === 'memory');
                if (!agents.length) {
                    container.append(emptyState(view.t('m44.memory.none'), 'fa-note-sticky'));
                    return;
                }
                for (const def of agents) {
                    if (def.result.type !== 'memory') continue;
                    const memory = view.state.memory(def.id);
                    const names = [
                        ...new Set([
                            ...def.result.options.fields.map((item) => item.name),
                            ...Object.keys(memory.fields),
                        ]),
                    ];
                    const body = names.map((name) => {
                        const area = el('textarea', { class: 'text_pole maestro-agent-textarea', attrs: { rows: 2 } });
                        area.value = memory.fields[name] ?? '';
                        area.addEventListener('change', () =>
                            view.state.updateMemory(def.id, { [name]: area.value }, Date.now(), true),
                        );
                        return el('div', { class: 'maestro-agent-memory-field' }, [
                            el('div', { class: 'maestro-row' }, [
                                el('strong', { text: name }),
                                toggle({
                                    label: view.t('m44.memory.lock'),
                                    checked: memory.locked.includes(name),
                                    onChange: (on) => view.state.setLocked(def.id, name, on),
                                }),
                            ]),
                            area,
                        ]);
                    });
                    container.append(
                        section(
                            def.name,
                            body.length
                                ? body
                                : [el('div', { class: 'maestro-muted', text: view.t('m44.memory.empty') })],
                            [
                                memory.history.length
                                    ? button({
                                          icon: 'fa-clock-rotate-left',
                                          kind: 'ghost',
                                          title: view.t('m44.memory.back'),
                                          onClick: () => {
                                              const previous = memory.history[memory.history.length - 1];
                                              if (previous)
                                                  view.state.updateMemory(def.id, previous.fields, Date.now(), true);
                                          },
                                      })
                                    : null,
                            ],
                        ),
                    );
                }
            };
            paint();
            const off = view.state.onChange(() => {
                if (!container.contains(document.activeElement)) paint();
            });
            return () => off();
        },
    };
}

/* ------------------------------------------------------------------ Журнал запусков */

export function logTab(view: AgentsView): PultTab {
    return {
        id: 'agents-log',
        titleKey: 'm44.tab.log',
        icon: 'fa-list-check',
        order: 40,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                const runs = [...view.state.runs()].reverse().slice(0, 100);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.log.hint') }));
                if (!runs.length) {
                    container.append(emptyState(view.t('m44.log.none'), 'fa-list-check'));
                    return;
                }
                for (const run of runs) {
                    const status = runStatus(run);
                    const time = new Date(run.startedAt).toLocaleTimeString();
                    const details = el('details', { class: 'maestro-agent-run' }, [
                        el('summary', {}, [
                            el('span', { class: ['maestro-lamp', `maestro-lamp-${status}`] }),
                            ` ${time} · ${run.agentName} · ${run.builtin ? view.t('m44.bi.builtin') : view.t(`m44.phase.${run.phase}`)}${run.test ? ` · ${view.t('m44.log.test')}` : ''}${run.batchId ? ` · ${view.t('m44.log.batch')}` : ''}${run.reason === 'gate' ? ` · ${view.t('m44.gate.skipped')}` : ''}`,
                            run.ok ? '' : ` · ${view.t(`m44.error.${run.error ?? 'other'}`)}`,
                            run.costUsd !== undefined ? ` · ${money(run.costUsd)}` : '',
                            ` · ${(run.ms / 1000).toFixed(1)} s`,
                        ]),
                    ]);
                    details.addEventListener('toggle', () => {
                        if (!details.open || details.dataset.filled) return;
                        details.dataset.filled = '1';
                        append(details, [
                            el('div', {
                                class: 'maestro-muted',
                                text: view.t('m44.log.reason', {
                                    reason: run.reason,
                                    tokens: (run.tokens?.prompt ?? 0) + (run.tokens?.completion ?? 0),
                                }),
                            }),
                            run.applied?.length
                                ? el('div', { text: view.t('m44.log.applied', { what: run.applied.join(', ') }) })
                                : null,
                            run.result !== undefined
                                ? el('pre', {
                                      class: 'maestro-agent-preview',
                                      text: JSON.stringify(run.result, null, 2),
                                  })
                                : null,
                            run.raw !== undefined
                                ? el('details', {}, [
                                      el('summary', { text: view.t('m44.log.raw') }),
                                      el('pre', { class: 'maestro-agent-preview', text: run.raw }),
                                  ])
                                : null,
                            run.request
                                ? el('details', {}, [
                                      el('summary', { text: view.t('m44.log.request') }),
                                      el('pre', {
                                          class: 'maestro-agent-preview',
                                          text: run.request
                                              .map((message) => `── ${message.role} ──\n${message.content}`)
                                              .join('\n\n'),
                                      }),
                                  ])
                                : null,
                            !run.ok && !run.test
                                ? button({
                                      icon: 'fa-rotate-right',
                                      label: view.t('m44.log.retry'),
                                      onClick: () =>
                                          view.runtime
                                              .runManual(run.agentId, { messageIndex: run.messageIndex })
                                              .then(() => undefined),
                                  })
                                : null,
                        ]);
                    });
                    container.append(details);
                }
            };
            paint();
            const off = view.state.onChange(() => paint());
            return () => off();
        },
    };
}

/* ------------------------------------------------------------------ Шаблоны */

export function templatesTab(view: AgentsView): PultTab {
    return {
        id: 'agents-templates',
        titleKey: 'm44.tab.templates',
        icon: 'fa-shapes',
        order: 50,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.templates.hint') }));
                const groups: TemplateGroup[] = [
                    'text',
                    'story',
                    'player',
                    'trackers',
                    'mechanics',
                    'creators',
                    'images',
                ];
                for (const group of groups) {
                    const list = AGENT_TEMPLATES.filter((template) => template.group === group);
                    if (!list.length) continue;
                    container.append(
                        section(
                            view.t(`m44.tplGroup.${group}`),
                            list.map((template) => {
                                const taken = view.store.fromTemplate(template.id);
                                return card({
                                    title: view.templateName(template.id),
                                    subtitle: `${view.t(`m44.phase.${template.trigger.phase}`)} · ${view.t(`m44.type.${template.result.type}`)}`,
                                    body: el('div', { text: view.t(`m44.tpl.${template.id}.desc`) }),
                                    actions: taken
                                        ? [
                                              el('span', {
                                                  class: 'maestro-muted',
                                                  text: view.t('m44.templates.taken'),
                                              }),
                                              button({
                                                  icon: 'fa-pen',
                                                  label: view.t('m44.list.edit'),
                                                  onClick: () => {
                                                      view.editing = taken.id;
                                                      view.app.ui.openPult('agents');
                                                  },
                                              }),
                                          ]
                                        : [
                                              button({
                                                  icon: 'fa-plus',
                                                  label: view.t('m44.templates.take'),
                                                  kind: 'primary',
                                                  onClick: async () => {
                                                      const def = await view.store.takeTemplate(
                                                          template.id,
                                                          view.templateName(template.id),
                                                          () => view.newId(view.templateName(template.id)),
                                                      );
                                                      if (def)
                                                          await view.store.setAgentState('chat', def.id, { on: true });
                                                      paint();
                                                  },
                                              }),
                                          ],
                                });
                            }),
                        ),
                    );
                }
            };
            paint();
            const off = view.store.onChange(() => paint());
            return () => off();
        },
    };
}

/* ------------------------------------------------------------------ Наборы */

export function setsTab(view: AgentsView): PultTab {
    return {
        id: 'agents-sets',
        titleKey: 'm44.tab.sets',
        icon: 'fa-layer-group',
        order: 60,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.sets.hint') }));
                const context = view.store.context();
                const used = (setId: string): string[] => {
                    const out: string[] = [];
                    if (view.store.scopeState('global')?.set === setId) out.push(view.t('m44.scope.global'));
                    if (context.avatar && view.store.scopeState('character')?.set === setId)
                        out.push(view.t('m44.scope.characterNamed', { name: context.characterName ?? '' }));
                    if (context.chatId && view.store.scopeState('chat')?.set === setId)
                        out.push(view.t('m44.scope.chat'));
                    return out;
                };
                container.append(
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            icon: 'fa-floppy-disk',
                            label: view.t('m44.sets.saveCurrent'),
                            kind: 'primary',
                            onClick: async () => {
                                const name = await view.app.ui.prompt?.(view.t('m44.sets.name'));
                                if (!name?.trim()) return;
                                const id = `set-${Date.now().toString(36)}`;
                                await view.store.saveSet(setFromStates(id, name.trim(), view.store.states()));
                                paint();
                            },
                        }),
                        context.avatar
                            ? button({
                                  icon: 'fa-id-card',
                                  label: view.t('m44.sets.toCard'),
                                  onClick: () => view.putIntoCard(view.store.activeAgents().map(({ def }) => def.id)),
                              })
                            : null,
                    ]),
                );
                for (const set of view.store.sets()) {
                    const names = Object.keys(set.agents).map((key) =>
                        key.startsWith('template:')
                            ? view.templateName(key.slice('template:'.length))
                            : (view.store.get(key)?.name ?? key),
                    );
                    const where = used(set.id);
                    const applyButton = (scope: AgentScope, label: string) =>
                        button({
                            label,
                            onClick: async () => {
                                await view.store.applySet(
                                    scope,
                                    set.id,
                                    (templateId) => view.templateName(templateId),
                                    (name) => view.newId(name),
                                );
                                paint();
                            },
                        });
                    container.append(
                        card({
                            title: set.name,
                            subtitle: [
                                set.builtin ? badge(view.t('m44.sets.builtin'), 'muted') : null,
                                where.length ? ` ${view.t('m44.sets.usedIn', { where: where.join(', ') })}` : '',
                            ],
                            body: [
                                set.descriptionKey ? el('div', { text: view.t(set.descriptionKey) }) : null,
                                el('div', {
                                    class: 'maestro-muted',
                                    text: names.length ? names.join(', ') : view.t('m44.sets.emptySet'),
                                }),
                            ],
                            actions: [
                                el('span', { class: 'maestro-muted', text: view.t('m44.sets.applyTo') }),
                                applyButton('global', view.t('m44.scope.global')),
                                context.avatar ? applyButton('character', view.t('m44.scope.character')) : null,
                                context.chatId ? applyButton('chat', view.t('m44.scope.chat')) : null,
                                !set.builtin
                                    ? button({
                                          icon: 'fa-trash',
                                          kind: 'ghost',
                                          title: view.t('m44.sets.remove'),
                                          onClick: async () => {
                                              if (
                                                  await view.app.ui.confirm(
                                                      view.t('m44.sets.remove'),
                                                      view.t('m44.sets.removeBody', { name: set.name }),
                                                  )
                                              ) {
                                                  await view.store.removeSet(set.id);
                                                  paint();
                                              }
                                          },
                                      })
                                    : null,
                            ],
                        }),
                    );
                }
            };
            paint();
            const off = view.store.onChange(() => paint());
            return () => off();
        },
    };
}

/* ------------------------------------------------------------------ Расходы */

export function costTab(view: AgentsView): PultTab {
    return {
        id: 'agents-cost',
        titleKey: 'm44.tab.cost',
        icon: 'fa-coins',
        order: 70,
        group: AGENTS_GROUP,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(el('div', { class: 'maestro-hint', text: view.t('m44.cost.hint') }));
                const runs = view.state.runs();
                const dayStart = new Date();
                dayStart.setHours(0, 0, 0, 0);
                const weekStart = dayStart.getTime() - 6 * 86_400_000;
                const byAgent = new Map<
                    string,
                    { name: string; today: number; week: number; runs: number; turns: Set<number> }
                >();
                for (const run of runs) {
                    if (run.startedAt < weekStart) continue;
                    const row = byAgent.get(run.agentId) ?? {
                        name: run.agentName,
                        today: 0,
                        week: 0,
                        runs: 0,
                        turns: new Set<number>(),
                    };
                    row.week += run.costUsd ?? 0;
                    if (run.startedAt >= dayStart.getTime()) row.today += run.costUsd ?? 0;
                    row.runs += 1;
                    if (run.messageIndex !== undefined) row.turns.add(run.messageIndex);
                    byAgent.set(run.agentId, row);
                }
                if (!byAgent.size) {
                    container.append(emptyState(view.t('m44.cost.none'), 'fa-coins'));
                    return;
                }
                const perTurn = [...byAgent.values()].reduce(
                    (sum, row) => sum + (row.turns.size ? row.week / row.turns.size : 0),
                    0,
                );
                container.append(el('div', { text: view.t('m44.cost.perTurn', { usd: money(perTurn) }) }));
                const table = el('table', { class: 'maestro-table' }, [
                    el(
                        'thead',
                        {},
                        el(
                            'tr',
                            {},
                            [
                                view.t('m44.cost.agent'),
                                view.t('m44.cost.today'),
                                view.t('m44.cost.week'),
                                view.t('m44.cost.runs'),
                            ].map((text) => el('th', { text })),
                        ),
                    ),
                    el(
                        'tbody',
                        {},
                        [...byAgent.values()].map((row) =>
                            el('tr', {}, [
                                el('td', { text: row.name }),
                                el('td', { text: money(row.today) }),
                                el('td', { text: money(row.week) }),
                                el('td', { text: String(row.runs) }),
                            ]),
                        ),
                    ),
                ]);
                container.append(table);
            };
            paint();
            const off = view.state.onChange(() => paint());
            return () => off();
        },
    };
}

/* ------------------------------------------------------------------ the strip under messages */

function stripItems(view: AgentsView, index: number): StripItem[] {
    const message = view.app.host.ctx().chat?.[index];
    if (!message || message.is_user) return [];
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const items: StripItem[] = [];
    for (const result of view.state.resultsOf(index, swipeId)) {
        if (result.dismissed) continue;
        const item = stripItem(view, result, index);
        if (item) items.push(item);
    }
    return items;
}

function stripItem(view: AgentsView, result: MessageResult, index: number): StripItem | null {
    const id = `${result.agentId}:${result.type}`;
    const name = result.agentName;
    switch (result.type) {
        case 'note': {
            const text = String(result.data.text ?? '');
            return {
                id,
                kind: 'info',
                icon: 'fa-comment',
                text: `${name}: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`,
                body:
                    text.length > 160
                        ? (container) => void container.append(el('div', { class: 'maestro-agent-note', text }))
                        : undefined,
                actions: [{ label: view.t('m44.strip.hide'), run: () => view.state.dismiss(result) }],
            };
        }
        case 'verdict': {
            const problems = Array.isArray(result.data.problems)
                ? (result.data.problems as { quote: string; issue: string; fix: string }[])
                : [];
            if (result.data.ok || !problems.length) return null;
            const actions = [
                {
                    label: view.t('m44.strip.redo'),
                    primary: true,
                    run: async () => {
                        await view.runtime.redo(index, name, problems);
                    },
                },
                { label: view.t('m44.strip.fine'), run: () => view.state.dismiss(result) },
            ];
            return {
                id,
                kind: 'proposal',
                tone: 'warn',
                icon: 'fa-triangle-exclamation',
                text: `${name}: ${problems.map((problem) => problem.issue).join('; ')}`,
                body: (container) =>
                    void container.append(
                        ...problems.map((problem) =>
                            el('div', { class: 'maestro-agent-problem' }, [
                                problem.quote ? el('q', { text: problem.quote }) : null,
                                el('div', { text: problem.issue }),
                                problem.fix ? el('div', { class: 'maestro-muted', text: problem.fix }) : null,
                            ]),
                        ),
                    ),
                actions,
            };
        }
        case 'choices': {
            const choices = Array.isArray(result.data.choices) ? (result.data.choices as string[]) : [];
            const def = view.store.get(result.agentId);
            const send = def?.result.type === 'choices' && def.result.options.send;
            return {
                id,
                kind: 'question',
                icon: 'fa-list-ol',
                text: view.t('m44.strip.choices', { name }),
                body: (container) =>
                    void container.append(
                        el(
                            'div',
                            { class: 'maestro-agent-choices' },
                            choices.map((choice) =>
                                button({
                                    label: choice,
                                    className: 'maestro-agent-choice',
                                    onClick: () => {
                                        useChoice(choice, send === true);
                                        view.state.dismiss(result);
                                    },
                                }),
                            ),
                        ),
                    ),
                actions: [{ label: view.t('m44.strip.hide'), run: () => view.state.dismiss(result) }],
            };
        }
        case 'rewrite': {
            const original = String(result.data.original ?? '');
            const changes = Array.isArray(result.data.changes) ? (result.data.changes as string[]) : [];
            return {
                id,
                kind: 'change',
                icon: 'fa-feather-pointed',
                text: view.t('m44.strip.rewrite', { name, count: Math.max(1, changes.length) }),
                body: (container) => {
                    const current = view.app.host.ctx().chat?.[index]?.mes ?? '';
                    append(container, [
                        changes.length
                            ? el(
                                  'ul',
                                  {},
                                  changes.map((change) => el('li', { text: change })),
                              )
                            : null,
                        view.rewriteDiff(original, String(current)),
                    ]);
                },
                actions: [
                    {
                        label: view.t('m44.strip.restore'),
                        run: async () => {
                            const current = view.app.host.ctx().chat?.[index]?.mes;
                            if (typeof current !== 'string') return;
                            if (await view.runtime.writeText(index, current, original)) view.state.dismiss(result);
                        },
                    },
                ],
            };
        }
        case 'memory':
            return {
                id,
                kind: 'fact',
                icon: 'fa-note-sticky',
                text: view.t('m44.strip.memory', { name }),
                open: { window: AGENTS_WINDOW, tab: 'agents-memory' },
            };
        default:
            return null;
    }
}

/** A choice goes into the send box (or is sent). */
function useChoice(text: string, send: boolean): void {
    const area = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    if (!area) return;
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.focus();
    if (send) document.querySelector<HTMLElement>('#send_but')?.click();
}

export function stripProvider(view: AgentsView): MessageStripProvider {
    return {
        id: 'agents',
        order: 60,
        items: (index) => {
            try {
                return stripItems(view, index);
            } catch {
                return [];
            }
        },
        onChange: (listener) => view.state.onChange(listener),
    };
}

export const AGENTS_CSS = `
.maestro-agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); }
.maestro-agent-row .maestro-toggle { margin: 0; }
.maestro-agent-row-main { flex: 1; min-width: 0; }
.maestro-agent-row-name { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.maestro-agent-row-actions { display: flex; gap: 2px; }
.maestro-agent-row-fixed { width: 18px; text-align: center; opacity: 0.5; }
.maestro-agent-subhead { margin: 14px 0 4px; font-size: 1.05em; }
.maestro-agent-row:not(.maestro-on) .maestro-agent-row-name strong { opacity: 0.7; }
.maestro-agent-editor-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.maestro-agent-editor-spacer { flex: 1; }
.maestro-agent-editor { display: grid; grid-template-columns: minmax(140px, 180px) 1fr; gap: 12px; }
.maestro-agent-editor-body { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.maestro-agent-textarea { width: 100%; min-height: 3em; font-family: inherit; resize: vertical; }
.maestro-agent-var, .maestro-agent-variant { display: grid; grid-template-columns: minmax(80px, 160px) 1fr auto; gap: 6px; align-items: start; margin-bottom: 6px; }
.maestro-agent-var:has(> code), .maestro-agent-variant { grid-template-columns: 1fr auto; }
.maestro-agent-var > code, .maestro-agent-variant > input { grid-column: 1 / -1; }
.maestro-agent-source { display: grid; grid-template-columns: 1fr auto 110px; gap: 6px; align-items: center; }
.maestro-agent-preview { white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow: auto; font-size: 0.85em; background: var(--black30a, rgba(0,0,0,.3)); padding: 8px; border-radius: 6px; }
.maestro-agent-preview:empty { display: none; }
.maestro-agent-would { display: flex; gap: 6px; align-items: baseline; margin: 6px 0; }
.maestro-agent-choices { display: flex; flex-direction: column; gap: 4px; }
.maestro-agent-choice { text-align: left; white-space: normal; height: auto; }
.maestro-agent-problem { margin: 4px 0; }
.maestro-agent-memory-field { margin-bottom: 8px; }
.maestro-agent-run summary { cursor: pointer; }
.maestro-agent-run { padding: 4px 0; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); }
.maestro-agent-wait { display: flex; gap: 8px; align-items: center; justify-content: center; font-size: 0.85em; padding: 2px 6px; opacity: 0.9; }
#chat .mes.maestro-agent-hold .mes_text { filter: blur(4px); transition: filter .2s; }
#chat .mes.maestro-agent-hold::after { content: attr(data-maestro-hold); display: block; text-align: center; font-size: 0.85em; opacity: 0.8; padding: 4px; }
@media (max-width: 1000px) {
  .maestro-agent-editor { grid-template-columns: 1fr; }
  .maestro-agent-var, .maestro-agent-variant { grid-template-columns: 1fr auto; }
  .maestro-agent-var > code { grid-column: 1 / -1; }
  .maestro-agent-source { grid-template-columns: 1fr 90px; }
  .maestro-agent-source > .maestro-muted { display: none; }
}
`;
