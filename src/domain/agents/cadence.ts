// When an agent runs (plan §3.3, §1 «Берём» п. 3): cheap filters in order — the counter (from the last SUCCESSFUL
// run, so a failure does not skip a turn), the story events, then the conditions (scene, words, mode, what must be on,
// group chats). A filter that cannot be read lets the agent run.
import type { AgentConditions, AgentEvent, AgentTrigger, MaestroMode } from './types';

export interface ConditionContext {
    /** Director scene type now (null: unknown). */
    scene: string | null;
    /** Text of the last messages, newest last (for the words). */
    recentTexts: readonly string[];
    mode: MaestroMode;
    /** Module keys / neighbour ids that are on now. */
    enabled: ReadonlySet<string>;
    isGroup: boolean;
    /** The director sees a stall (null: unknown — the condition then holds). */
    stalled: boolean | null;
}

function fold(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е');
}

/** Whether the conditions hold now. */
export function conditionsHold(when: AgentConditions | undefined, ctx: ConditionContext): boolean {
    if (!when) return true;
    if (when.group === 'only' && !ctx.isGroup) return false;
    if (when.group === 'never' && ctx.isGroup) return false;
    if (when.stalled && ctx.stalled === false) return false;
    if (when.modes?.length && !when.modes.includes(ctx.mode)) return false;
    if (when.requires?.length && when.requires.some((key) => !ctx.enabled.has(key))) return false;
    if (when.scenes?.length && ctx.scene !== null && !when.scenes.includes(ctx.scene)) return false;
    if (when.words?.length) {
        const depth = when.scanDepth ?? 2;
        const text = fold(ctx.recentTexts.slice(-depth).join('\n'));
        if (!when.words.some((word) => word.trim() && text.includes(fold(word.trim())))) return false;
    }
    return true;
}

export interface ScheduleState {
    /** Messages since the last successful run (absent: never ran in this chat). */
    sinceLastOk?: number;
    /** Events that happened since the last check. */
    events: ReadonlySet<AgentEvent>;
}

/**
 * Whether a scheduled agent is due: one of its events happened, or its counter is reached. An agent that never ran in
 * this chat counts from the start of the chat (`sinceLastOk` absent = the chat length is given by the caller).
 */
export function isDue(trigger: AgentTrigger, state: ScheduleState): { due: boolean; reason?: string } {
    for (const event of trigger.events ?? [])
        if (state.events.has(event)) return { due: true, reason: `event:${event}` };
    const every = trigger.everyMessages ?? 0;
    if (every > 0 && (state.sinceLastOk ?? 0) >= every) return { due: true, reason: 'schedule' };
    return { due: false };
}

/** Whether the silence before this moment is a break (event 'break'). */
export function isBreak(lastMessageAt: number | null, now: number, hours: number): boolean {
    return lastMessageAt !== null && now - lastMessageAt >= hours * 3_600_000;
}

/** Story signals of Maestro's signal service (S4) mapped to agent events. */
export function eventOfSignal(kind: string): AgentEvent | null {
    switch (kind) {
        case 'scene.ended':
            return 'sceneEnd';
        case 'location.changed':
            return 'placeChange';
        case 'character.appeared':
        case 'name.new':
            return 'newCharacter';
        case 'time.skipped':
            return 'timeSkip';
        default:
            return null;
    }
}
