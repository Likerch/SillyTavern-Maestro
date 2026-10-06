// M25 «Механики», narrator messages (plan-2 §6.А п.3; В22: off by default — a mechanic's place «Сообщения
// рассказчика»): the rolls of a turn as a game master's line in the chat feed — «🎲 Скрытность (Кай): 14 · Внимательность
// (Стражник): 11 — успех · −10 ❤». It stays in the chat history; the model gets it only when the mechanic says so
// (`narratorToModel`), otherwise the message is a system one ST keeps out of the prompt.
//
// When: right after the user's message is rendered (ST's USER_MESSAGE_RENDERED of the message just sent, which ST
// awaits before it assembles the prompt and saves the chat). The line goes after the user's message and before the
// reply, so the reply stays the last message (swipes keep working) and no index of an earlier message moves. It
// carries the rolls of that message (auto and by hand) and those the model asked for in the reply it answers; rolls
// already narrated (marked on their narrator message) are never told twice. The message is added the way ST's own
// /sys adds one (pushed, rendered) but without emitting MESSAGE_SENT, so Maestro and the neighbours never take it for
// the user's turn; a model-visible one is a narrator message (system role in Chat Completion).
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { CheckResult, MechanicsApi, StateChange } from './api';
import { rollConsequences, rollLine } from './play-strip';

/** Key of Maestro's mark in a narrator message's `extra`: the roll ids it told. */
export const NARRATOR_EXTRA = 'maestro_mechanics';
/** ST's avatar of system messages (/sys uses the same). */
export const SYSTEM_AVATAR = 'img/five.png';
const LOOKBACK = 40;
const ROLLS_LOOKUP = 50;
const DEFAULT_WAIT_MS = 400;
const WAIT_STEP_MS = 25;

export interface NarratorDeps {
    app: App;
    log: Logger;
}

export interface NarratorOptions {
    /** How long to wait for a roll's consequences to land (they are applied off the send path). */
    waitMs?: number;
}

