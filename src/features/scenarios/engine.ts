// The generation-scenario engine (M34 п. 7). A scenario takes over ONE main Chat Completion generation without
// switching the preset (review/audit-v0.4.md T5, research/parity-preset.md §5.2, §9 P-185, §10.4 (г)):
// 1. `generation:before` (inside Maestro's generate_interceptor, before the WI scan): the first matching scenario is
//    armed and our ordered listeners are re-asserted, so the CHAT_COMPLETION_PROMPT_READY listener is really last;
// 2. WORLDINFO_ENTRIES_LOADED: the scenario may drop entries (top-level arrays only), so lore that will not reach the
//    model does not get sticky/cooldown either;
// 3. CHAT_COMPLETION_PROMPT_READY (last listener, real generations only): the plan is built from a read-only copy
//    of ST's prompt and the messages are replaced IN PLACE (`chat.splice`) — ST returns its local array (P-123);
// 4. GENERATE_AFTER_DATA: safety net — if a listener after us changed the prompt, `generate_data.prompt` is
//    reassigned (P-124); `lastInContextMessageId` and the "in context" marker get back their previous values,
//    because ST counted them from the replaced prompt;
// 5. CHAT_COMPLETION_SETTINGS_READY (one-shot, only for the request that carries our message objects —
//    createGenerationParameters copies the array, not the messages): per-request parameters; `stream` untouched;
// 6. `reply:ready` for the reply of that generation → `onReply`. GENERATION_ENDED may come before the reply events
//    (streaming), so the scenario waits for its reply after the generation has ended.
import { applyScenarioParams, snapshotPrompt, toPromptMessages } from '../../domain/scenario-params';
import type { GenerationInfo, Host, Logger, Unsubscribe } from '../../shared/contracts';
import type { Scenario, ScenarioPlan, ScenariosApi } from './api';

/** Generation types whose rendered reply is not the scenario's answer. */
const FOREIGN_REPLY_TYPES: ReadonlySet<string> = new Set(['first_message', 'extension', 'impersonate', 'quiet']);
/** A reply that has not arrived this long after the generation ended is not waited for any more. */
const REPLY_WAIT_MS = 2 * 60 * 1000;
const WI_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'] as const;

type Phase = 'armed' | 'building' | 'replaced' | 'sent';

interface Armed {
    scenario: Scenario;
    info: GenerationInfo;
    phase: Phase;
    plan: ScenarioPlan | null;
    /** The message objects we put into ST's prompt. */
    messages: object[] | null;
    /** `chat_metadata.lastInContextMessageId` and the marked `.mes` before this generation. */
    inContext: { known: boolean; id: unknown; mesId: string | null };
    replied: boolean;
}

