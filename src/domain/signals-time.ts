// In-story time from DES tracker strings (plan M8 «конец сцены»: a time skip ends a scene). DES writes the date and
// the time as free text in the model's language: «Day 3», «March 5, 1856», «5 марта 1856 г.», «18:00», «6:30 PM».
// Readers here are tolerant: what they cannot read gives null and the caller falls back to comparing the text.
// Pure: no DOM, no SillyTavern.
import { normalizeText, textWords } from './signals-tokens';

export interface TimePoint {
    date?: string;
    start?: string;
    end?: string;
}

export interface TimeJump {
    skipped: boolean;
    /** Hours between the two points when they could be computed. */
    hours?: number;
    dateChanged: boolean;
}

/** A parsed date: a story day number («Day 3») or a calendar date as an ordinal. */
export interface ParsedDay {
    kind: 'day' | 'date';
    value: number;
    /** Calendar dates only: the year was written. */
    year?: number;
    month?: number;
    day?: number;
}

const MINUTES_PER_DAY = 1440;

// prettier-ignore
const MONTHS: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
    july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
    december: 12, dec: 12,
    январь: 1, января: 1, февраль: 2, февраля: 2, март: 3, марта: 3, апрель: 4, апреля: 4, мая: 5, май: 5,
    июнь: 6, июня: 6, июль: 7, июля: 7, август: 8, августа: 8, сентябрь: 9, сентября: 9, октябрь: 10, октября: 10,
    ноябрь: 11, ноября: 11, декабрь: 12, декабря: 12,
};

const CLOCK_RE = /(\d{1,2})\s*[:.hч]\s*(\d{2})(?:\s*(a\.?\s?m\.?|p\.?\s?m\.?))?/i;
const HOUR_AMPM_RE = /\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/i;
const STORY_DAY_RE =
    /(?:^|[^\p{L}])(?:day|день|сутки)\s*(?:№\s*)?(\d{1,5})(?!\d)|(\d{1,5})(?:st|nd|rd|th|-?й|-?ый|-?ой)?\s+(?:day|день)(?![\p{L}])/iu;
const ISO_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/;
const DOTTED_RE = /(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?!\d)/;
const YEAR_RE = /(?<!\d)(\d{3,4})(?!\d)/;

/** Month number of an English or Russian month word (normalised: lower case, ё → е), undefined otherwise. */
export function monthNumber(word: string): number | undefined {
    return Object.prototype.hasOwnProperty.call(MONTHS, word) ? MONTHS[word] : undefined;
}

/** Minutes since midnight of a clock time in the text («18:30», «6:30 PM», «9 am», «полдень»); null if none. */
export function parseClock(text: string | undefined): number | null {
    if (!text) return null;
    const value = normalizeText(text);
    const clock = CLOCK_RE.exec(value);
    let hours: number | null = null;
    let minutes = 0;
    let suffix: string | undefined;
    if (clock) {
        hours = Number(clock[1]);
        minutes = Number(clock[2]);
        suffix = clock[3];
    } else {
        const short = HOUR_AMPM_RE.exec(value);
        if (short) {
            hours = Number(short[1]);
            suffix = short[2];
        }
    }
    if (hours === null) {
        if (/(?:^|[^\p{L}])(?:midnight|полночь)/u.test(value)) return 0;
        if (/(?:^|[^\p{L}])(?:noon|midday|полдень)/u.test(value)) return 12 * 60;
        return null;
    }
    if (suffix) {
        const pm = suffix.startsWith('p');
        if (hours < 1 || hours > 12) return null;
        if (pm && hours < 12) hours += 12;
        if (!pm && hours === 12) hours = 0;
    }
    if (hours > 24 || minutes > 59) return null;
    return (hours % 24) * 60 + minutes;
}

function calendar(year: number | undefined, month: number, day: number): ParsedDay | null {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const parsed: ParsedDay = { kind: 'date', value: (year ?? 0) * 372 + (month - 1) * 31 + (day - 1), month, day };
    if (year !== undefined) parsed.year = year;
    return parsed;
}

