// The user's character's clothes (plan-2 §4 п. 6): DES does not track {{user}}. After a committed turn, when at least
// `personaEvery` turns passed since the last look and the user's messages or the narration since then speak of clothes,
// one background request (task wardrobe.persona, strict schema) asks what the persona wears now; the answer goes into
// the persona's «что надето сейчас» record and its NAI passport (wardrobe service). Leader tab only, never in economy
// mode, under the background cost cap; the manual field in the Wardrobe tab works without it.
import { cleanForAnalysis } from '../../domain/text-clean';
import {
    parsePersonaAnswer,
    PERSONA_EXCERPT_CHARS,
    PERSONA_SCHEMA,
    PERSONA_SCHEMA_NAME,
    personaMessages,
} from '../../domain/wardrobe-persona';
import { mentionsClothing } from '../../domain/wardrobe-wear';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { WardrobeService } from './service';
import { PERSONA_KEY, PERSONA_TASK } from './settings';
import type { WardrobeSettings } from './settings';

const TASK_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 150;

export class PersonaCheck {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly service: WardrobeService,
        private readonly settings: () => WardrobeSettings,
    ) {}

    install(): Unsubscribe[] {
        return [this.app.tasks.register(PERSONA_TASK, (payload) => this.run(payload))];
    }

    private modelAllowed(): boolean {
        const { app } = this;
        try {
            if (!this.settings().persona || app.settings.core().mode === 'economy' || !app.leader.isLeader()) {
                return false;
            }
            return app.llm.available(PERSONA_TASK) && !app.cost.backgroundCapReached();
        } catch {
            return false;
        }
    }

    /** After a committed turn (the wardrobe's own reading of it): maybe one check is queued. */
    async afterTurn(index: number): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.app.host.isGroupChat() || !this.modelAllowed()) return;
        const since = await this.service.personaCheckIndex();
        const chat = this.app.host.ctx().chat ?? [];
        let turns = 0;
        for (let i = Math.max(0, since + 1); i <= index && i < chat.length; i++) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) turns++;
        }
        if (turns < this.settings().personaEvery) return;
        const name = this.app.host.ctx().name1 || 'User';
        const lines: string[] = [];
        // The user's answer to the reply belongs to the excerpt as well.
        for (let i = Math.max(0, since + 1); i <= index + 1 && i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            const text = cleanForAnalysis(message);
            if (text) lines.push(`${message.is_user ? name : message.name || 'Narrator'}: ${text}`);
        }
        const excerpt = lines.join('\n\n').slice(-PERSONA_EXCERPT_CHARS);
        // No clothes in what happened since the last look: nothing to ask (the turns keep counting).
        if (!mentionsClothing(excerpt)) return;
        await this.service.setPersonaCheckIndex(index);
        const current = this.service.current().find((item) => item.key === PERSONA_KEY)?.wording ?? '';
        try {
            await this.app.tasks.enqueue({
                kind: PERSONA_TASK,
                dedupeKey: `${PERSONA_TASK}:${chatId}`,
                payload: { chatId, messageIndex: index, name, current, excerpt },
                chatId,
                ttlMs: TASK_TTL_MS,
                priority: 3,
            });
            this.app.tasks.kick();
        } catch (error) {
            this.log.warn('persona clothing check could not be queued', error);
        }
    }

    /** Task runner: one small request; never throws (no answer keeps what is known). */
    private async run(payload: Record<string, unknown>): Promise<void> {
        const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
        if (!chatId || chatId !== this.app.host.chatId()) return;
        const messageIndex = typeof payload.messageIndex === 'number' ? payload.messageIndex : -1;
        const str = (value: unknown) => (typeof value === 'string' ? value : '');
        let wearing: string | null = null;
        try {
            const response = await this.app.llm.request<unknown>({
                task: PERSONA_TASK,
                messages: personaMessages({
                    name: str(payload.name),
                    current: str(payload.current),
                    excerpt: str(payload.excerpt),
                }),
                maxTokens: MAX_TOKENS,
                temperature: 0,
                schema: { name: PERSONA_SCHEMA_NAME, schema: PERSONA_SCHEMA },
            });
            if (response.ok) wearing = parsePersonaAnswer(response.data ?? response.text);
            else this.log.debug('persona clothing check failed', response.error);
        } catch (error) {
            this.log.debug('persona clothing check request failed', error);
        }
        if (!wearing || chatId !== this.app.host.chatId()) return;
        await this.service.setPersonaWearing(wearing, 'model', messageIndex);
    }
}
