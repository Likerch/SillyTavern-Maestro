// «Записывать одежду в трекер DES» (M27 «Переодеть сейчас»): what a character wears now goes into DES's tracker of the
// newest reply — the clothing field («Одежда» / "Outfit"), else the appearance field when it holds clothes
// (src/domain/des-outfit.ts) — so DES shows it and the next reply is generated from it. Written the way DES stores a
// parsed reply (adapters/des/kit.ts): `extra.dooms_tracker_swipes[swipe]` (and its `swipe_info` mirror), the display
// and committed state where they still hold the old text, DES's renderers, saveChatData. During a generation DES has
// already put the committed tracker into the prompt (its example block): that slot is rebuilt with DES's own function.
// Never while DES's Workshop is open. The journal change of DES_TRACKER_TARGET takes it back (only while the tracker
// still says what Maestro wrote).
import { adaptersOf } from '../../adapters';
import { loadDesKit } from '../../adapters/des/kit';
import type { DesKit } from '../../adapters/des/kit';
import { setDesOutfit } from '../../domain/des-outfit';
import { desSwipeRecord, parseTrackerJson } from '../../domain/des-tracker';
import type { App, JournalChange, Logger } from '../../shared/contracts';

/** Journal target of a clothing written into DES's tracker. */
export const DES_TRACKER_TARGET = 'wardrobe.desTracker';
/** DES's slot of the committed tracker in the prompt (injector.js). */
const EXAMPLE_SLOT = 'dooms-tracker-example';
/** How many replies back the newest tracker with characters is looked for. */
const LOOK_BACK = 6;

/** The parts of DES's kit the writer uses (a fake in tests). */
export type DesKitLike = Pick<DesKit, 'replaceCharacters' | 'render' | 'save' | 'trackerExample'>;

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);

function swipeOf(message: STChatMessage): number {
    return typeof message.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}

/** The record DES keeps for a swipe of a message (in `extra`, and the `swipe_info` mirror when there is one). */
function holders(message: STChatMessage, swipe: number): Dict[] {
    const out: Dict[] = [];
    // DES keys the swipes by number (an object, or an array in older chats).
    const slot = (swipes: unknown): Dict | null => {
        const value = Array.isArray(swipes) ? swipes[swipe] : isDict(swipes) ? swipes[String(swipe)] : undefined;
        return isDict(value) ? value : null;
    };
    const extra = isDict(message.extra) ? message.extra : null;
    const own = slot(extra?.dooms_tracker_swipes);
    if (own) out.push(own);
    const info = Array.isArray((message as unknown as Dict).swipe_info)
        ? ((message as unknown as Dict).swipe_info as unknown[])[swipe]
        : undefined;
    const infoExtra = isDict(info) && isDict(info.extra) ? info.extra : null;
    const mirror = slot(infoExtra?.dooms_tracker_swipes);
    if (mirror && mirror !== own) out.push(mirror);
    return out;
}

