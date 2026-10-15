// M25 «Механики», prompt part (plan M25 п.5, §5 phase 2, M34 п.8, P15, P16; release 1.27): one ephemeral producer per
// generation (normal, swipe, regenerate, continue; impersonate gets the rules without the service-block instruction,
// the state, and no facts; quiet/background generations and sheet scenarios are left alone, like the other producers):
// - the flag `maestro_mech_<id>` for every mechanic with a holder in the scene (conditional preset blocks);
// - two blocks of the mechanics in the scene (domain/mechanics-prompt.ts renderGame), fitted together to the
//   Architect's «mechanics» budget when it is set, else to settings.promptBudget (the blocks fit themselves: the
//   Architect only measures both slots), never scanned, system role:
//   · the rules `<game_rules>` (slot `maestro_mechanics_rules`): the framing line, each mechanic's rules, the tracking
//     part's block instruction at the end. Stable while the scene's mechanics do not change (definition order), so
//     settings.rulesPlace 'top' (default) puts it IN_PROMPT — ST's Chat Completion adds an in-prompt extension prompt
//     right after the main prompt (openai.js getPromptPosition → 'end', injectToMain), the cache-friendly head of the
//     prompt; 'end' puts it right before the state in the state's slot (a separate slot at the same depth would sort
//     after the state: ST joins the slots of one depth by key);
//   · the state `<game_state>` (slot `maestro_mechanics`, the key the Architect and the neighbour prompts know) in the
//     chat at settings.stateDepth (default 0, P16): per holder the values with their band words, the lasting events
//     that hold now, the conditions with their modifiers, the inventory; the fight, DES's tracker stats (attributes DES
//     keeps: tracking.desTracked) and the closing line;
// - the facts (pending check results and fired events) at depth 0 for one generation, right after the state (same depth
//   and role: ST merges the slots in key order, `maestro_mechanics` < `maestro_mechanics_facts`); they are marked
//   delivered when the generation ends without being stopped, and a swipe / regenerate / continue of the same reply
//   gets them again (the roll belongs to the user's message: it is never rolled again).
// Sections come most important first: mechanics with facts in this generation, changed in the last two turns, named
// in the user's latest message (name, keys, attributes, a holder), the rest — the cutting goes from the end.
// Everything is read from memory (definitions, state, the roll log): nothing is awaited on the send path (P15).
import { combatLine } from '../../domain/mechanics-combat';
import { initialValueOf } from '../../domain/mechanics-defs';
import {
    defaultModifierLabel,
    mentionedIn,
    orderSections,
    renderFacts,
    renderGame,
    trackerLine,
} from '../../domain/mechanics-prompt';
import type {
    CutStep,
    HolderExtras,
    ModifierLabel,
    PromptSection,
    RenderedGame,
    SectionSignals,
} from '../../domain/mechanics-prompt';
import { WORLD_HOLDER } from '../../domain/mechanics-state';
import { resolveVisibility } from '../../domain/mechanics-visibility';
import type { GenerationInfo, Unsubscribe } from '../../shared/contracts';
import type { ArchitectApi } from '../architect/api';
import type { AttributeValue, CheckResult, FiredEvent, MechanicDef } from './api';
import { nameKey } from './checks';
import { FLAG_PREFIX, INJECT_FACTS, INJECT_RULES, INJECT_STATE } from './parts';
import type { ChecksPart, DefinitionsPart, PartDeps, RulesPlace, StatePart, TrackingPart } from './parts';

export const PROMPT_PRODUCER = 'mechanics';
/**
 * app.ephemeral prefixes injection keys with `maestro_` (core/ephemeral.ts injectionKey): these keys give the
 * extension prompt slots INJECT_STATE (`maestro_mechanics`), INJECT_RULES (`maestro_mechanics_rules`) and INJECT_FACTS
 * (`maestro_mechanics_facts`).
 */
