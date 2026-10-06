// The offer under the greeting (plan-2 §7, В13: Maestro offers preparation by itself; В14: only in new chats). In a
// new one-on-one chat — the greeting and nothing of the player's yet — the last message carries one line of the strip:
// «Подготовить историю к игре?» [Подготовить] [Не сейчас]; with a preparation saved for this character it offers that
// instead [Применить сохранённое] [Разобрать заново]. While the analysis runs the line shows its progress, a ready plan
// waits there to be looked at; once the plan is applied, the player writes, or he says «Не сейчас» (remembered in the
// chat's metadata) the line is gone. With the strip off (chatNotices 'none', or a shell without it) a quiet notice is
// given once per new chat instead.
import type { App, MessageStripProvider, StripItem, Unsubscribe } from '../../shared/contracts';
import { el } from '../../ui/components/dom';
import { PREPARE_WINDOW } from './controller';
import type { PrepareUi } from './controller';
import { PREPARE_TAB } from './settings';

export const PREPARE_STRIP = 'prepare';
const PREPARE_STRIP_ORDER = 5;
/** ST events after which the last message or the player's part in the chat may have changed (keys of eventTypes). */
const CHAT_EVENTS = ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED'];

function chatLength(app: App): number {
    try {
        const chat = app.host.ctx().chat;
        return Array.isArray(chat) ? chat.length : 0;
    } catch {
        return 0;
    }
}

/** «часть 2 из 3» of the running job, or its own label. */
export function jobProgress(ui: PrepareUi, jobKey: string | null): string {
    const job = jobKey ? ui.app.jobs?.get(jobKey) : undefined;
    if (job?.state === 'active' && job.total) {
        if ((job.done ?? 0) >= job.total) return ui.t('m37.ui.merging');
        return ui.t('m37.ui.readingPart', { part: (job.done ?? 0) + 1, total: job.total });
    }
    return job?.label ?? ui.t('m37.job.collecting');
}

export class PrepareOffer {
    private readonly listeners = new Set<(indexes?: number[]) => void>();
    /** Messages the provider returned a line for since the last change (they must be repainted when it goes). */
    private readonly shown = new Set<number>();
    /** The chat whose plan document the engine has answered for (no line before: no flicker of an applied chat). */
    private loadedChat: string | null = null;
    private readyCount = 0;
    private readonly noticed = new Set<string>();

    constructor(private readonly ui: PrepareUi) {}

    private get app(): App {
        return this.ui.app;
    }

    /* ---------------------------------------------------------------- the strip */

    provider(): MessageStripProvider {
        return {
            id: PREPARE_STRIP,
            order: PREPARE_STRIP_ORDER,
            items: (index) => this.items(index),
            onChange: (listener) => {
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
            },
        };
    }

    /** The line for the last message of a new chat; nothing elsewhere (cheap: called on every repaint). */
    items(index: number): StripItem[] {
        if (index !== chatLength(this.app) - 1) return [];
        const item = this.offerItem();
        if (!item) return [];
        this.shown.add(index);
        return [item];
    }

    /** Whether the offer is due in this chat now (the setting, «Не сейчас», a new chat, nothing applied). */
    private due(): boolean {
        const chatId = this.ui.chatId();
        if (!chatId || this.loadedChat !== chatId) return false;
        if (!this.ui.settings().offer || this.ui.offerPointer().hidden) return false;
        if (!this.ui.engine.eligibility().ok) return false;
        return this.ui.engine.state().stage !== 'applied';
    }

