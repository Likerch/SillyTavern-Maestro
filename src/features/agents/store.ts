// Where agents live (plan §4.3): the definitions, the user's sets and the «везде» scope in `maestro-agents.json`
// (versions with undo through the journal, target 'agent-def'), the character and chat scopes in scoped documents
// (core/scoped-docs.ts, kind 'agents-scope'), card agents in `data.extensions.maestro.agents` of the card (merge only).
// The state of an agent in the open chat = sets and point changes of the three scopes, the nearest winning.
import { currentScopeContext, ScopedDocs } from '../../core/scoped-docs';
import type { ScopeContext, ScopeKind } from '../../core/scoped-docs';
import {
    capabilitiesOf,
    effectiveStates,
    sanitizeAgent,
    sanitizeScopeState,
    sanitizeSet,
} from '../../domain/agents/def';
import { BUILTIN_SETS, DEFAULT_SET_ID, agentFromTemplate, templateById } from '../../domain/agents/templates';
import { sanitizeOverride } from '../../domain/agents/builtin';
import type { BuiltInOverride } from '../../domain/agents/builtin';
import type { AgentDef, AgentScope, AgentScopeState, AgentSet, AgentState } from '../../domain/agents/types';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const AGENTS_FILE = 'agents';
export const SCOPE_DOC_KIND = 'agents-scope';
export const DEF_TARGET = 'agent-def';
export const SCOPE_TARGET = 'agent-scope';
export const BUILTIN_TARGET = 'agent-builtin';

interface AgentsFile {
    schema: 1;
    agents: AgentDef[];
    sets: AgentSet[];
    global: AgentScopeState;
    /** The one-time hint about the ready sets was shown (plan В17). */
    hintShown?: boolean;
    /** Card agents the user decided about: card avatar → hash of the agents he saw (plan В6). */
    cards?: Record<string, string>;
    /** What the user changed in built-in agents (release 1.29): task id → override. */
    builtins?: Record<string, BuiltInOverride>;
}

