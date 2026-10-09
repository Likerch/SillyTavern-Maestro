import { describe, expect, it } from 'vitest';
import {
    insertCommand,
    NOT_BUTTONS,
    sendScript,
    SHEET_BUTTONS,
    sheetCommandText,
} from '../../src/domain/bunnymo-commands';
import { detectSheetCommand, SHEET_COMMANDS } from '../../src/domain/sheets';
import { parseSheetTarget } from '../../src/domain/sheet-context';

describe('BunnyMo sheet commands as buttons', () => {
    it('are the six sheet commands, never the library keys', () => {
        expect(SHEET_BUTTONS.map((button) => button.command).sort()).toEqual([...SHEET_COMMANDS].sort());
        expect(SHEET_BUTTONS.find((button) => button.command === 'memsheet')?.target).toBe('moment');
        for (const key of NOT_BUTTONS) expect(SHEET_BUTTONS.some((button) => button.command === key)).toBe(false);
    });

    it('builds `!command target` that M31 reads back', () => {
        const text = sheetCommandText('fullsheet', '  Вера  Грей ');
        expect(text).toBe('!fullsheet Вера Грей');
        expect(detectSheetCommand(text)).toBe('fullsheet');
        expect(parseSheetTarget(text, 'fullsheet')).toBe('Вера Грей');
        expect(sheetCommandText('memsheet', 'первый поцелуй\nна мосту')).toBe('!memsheet первый поцелуй на мосту');
        expect(sheetCommandText('quicksheet')).toBe('!quicksheet');
    });

    it('puts the command on its own line at the start and keeps what was typed', () => {
        expect(insertCommand('', '!fullsheet Вера')).toEqual({ value: '!fullsheet Вера', caret: 15 });
        expect(insertCommand('Привет, Вера!', '!fullsheet Вера')).toEqual({
            value: '!fullsheet Вера\nПривет, Вера!',
            caret: 15,
        });
        // A command already at the start is replaced, not stacked.
        expect(insertCommand('!quicksheet Кай\nтекст', '!physheet Вера').value).toBe('!physheet Вера\nтекст');
    });

    it('sends through /send and /trigger with pipes escaped', () => {
        expect(sendScript('!fullsheet Вера')).toBe('/send !fullsheet Вера | /trigger');
        expect(sendScript('!memsheet бой | ночь')).toBe('/send !memsheet бой \\| ночь | /trigger');
    });
});
