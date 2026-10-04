// Public API of M31 (character sheets), exposed as 'sheets'. M3 (medic) and M12 (quality check) skip sheet
// messages; the dossier (stage 3) opens a character's sheets.
import type { SheetTagReport } from '../../domain/sheet-reply';
import type { SheetCommand } from '../../domain/sheets';

/** What M31 stores on the command message and the sheet reply: `extra.maestro.sheet`. */
export interface SheetMark {
    command: SheetCommand;
    /** The character the sheet is for (as typed, or the current character). */
    target: string;
    part: 'command' | 'reply';
    /** Hidden from the prompt by M31 after the next user message (P14). */
    committed?: boolean;
}

export interface SheetsApi {
    /** The message is a sheet command or a sheet reply handled by M31. */
    isSheetMessage(index: number): boolean;
    /** Sheet replies of a character in the current chat, oldest first. */
    sheetsFor(name: string): { index: number; command: string }[];
    /**
     * Tag-loss check (M31 п. 9): the raw reply of a sheet (as received, before trimming, while the page is open)
     * against the character's stored archive entry. Null when the message is not a sheet reply.
     */
    checkTags(index: number): Promise<SheetTagReport | null>;
}