function safe<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MechanicsNarrator {
    /** The user's message just sent (MESSAGE_SENT), waiting for its render. */
    private sent: number | null = null;
    private readonly offs: Unsubscribe[] = [];
    private disposed = false;
    private readonly waitMs: number;

    constructor(
        private readonly deps: NarratorDeps,
        private readonly api: MechanicsApi,
        options: NarratorOptions = {},
    ) {
        this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    }

    install(): void {
        const { host } = this.deps.app;
        const sent = host.events.name('MESSAGE_SENT');
        const rendered = host.events.name('USER_MESSAGE_RENDERED');
        if (!sent || !rendered) {
            this.deps.log.debug('mechanics narrator: ST lacks MESSAGE_SENT / USER_MESSAGE_RENDERED');
            return;
        }
        this.offs.push(host.events.on(sent, (id) => this.onSent(id)));
        this.offs.push(host.events.on(rendered, (id) => this.onRendered(id)));
        this.offs.push(
            this.deps.app.bus.on('chat:changed', () => {
                this.sent = null;
            }),
        );
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) off();
    }

    private onSent(id: unknown): void {
        const index = Number(id);
        const message = safe(() => this.deps.app.host.ctx().chat?.[index], undefined);
        this.sent = Number.isInteger(index) && message?.is_user ? index : null;
    }

    private async onRendered(id: unknown): Promise<void> {
        const index = Number(id);
        if (this.disposed || this.sent === null || index !== this.sent) return;
        this.sent = null;
        try {
            await this.narrate(index);
        } catch (error) {
            this.deps.log.warn('mechanics narrator: the message was not added', error);
        }
    }

    /** Whether a mechanic's rolls are narrated (its place is on and the player may see it at all). */
    private narrated(mechanicId: string): { on: boolean; toModel: boolean } {
        const visibility = safe(() => this.api.visibilityOf?.(mechanicId) ?? null, null);
        const def = safe(() => this.api.get(mechanicId), null);
        const on =
            !!visibility &&
            visibility.places.narrator === true &&
            visibility.preset !== 'hidden' &&
            visibility.preset !== 'secret';
        return { on, toModel: def?.narratorToModel === true };
    }

    /** Roll ids already told by narrator messages of the last messages. */
    private told(chat: readonly STChatMessage[]): Set<string> {
        const out = new Set<string>();
        for (const message of chat.slice(-LOOKBACK)) {
            const mark = message?.extra?.[NARRATOR_EXTRA] as { rolls?: unknown } | undefined;
            if (Array.isArray(mark?.rolls)) for (const id of mark.rolls) if (typeof id === 'string') out.add(id);
        }
        return out;
    }

    /** The rolls of the turn the message `index` starts: its own and the previous reply's (asked by the model). */
    candidates(index: number): CheckResult[] {
        const chat = safe(() => this.deps.app.host.ctx().chat ?? [], [] as STChatMessage[]);
        let from = index;
        for (let i = index - 1; i >= 0; i--) {
            if (chat[i]?.is_user) break;
            from = i;
        }
        const told = this.told(chat);
        return safe(() => this.api.checks(ROLLS_LOOKUP), [] as CheckResult[])
            .filter(
                (result) =>
                    result.messageIndex >= from &&
                    result.messageIndex <= index &&
                    !result.hidden &&
                    !result.undone &&
                    !told.has(result.id) &&
                    this.narrated(result.mechanicId).on,
            )
            .reverse();
    }

    /** Waits (a little) until the consequences of the rolls are in the state. */
    private async settled(rolls: readonly CheckResult[]): Promise<StateChange[]> {
        const wanted = rolls.filter((roll) => (roll.consequences?.length ?? 0) > 0).map((roll) => roll.id);
        const read = () => safe(() => this.api.history(ROLLS_LOOKUP), [] as StateChange[]);
        let history = read();
        for (let waited = 0; waited < this.waitMs; waited += WAIT_STEP_MS) {
            const landed = wanted.every((id) => history.some((change) => change.rollId === id));
            if (landed) break;
            await sleep(WAIT_STEP_MS);
            history = read();
        }
        return [...history].reverse();
    }

    /** The narrator line of a roll: «🎲 Убеждение (Кай): 16 против 15 — успех · −10 ❤». */
    line(result: CheckResult, changes: readonly StateChange[]): string {
        const { i18n } = this.deps.app;
        const consequences = rollConsequences(i18n, this.api, result, changes);
        const tail = consequences.length ? ` · ${consequences.join(' · ')}` : '';
        return `🎲 ${rollLine(i18n, this.api, result)}${tail}`;
    }

    /** Adds the narrator messages of the turn the message `index` starts (one for the player, one the model sees). */
    async narrate(index: number): Promise<number> {
        const rolls = this.candidates(index);
        if (!rolls.length) return 0;
        const changes = await this.settled(rolls);
        if (this.disposed) return 0;
        let added = 0;
        for (const toModel of [false, true]) {
            const group = rolls.filter((roll) => this.narrated(roll.mechanicId).toModel === toModel);
            if (!group.length) continue;
            const text = group.map((roll) => this.line(roll, changes)).join('\n');
            if (
                this.add(
                    text,
                    toModel,
                    group.map((roll) => roll.id),
                )
            )
                added++;
        }
        return added;
    }

    private add(text: string, toModel: boolean, rolls: string[]): boolean {
        const ctx = this.deps.app.host.ctx();
        if (!Array.isArray(ctx.chat)) return false;
        const message: STChatMessage = {
            name: this.deps.app.i18n.t('m25.narrator.name'),
            is_user: false,
            // Out of the prompt unless the mechanic gives it to the model (ST skips system messages).
            is_system: !toModel,
            send_date: safe(() => ctx.humanizedDateTime(), new Date().toISOString()),
            mes: text,
            force_avatar: SYSTEM_AVATAR,
            extra: { type: 'narrator', isSmallSys: true, [NARRATOR_EXTRA]: { rolls } },
        };
        ctx.chat.push(message);
        try {
            ctx.addOneMessage(message);
        } catch (error) {
            this.deps.log.debug('mechanics narrator: the message was not rendered', error);
        }
        return true;
    }
}
