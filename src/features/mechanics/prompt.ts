// M25 «Механики», prompt part (plan M25 п.5, §5 phase 2, M34 п.8, P15, P16): one ephemeral producer per generation
// (normal, swipe, regenerate, continue; impersonate gets the state without the service-block instruction and without
// facts; quiet/background generations and sheet scenarios are left alone, like the other producers):
// - the flag `maestro_mech_<id>` for every mechanic with a holder in the scene (conditional preset blocks);
// - the rules + state of those mechanics (domain/mechanics-prompt.ts) plus the tracking part's block instruction, in
//   chat at settings.depth (near the end, P16), system role, never scanned, fitted to the Architect's «mechanics»
//   budget when it is set, else to settings.promptBudget (the block fits itself: the Architect only measures it);
// - the facts (pending check results and fired events) at depth 0 for one generation; they are marked delivered when
//   the generation ends without being stopped, and a swipe / regenerate / continue of the same reply gets them again
//   (the roll belongs to the user's message: it is never rolled again).
// Everything is read from memory (definitions, state, the roll log): nothing is awaited on the send path (P15).
import { initialValueOf } from '../../domain/mechanics-defs';
import { renderFacts, renderRules } from '../../domain/mechanics-prompt';
import type { CutStep, PromptSection, RenderedRules } from '../../domain/mechanics-prompt';
import type { GenerationInfo, Unsubscribe } from '../../shared/contracts';
import type { ArchitectApi } from '../architect/api';
import type { AttributeValue, CheckResult, FiredEvent, MechanicDef } from './api';
import { nameKey } from './checks';
import { FLAG_PREFIX, INJECT_FACTS, INJECT_RULES } from './parts';
import type { ChecksPart, DefinitionsPart, PartDeps, StatePart, TrackingPart } from './parts';

export const PROMPT_PRODUCER = 'mechanics';
/**
 * app.ephemeral prefixes injection keys with `maestro_` (core/ephemeral.ts injectionKey): these keys give the
 * extension prompt slots INJECT_RULES (`maestro_mechanics`) and INJECT_FACTS (`maestro_mechanics_facts`).
 */
export const RULES_KEY = INJECT_RULES.replace(/^maestro_/, '');
export const FACTS_KEY = INJECT_FACTS.replace(/^maestro_/, '');
/** Facts given in one generation at most (the newest). */
const FACTS_MAX = 8;
/** Results looked through when a swipe repeats the delivered facts. */
const REPEAT_LOOKUP = 50;
const DEFAULT_DEPTH = 1;

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

export interface MechanicsPromptPreview {
    /** The rules + state block as the next generation would get it ('' when no mechanic takes part). */
    text: string;
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

function eventKey(event: FiredEvent): string {
    return `${event.mechanicId}|${event.holder}|${event.attribute}|${event.eventId}|${event.messageIndex}|${event.at}`;
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
            if (attribute.visible === false) continue;
            try {
                values[attribute.id] = this.state.value(def.id, holder, attribute.id) ?? initialValueOf(attribute);
            } catch {
                values[attribute.id] = initialValueOf(attribute);
            }
        }
        return values;
    }

    private sections(scene: readonly SceneEntry[]): PromptSection[] {
        const persona = nameKey(this.deps.app.host.ctx().name1 ?? '');
        return scene.map(({ def, holders }) => {
            const own = holders.findIndex((name) => nameKey(name) === persona);
            const primary = own >= 0 ? own : 0;
            return {
                mechanic: def,
                holders: holders.map((name, index) => ({
                    name,
                    primary: index === primary,
                    values: this.values(def, name),
                })),
            };
        });
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

    private depth(): number {
        const depth = this.deps.settings().depth;
        return typeof depth === 'number' && Number.isFinite(depth) ? Math.max(0, Math.round(depth)) : DEFAULT_DEPTH;
    }

    private build(withInstruction: boolean): {
        scene: SceneEntry[];
        rendered: RenderedRules;
        source: 'architect' | 'own';
    } {
        const scene = this.scene();
        const budget = this.budget();
        if (!scene.length) {
            return {
                scene,
                rendered: { text: '', tokens: 0, budget: budget.tokens, cut: [], mechanics: [] },
                source: budget.source,
            };
        }
        let instruction = '';
        if (withInstruction) {
            const holders: Record<string, string[]> = {};
            for (const entry of scene) holders[entry.def.id] = entry.holders;
            instruction = this.safe(
                () =>
                    this.tracking.blockInstruction(
                        scene.map((entry) => entry.def),
                        holders,
                    ),
                '',
                'the block instruction',
            );
        }
        const rendered = renderRules(this.sections(scene), { budget: budget.tokens, instruction });
        return { scene, rendered, source: budget.source };
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

    /* ---------------------------------------------------------------- the generation */

    private produce(gen: GenerationInfo): void {
        if (this.disposed || gen.quiet || gen.dryRun || gen.sheetCommand) return;
        this.armed = null;
        const { app } = this.deps;
        const chatId = app.host.chatId();
        if (!chatId) return;
        const type = gen.type || 'normal';
        const impersonate = type === 'impersonate';
        // The service block is for the model's reply, never for text written in the user's name.
        const { scene, rendered } = this.build(!impersonate);
        for (const { def } of scene) app.ephemeral.setFlag(mechanicFlag(def.id), '1');
        if (rendered.text) {
            // P16: in chat near the end, system role, never scanned; cleared after the generation.
            app.ephemeral.setInjection(RULES_KEY, {
                text: rendered.text,
                position: 1,
                depth: this.depth(),
                role: 0,
                scan: false,
            });
        }
        if (impersonate) return;

        const chat = app.host.ctx().chat ?? [];
        const forIndex = type === 'swipe' || type === 'continue' ? chat.length - 1 : chat.length;
        const facts = this.facts(chatId, type, forIndex);
        const lines = [...facts.checks.map((result) => result.text), ...facts.events.map((event) => event.text)];
        const text = renderFacts(lines.slice(-FACTS_MAX));
        if (text) {
            // The outcome of what the user just did: the very end of the history.
            app.ephemeral.setInjection(FACTS_KEY, { text, position: 1, depth: 0, role: 0, scan: false });
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
        const { scene, rendered, source } = this.build(true);
        const chatId = this.deps.app.host.chatId();
        const facts = chatId ? this.facts(chatId, 'normal', -1) : null;
        return {
            text: rendered.text,
            tokens: rendered.tokens,
            budget: rendered.budget,
            budgetSource: source,
            cut: rendered.cut,
            mechanics: rendered.mechanics,
            flags: scene.map((entry) => mechanicFlag(entry.def.id)),
            facts: facts
                ? renderFacts(
                      [...facts.checks.map((result) => result.text), ...facts.events.map((event) => event.text)].slice(
                          -FACTS_MAX,
                      ),
                  )
                : '',
        };
    }
}
