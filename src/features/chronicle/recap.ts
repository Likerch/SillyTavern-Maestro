// M9 п. 4 «Ранее в истории…» (plan M9, §5 phase 0, P15, P16). After a break (default: more than 12 hours since the
// last message and the last recap) the chat opened or the tab came back (visibilitychange) → a short recap:
// - source 'memory' (default, free): recent chronicle chapters, Qvink's long-term memories, the latest memories;
// - source 'ai': a background task 'chronicle.recap' asks the cheap model for ≤ 120 words in the chat's language
//   (the free text is the fallback);
// - target 'user': a dismissible panel above the chat input (mobile friendly; a notice when ST's input is not found);
//   'userAndPrompt': also a one-generation injection near the end of the prompt; 'off': nothing.
// Shown once: the leader tab claims the stamp in the chat document BEFORE showing (compare-and-swap), so other tabs,
// reloads and devices do not repeat it. recapNow() ignores the timer.
import {
    chatLanguage,
    freeRecap,
    hasMaterial,
    lastMessageTime,
    promptRecap,
    recapDue,
    recapPrompt,
    tidyRecap,
} from '../../domain/chronicle-recap';
import type { RecapMaterial } from '../../domain/chronicle-recap';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { GenerationInfo, TaskInfo, Unsubscribe } from '../../shared/contracts';
import { button, el, icon } from '../../ui/components/dom';
import type { ChapterService } from './chapters';
import type { ChronicleEnv } from './env';
import { CHRONICLE_KEY } from './settings';

export const RECAP_TASK = 'chronicle.recap';
export const RECAP_INJECTION = 'chronicle_recap';
export const RECAP_PANEL_CLASS = 'maestro-m9-recap';
/** Words of the model's recap. */
export const RECAP_WORDS = 120;

const OPEN_DELAY_MS = 2500;
const RETURN_DELAY_MS = 400;
const LEADER_DELAY_MS = 500;
/** A chat this short has nothing to recap. */
const MIN_MESSAGES = 4;
const LANGUAGE_MESSAGES = 6;
const TASK_TTL_MS = 30 * 60_000;