export class DesOutfitWriter {
    private kitPromise: Promise<DesKitLike | null> | null = null;
    private loader: () => Promise<DesKitLike | null>;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.loader = () => loadDesKit(this.app, this.log);
    }

    /** Replaces how DES's modules are loaded (tests). */
    setKitLoader(loader: () => Promise<DesKitLike | null>): void {
        this.loader = loader;
        this.kitPromise = null;
    }

    private kit(): Promise<DesKitLike | null> {
        if (!this.kitPromise) {
            const pending = this.loader().catch((error: unknown) => {
                this.log.debug('DES modules could not be loaded', error);
                return null;
            });
            this.kitPromise = pending;
            void pending.then((kit) => {
                if (!kit && this.kitPromise === pending) this.kitPromise = null;
            });
        }
        return this.kitPromise;
    }

    private des() {
        try {
            return adaptersOf(this.app).des;
        } catch {
            return undefined;
        }
    }

    /** DES is there, on, and its Workshop is closed. */
    writable(): boolean {
        const des = this.des();
        try {
            return !!des && des.present() && des.enabled() && !des.isWorkshopOpen();
        } catch {
            return false;
        }
    }

    /** The newest reply whose tracker has characters (DES shows and generates from it). */
    private newest(): number {
        const chat = this.app.host.ctx().chat ?? [];
        let seen = 0;
        for (let index = chat.length - 1; index >= 0 && seen <= LOOK_BACK; index--) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            seen++;
            const record = desSwipeRecord(message);
            if (record && parseTrackerJson(record.characterThoughts) !== null) return index;
        }
        return -1;
    }

    /**
     * Writes what `names[0]` (and its aliases) wears into the newest tracker. The journal change, or null when DES
     * is not there, the Workshop is open, the character is not in the tracker or it has no place for clothes.
     */
    async write(
        names: readonly string[],
        wording: string,
        options: { generating?: boolean } = {},
    ): Promise<JournalChange | null> {
        if (!this.writable() || !wording.trim()) return null;
        const chatId = this.app.host.chatId();
        const index = this.newest();
        const message = index >= 0 ? this.app.host.ctx().chat[index] : undefined;
        if (!chatId || !message) return null;
        const swipe = swipeOf(message);
        const record = desSwipeRecord(message);
        const before = typeof record?.characterThoughts === 'string' ? record.characterThoughts : null;
        if (before === null) return null;
        const fields = ((): { name: string; enabled: boolean }[] | null => {
            try {
                return this.des()?.characterFields() ?? null;
            } catch {
                return null;
            }
        })();
        const edit = setDesOutfit(before, names, wording, fields);
        if (!edit) return null;
        const places = holders(message, swipe);
        if (!places.length) return null;
        for (const place of places) place.characterThoughts = edit.thoughts;
        await this.settle(before, edit.thoughts, index, options.generating === true);
        return {
            target: DES_TRACKER_TARGET,
            ref: {
                chatId,
                messageIndex: index,
                swipeId: swipe,
                name: names[0] ?? '',
                key: edit.key,
                field: edit.field,
            },
            before: { value: edit.before, thoughts: before },
            after: { value: edit.after, thoughts: edit.thoughts },
        };
    }

    /** DES's display and committed state, its renderers, its save; the prompt slot during a generation. */
    private async settle(before: string, after: string, index: number, generating: boolean): Promise<void> {
        const kit = await this.kit();
        if (!kit) {
            if (!generating) await this.app.host.ctx().saveChat();
            return;
        }
        const swapped = kit.replaceCharacters(before, after);
        try {
            kit.render({ characterThoughts: after }, index);
        } catch (error) {
            this.log.debug('DES did not redraw', error);
        }
        if (generating && swapped.committed) this.refreshExample(kit);
        const saving = kit.save().catch((error: unknown) => this.log.warn('DES did not save the chat', error));
        // During a generation the chat is saved after the reply anyway: the send path does not wait for it.
        if (!generating) await saving;
    }

    /** DES built its example block from the old committed tracker at the start of this generation: rebuilt. */
    private refreshExample(kit: DesKitLike): void {
        const slots = this.app.host.ctx().extensionPrompts;
        const slot = slots?.[EXAMPLE_SLOT];
        if (!slot || !slot.value?.trim()) return;
        const example = kit.trackerExample();
        if (example) slot.value = `\`\`\`json\n${example}\n\`\`\`\n`;
    }

    /** Journal undo: the tracker text from before, while the tracker still says what Maestro wrote. */
    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref as { chatId?: unknown; messageIndex?: unknown; swipeId?: unknown };
        const before =
            isDict(change.before) && typeof change.before.thoughts === 'string' ? change.before.thoughts : null;
        const after = isDict(change.after) && typeof change.after.thoughts === 'string' ? change.after.thoughts : null;
        if (before === null || after === null || typeof ref.messageIndex !== 'number') return false;
        // Another chat, or the tracker was written anew since (a new reply, DES's own edit): nothing of ours is left.
        if (this.app.host.chatId() !== ref.chatId) return true;
        const message = this.app.host.ctx().chat[ref.messageIndex];
        if (!message) return true;
        const swipe = typeof ref.swipeId === 'number' ? ref.swipeId : swipeOf(message);
        const places = holders(message, swipe).filter((place) => place.characterThoughts === after);
        if (!places.length) return true;
        if (this.des()?.isWorkshopOpen()) return false;
        for (const place of places) place.characterThoughts = before;
        await this.settle(after, before, ref.messageIndex, false);
        return true;
    }
}