function emptyFile(): AgentsFile {
    return { schema: 1, agents: [], sets: [], global: { set: DEFAULT_SET_ID, overrides: {} } };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeFile(raw: unknown, now: number): AgentsFile {
    if (!isDict(raw)) return emptyFile();
    const agents: AgentDef[] = [];
    if (Array.isArray(raw.agents)) {
        for (const item of raw.agents) {
            const def = sanitizeAgent(item, now);
            if (def && !agents.some((agent) => agent.id === def.id)) agents.push(def);
        }
    }
    const sets: AgentSet[] = [];
    if (Array.isArray(raw.sets)) {
        for (const item of raw.sets) {
            const set = sanitizeSet(item);
            if (set && !sets.some((other) => other.id === set.id)) sets.push(set);
        }
    }
    const file: AgentsFile = {
        schema: 1,
        agents,
        sets,
        global: isDict(raw.global) ? sanitizeScopeState(raw.global) : { set: DEFAULT_SET_ID, overrides: {} },
    };
    if (raw.hintShown === true) file.hintShown = true;
    if (isDict(raw.builtins)) {
        const builtins: Record<string, BuiltInOverride> = {};
        for (const [id, value] of Object.entries(raw.builtins)) {
            const override = sanitizeOverride(value);
            if (override && /^[a-zA-Z][\w.]{0,60}$/.test(id)) builtins[id] = override;
        }
        if (Object.keys(builtins).length) file.builtins = builtins;
    }
    if (isDict(raw.cards)) {
        const cards: Record<string, string> = {};
        for (const [avatar, hash] of Object.entries(raw.cards)) if (typeof hash === 'string') cards[avatar] = hash;
        file.cards = cards;
    }
    return file;
}

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** The agents of a card (`data.extensions.maestro.agents`). */
export interface CardAgents {
    agents: AgentDef[];
    /** The card's set (its agents' states), if it carries one. */
    set?: AgentSet;
}

export function readCardAgents(card: unknown, now: number): CardAgents | null {
    if (!isDict(card)) return null;
    const data = isDict(card.data) ? card.data : undefined;
    const ext = data && isDict(data.extensions) ? data.extensions : undefined;
    const maestro = ext && isDict(ext.maestro) ? ext.maestro : undefined;
    const raw = maestro && isDict(maestro.agents) ? maestro.agents : undefined;
    if (!raw || !Array.isArray(raw.agents)) return null;
    const agents = raw.agents
        .map((item) => sanitizeAgent(item, now))
        .filter((def): def is AgentDef => def !== null)
        .slice(0, 20);
    if (!agents.length) return null;
    const out: CardAgents = { agents };
    const set = sanitizeSet(raw.set);
    if (set) out.set = set;
    return out;
}

export class AgentStore {
    private file: AgentsFile = emptyFile();
    private loaded: Promise<void> | null = null;
    private readonly listeners = new Set<() => void>();
    private writeChain: Promise<void> = Promise.resolve();
    readonly scopes: ScopedDocs<AgentScopeState>;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly now: () => number = Date.now,
    ) {
        this.scopes = new ScopedDocs<AgentScopeState>(
            { files: app.files, chat: app.chat, log },
            {
                kind: SCOPE_DOC_KIND,
                defaults: () => ({ overrides: {} }),
                sanitize: sanitizeScopeState,
                onError: () => app.ui.notice(app.i18n.t('m44.saveFailed'), { level: 'error' }),
            },
        );
    }

    private fileName(): string {
        return this.app.files.fileName(AGENTS_FILE);
    }

    load(): Promise<void> {
        if (!this.loaded) {
            this.loaded = this.app.files
                .read<unknown>(this.fileName())
                .then((raw) => {
                    this.file = sanitizeFile(raw, this.now());
                })
                .catch((error: unknown) => {
                    this.log.warn('could not read agents', error);
                    this.file = emptyFile();
                })
                .then(() => this.loadScopes())
                .then(() => this.changed());
        }
        return this.loaded;
    }

    /** Loads the character and chat scope documents of the open chat. */
    async loadScopes(): Promise<void> {
        try {
            await this.scopes.load(currentScopeContext(this.app.host));
        } catch (error) {
            this.log.warn('could not read agent scopes', error);
        }
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('agents listener failed', error);
            }
        }
    }

    /** Writes the file: a fresh read, the change replayed on it (two tabs merge instead of overwriting). */
    private async write(change: (file: AgentsFile) => void): Promise<void> {
        change(this.file);
        this.changed();
        const job = this.writeChain.then(async () => {
            try {
                const fresh = sanitizeFile(
                    await this.app.files.read<unknown>(this.fileName(), { fresh: true }),
                    this.now(),
                );
                change(fresh);
                await this.app.files.write(this.fileName(), fresh);
                this.file = fresh;
            } catch (error) {
                this.log.warn('could not save agents', error);
                this.app.ui.notice(this.app.i18n.t('m44.saveFailed'), { level: 'error' });
            }
        });
        this.writeChain = job;
        await job;
        this.changed();
    }

    /* ------------------------------------------------------------ definitions */

    list(): AgentDef[] {
        return this.file.agents;
    }

    get(id: string): AgentDef | undefined {
        return this.file.agents.find((agent) => agent.id === id);
    }

    /** Saves a definition (new or changed) with a journal record and undo. */
    async save(def: AgentDef, summary: string): Promise<void> {
        const clean = sanitizeAgent({ ...def, updatedAt: this.now() }, this.now());
        if (!clean) throw new Error('invalid agent');
        clean.capabilities = capabilitiesOf(clean);
        const before = this.get(clean.id);
        await this.write((file) => {
            const index = file.agents.findIndex((agent) => agent.id === clean.id);
            if (index >= 0) file.agents[index] = copy(clean);
            else file.agents.push(copy(clean));
        });
        await this.journal(summary, clean.id, before ?? null, clean);
    }

    async remove(id: string, summary: string): Promise<void> {
        const before = this.get(id);
        if (!before) return;
        await this.write((file) => {
            file.agents = file.agents.filter((agent) => agent.id !== id);
        });
        await this.journal(summary, id, before, null);
    }

    private async journal(summary: string, id: string, before: AgentDef | null, after: AgentDef | null): Promise<void> {
        try {
            await this.app.journal.record({
                module: 'agents',
                kind: 'agents.def',
                summary,
                changes: [
                    {
                        target: DEF_TARGET,
                        ref: { id },
                        before: before ? copy(before) : null,
                        after: after ? copy(after) : null,
                    },
                ],
            });
        } catch (error) {
            this.log.debug('journal record failed', error);
        }
    }

    /** Undo of a definition change: puts the previous version back (or removes a created agent). */
    async undoDef(id: string, before: unknown): Promise<boolean> {
        const def = before === null ? null : sanitizeAgent(before, this.now());
        await this.write((file) => {
            file.agents = file.agents.filter((agent) => agent.id !== id);
            if (def) file.agents.push(def);
        });
        return true;
    }

    /** The own agent taken from a template (the first one), if any. */
    fromTemplate(templateId: string): AgentDef | undefined {
        return this.file.agents.find((agent) => agent.templateId === templateId);
    }

    /** Takes a template into work: a new own agent (or the existing copy). */
    async takeTemplate(templateId: string, name: string, newId: () => string): Promise<AgentDef | null> {
        const existing = this.fromTemplate(templateId);
        if (existing) return existing;
        const template = templateById(templateId);
        if (!template) return null;
        const def = agentFromTemplate(template, name, newId(), this.now(), capabilitiesOf);
        await this.save(def, this.app.i18n.t('m44.journal.taken', { name }));
        return def;
    }

    /* ------------------------------------------------------------ sets */

    sets(): AgentSet[] {
        const builtins = BUILTIN_SETS.map((set) => {
            const own = this.file.sets.find((item) => item.id === set.id);
            const name = set.titleKey ? this.app.i18n.t(set.titleKey) : set.name;
            return own
                ? { ...own, builtin: true, titleKey: set.titleKey, descriptionKey: set.descriptionKey, name }
                : { ...set, name };
        });
        const own = this.file.sets.filter((set) => !BUILTIN_SETS.some((builtin) => builtin.id === set.id));
        return [...builtins, ...own];
    }

    setById(id: string): AgentSet | undefined {
        return this.sets().find((set) => set.id === id);
    }

    async saveSet(set: AgentSet): Promise<void> {
        const clean = sanitizeSet(set);
        if (!clean) throw new Error('invalid set');
        await this.write((file) => {
            const index = file.sets.findIndex((item) => item.id === clean.id);
            if (index >= 0) file.sets[index] = clean;
            else file.sets.push(clean);
        });
    }

    async removeSet(id: string): Promise<void> {
        await this.write((file) => {
            file.sets = file.sets.filter((set) => set.id !== id);
        });
    }

    /** «Вернуть как было» of a built-in set the user changed. */
    async resetBuiltinSet(id: string): Promise<void> {
        await this.removeSet(id);
    }

    /* ------------------------------------------------------------ built-in agents (release 1.29) */

    builtinOverride(id: string): BuiltInOverride | undefined {
        return this.file.builtins?.[id];
    }

    /** Saves what the user changed in a built-in agent (null: back to the defaults), journaled with undo. */
    async setBuiltinOverride(id: string, override: BuiltInOverride | null, summary: string): Promise<void> {
        const clean = override ? sanitizeOverride(override) : null;
        const before = this.builtinOverride(id) ?? null;
        await this.write((file) => {
            const next = { ...(file.builtins ?? {}) };
            if (clean) next[id] = clean;
            else delete next[id];
            file.builtins = Object.keys(next).length ? next : undefined;
        });
        try {
            await this.app.journal.record({
                module: 'agents',
                kind: 'agents.builtin',
                summary,
                changes: [
                    {
                        target: BUILTIN_TARGET,
                        ref: { id },
                        before: before ? copy(before) : null,
                        after: clean ? copy(clean) : null,
                    },
                ],
            });
        } catch (error) {
            this.log.debug('journal record failed', error);
        }
    }

    /** Undo of a built-in agent change. */
    async undoBuiltin(id: string, before: unknown): Promise<boolean> {
        const override = before === null ? null : sanitizeOverride(before);
        await this.write((file) => {
            const next = { ...(file.builtins ?? {}) };
            if (override) next[id] = override;
            else delete next[id];
            file.builtins = Object.keys(next).length ? next : undefined;
        });
        return true;
    }

    cardDecision(avatar: string): string | undefined {
        return this.file.cards?.[avatar];
    }

    async setCardDecision(avatar: string, hash: string): Promise<void> {
        await this.write((file) => {
            file.cards = { ...(file.cards ?? {}), [avatar]: hash };
        });
    }

    hintShown(): boolean {
        return this.file.hintShown === true;
    }

    async markHintShown(): Promise<void> {
        await this.write((file) => {
            file.hintShown = true;
        });
    }

    /* ------------------------------------------------------------ scopes */

    context(): ScopeContext {
        return currentScopeContext(this.app.host);
    }

    scopeState(scope: AgentScope, context: ScopeContext = this.context()): AgentScopeState | null {
        if (scope === 'global') return this.file.global;
        const owner = scope === 'character' ? context.avatar : context.chatId;
        if (!owner) return null;
        return this.scopes.get(scope, owner) ?? null;
    }

    async updateScope(scope: AgentScope, change: (state: AgentScopeState) => void): Promise<void> {
        if (scope === 'global') {
            await this.write((file) => change(file.global));
            return;
        }
        const context = this.context();
        const owner = scope === 'character' ? context.avatar : context.chatId;
        if (!owner) return;
        await this.scopes.mutate(scope as ScopeKind, owner, change);
        this.changed();
    }

    /** Template id → own agent id (for built-in sets that name templates). */
    templateAgents(): Map<string, string> {
        const map = new Map<string, string>();
        for (const agent of this.file.agents)
            if (agent.templateId && !map.has(agent.templateId)) map.set(agent.templateId, agent.id);
        return map;
    }

    /** The state of every agent in the open chat (nearest scope wins). */
    states(context: ScopeContext = this.context()): Map<string, AgentState> {
        const sets = new Map(this.sets().map((set) => [set.id, set]));
        const layers = [
            this.scopeState('global', context),
            this.scopeState('character', context),
            this.scopeState('chat', context),
        ];
        return effectiveStates(layers, sets, this.templateAgents());
    }

    /** The agents that are on in the open chat. */
    activeAgents(): { def: AgentDef; state: AgentState }[] {
        const states = this.states();
        const out: { def: AgentDef; state: AgentState }[] = [];
        for (const def of this.file.agents) {
            const state = states.get(def.id);
            if (state?.on) out.push({ def, state });
        }
        return out;
    }

    /**
     * Applies a set to a scope: the agents a built-in set names by template are taken into work first, the scope's own
     * switches of agents the set decides are cleared.
     */
    async applySet(
        scope: AgentScope,
        setId: string,
        nameOf: (templateId: string) => string,
        newId: (name: string) => string,
    ): Promise<void> {
        const set = this.setById(setId);
        if (!set) return;
        for (const key of Object.keys(set.agents)) {
            if (!key.startsWith('template:')) continue;
            const templateId = key.slice('template:'.length);
            const name = nameOf(templateId);
            await this.takeTemplate(templateId, name, () => newId(name));
        }
        await this.updateScope(scope, (state) => {
            state.set = setId;
            state.overrides = {};
        });
    }

    /** A scope stops naming a set (its point changes stay). */
    async clearSet(scope: AgentScope): Promise<void> {
        await this.updateScope(scope, (state) => {
            delete state.set;
        });
    }

    /** Switches one agent in a scope (a point change over the set). */
    async setAgentState(scope: AgentScope, agentId: string, patch: Partial<AgentState> | null): Promise<void> {
        await this.updateScope(scope, (state) => {
            if (patch === null) {
                delete state.overrides[agentId];
                return;
            }
            const next: Partial<AgentState> = { ...(state.overrides[agentId] ?? {}), ...patch };
            for (const key of Object.keys(next) as (keyof AgentState)[]) if (next[key] === undefined) delete next[key];
            if (Object.keys(next).length) state.overrides[agentId] = next;
            else delete state.overrides[agentId];
        });
    }

    async flush(): Promise<void> {
        await this.writeChain;
        await this.scopes.flush();
    }
}

export { copy as copyJson };
