// M42 «Мастерская»: a card with a workshop tag (ST's tag list, «мастерская» by default) is a helper — a scenario or
// character creator, an editor — and its chats are workshop chats, where the story machinery of the stack stays silent:
// - Maestro's story modules are paused (ModuleManager.suspend: stopped without touching their switches, started again
//   when a story chat opens); tools and looks keep running (WORKSHOP_KEEPS);
// - the outgoing prompt loses every extension's injection but ST's own (DES tracker texts, NAI markers, CarrotKernel,
//   Dramatis, DES-RU, Qvink, Maestro's own — domain/workshop.ts keepsSlot), cut at CHAT_COMPLETION_PROMPT_READY after
//   everyone else (the slot texts are read there, so it does not matter when a neighbour set them);
// - global and persona lorebooks are dropped at WORLDINFO_ENTRIES_LOADED (the card's and the chat's own stay);
// - Qvink is switched off for the chat by its own per-chat switch (and back on when the card leaves the workshop);
// - the Preset Studio's binder selects the workshop preset (layer.bindings() reports it) and keeps the model.
// Dramatis pauses itself through MAESTRO_API.workshop. The decision is taken in the FIRST CHAT_CHANGED listener and
// awaited by ST, so paused modules never see the workshop chat (host/events.ts drops calls to removed listeners that
// ST's emit still holds in its copy of the list); the tag set or removed while the chat is open is noticed on
// SETTINGS_UPDATED (ST saves its tag map), CHARACTER_EDITED and before every generation.
import { adaptersOf } from '../../adapters';
import { cutTexts, filterLore, slotsToCut, workshopTagOf } from '../../domain/workshop';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import { WORKSHOP_ID, WORKSHOP_KEEPS, WORKSHOP_LISTENER_TIMEOUT_MS } from './api';
import type { WorkshopApi, WorkshopSettings } from './api';

