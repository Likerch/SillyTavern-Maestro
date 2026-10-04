// `extra.maestro.sheet` on chat messages. Written on the live message (and on the current swipe's swipe_info, which
// ST copies back into `extra` on every swipe), under Maestro's own key only; neighbours' keys are never touched.
import { SHEET_COMMANDS } from '../../domain/sheets';
import type { SheetCommand } from '../../domain/sheets';
import type { SheetMark } from './api';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The sheet mark of a message, validated; null when there is none. */
export function sheetMark(message: STChatMessage | null | undefined): SheetMark | null {
    const maestro = message?.extra?.maestro;
    const raw = isDict(maestro) ? maestro.sheet : undefined;
    if (!isDict(raw)) return null;
    const command = raw.command;
    if (typeof command !== 'string' || !(SHEET_COMMANDS as readonly string[]).includes(command)) return null;
    const mark: SheetMark = {
        command: command as SheetCommand,
        target: typeof raw.target === 'string' ? raw.target : '',
        part: raw.part === 'command' ? 'command' : 'reply',
    };
    if (raw.committed === true) mark.committed = true;
    return mark;
}

function withMark(extra: unknown, mark: SheetMark): Dict {
    const base = isDict(extra) ? extra : {};
    const maestro = isDict(base.maestro) ? base.maestro : {};
    base.maestro = { ...maestro, sheet: { ...mark } };
    return base;
}

/** Sets the mark on the message and on its current swipe record. */
export function setSheetMark(message: STChatMessage, mark: SheetMark): void {
    message.extra = withMark(message.extra, mark) as STChatMessage['extra'];
    const swipeId = message.swipe_id;
    const info = Array.isArray(message.swipe_info) && typeof swipeId === 'number' ? message.swipe_info[swipeId] : null;
    if (isDict(info)) info.extra = withMark(info.extra, mark);
}

function withoutMark(extra: unknown): void {
    if (!isDict(extra) || !isDict(extra.maestro) || !('sheet' in extra.maestro)) return;
    const rest = { ...extra.maestro };
    delete rest.sheet;
    if (Object.keys(rest).length) extra.maestro = rest;
    else delete extra.maestro;
}

/** Removes the mark (a swipe that is not a sheet inherited it through ST's swipe_info copy of `extra`). */
export function clearSheetMark(message: STChatMessage): void {
    withoutMark(message.extra);
    const swipeId = message.swipe_id;
    const info = Array.isArray(message.swipe_info) && typeof swipeId === 'number' ? message.swipe_info[swipeId] : null;
    if (isDict(info)) withoutMark(info.extra);
}

/** Index of the sheet command message a reply answers: the last user message before it with a command. */
export function commandIndexFor(chat: readonly STChatMessage[], replyIndex: number): number {
    for (let i = Math.min(replyIndex, chat.length) - 1; i >= 0; i--) {
        const message = chat[i];
        if (message?.is_user) return i;
    }
    return -1;
}

/** Replaces the text of a message and of its current swipe (ST's syncMesToSwipe keeps them equal). */
export function setMessageText(message: STChatMessage, text: string): void {
    message.mes = text;
    const swipeId = message.swipe_id;
    if (
        Array.isArray(message.swipes) &&
        typeof swipeId === 'number' &&
        swipeId >= 0 &&
        swipeId < message.swipes.length
    ) {
        message.swipes[swipeId] = text;
    }
}

/** Text of the current swipe (falls back to `mes`). */
export function currentText(message: STChatMessage | null | undefined): string {
    return typeof message?.mes === 'string' ? message.mes : '';
}

export function swipeIdOf(message: STChatMessage | null | undefined): number {
    return typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
}