/** A story day («Day 3», «День 3», «3rd day») or a calendar date («March 5, 1856», «5 марта», «1856-03-05»). */
export function parseDay(text: string | undefined): ParsedDay | null {
    if (!text) return null;
    const value = normalizeText(text);
    const story = STORY_DAY_RE.exec(value);
    if (story) return { kind: 'day', value: Number(story[1] ?? story[2]) };
    const iso = ISO_RE.exec(value);
    if (iso) return calendar(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const dotted = DOTTED_RE.exec(value);
    if (dotted) {
        const year = Number(dotted[3]);
        return calendar(year < 100 ? 2000 + year : year, Number(dotted[2]), Number(dotted[1]));
    }
    const words = textWords(value);
    const monthIndex = words.findIndex((word) => monthNumber(word) !== undefined);
    if (monthIndex < 0) return null;
    const month = monthNumber(words[monthIndex] as string) as number;
    // «5 March», «March 5», «the 5th of May».
    const before = words[monthIndex - 1] === 'of' ? words[monthIndex - 2] : words[monthIndex - 1];
    const near = [before, words[monthIndex + 1]].map((word) =>
        word ? /^(\d{1,2})(?:st|nd|rd|th|е|го|ое)?$/.exec(word) : null,
    );
    const dayMatch = near[0] ?? near[1];
    if (!dayMatch) return null;
    const rest = value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${dayMatch[0]}(?![\\p{L}\\p{N}])`, 'u'), ' ');
    const year = YEAR_RE.exec(rest);
    return calendar(year ? Number(year[1]) : undefined, month, Number(dayMatch[1]));
}

/** Word set of a date for a wording-insensitive comparison («Monday, 3 March» = «3 March, Monday»). */
export function dateKey(text: string): string {
    return [...new Set(textWords(text))].sort().join(' ');
}

/** Day difference of two parsed days of the same kind; a year written on one side only is ignored. */
function dayDifference(a: ParsedDay, b: ParsedDay): number | null {
    if (a.kind !== b.kind) return null;
    if (a.kind === 'day') return b.value - a.value;
    if ((a.year === undefined) === (b.year === undefined)) return b.value - a.value;
    const strip = (day: ParsedDay) => ((day.month ?? 1) - 1) * 31 + ((day.day ?? 1) - 1);
    return strip(b) - strip(a);
}

/**
 * Did the story jump forward by more than `thresholdHours` between two tracker time points? The previous point's
 * end (or start) is compared with the current start (or end). A changed date whose distance cannot be computed counts
 * as a skip unless both clock times are known (then the next day is assumed); time going backwards is DES noise or
 * a flashback, never a skip.
 */
export function timeJump(previous: TimePoint, current: TimePoint, thresholdHours: number): TimeJump {
    const before = parseClock(previous.end) ?? parseClock(previous.start);
    const after = parseClock(current.start) ?? parseClock(current.end);
    const clocks = before !== null && after !== null;
    let days: number | null = 0;
    let dateChanged = false;
    if (previous.date && current.date) {
        const a = parseDay(previous.date);
        const b = parseDay(current.date);
        const difference = a && b ? dayDifference(a, b) : null;
        if (difference !== null) {
            days = difference;
            dateChanged = difference !== 0;
        } else {
            dateChanged = dateKey(previous.date) !== dateKey(current.date);
            days = dateChanged ? null : 0;
        }
    }
    if (days === null) {
        if (!clocks) return { skipped: true, dateChanged: true };
        const hours = round((MINUTES_PER_DAY - (before as number) + (after as number)) / 60);
        return { skipped: hours > thresholdHours, hours, dateChanged: true };
    }
    if (days < 0) return { skipped: false, dateChanged };
    if (days > 0 && !clocks) {
        const hours = days * 24;
        return { skipped: hours > thresholdHours, hours, dateChanged };
    }
    if (!clocks) return { skipped: false, dateChanged };
    const minutes = days * MINUTES_PER_DAY + (after as number) - (before as number);
    if (minutes < 0) return { skipped: false, dateChanged };
    const hours = round(minutes / 60);
    return { skipped: hours > thresholdHours, hours, dateChanged };
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}