export const STATE_KEY = INJECT_STATE.replace(/^maestro_/, '');
export const RULES_KEY = INJECT_RULES.replace(/^maestro_/, '');
export const FACTS_KEY = INJECT_FACTS.replace(/^maestro_/, '');
/** ST extension_prompt_types: in the prompt (after the main prompt in Chat Completion), in the chat at a depth. */
const IN_PROMPT = 0;
const IN_CHAT = 1;
/** Facts given in one generation at most (the newest). */
const FACTS_MAX = 8;
/** Results looked through when a swipe repeats the delivered facts. */
const REPEAT_LOOKUP = 50;
/** Changes looked through for the mechanics changed in the last turns. */
const HISTORY_LOOKUP = 200;
/** User turns a change keeps its mechanic among the important ones. */
const RECENT_TURNS = 2;

/** `maestro_mech_<id>`, safe for `{{if .name}}` whatever the id. */
export function mechanicFlag(id: string): string {
    return `${FLAG_PREFIX}${id.replace(/[^\w]/g, '_')}`;
}

/** The flags the mechanics can set, for the Preset Studio's conditions catalogue (one per mechanic). */
export function mechanicFlags(defs: MechanicDef[]): { flag: string; label: string }[] {
    const seen = new Set<string>();
    const result: { flag: string; label: string }[] = [];
    for (const def of defs) {
        const flag = mechanicFlag(def.id);
        if (seen.has(flag)) continue;
        seen.add(flag);
        result.push({ flag, label: def.name || def.id });
    }
    return result;
}

/** The rules and the state as one text (the state slot's text when the rules go right before it). */
export function joinBlocks(rules: string, state: string): string {
    return [rules, state].filter(Boolean).join('\n');
}

export interface MechanicsPromptPreview {
    /** Both blocks as the next generation would get them, the rules first ('' when no mechanic takes part). */
    text: string;
    /** The rules block (`<game_rules>`) and the state block (`<game_state>`) apart. */
    rules: string;
    state: string;
    /** Where they go: the rules at the top of the prompt or right before the state; the state's depth in the chat. */
    placement: { rules: RulesPlace; stateDepth: number };
    tokens: number;
    budget: number;
    budgetSource: 'architect' | 'own';
    cut: CutStep[];
    /** Mechanics in the scene (their flags are set). */
    mechanics: string[];
    flags: string[];
    /** The facts block the next normal generation would get. */
    facts: string;
}

interface Armed {
    chatId: string;
    /** Index of the reply the generation writes. */
    forIndex: number;
    checks: CheckResult[];
    events: FiredEvent[];
    /** What becomes delivered when the generation ends. */
    pendingChecks: CheckResult[];
    pendingEvents: FiredEvent[];
}

interface Delivered {
    chatId: string;
    forIndex: number;
    checkIds: string[];
    events: FiredEvent[];
}

interface SceneEntry {
    def: MechanicDef;
    holders: string[];
}

interface Built {
    scene: SceneEntry[];
    rendered: RenderedGame;
    source: 'architect' | 'own';
    place: RulesPlace;
    stateDepth: number;
}

function eventKey(event: FiredEvent): string {
    return `${event.mechanicId}|${event.holder}|${event.attribute}|${event.eventId}|${event.messageIndex}|${event.at}`;
}