    private offerItem(): StripItem | null {
        if (!this.due()) return null;
        const { ui } = this;
        const state = ui.engine.state();
        const open = { window: PREPARE_WINDOW, tab: PREPARE_TAB };
        const later = { label: ui.t('m37.offer.later'), run: () => ui.setOfferPointer({ hidden: true }) };
        if (state.stage === 'running') {
            return {
                id: 'running',
                kind: 'info',
                icon: 'fa-wand-magic-sparkles',
                text: ui.t('m37.offer.running', { progress: jobProgress(ui, state.jobKey) }),
                open,
            };
        }
        if (state.stage === 'ready') {
            return {
                id: 'ready',
                kind: 'question',
                icon: 'fa-wand-magic-sparkles',
                tone: 'accent',
                text: ui.t('m37.offer.ready', { count: this.readyCount }),
                actions: [{ label: ui.t('m37.offer.open'), primary: true, run: () => ui.open() }, later],
            };
        }
        const saved = ui.savedInfo();
        if (saved === undefined) return null;
        if (saved) {
            return {
                id: 'saved',
                kind: 'question',
                icon: 'fa-wand-magic-sparkles',
                tone: 'accent',
                text: ui.t('m37.offer.saved', { count: saved.items.length }),
                actions: [
                    {
                        label: ui.t('m37.offer.applySaved'),
                        primary: true,
                        run: async () => {
                            await ui.applySaved();
                        },
                    },
                    {
                        label: ui.t('m37.offer.again'),
                        run: () => {
                            const draft = ui.draft();
                            draft.reuse = false;
                            draft.restart = true;
                            ui.changed();
                            ui.open();
                        },
                    },
                    later,
                ],
                body: (container) => {
                    container.appendChild(
                        el('div', {
                            class: 'maestro-muted',
                            text: saved.changed.length
                                ? ui.t('m37.view.changed', { list: saved.changed.slice(0, 8).join(', ') })
                                : ui.t('m37.ui.savedSame'),
                        }),
                    );
                },
            };
        }
        return {
            id: 'offer',
            kind: 'question',
            icon: 'fa-wand-magic-sparkles',
            tone: 'accent',
            text: ui.t('m37.offer.text'),
            actions: [{ label: ui.t('m37.offer.prepare'), primary: true, run: () => ui.open() }, later],
            body: (container) => {
                container.appendChild(el('div', { class: 'maestro-muted', text: ui.t('m37.offer.body') }));
            },
        };
    }

    /** Repaints the messages that had the line and the one that gets it now (none in an ordinary chat). */
    private refresh(): void {
        const indexes = new Set(this.shown);
        const last = chatLength(this.app) - 1;
        if (last >= 0 && this.due()) indexes.add(last);
        this.shown.clear();
        if (!indexes.size) return;
        const list = [...indexes];
        for (const listener of [...this.listeners]) {
            try {
                listener(list);
            } catch (error) {
                this.app.log.debug('prepare: a strip listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- wiring */

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const { app, ui } = this;
        offs.push(
            ui.engine.onChange(() => {
                this.readyCount = ui.engine.state().stage === 'ready' ? (ui.engine.plan()?.items.length ?? 0) : 0;
                this.refresh();
            }),
        );
        offs.push(ui.onChange(() => this.refresh()));
        for (const event of CHAT_EVENTS) {
            try {
                offs.push(
                    app.host.events.on(event, () => {
                        if (event === 'CHAT_CHANGED') void this.chatOpened();
                        else this.refresh();
                    }),
                );
            } catch (error) {
                app.log.debug(`prepare: no event ${event}`, error);
            }
        }
        const offJobs = app.jobs?.on((_job, key) => {
            if (key.startsWith('prepare:')) this.refresh();
        });
        if (offJobs) offs.push(offJobs);
        offs.push(
            app.settings.onChange((path) => {
                if (path === 'core.chatNotices' || path.startsWith('modules.prepare')) this.refresh();
            }),
        );
        void this.chatOpened();
        return offs;
    }

    /** A chat was opened: the engine reads its plan, then the line (or the quiet notice) may come. */
    async chatOpened(): Promise<void> {
        const chatId = this.ui.chatId();
        this.loadedChat = null;
        if (!chatId) return;
        try {
            await this.ui.engine.load();
        } catch (error) {
            this.app.log.debug('prepare: the plan did not load for the offer', error);
        }
        if (this.ui.chatId() !== chatId) return;
        this.loadedChat = chatId;
        this.readyCount = this.ui.engine.state().stage === 'ready' ? (this.ui.engine.plan()?.items.length ?? 0) : 0;
        // The saved preparation of the card decides which line is offered: start reading it now.
        if (this.due()) this.ui.savedInfo();
        this.refresh();
        await this.quietNotice(chatId);
    }

    /** With the strip off the offer is one quiet notice, once per new chat. */
    private async quietNotice(chatId: string): Promise<void> {
        const { app, ui } = this;
        const stripOn =
            typeof app.ui.addMessageStripProvider === 'function' && app.settings.core().chatNotices !== 'none';
        if (stripOn || this.noticed.has(chatId) || !this.due()) return;
        if (ui.engine.state().stage !== 'none' || ui.offerPointer().noticed) return;
        this.noticed.add(chatId);
        app.ui.notice(ui.t('m37.offer.notice'), {
            importance: 'info',
            action: { label: ui.t('m37.offer.prepare'), run: () => ui.open() },
        });
        try {
            await ui.setOfferPointer({ noticed: true });
        } catch (error) {
            app.log.debug('prepare: the notice mark was not saved', error);
        }
    }
}
