// BunnyMo's commands as buttons (M40): BunnyMo has no slash commands — its «commands» are `!` trigger words typed in a
// user message. Only the six sheet commands are useful as buttons (M31 «Листы» generates them with a small context of
// its own and reads only the first name); the library keys (`!genre`, `!conditions`, `!mentalhealth`, `!archetypes` …)
// are left out on purpose: they flood the prompt or stay sticky. A command goes on a line of its own at the start of
// the message box (what the user typed stays below it), or is sent at once through ST's `/send … | /trigger`. Pure.
import type { SheetCommand } from './sheets';

export interface SheetButton {
    command: SheetCommand;
    /** What follows the command: a character's name, or a moment to remember (memsheet). */
    target: 'name' | 'moment';
}

/** The six sheet commands in the order the menu shows them. */
export const SHEET_BUTTONS: readonly SheetButton[] = [
    { command: 'fullsheet', target: 'name' },
    { command: 'quicksheet', target: 'name' },
    { command: 'tagsheet', target: 'name' },
    { command: 'updatesheet', target: 'name' },
    { command: 'physheet', target: 'name' },
    { command: 'memsheet', target: 'moment' },
];

/** Library keys of BunnyMo that are no buttons (they flood the prompt or are sticky). */
export const NOT_BUTTONS: readonly string[] = ['genre', 'conditions', 'mentalhealth', 'archetypes'];

/** `!fullsheet Вера` (the target on one line, trimmed; no target: the bare command). */
export function sheetCommandText(command: SheetCommand, target = ''): string {
    const value = String(target ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return value ? `!${command} ${value}` : `!${command}`;
}

/**
 * The message box with the command on a line of its own at the start; what was there stays below it. `caret` is the
 * end of the command line (where the cursor goes). A command already at the start is replaced, not stacked.
 */
export function insertCommand(existing: string, command: string): { value: string; caret: number } {
    const text = String(existing ?? '');
    const rest = text.replace(/^\s*!(?:fullsheet|quicksheet|tagsheet|updatesheet|physheet|memsheet)\b[^\n]*\n?/i, '');
    const body = rest.replace(/^\n+/, '');
    return { value: body ? `${command}\n${body}` : command, caret: command.length };
}

/** STscript that sends the command as the user's message and starts the reply (`|` and `\` escaped). */
export function sendScript(command: string): string {
    const escaped = String(command ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
    return `/send ${escaped} | /trigger`;
}