function compact(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export class MechanicPrompt {
    private armed: Armed | null = null;
    private last: Delivered | null = null;
    private readonly offs: Unsubscribe[] = [];
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly state: StatePart,
        private readonly tracking: TrackingPart,
        private readonly checks: ChecksPart,
    ) {}

    install(): void {
        const { app } = this.deps;
        this.offs.push(app.ephemeral.addProducer(PROMPT_PRODUCER, (gen) => this.produce(gen)));
        this.offs.push(app.bus.on('generation:ended', ({ stopped }) => this.ended(stopped)));
        this.offs.push(
            app.bus.on('chat:changed', () => {
                this.armed = null;
                this.last = null;
            }),
        );
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.armed = null;
        this.last = null;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('prompt: release failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- reading */

    private safe<T>(read: () => T, fallback: T, what: string): T {
        try {
            return read();
        } catch (error) {
            this.deps.log.warn(`mechanics prompt: ${what} is not available`, error);
            return fallback;
        }
    }

    private scene(): SceneEntry[] {
        const defs = this.safe(() => this.defs.active(), [], 'the definitions');
        const scene: SceneEntry[] = [];
        for (const def of defs) {
            const holders = this.safe(() => this.state.holdersInScene(def), [], 'the scene');
            if (holders.length) scene.push({ def, holders });
        }
        return scene;
    }

    private values(def: MechanicDef, holder: string): Record<string, AttributeValue | null> {
        const values: Record<string, AttributeValue | null> = {};
        for (const attribute of def.attributes) {
            if (resolveVisibility(def, attribute).prompt === 'none') continue;
            try {
                const effective =
                    attribute.kind === 'number' ? (this.state.numberOf?.(def.id, holder, attribute.id) ?? null) : null;
                values[attribute.id] =
                    effective ?? this.state.value(def.id, holder, attribute.id) ?? initialValueOf(attribute);
            } catch {
                values[attribute.id] = initialValueOf(attribute);
            }
        }
        return values;
    }

    /** Conditions and inventories of the holders in the scene, as the model may know them. */
    private extras(scene: readonly SceneEntry[]): HolderExtras[] {
        const names: string[] = [];
        const add = (list: string[], holder: string) => {
            if (!list.some((name) => nameKey(name) === nameKey(holder))) list.push(holder);
        };
        for (const entry of scene) {
            if (entry.def.holders.kind === 'world' || entry.def.holders.kind === 'factions') continue;
            for (const holder of entry.holders) add(names, holder);
        }
        const statuses = this.safe(() => this.state.statuses?.() ?? [], [], 'the statuses');
        const known = (mechanicId: string | undefined) => {
            const def = mechanicId ? this.safe(() => this.defs.get(mechanicId), null, 'a definition') : null;
            return !def || resolveVisibility(def).prompt !== 'none';
        };
        const items = this.safe(() => this.state.items?.() ?? [], [], 'the items');
        const carriers: string[] = [];
        for (const entry of scene) {
            if (entry.def.inventory === undefined || resolveVisibility(entry.def).prompt === 'none') continue;
            for (const holder of entry.holders) add(carriers, holder);
        }
        const everyone = [...names];
        for (const holder of carriers) add(everyone, holder);
        return everyone.map((holder) => ({
            holder,
            statuses: names.some((name) => nameKey(name) === nameKey(holder))
                ? (statuses.find((entry) => nameKey(entry.holder) === nameKey(holder))?.statuses ?? []).filter(
                      (status) => known(status.mechanicId),
                  )
                : [],
            items: carriers.some((name) => nameKey(name) === nameKey(holder))
                ? (items.find((entry) => nameKey(entry.holder) === nameKey(holder))?.items ?? [])
                : [],
        }));
    }

    /** Modifier keys in the words of the definitions: a check's or an attribute's English name. */
    private modifierLabel(): ModifierLabel {
        const defs = this.safe(() => this.defs.active(), [], 'the definitions');
        return (key, mechanicId) => {
            const clean = key.trim();
            if (clean.toLowerCase() === 'checks') return 'checks';
            const own = mechanicId ? defs.find((def) => def.id === mechanicId) : undefined;
            const order = own ? [own, ...defs.filter((def) => def !== own)] : defs;
            if (/^check:/i.test(clean)) {
                const id = clean.slice(6).trim();
                for (const def of order) {
                    const check = def.checks.find((item) => item.id === id);
                    if (check) return `${compact(check.promptName || check.name).toLowerCase()} checks`;
                }
                return defaultModifierLabel(key);
            }
            const dot = clean.indexOf('.');
            const pool = dot > 0 ? defs.filter((def) => def.id === clean.slice(0, dot)) : order;
            const id = dot > 0 ? clean.slice(dot + 1) : clean;
            for (const def of pool) {
                const attribute = def.attributes.find((item) => item.id === id);
                if (attribute) return compact(attribute.promptName || attribute.name).toLowerCase();
            }
            return defaultModifierLabel(key);
        };
    }

    private sections(scene: readonly SceneEntry[]): PromptSection[] {
        const persona = nameKey(this.deps.app.host.ctx().name1 ?? '');
        return scene.map(({ def, holders }) => {
            const own = persona ? holders.findIndex((name) => nameKey(name) === persona) : -1;
            const primary = own >= 0 ? own : 0;
            return {
                mechanic: def,
                holders: holders.map((name, index) => ({
                    name,
                    primary: index === primary,
                    ...(index === own ? { persona: true } : {}),
                    values: this.values(def, name),
                })),
            };
        });
    }

    /** What makes a mechanic important now: facts of this generation, recent changes, the user's latest message. */
    private signals(scene: readonly SceneEntry[], facts: Iterable<string>): SectionSignals {
        const chat = this.deps.app.host.ctx().chat ?? [];
        const users: number[] = [];
        chat.forEach((message, index) => {
            if (message?.is_user) users.push(index);
        });
        const floor = users[users.length - RECENT_TURNS] ?? 0;
        const history = this.safe(() => this.state.history(HISTORY_LOOKUP), [], 'the history');
        const changed = new Set(
            history
                .filter((change) => change.messageIndex >= 0 && change.messageIndex >= floor)
                .map((c) => c.mechanicId),
        );
        const latest = users.length ? chat[users[users.length - 1] as number] : undefined;
        const text = typeof latest?.mes === 'string' ? latest.mes : '';
        const persona = nameKey(this.deps.app.host.ctx().name1 ?? '');
        const named = text
            ? scene
                  .filter(({ def, holders }) => {
                      const words = [
                          def.name,
                          def.promptName ?? '',
                          ...(def.keys ?? []),
                          ...def.attributes
                              .filter((attribute) => resolveVisibility(def, attribute).prompt !== 'none')
                              .flatMap((attribute) => [attribute.name, attribute.promptName]),
                          ...holders.filter((holder) => holder !== WORLD_HOLDER && nameKey(holder) !== persona),
                      ].filter((word) => word.trim());
                      return mentionedIn(text, words);
                  })
                  .map((entry) => entry.def.id)
            : [];
        return { facts, changed, named };
    }

    /** DES's tracker line: the stats DES keeps for the characters of the scene whose numbers the model gets. */
    private desLine(scene: readonly SceneEntry[]): string {
        if (!this.tracking.desTracked) return '';
        const persona = nameKey(this.deps.app.host.ctx().name1 ?? '');
        const names: string[] = [];
        for (const { def, holders } of scene) {
            if (!holders.some((holder) => nameKey(holder) !== persona && holder !== WORLD_HOLDER)) continue;
            const tracked = this.safe(() => this.tracking.desTracked?.(def) ?? [], [], 'the DES stats');
            for (const item of tracked) {
                const attribute = def.attributes.find((attr) => attr.id === item.attribute);
                if (attribute && resolveVisibility(def, attribute).prompt === 'value') names.push(item.stat);
            }
        }
        return trackerLine(names);
    }

    /** The Architect's «mechanics» budget wins when it is set; else the module's own. */
    budget(): { tokens: number; source: 'architect' | 'own' } {
        try {
            const row = this.deps.app.modules
                .api<ArchitectApi>('architect')
                ?.budgets()
                .find((item) => item.source === 'mechanics');
            if (row && row.tokens > 0) return { tokens: row.tokens, source: 'architect' };
        } catch (error) {
            this.deps.log.debug('architect budgets are not available', error);
        }
        const own = this.deps.settings().promptBudget;
        return { tokens: typeof own === 'number' && own > 0 ? own : 0, source: 'own' };
    }

    private placement(): { place: RulesPlace; stateDepth: number } {
        const settings = this.deps.settings();
        const depth = settings.stateDepth;
        return {
            place: settings.rulesPlace === 'end' ? 'end' : 'top',
            stateDepth: typeof depth === 'number' && Number.isFinite(depth) ? Math.max(0, Math.round(depth)) : 0,
        };
    }

    private build(withInstruction: boolean, facts: Iterable<string> = []): Built {
        const scene = this.scene();
        const budget = this.budget();
        const { place, stateDepth } = this.placement();
        if (!scene.length) {
            return {
                scene,
                rendered: {
                    rules: '',
                    state: '',
                    tokens: 0,
                    rulesTokens: 0,
                    stateTokens: 0,
                    budget: budget.tokens,
                    cut: [],
                    mechanics: [],
                },
                source: budget.source,
                place,
                stateDepth,
            };
        }
        let instruction = '';
        const combat = this.safe(() => this.state.combat?.() ?? null, null, 'the fight');
        if (withInstruction) {
            const holders: Record<string, string[]> = {};
            for (const entry of scene) holders[entry.def.id] = entry.holders;
            const checks = this.deps.settings().modelRolls
                ? this.safe(() => this.checks.checkNames?.() ?? [], [], 'the checks')
                : [];
            const fights = scene.some((entry) => entry.def.combat !== undefined);
            instruction = this.safe(
                () =>
                    this.tracking.blockInstruction(
                        scene.map((entry) => entry.def),
                        holders,
                        { ...(checks.length ? { checks } : {}), ...(fights ? { combat: true } : {}) },
                    ),
                '',
                'the block instruction',
            );
        }
        // A secret mechanic is Maestro's alone: no rules, no values (its flag still serves the preset's blocks).
        const known = scene.filter((entry) => resolveVisibility(entry.def).prompt !== 'none');
        const ordered = orderSections(this.sections(known), this.signals(known, facts));
        const fixed = [combatLine(combat), this.desLine(known)].filter(Boolean);
        const rendered = renderGame(ordered, {
            budget: budget.tokens,
            instruction,
            extras: this.extras(scene),
            fixed,
            // The rules keep the definitions' order: the block stays the same while the scene's mechanics do.
            rulesOrder: known.map((entry) => entry.def.id),
            place,
            modifierLabel: this.modifierLabel(),
        });
        return { scene, rendered, source: budget.source, place, stateDepth };
    }

    /** The facts of a generation: the delivered ones of the same reply again (swipes), then the pending ones. */
    private facts(chatId: string, type: string, forIndex: number): Omit<Armed, 'chatId' | 'forIndex'> {
        const pendingChecks = this.safe(() => this.checks.pendingChecks(), [], 'the roll log');
        const pendingEvents = this.safe(() => this.state.pendingEvents(), [], 'the events');
        let checks = pendingChecks;
        let events = pendingEvents;
        const last = this.last;
        if (type !== 'normal' && last && last.chatId === chatId && last.forIndex === forIndex) {
            const fresh = new Set(pendingChecks.map((result) => result.id));
            const known = this.safe(() => this.checks.checks(REPEAT_LOOKUP), [], 'the roll log');
            // A roll dropped since (its message was edited away) is not in the log any more and is not repeated.
            const repeated = last.checkIds
                .filter((id) => !fresh.has(id))
                .map((id) => known.find((result) => result.id === id))
                .filter((result): result is CheckResult => !!result);
            checks = [...repeated, ...pendingChecks];
            const seen = new Set(pendingEvents.map(eventKey));
            events = [...last.events.filter((event) => !seen.has(eventKey(event))), ...pendingEvents];
        }
        return { checks, events, pendingChecks, pendingEvents };
    }

    /** Events the model may hear of: a secret mechanic's own status ending stays Maestro's. */
    private told(events: readonly FiredEvent[]): FiredEvent[] {
        return events.filter((event) => {
            if (event.attribute !== 'status') return true;
            const def = this.safe(() => this.defs.get(event.mechanicId), null, 'a definition');
            return !def || resolveVisibility(def).prompt !== 'none';
        });
    }

    /** The facts block and the mechanics it is about. */
    private factsText(facts: Omit<Armed, 'chatId' | 'forIndex'>): { text: string; mechanics: string[] } {
        const told = this.told(facts.events);
        const entries = [
            ...facts.checks.map((result) => ({ text: result.text, mechanicId: result.mechanicId })),
            ...told.map((event) => ({ text: event.text, mechanicId: event.mechanicId })),
        ].slice(-FACTS_MAX);
        return {
            text: renderFacts(entries.map((entry) => entry.text)),
            mechanics: entries.map((entry) => entry.mechanicId),
        };
    }

    /* ---------------------------------------------------------------- the generation */

    /** P16: the rules at the top (stable) or right before the state; the state near the end; system role, not scanned. */
    private inject(built: Built): void {
        const { app } = this.deps;
        const { rules, state } = built.rendered;
        const inChat = (text: string) =>
            ({ text, position: IN_CHAT, depth: built.stateDepth, role: 0, scan: false }) as const;
        if (built.place === 'top') {
            if (rules)
                app.ephemeral.setInjection(RULES_KEY, {
                    text: rules,
                    position: IN_PROMPT,
                    depth: 0,
                    role: 0,
                    scan: false,
                });
            if (state) app.ephemeral.setInjection(STATE_KEY, inChat(state));
            return;
        }
        const text = joinBlocks(rules, state);
        if (text) app.ephemeral.setInjection(STATE_KEY, inChat(text));
    }

    private produce(gen: GenerationInfo): void {
        if (this.disposed || gen.quiet || gen.dryRun || gen.sheetCommand) return;
        this.armed = null;
        const { app } = this.deps;
        const chatId = app.host.chatId();
        if (!chatId) return;
        const type = gen.type || 'normal';
        if (type === 'impersonate') {
            // The service block is for the model's reply, never for text written in the user's name.
            const built = this.build(false);
            for (const { def } of built.scene) app.ephemeral.setFlag(mechanicFlag(def.id), '1');
            this.inject(built);
            return;
        }
        const chat = app.host.ctx().chat ?? [];
        const forIndex = type === 'swipe' || type === 'continue' ? chat.length - 1 : chat.length;
        const facts = this.facts(chatId, type, forIndex);
        const told = this.factsText(facts);
        const built = this.build(true, told.mechanics);
        for (const { def } of built.scene) app.ephemeral.setFlag(mechanicFlag(def.id), '1');
        this.inject(built);
        if (told.text) {
            // The outcome of what the user just did: the very end of the history.
            app.ephemeral.setInjection(FACTS_KEY, {
                text: told.text,
                position: IN_CHAT,
                depth: 0,
                role: 0,
                scan: false,
            });
        }
        this.armed = { chatId, forIndex, ...facts };
    }

    /** generation:ended: what went out is delivered unless the user stopped the generation. */
    private ended(stopped: boolean): void {
        const armed = this.armed;
        this.armed = null;
        if (!armed || stopped || this.disposed || armed.chatId !== this.deps.app.host.chatId()) return;
        if (armed.pendingChecks.length) {
            try {
                this.checks.markChecksDelivered(armed.pendingChecks);
            } catch (error) {
                this.deps.log.warn('check results were not marked delivered', error);
            }
        }
        if (armed.pendingEvents.length) {
            void Promise.resolve()
                .then(() => this.state.markEventsDelivered(armed.pendingEvents))
                .catch((error: unknown) => this.deps.log.warn('events were not marked delivered', error));
        }
        this.last = {
            chatId: armed.chatId,
            forIndex: armed.forIndex,
            checkIds: armed.checks.map((result) => result.id),
            events: armed.events,
        };
    }

    /* ---------------------------------------------------------------- the pult */

    /** What the next generation would get (the pult, the inspector, tests). */
    preview(): MechanicsPromptPreview {
        const chatId = this.deps.app.host.chatId();
        const facts = chatId ? this.factsText(this.facts(chatId, 'normal', -1)) : { text: '', mechanics: [] };
        const { scene, rendered, source, place, stateDepth } = this.build(true, facts.mechanics);
        return {
            text: joinBlocks(rendered.rules, rendered.state),
            rules: rendered.rules,
            state: rendered.state,
            placement: { rules: place, stateDepth },
            tokens: rendered.tokens,
            budget: rendered.budget,
            budgetSource: source,
            cut: rendered.cut,
            mechanics: rendered.mechanics,
            flags: scene.map((entry) => mechanicFlag(entry.def.id)),
            facts: facts.text,
        };
    }
}
