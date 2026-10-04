// BunnyMo sheet commands (core entries #2–#7, research/bunnymo-carrotkernel.md §1.3).

export const SHEET_COMMANDS = ['fullsheet', 'quicksheet', 'tagsheet', 'memsheet', 'updatesheet', 'physheet'] as const;
export type SheetCommand = (typeof SHEET_COMMANDS)[number];

const COMMAND_RE = new RegExp(`(^|[^\\p{L}\\p{N}])!(${SHEET_COMMANDS.join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/** Returns the sheet command found in a user message, if any. */
export function detectSheetCommand(text: string | undefined | null): SheetCommand | undefined {
    if (!text) return undefined;
    const match = COMMAND_RE.exec(text);
    return match?.[2] ? (match[2].toLowerCase() as SheetCommand) : undefined;
}
