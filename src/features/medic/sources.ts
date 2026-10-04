// What M3 reads from the live chat, lorebooks and neighbours, shaped for the pure checks in src/domain/medic-*.ts.
import { QVINK_KEY } from '../../adapters/qvink';
import { detectSheetCommand } from '../../domain/sheets';
import type { QvinkGapOptions, QvinkMessageView } from '../../domain/medic-qvink';
import type { App } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reply types that are not a model's story reply (first message, background calls, NAI picture posts). */
const SKIPPED_TYPES = new Set(['first_message', 'quiet', 'impersonate', 'extension']);

/** NAI Studio picture post: `extra.nai_studio` with the image prompt as text (research/qvink-nai-studio.md §B5). */
export function isPicturePost(message: STChatMessage): boolean {
    return isDict(message.extra?.nai_studio);
}

/** The last user message before `index` asked BunnyMo for a sheet (`!fullsheet`, …). */
export function answersSheetCommand(chat: readonly STChatMessage[], index: number): boolean {
    for (let i = index - 1; i >= 0; i--) {
        const message = chat[i];
        if (message?.is_user) return detectSheetCommand(message.mes) !== undefined;
    }
    return false;
}

/** A message M31 marked as a sheet (`extra.maestro.sheet`). */
export function isSheetMessage(message: STChatMessage): boolean {
    const maestro = message.extra?.maestro;
    return isDict(maestro) && maestro.sheet === true;
}

/** The reply at `index` is a regular story reply the checks apply to. */
export function isStoryReply(chat: readonly STChatMessage[], index: number, type = 'normal'): boolean {
    if (SKIPPED_TYPES.has(type)) return false;
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return false;
    if (isPicturePost(message) || isSheetMessage(message)) return false;
    return !answersSheetCommand(chat, index);
}

/** Newest story reply of the chat (NAI picture posts after it are skipped), -1 if none. */
export function lastStoryReply(app: App): number {
    const chat = app.host.ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system || isPicturePost(message)) continue;
        return isStoryReply(chat, i) ? i : -1;
    }
    return -1;
}

/** Messages as Qvink sees them; the raw `lagging` flag is kept tri-state (the adapter folds it to boolean). */
export function qvinkViews(chat: readonly STChatMessage[]): QvinkMessageView[] {
    return chat.map((message) => {
        const raw = message.extra?.[QVINK_KEY];
        return {
            isUser: message.is_user,
            isSystem: message.is_system,
            textLength: typeof message.mes === 'string' ? message.mes.trim().length : 0,
            skip: isPicturePost(message),
            record: isDict(raw)
                ? {
                      memory: typeof raw.memory === 'string' ? raw.memory : '',
                      exclude: raw.exclude === true,
                      remember: raw.remember === true,
                      ...(typeof raw.lagging === 'boolean' ? { lagging: raw.lagging } : {}),
                  }
                : null,
        };
    });
}

/** Qvink's exclusion settings (best effort: Qvink has no API; names from its settings object). */
export function qvinkGapOptions(settings: Dict | null): QvinkGapOptions {
    const flag = (key: string) => settings?.[key] === true;
    const threshold = Number(settings?.message_length_threshold);
    return {
        includeUser: flag('include_user_messages'),
        includeSystem: flag('include_system_messages'),
        minTokens: Number.isFinite(threshold) && threshold >= 0 ? threshold : 10,
    };
}

function charaFilename(avatar: unknown): string {
    return typeof avatar === 'string' ? avatar.replace(/\.[^/.]+$/, '') : '';
}

function addName(names: Set<string>, value: unknown): void {
    if (typeof value === 'string' && value.trim()) names.add(value);
}

/**
 * Lorebooks active for the current chat: M1's "why active" when it runs, otherwise ST's own sources — global
 * selection, character primary and extra books, chat book, persona book (world-info.js, personas.js).
 */
export async function activeBookNames(app: App): Promise<string[]> {
    const journal = app.modules.api<LoreJournalApi>('loreJournal');
    if (journal) {
        try {
            const reasons = await journal.whyActive();
            if (reasons.length) return [...new Set(reasons.map((reason) => reason.book))];
        } catch {
            // fall back to ST's sources
        }
    }
    const ctx = app.host.ctx();
    const names = new Set<string>();
    if (app.host.caps.has('st.wi.module')) {
        try {
            const wi = await app.host.modules.worldInfo();
            if (Array.isArray(wi.selected_world_info)) for (const name of wi.selected_world_info) addName(names, name);
            const character = ctx.characters[Number(ctx.characterId)];
            const lore = isDict(wi.world_info) ? wi.world_info.charLore : undefined;
            const fileName = charaFilename(character?.avatar);
            if (Array.isArray(lore) && fileName) {
                const extra = lore.find((item) => isDict(item) && item.name === fileName);
                if (isDict(extra) && Array.isArray(extra.extraBooks))
                    for (const name of extra.extraBooks) addName(names, name);
            }
        } catch {
            // world-info.js unavailable: the other sources still count
        }
    }
    if (!app.host.isGroupChat()) {
        const character = ctx.characters[Number(ctx.characterId)];
        addName(names, character?.data?.extensions?.world);
    }
    addName(names, ctx.chatMetadata.world_info);
    addName(names, ctx.powerUserSettings?.persona_description_lorebook);
    return [...names];
}

/** Loads a lorebook through ST (cached by ST, returns a copy); null when it is missing. */
export async function loadBook(app: App, name: string): Promise<unknown> {
    const load = app.host.ctx().loadWorldInfo;
    if (typeof load !== 'function') return null;
    try {
        return await load(name);
    } catch {
        return null;
    }
}