export const WORKSHOP_CARD_KIND = 'workshop.card';
export const WORKSHOP_QVINK_KIND = 'workshop.qvink';
/** Journal targets: a card's workshop tag (ref avatar), Qvink's switch of one chat (ref chatId). */
export const CARD_TARGET = 'workshop-card';
export const QVINK_TARGET = 'workshop-qvink';
/** Chat pointer: Qvink was switched off in this chat by the workshop (it is switched back on when the card leaves). */
export const QVINK_POINTER = 'workshop.qvinkOff';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Characters a slash argument cannot carry safely (quotes, pipes, macros). */
const UNSAFE_SLASH = /["|\\]|\{\{/;

export class WorkshopService implements WorkshopApi {
    private current = false;
    private chatId: string | null = null;
    private noticedChat: string | null = null;
    private readonly listeners = new Set<(active: boolean) => void | Promise<void>>();
    private chain: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => WorkshopSettings,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { host } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown, order?: 'first' | 'last') => {
            const name = host.events.name(key);
            if (!name) {
                this.log.debug(`ST event ${key} is missing`);
                return;
            }
            own(host.events.on(name, handler, order ? { order } : undefined));
        };
        // ST awaits this listener before the others: paused modules never see the workshop chat.
        on('CHAT_CHANGED', () => this.sync(), 'first');
        on('APP_READY', () => this.sync());
        on('SETTINGS_UPDATED', () => this.sync());
        on('CHARACTER_EDITED', () => this.sync());
        on('GENERATION_STARTED', () => this.sync(), 'first');
        on('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data), 'last');
        on('WORLDINFO_ENTRIES_LOADED', (payload) => this.onEntriesLoaded(payload), 'first');
        own(
            this.app.settings.onChange((path) => {
                if (path.startsWith('modules.workshop')) void this.sync();
            }),
        );
        this.app.journal.registerUndo(CARD_TARGET, (change) => this.undoCard(change));
        this.app.journal.registerUndo(QVINK_TARGET, (change) => this.undoQvink(change));
        own(() => this.dispose());
        void this.sync();
    }

    /** The module stops (switched off, or Maestro stops): paused modules start again, nothing stays silent. */
    private async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const was = this.current;
        this.current = false;
        this.listeners.clear();
        await this.chain.catch(() => undefined);
        if (this.app.modules.isSuspended?.()) await this.app.modules.resume?.();
        if (was) await this.app.bus.emit('workshop:changed', { active: false, chatId: this.chatId });
    }

    /* ---------------------------------------------------------------- reading */

    active(): boolean {
        return !this.disposed && this.current;
    }

    preset(): string | null {
        if (!this.active()) return null;
        return this.settings().preset.trim() || null;
    }

    isWorkshopCard(avatar: string): boolean {
        return this.tagOf(avatar) !== null;
    }

    private tagOf(avatar: string): { id: string; name: string } | null {
        try {
            const ctx = this.app.host.ctx();
            return workshopTagOf(ctx.tagMap?.[avatar], ctx.tags, this.settings().tags);
        } catch {
            return null;
        }
    }

    /** The avatar of the character whose solo chat is open, or null (a group, nothing open). */
    openAvatar(): string | null {
        try {
            const ctx = this.app.host.ctx();
            if (ctx.groupId) return null;
            const id = ctx.characterId;
            if (id === undefined || id === null || id === '') return null;
            const avatar = ctx.characters?.[Number(id)]?.avatar;
            return typeof avatar === 'string' && avatar ? avatar : null;
        } catch {
            return null;
        }
    }

    onChange(listener: (active: boolean) => void | Promise<void>): Unsubscribe {
        if (this.disposed || typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- deciding */

    /** Serialised: a chat switch waits for the decision of the one before. */
    sync(): Promise<void> {
        const job = this.chain.then(() => this.decide());
        this.chain = job.catch((error: unknown) => this.log.warn('workshop state was not applied', error));
        return this.chain;
    }

    private async decide(): Promise<void> {
        if (this.disposed) return;
        const chatId = this.app.host.chatId();
        const avatar = this.openAvatar();
        const next = avatar !== null && this.isWorkshopCard(avatar);
        const flipped = next !== this.current;
        const switched = chatId !== this.chatId;
        this.current = next;
        this.chatId = chatId;
        if (next) {
            if (flipped || !this.app.modules.isSuspended?.()) await this.app.modules.suspend?.(WORKSHOP_KEEPS);
        } else if (this.app.modules.isSuspended?.()) {
            await this.app.modules.resume?.();
        }
        if (flipped) {
            this.log.info(next ? 'workshop chat: the story machinery is paused' : 'story chat: everything runs');
            await this.app.bus.emit('workshop:changed', { active: next, chatId });
            await this.notify(next);
        }
        if (!flipped && !switched) return;
        if (next) {
            this.noticeOnce(chatId);
            void this.qvinkOff();
        } else {
            this.noticedChat = null;
            void this.qvinkBack();
        }
    }

    /** Listeners of a flip (MAESTRO_API: Dramatis pauses itself), each awaited a bounded time. */
    private async notify(active: boolean): Promise<void> {
        for (const listener of [...this.listeners]) {
            if (!this.listeners.has(listener)) continue;
            try {
                const result = listener(active);
                if (result instanceof Promise) {
                    await Promise.race([
                        result.catch((error: unknown) => this.log.warn('workshop listener failed', error)),
                        new Promise((resolve) => setTimeout(resolve, WORKSHOP_LISTENER_TIMEOUT_MS)),
                    ]);
                }
            } catch (error) {
                this.log.warn('workshop listener failed', error);
            }
        }
    }

    private noticeOnce(chatId: string | null): void {
        if (!this.settings().notice || this.noticedChat === (chatId ?? '')) return;
        this.noticedChat = chatId ?? '';
        const preset = this.settings().preset.trim();
        this.app.ui.notice(preset ? this.t('m42.notice.on', { preset }) : this.t('m42.notice.onNoPreset'), {
            importance: 'info',
            group: 'workshop.on',
        });
    }

    /* ---------------------------------------------------------------- generation time */

    /**
     * CHAT_COMPLETION_PROMPT_READY `{chat, dryRun}`, last listener: in a workshop chat every extension's text but ST's
     * own is cut out of the outgoing messages (dry runs too, so the prompt preview shows what really goes).
     */
    onPromptReady(data: unknown): void {
        if (!this.active() || !isDict(data) || !Array.isArray(data.chat)) return;
        try {
            const ctx = this.app.host.ctx();
            const texts = slotsToCut(ctx.extensionPrompts);
            if (!texts.length) return;
            const substitute = (text: string) => {
                try {
                    return ctx.substituteParams(text);
                } catch {
                    return text;
                }
            };
            const cut = cutTexts(data.chat as unknown[], texts, substitute);
            if (cut.length && data.dryRun === false) this.log.debug(`workshop: cut from the prompt: ${cut.join(', ')}`);
        } catch (error) {
            this.log.warn('workshop: the prompt was not cleaned', error);
        }
    }

    /** WORLDINFO_ENTRIES_LOADED, first listener: the lorebooks a workshop chat does not get. */
    onEntriesLoaded(payload: unknown): void {
        if (!this.active()) return;
        const dropped = filterLore(payload, this.settings().lore);
        if (dropped) this.log.debug(`workshop: ${dropped} lore entries left out`);
    }

    /* ---------------------------------------------------------------- the card's tag */

    async setCard(avatar: string, on: boolean): Promise<boolean> {
        if (this.disposed || !avatar) return false;
        const before = this.tagOf(avatar);
        if (on === (before !== null)) return true;
        const ok = on ? await this.addTag(avatar) : await this.removeTags(avatar);
        const after = this.tagOf(avatar);
        if (!ok || on !== (after !== null)) {
            this.app.ui.notice(this.t(on ? 'm42.tag.addFailed' : 'm42.tag.removeFailed'), {
                level: 'warn',
                urgent: true,
            });
            return false;
        }
        const name = this.cardName(avatar);
        try {
            await this.app.journal.record({
                module: WORKSHOP_ID,
                kind: WORKSHOP_CARD_KIND,
                summary: this.t(on ? 'm42.journal.on' : 'm42.journal.off', { name }),
                changes: [{ target: CARD_TARGET, ref: { avatar }, before: !on, after: on }],
            });
        } catch (error) {
            this.log.warn('workshop tag change was not journaled', error);
        }
        await this.sync();
        return true;
    }

    private cardName(avatar: string): string {
        try {
            const character = this.app.host.ctx().characters?.find((item) => item?.avatar === avatar);
            return typeof character?.name === 'string' && character.name ? character.name : avatar;
        } catch {
            return avatar;
        }
    }

    /** The tag the button sets: an existing tag with a workshop name, else the first name of the setting. */
    private tagToSet(): string {
        const tags = this.settings().tags;
        try {
            const ctx = this.app.host.ctx();
            for (const tag of ctx.tags ?? []) {
                if (workshopTagOf([tag.id], [tag], tags)) return tag.name;
            }
        } catch {
            // fall through to the setting
        }
        return tags[0] ?? 'мастерская';
    }

    private async addTag(avatar: string): Promise<boolean> {
        const name = this.tagToSet();
        // ST's /tag-add creates the tag when it does not exist yet and takes the avatar file as the character key.
        if (UNSAFE_SLASH.test(avatar) || UNSAFE_SLASH.test(name)) return this.tagsModule('add', avatar, name);
        return this.runSlash(`/tag-add name="${avatar}" ${name}`);
    }

    private async removeTags(avatar: string): Promise<boolean> {
        let ok = true;
        // Every workshop tag the card has (it may carry «мастерская» and «workshop» both).
        for (let guard = 0; guard < 8; guard++) {
            const tag = this.tagOf(avatar);
            if (!tag) break;
            const done =
                UNSAFE_SLASH.test(avatar) || UNSAFE_SLASH.test(tag.name)
                    ? await this.tagsModule('remove', avatar, tag.name)
                    : await this.runSlash(`/tag-remove name="${avatar}" ${tag.name}`);
            if (!done) {
                ok = false;
                break;
            }
        }
        return ok && this.tagOf(avatar) === null;
    }

    /** tags.js directly, for names a slash argument cannot carry: only an existing tag can be set this way. */
    private async tagsModule(op: 'add' | 'remove', avatar: string, name: string): Promise<boolean> {
        try {
            const ctx = this.app.host.ctx();
            const tag = ctx.tags?.find((item) => item.name === name);
            if (!tag) return false;
            const tags = await this.app.host.modules.load('/scripts/tags.js');
            const fn = op === 'add' ? tags.addTagsToEntity : tags.removeTagFromEntity;
            if (typeof fn !== 'function') return false;
            (fn as (tag: unknown, entity: string) => unknown)(tag, avatar);
            return true;
        } catch (error) {
            this.log.warn(`workshop: tags.js ${op} failed`, error);
            return false;
        }
    }

    private async runSlash(command: string): Promise<boolean> {
        try {
            const ctx = this.app.host.ctx();
            if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return false;
            const result = await ctx.executeSlashCommandsWithOptions(command, {
                handleParserErrors: false,
                handleExecutionErrors: false,
                source: 'maestro',
            });
            return !(isDict(result) && result.isError === true);
        } catch (error) {
            this.log.warn(`workshop: ${command.split(' ')[0]} failed`, error);
            return false;
        }
    }

    private async undoCard(change: JournalChange): Promise<boolean> {
        const avatar = typeof change.ref.avatar === 'string' ? change.ref.avatar : '';
        if (!avatar || typeof change.before !== 'boolean') return false;
        if (this.isWorkshopCard(avatar) !== change.after) return false;
        const ok = change.before ? await this.addTag(avatar) : await this.removeTags(avatar);
        await this.sync();
        return ok && this.isWorkshopCard(avatar) === change.before;
    }

    /* ---------------------------------------------------------------- Qvink */

    private qvink(): {
        present(): boolean;
        chatEnabled(): boolean;
        settings(): Dict | null;
    } | null {
        const adapter = adaptersOf(this.app).qvink as unknown as Partial<{
            present(): boolean;
            chatEnabled(): boolean;
            settings(): Dict | null;
        }>;
        if (
            typeof adapter?.present !== 'function' ||
            typeof adapter.chatEnabled !== 'function' ||
            typeof adapter.settings !== 'function'
        )
            return null;
        return adapter as { present(): boolean; chatEnabled(): boolean; settings(): Dict | null };
    }

    /** Switches Qvink off for the workshop chat open now (its own per-chat switch), once, journaled. */
    private async qvinkOff(): Promise<void> {
        const chatId = this.app.host.chatId();
        const qvink = this.qvink();
        if (!this.settings().qvink || !chatId || !qvink?.present() || !qvink.chatEnabled()) return;
        if (qvink.settings()?.use_global_toggle_state === true) {
            // Qvink keeps one switch for every chat: switching it here would switch it everywhere.
            this.app.ui.notice(this.t('m42.qvink.global'), { importance: 'important', level: 'warn' });
            return;
        }
        if (!(await this.runSlash('/qm-toggle false')) || qvink.chatEnabled()) {
            this.log.warn('workshop: Qvink stayed on for this chat');
            return;
        }
        if (this.app.host.chatId() !== chatId) return;
        await this.app.chat.setPointer(QVINK_POINTER, true);
        try {
            await this.app.journal.record({
                module: WORKSHOP_ID,
                kind: WORKSHOP_QVINK_KIND,
                summary: this.t('m42.journal.qvinkOff'),
                changes: [{ target: QVINK_TARGET, ref: { chatId }, before: true, after: false }],
            });
        } catch (error) {
            this.log.warn('Qvink switch was not journaled', error);
        }
    }

    /** A chat whose Qvink the workshop switched off, opened while its card is no workshop card any more. */
    private async qvinkBack(): Promise<void> {
        if (!this.app.host.chatId() || this.app.chat.pointer<boolean>(QVINK_POINTER) !== true) return;
        const qvink = this.qvink();
        if (qvink?.present() && !qvink.chatEnabled()) {
            if (!(await this.runSlash('/qm-toggle true'))) return;
            this.app.ui.notice(this.t('m42.qvink.back'), { importance: 'info' });
        }
        await this.app.chat.setPointer(QVINK_POINTER, null);
    }

    private async undoQvink(change: JournalChange): Promise<boolean> {
        const chatId = typeof change.ref.chatId === 'string' ? change.ref.chatId : '';
        const qvink = this.qvink();
        // Qvink's switch belongs to its chat: undo works only there.
        if (!chatId || this.app.host.chatId() !== chatId || !qvink?.present()) return false;
        if (qvink.chatEnabled()) return true;
        if (!(await this.runSlash('/qm-toggle true'))) return false;
        await this.app.chat.setPointer(QVINK_POINTER, null);
        return qvink.chatEnabled();
    }
}
