// The face of «Подготовить к игре» (plan-2 §7): one controller shared by the offer under the greeting and the
// preparation window — where the window lives (a window of its own when the shell has windows, else the pult tab
// «Подготовка»), the per-chat drafts of the window, the saved character-level preparation of the card (read once per
// chat: the offer and the first step both show it), and the actions both of them run (apply the saved preparation,
// apply the chosen items, undo one, hide the offer).
import type { SelectionRow } from '../../domain/prepare-apply';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { PrepareApi, PrepareApplyOptions, PrepareApplySummary, SavedPreparationInfo } from './api';
import { emptyDraft, mergeSummary } from './drafts';
import type { ChatDraft } from './drafts';
import { PREPARE_TAB } from './settings';
import type { PrepareSettings } from './settings';

/** Id of the preparation window (Ui.addWindow). */
export const PREPARE_WINDOW = 'prepare';
/** Chat metadata pointer of the offer: «Не сейчас» and the quiet notice given once. */
export const OFFER_POINTER = 'prepare.offer';

/** The engine as the face uses it; `watch` marks the job as shown (its end needs no notice then). */
export type PrepareEngine = PrepareApi & { watch?(): Unsubscribe };

export interface OfferPointer {
    hidden?: boolean;
    noticed?: boolean;
}

interface SavedSlot {
    chatId: string;
    /** undefined while it loads. */
    info?: SavedPreparationInfo | null;
}

export class PrepareUi {
    private readonly drafts = new Map<string, ChatDraft>();
    private readonly listeners = new Set<() => void>();
    private mode: 'window' | 'tab' | null = null;
    private saved: SavedSlot | null = null;

    constructor(
        readonly app: App,
        readonly engine: PrepareEngine,
        readonly settings: () => PrepareSettings,
    ) {}

    t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    chatId(): string | null {
        try {
            return this.app.host.chatId();
        } catch {
            return null;
        }
    }

    /** The current chat's draft (created on first use). */
    draft(): ChatDraft {
        const chatId = this.chatId() ?? '';
        let draft = this.drafts.get(chatId);
        if (!draft) {
            draft = emptyDraft();
            this.drafts.set(chatId, draft);
        }
        return draft;
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
                this.app.log.error('prepare: a view listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- where the window lives */

    setMode(mode: 'window' | 'tab' | null): void {
        this.mode = mode;
    }

    windowed(): boolean {
        return this.mode === 'window' && typeof this.app.ui.openWindow === 'function';
    }

    /** Opens the preparation window (or the pult tab when the shell has no windows). */
    open(): void {
        if (this.windowed()) this.app.ui.openWindow!(PREPARE_WINDOW);
        else this.app.ui.openPult(PREPARE_TAB);
    }

    /** Opens the window (or pult tab) of another module's section: the canon, places, mechanics, the dossier… */
    openSection(tab: string): void {
        const win = this.app.ui.windowOfTab?.(tab);
        if (win && typeof this.app.ui.openWindow === 'function') this.app.ui.openWindow(win, { tab });
        else this.app.ui.openPult(tab);
    }

    /* ---------------------------------------------------------------- the saved preparation of the card */

    /** The saved character-level preparation of this chat's card: undefined while it loads (the load starts). */
    savedInfo(): SavedPreparationInfo | null | undefined {
        const chatId = this.chatId();
        if (!chatId) return null;
        if (this.saved?.chatId === chatId) return this.saved.info;
        const slot: SavedSlot = { chatId };
        this.saved = slot;
        void this.engine
            .savedFor()
            .catch((error: unknown) => {
                this.app.log.debug('prepare: the saved preparation was not read', error);
                return null;
            })
            .then((info) => {
                if (this.saved !== slot) return;
                slot.info = info;
                this.changed();
            });
        return undefined;
    }

    /** Reads the saved preparation again (after applying something «для персонажа»). */
    refreshSaved(): void {
        this.saved = null;
        this.changed();
    }

    /* ---------------------------------------------------------------- the offer */

    offerPointer(): OfferPointer {
        try {
            const value = this.app.chat.pointer<unknown>(OFFER_POINTER);
            return value && typeof value === 'object' ? (value as OfferPointer) : {};
        } catch {
            return {};
        }
    }

    async setOfferPointer(patch: OfferPointer): Promise<void> {
        await this.app.chat.setPointer(OFFER_POINTER, { ...this.offerPointer(), ...patch });
        this.changed();
    }

    /* ---------------------------------------------------------------- actions */

    /** Analyses the story (the window's «Начать», the offer's «Разобрать заново» goes through the first step). */
    async start(reuse: boolean): Promise<string | null> {
        const draft = this.draft();
        draft.restart = false;
        draft.review = false;
        draft.summary = null;
        draft.undone.clear();
        const key = await this.engine.start(reuse ? { reuse: true } : {});
        this.changed();
        return key;
    }

    /** The saved character-level preparation into this chat (no model call). */
    async applySaved(): Promise<PrepareApplySummary> {
        const draft = this.draft();
        const summary = await this.engine.applySaved(this.passportOption());
        draft.summary = mergeSummary(draft.summary, summary);
        draft.review = false;
        draft.restart = false;
        this.refreshSaved();
        return summary;
    }

    passportOption(): PrepareApplyOptions {
        const passports = this.draft().passports;
        return passports === null ? {} : { passports };
    }

    /**
     * The chosen rows; items «для персонажа» are confirmed here once (the card's own book and passports are written).
     * Returns null when the user declined.
     */
    async apply(rows: readonly SelectionRow[], cardName: string): Promise<PrepareApplySummary | null> {
        if (!rows.length) return null;
        const forCard = rows.filter((row) => row.scope === 'character').length;
        if (forCard) {
            const ok = await this.app.ui.confirm(
                this.t('m37.confirm.title'),
                this.t('m37.confirm.body', { count: forCard, card: cardName }),
            );
            if (!ok) return null;
        }
        const draft = this.draft();
        const summary = await this.engine.apply(rows, { ...this.passportOption(), confirmed: true });
        if (summary.cancelled) return null;
        // What was written now exists: its choice starts over (off, «уже есть»).
        for (const line of summary.done) {
            draft.choices.delete(line.itemId);
            draft.undone.delete(line.itemId);
        }
        draft.summary = mergeSummary(draft.summary, summary);
        draft.review = false;
        if (forCard) this.refreshSaved();
        else this.changed();
        return summary;
    }

    /** Undoes one applied item from the result list. */
    async undo(itemId: string): Promise<boolean> {
        const ok = await this.engine.undoItem(itemId);
        if (ok) {
            const draft = this.draft();
            draft.undone.add(itemId);
            draft.choices.delete(itemId);
        }
        this.changed();
        return ok;
    }
}
