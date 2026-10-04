// Settings slice of the calendar (`extensionSettings.maestro.modules.calendar`): the grace after a deadline before a
// due promise counts as overdue — in story days and in committed turns (whichever comes first; 0 switches one off).
export const CALENDAR_KEY = 'calendar';
export const CALENDAR_ID = 'M17';
/** Per-chat document kind. */
export const CALENDAR_DOC = 'calendar';

export interface CalendarSettings {
    /** Story days after the deadline before a due promise is overdue; 0 = no day limit. */
    overdueDays: number;
    /** Committed turns after a promise came due before it is overdue; 0 = no turn limit. */
    overdueTurns: number;
}

export const DAYS_MAX = 30;
export const TURNS_MAX = 100;

export function defaultCalendarSettings(): CalendarSettings {
    return { overdueDays: 1, overdueTurns: 10 };
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}

/** The live slice, repaired in place (it is the object the pult edits). */
export function readCalendarSettings(slice: Partial<CalendarSettings>): CalendarSettings {
    const defaults = defaultCalendarSettings();
    const days = intIn(slice.overdueDays, 0, DAYS_MAX, defaults.overdueDays);
    if (slice.overdueDays !== days) slice.overdueDays = days;
    const turns = intIn(slice.overdueTurns, 0, TURNS_MAX, defaults.overdueTurns);
    if (slice.overdueTurns !== turns) slice.overdueTurns = turns;
    return slice as CalendarSettings;
}