export class RecapService {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private panel: HTMLElement | null = null;
    private pendingPrompt: { chatId: string; text: string } | null = null;
    /** A check was wanted while another tab led (the leader may move here). */
    private checkWanted = false;
    private chain: Promise<unknown> = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly env: ChronicleEnv,
        private readonly chapters: ChapterService,
    ) {}

    private get app() {
        return this.env.app;
    }

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [
            app.bus.on('chat:changed', () => {
                this.hidePanel();
                this.pendingPrompt = null;
                this.arm(OPEN_DELAY_MS);
            }),
            app.leader.onChange((leader) => {
                if (leader && this.checkWanted) this.arm(LEADER_DELAY_MS);
            }),
            app.ephemeral.addProducer(RECAP_TASK, (gen) => this.produce(gen)),
            app.tasks.register(RECAP_TASK, (payload, info) => this.runTask(payload, info)),
        ];
        // The user moved on: the panel goes when a message is sent.
        const sent = app.host.events.name('MESSAGE_SENT');
        if (sent) offs.push(app.host.events.on(sent, () => this.hidePanel()));
        const doc = typeof document === 'undefined' ? null : document;
        if (doc) {
            const onVisible = () => {
                if (doc.visibilityState === 'visible') this.arm(RETURN_DELAY_MS);
            };
            doc.addEventListener('visibilitychange', onVisible);
            offs.push(() => doc.removeEventListener('visibilitychange', onVisible));
        }
        offs.push(() => this.dispose());
        return offs;
    }

    start(): void {
        this.arm(OPEN_DELAY_MS);
    }

    private dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.pendingPrompt = null;
        this.hidePanel();
    }

    private arm(delay: number): void {
        if (this.disposed) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.check();
        }, delay);
    }

    /* ---------------------------------------------------------------- the absence check */

    /** Shows the recap when it is due (serialised). */
    check(): Promise<void> {
        const run = () => this.checkNow().catch((error: unknown) => this.env.log.warn('recap check failed', error));
        const next = this.chain.then(run, run);
        this.chain = next;
        return next;
    }

    private async checkNow(): Promise<void> {
        const { app, env } = this;
        if (this.disposed) return;
        const settings = env.settings().recap;
        if (settings.target === 'off') return;
        const chatId = app.host.chatId();
        if (!chatId) return;
        if (!app.leader.isLeader()) {
            this.checkWanted = true;
            return;
        }
        this.checkWanted = false;
        const chat = app.host.ctx().chat ?? [];
        if (chat.length < MIN_MESSAGES) return;
        const lastAt = lastMessageTime(chat);
        const doc = await env.store.load();
        if (!doc) return;
        const now = Date.now();
        if (!recapDue(now, lastAt, doc.recap?.shownAt, settings.afterHours)) return;
        const material = await this.material();
        if (!hasMaterial(material)) return;
        const source = settings.source === 'ai' && app.llm.available(RECAP_TASK) ? 'ai' : 'memory';
        // Claim first: whoever writes the stamp shows the recap (other tabs and devices see it and stay quiet).
        const claimed = await env.store.mutate((current) => {
            if (!recapDue(now, lastAt, current.recap?.shownAt, settings.afterHours)) return false;
            current.recap = { shownAt: now, source };
            return true;
        });
        if (!claimed || app.host.chatId() !== chatId) return;
        if (source === 'ai') {
            try {
                await app.tasks.enqueue({
                    kind: RECAP_TASK,
                    dedupeKey: chatId,
                    chatId,
                    payload: { at: now },
                    priority: 5,
                    ttlMs: TASK_TTL_MS,
                });
                return;
            } catch (error) {
                env.log.warn('the recap task was not queued; showing the free recap', error);
            }
        }
        await this.show(this.freeText(material), chatId);
    }

    /* ---------------------------------------------------------------- building */

    /** Recent chapters, Qvink's long-term memories and the latest memories of the open chat. */
    async material(): Promise<RecapMaterial> {
        const material: RecapMaterial = { chapters: [], long: [], recent: [] };
        const chat = this.app.host.ctx().chat ?? [];
        if (this.env.qvinkReady()) {
            const qvink = this.env.qvink();
            const all: string[] = [];
            for (let index = 0; index < chat.length; index++) {
                const record = qvink.memoryOf(index);
                const text = record?.memory.trim();
                if (!record || !text) continue;
                if (record.include === 'long') material.long.push(text);
                if (record.include !== null) all.push(text);
            }
            material.recent = all.slice(-3);
        }
        const chapters = (await this.chapters.infos()).sort((a, b) => a.to - b.to);
        material.chapters = chapters.slice(-3).map((info) => ({ title: info.name || info.title, events: info.events }));
        return material;
    }

    freeText(material: RecapMaterial): string {
        const { t } = this.env;
        return freeRecap(material, {
            chapters: t('m9.recap.section.chapters'),
            long: t('m9.recap.section.long'),
            recent: t('m9.recap.section.recent'),
        });
    }

    private language(): 'ru' | 'en' {
        const chat = this.app.host.ctx().chat ?? [];
        const texts: string[] = [];
        for (let i = chat.length - 1; i >= 0 && texts.length < LANGUAGE_MESSAGES; i--) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            const text = cleanForAnalysis(message);
            if (text) texts.push(text);
        }
        return chatLanguage(texts);
    }

    /** The background model's recap; null when it is unavailable or failed. */
    private async aiText(material: RecapMaterial): Promise<string | null> {
        const { app, env } = this;
        if (!app.llm.available(RECAP_TASK)) return null;
        const prompt = recapPrompt(material, this.language(), RECAP_WORDS);
        try {
            const result = await app.llm.request({
                task: RECAP_TASK,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user },
                ],
                maxTokens: 400,
                temperature: 0.4,
            });
            if (!result.ok) {
                env.log.warn('the recap model failed', result.error);
                return null;
            }
            const text = tidyRecap(result.text ?? (typeof result.data === 'string' ? result.data : ''), RECAP_WORDS);
            return text || null;
        } catch (error) {
            env.log.warn('the recap model failed', error);
            return null;
        }
    }

    /** Task runner: the model's recap (the free one when the model fails), shown in the chat it was made for. */
    private async runTask(_payload: Record<string, unknown>, info: TaskInfo): Promise<void> {
        const chatId = info.chatId ?? this.app.host.chatId();
        if (!chatId || this.app.host.chatId() !== chatId) return;
        const material = await this.material();
        if (!hasMaterial(material)) return;
        const text = (await this.aiText(material)) ?? this.freeText(material);
        await this.show(text, chatId);
    }

    /** «Показать сейчас»: builds and shows the recap regardless of the timer; returns its text ('' when empty). */
    async recapNow(): Promise<string> {
        const { app, env } = this;
        const chatId = app.host.chatId();
        if (!chatId) return '';
        const material = await this.material();
        if (!hasMaterial(material)) {
            app.ui.notice(env.t('m9.recap.empty'));
            return '';
        }
        const settings = env.settings().recap;
        const text = (settings.source === 'ai' ? await this.aiText(material) : null) ?? this.freeText(material);
        if (app.leader.isLeader()) {
            const source = settings.source === 'ai' ? 'ai' : 'memory';
            await env.store.mutate((doc) => {
                doc.recap = { shownAt: Date.now(), source, text };
                return true;
            });
        }
        await this.show(text, chatId, true);
        return text;
    }

    /* ---------------------------------------------------------------- showing */

    private async show(text: string, chatId: string, explicit = false): Promise<void> {
        const { app, env } = this;
        if (!text || app.host.chatId() !== chatId || this.disposed) return;
        const target = env.settings().recap.target;
        if (target === 'off' && !explicit) return;
        this.renderPanel(text);
        if (target === 'userAndPrompt') this.pendingPrompt = { chatId, text };
        if (!explicit && app.leader.isLeader()) {
            await env.store.mutate((doc) => {
                if (!doc.recap || doc.recap.text === text) return false;
                doc.recap = { ...doc.recap, text };
                return true;
            });
        }
    }

    /** A dismissible panel right above ST's input bar; a notice with a link to the tab when the bar is missing. */
    private renderPanel(text: string): void {
        const { app, env } = this;
        this.hidePanel();
        const doc = typeof document === 'undefined' ? null : document;
        const form = doc?.getElementById('form_sheld');
        if (!doc || !form) {
            app.ui.notice(`${env.t('m9.recap.title')}\n${text}`, {
                urgent: true,
                action: { label: env.t('m9.recap.openTab'), run: () => app.ui.openPult(CHRONICLE_KEY) },
            });
            return;
        }
        const panel = el(
            'div',
            { class: RECAP_PANEL_CLASS, attrs: { role: 'region', 'aria-label': env.t('m9.recap.title') } },
            [
                el('div', { class: 'maestro-m9-recap-head' }, [
                    icon('fa-book-open'),
                    el('span', { class: 'maestro-m9-recap-title', text: env.t('m9.recap.title') }),
                    button({
                        icon: 'fa-xmark',
                        title: env.t('m9.recap.close'),
                        kind: 'ghost',
                        className: 'maestro-m9-recap-close',
                        onClick: () => this.hidePanel(),
                    }),
                ]),
                el('div', { class: 'maestro-m9-recap-text', text }),
                el('div', { class: 'maestro-m9-recap-actions' }, [
                    button({
                        label: env.t('m9.recap.openTab'),
                        icon: 'fa-book',
                        kind: 'ghost',
                        onClick: () => {
                            this.hidePanel();
                            app.ui.openPult(CHRONICLE_KEY);
                        },
                    }),
                ]),
            ],
        );
        const send = doc.getElementById('send_form');
        form.insertBefore(panel, send && send.parentElement === form ? send : form.firstChild);
        this.panel = panel;
    }

    hidePanel(): void {
        this.panel?.remove();
        this.panel = null;
    }

    /** The recap goes into the next real generation only (P16: near the end; cleared after it by app.ephemeral). */
    private produce(gen: GenerationInfo): void {
        if (gen.quiet || gen.dryRun || gen.sheetCommand) return;
        const pending = this.pendingPrompt;
        if (!pending) return;
        this.pendingPrompt = null;
        if (pending.chatId !== this.app.host.chatId()) return;
        const text = promptRecap(pending.text);
        if (text) this.app.ephemeral.setInjection(RECAP_INJECTION, { text, position: 1, depth: 1, role: 0 });
    }
}

export const RECAP_CSS = `
.${RECAP_PANEL_CLASS} { white-space: normal; box-sizing: border-box; width: 100%; margin: 0 auto 4px; padding: 8px 10px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius); background: var(--maestro-surface);
    backdrop-filter: blur(var(--SmartThemeBlurStrength, 0px)); color: var(--maestro-text); max-height: 40vh;
    overflow: auto; font-size: calc(var(--maestro-font-size) * 0.95); }
.maestro-m9-recap-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.maestro-m9-recap-title { flex: 1; }
.maestro-m9-recap-close { min-width: var(--maestro-tap); min-height: 32px; margin: 0; }
.maestro-m9-recap-text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; line-height: 1.4; }
.maestro-m9-recap-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 600px) { .${RECAP_PANEL_CLASS} { max-height: 30vh; padding: 6px 8px; } }
`;