export interface EngineDeps {
    host: Host;
    log: Logger;
    /** Called when a scenario failed and the generation went out with ST's own prompt. */
    onFailure?(scenarioId: string, error: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ScenarioEngine implements ScenariosApi {
    private readonly scenarios: Scenario[] = [];
    private armed: Armed | null = null;
    private awaiting: { scenario: Scenario; since: number } | null = null;
    /** Our prompt message objects, to recognise our request in CHAT_COMPLETION_SETTINGS_READY. */
    private ours = new WeakSet<object>();

    constructor(private readonly deps: EngineDeps) {}

    /* ------------------------------------------------------------------ public API */

    register(scenario: Scenario): Unsubscribe {
        const index = this.scenarios.findIndex((item) => item.id === scenario.id);
        if (index >= 0) {
            this.deps.log.debug(`scenario ${scenario.id} replaced`);
            this.scenarios.splice(index, 1, scenario);
        } else this.scenarios.push(scenario);
        return () => {
            const at = this.scenarios.indexOf(scenario);
            if (at >= 0) this.scenarios.splice(at, 1);
            if (this.armed?.scenario === scenario) this.armed = null;
            if (this.awaiting?.scenario === scenario) this.awaiting = null;
        };
    }

    active(): string | null {
        return this.armed?.scenario.id ?? null;
    }

    /** Drops every per-generation state (chat change, module disable). */
    reset(): void {
        this.armed = null;
        this.awaiting = null;
        this.ours = new WeakSet<object>();
    }

    /* ------------------------------------------------------------------ Maestro bus */

    onGenerationBefore(info: GenerationInfo): void {
        // Quiet and dry runs never belong to a scenario and must not cancel one in progress.
        if (info.dryRun || info.quiet) return;
        this.armed = null;
        this.awaiting = null;
        // Text Completion has no CHAT_COMPLETION_* events; group chats are not supported by Maestro (plan Q11).
        if (!this.deps.host.isChatCompletion() || this.deps.host.isGroupChat()) return;
        const scenario = this.scenarios.find((item) => {
            try {
                return item.match(info);
            } catch (error) {
                this.deps.log.error(`scenario ${item.id}: match failed`, error);
                return false;
            }
        });
        if (!scenario) return;
        this.armed = {
            scenario,
            info,
            phase: 'armed',
            plan: null,
            messages: null,
            inContext: this.readInContext(),
            replied: false,
        };
        this.deps.log.debug(`scenario ${scenario.id} armed for ${info.type}`);
        // Extensions that subscribed after Maestro would otherwise run after our "last" listeners.
        this.deps.host.events.reassertOrder();
    }

    onGenerationEnded(): void {
        const armed = this.armed;
        if (!armed) return;
        this.armed = null;
        if (!armed.replied) this.awaiting = { scenario: armed.scenario, since: Date.now() };
    }

    async onReplyReady(payload: { messageIndex: number; type: string }): Promise<void> {
        const armed = this.armed;
        let scenario: Scenario | null = armed?.scenario ?? null;
        if (!scenario && this.awaiting) {
            if (Date.now() - this.awaiting.since > REPLY_WAIT_MS) this.awaiting = null;
            else scenario = this.awaiting.scenario;
        }
        if (!scenario || FOREIGN_REPLY_TYPES.has(payload.type)) return;
        const message = this.deps.host.ctx().chat[payload.messageIndex];
        if (!message || message.is_user) return;
        if (armed) armed.replied = true;
        this.awaiting = null;
        if (!scenario.onReply) return;
        try {
            await scenario.onReply(payload.messageIndex);
        } catch (error) {
            this.deps.log.error(`scenario ${scenario.id}: onReply failed`, error);
        }
    }

    /* ------------------------------------------------------------------ SillyTavern events */

    /** WORLDINFO_ENTRIES_LOADED `{globalLore, characterLore, chatLore, personaLore}`. */
    onEntriesLoaded(payload: unknown): void {
        const armed = this.armed;
        const keep = armed?.scenario.keepEntry;
        if (!armed || armed.phase !== 'armed' || !keep || !isRecord(payload)) return;
        let dropped = 0;
        for (const key of WI_LISTS) {
            const list = payload[key];
            if (!Array.isArray(list)) continue;
            const kept = list.filter((entry) => {
                if (!isRecord(entry)) return true;
                try {
                    return keep.call(armed.scenario, entry) !== false;
                } catch (error) {
                    this.deps.log.warn(`scenario ${armed.scenario.id}: keepEntry failed`, error);
                    return true;
                }
            });
            if (kept.length === list.length) continue;
            dropped += list.length - kept.length;
            // Only the top-level arrays are ST's to share with us; nested arrays alias its WI cache.
            list.splice(0, list.length, ...kept);
        }
        if (dropped) this.deps.log.debug(`scenario ${armed.scenario.id}: ${dropped} WI entries left out`);
    }

    /** CHAT_COMPLETION_PROMPT_READY `{chat, dryRun}` — must run as the last listener. */
    async onPromptReady(eventData: unknown): Promise<void> {
        if (!isRecord(eventData) || eventData.dryRun !== false || !Array.isArray(eventData.chat)) return;
        const armed = this.armed;
        if (!armed || armed.phase !== 'armed') return;
        const chat = eventData.chat as unknown[];
        const messages = await this.buildMessages(armed, chat);
        if (!messages || this.armed !== armed) return;
        chat.splice(0, chat.length, ...messages);
        armed.phase = 'replaced';
    }

    /** GENERATE_AFTER_DATA `(generate_data, dryRun)`. */
    async onAfterData(generateData: unknown, dryRun: unknown): Promise<void> {
        const armed = this.armed;
        if (dryRun || !armed || !isRecord(generateData) || !Array.isArray(generateData.prompt)) return;
        if (armed.phase === 'armed') {
            // PROMPT_READY never reached us: replace the request body instead (research/parity-preset.md P-124).
            const messages = await this.buildMessages(armed, generateData.prompt as unknown[]);
            if (!messages || this.armed !== armed) return;
            generateData.prompt = messages;
            armed.phase = 'replaced';
            this.deps.log.info(`scenario ${armed.scenario.id}: prompt replaced after data assembly`);
        } else if (armed.phase === 'replaced' && armed.messages) {
            const prompt = generateData.prompt as unknown[];
            const same = prompt.length === armed.messages.length && prompt.every((m, i) => m === armed.messages?.[i]);
            if (!same) {
                this.deps.log.warn(`scenario ${armed.scenario.id}: a later listener changed the prompt; restored`);
                generateData.prompt = [...armed.messages];
            }
        } else return;
        this.restoreInContext(armed.inContext);
    }

    /** CHAT_COMPLETION_SETTINGS_READY `(generate_data)` — also fires for generateRaw and quiet generations. */
    onSettingsReady(generateData: unknown): void {
        const armed = this.armed;
        if (!armed || armed.phase !== 'replaced' || !isRecord(generateData)) return;
        if (generateData.type === 'quiet' || !Array.isArray(generateData.messages)) return;
        if (!generateData.messages.some((message) => isRecord(message) && this.ours.has(message))) return;
        armed.phase = 'sent';
        const changed = applyScenarioParams(generateData, armed.plan?.params);
        if (changed.length) this.deps.log.debug(`scenario ${armed.scenario.id}: request ${changed.join(', ')} set`);
    }

    /* ------------------------------------------------------------------ internals */

    private async buildMessages(armed: Armed, chat: readonly unknown[]): Promise<object[] | null> {
        armed.phase = 'building';
        let plan: ScenarioPlan | null = null;
        try {
            plan = await armed.scenario.build({
                info: armed.info,
                original: snapshotPrompt(chat),
                chat: this.deps.host.ctx().chat,
            });
        } catch (error) {
            this.deps.log.error(`scenario ${armed.scenario.id}: build failed`, error);
            this.deps.onFailure?.(armed.scenario.id, error);
        }
        const messages = plan ? toPromptMessages(plan.messages) : [];
        if (!plan || !messages.length) {
            if (this.armed === armed) this.armed = null;
            this.deps.log.debug(`scenario ${armed.scenario.id}: no plan; ST's prompt is kept`);
            return null;
        }
        for (const message of messages) this.ours.add(message);
        armed.plan = plan;
        armed.messages = messages;
        return messages;
    }

    private readInContext(): Armed['inContext'] {
        const metadata = this.deps.host.ctx().chatMetadata;
        const known = Object.prototype.hasOwnProperty.call(metadata, 'lastInContextMessageId');
        let mesId: string | null = null;
        if (typeof document !== 'undefined') {
            mesId = document.querySelector('#chat .mes.lastInContext')?.getAttribute('mesid') ?? null;
        }
        return { known, id: metadata.lastInContextMessageId, mesId };
    }

    /** ST marked the "last in context" message from the replaced prompt (S:6083-6101): put back the old marker. */
    private restoreInContext(previous: Armed['inContext']): void {
        const metadata = this.deps.host.ctx().chatMetadata;
        if (previous.known) metadata.lastInContextMessageId = previous.id;
        else delete metadata.lastInContextMessageId;
        if (typeof document === 'undefined') return;
        for (const element of document.querySelectorAll('#chat .mes.lastInContext')) {
            element.classList.remove('lastInContext');
        }
        if (previous.mesId !== null && /^\d+$/.test(previous.mesId)) {
            document.querySelector(`#chat .mes[mesid="${previous.mesId}"]`)?.classList.add('lastInContext');
        }
    }
}
