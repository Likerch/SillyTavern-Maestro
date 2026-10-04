// Story time for the calendar (M17, plan M17 п.2): DES writes the date and the time of every reply as free text in
// the model's language — «Day 3», «Monday, March 5, 1856», «5 марта», «12 Зимня», «3rd of Frostfall, 4E 201»,
// «18:00», «6:30 PM». Promises need a comparable day even for calendars nobody can read, so the calendar keeps its own
// per-chat day counter and moves it by what it can understand:
// - a story day («Day 3», «День 3») or a real date: the exact difference (an anchor ties the label to the counter;
//   the counter never goes back — a date written backwards is DES noise or a flashback);
// - an unknown calendar: the label changed → relative words («the next day», «три дня спустя»), one number of an
//   otherwise identical label («12 Зимня» → «14 Зимня»: +2), weekdays («Monday» → «Thursday»: +3), else one day;
//   day parts are not part of the label («Morning of the Feast» → «Evening of the Feast» is the same day);
// - no date at all: the clock wrapped (22:00 → 07:00) means the next day.
// Also the deadline phrases of promises: «к закату», «через три дня», "by tomorrow", "in two days", "by Friday",
// "by March 5", «в 6 вечера» → a moment relative to the story time when the promise was made.
// Pure: no DOM, no SillyTavern.
import { monthNumber, parseClock, parseDay } from './signals-time';
import { STOP_WORDS, normalizeText, stemWord, textWords } from './signals-tokens';

export const MINUTES_PER_DAY = 1440;
/** A clock going back at least this much (without a date change) passed midnight. */
const WRAP_BACK_MINUTES = 180;
/** A fantasy label whose only changed number moved further than this is not a day count. */
const MAX_NUMBER_STEP = 60;
/** Larger jumps of an understood calendar are noise (a wrong year), not story time. */
const MAX_JUMP_DAYS = 3660;
const HALF_YEAR = 182;

/** Same shape as the calendar API's StoryMoment (src/domain cannot import feature types). */
export interface Moment {
    label: string;
    day: number | null;
    minutes?: number;
}

/** A date the calendar understands. */
export interface CalendarDate {
    kind: 'day' | 'date';
    /** Story day number («Day 3») or day of the year (dates, 1–365). */
    n: number;
    /** Dates with a written year: days since 1970-01-01. */
    abs?: number;
}

export interface LabelInfo {
    text: string;
    /** Content words without numbers, weekdays, months, day parts and filler (stemmed, sorted, unique). */
    key: string;
    /** Numbers of the label (clock times removed). */
    numbers: number[];
    /** 0 = Monday … 6 = Sunday. */
    weekday?: number;
    date?: CalendarDate;
    /** «The next day», «три дня спустя»: days after the previous label. */
    relative?: number;
}

/** Where the counter stands against an understood calendar. */
export interface ClockAnchor extends CalendarDate {
    /** Label key at the anchor (a «3rd day of Frostfall» compares only within Frostfall). */
    key: string;
    day: number;
}

/** The calendar's reading of the story time after a committed reply. */
export interface StoryClock {
    /** The date as DES wrote it ('' when DES has no date). */
    label: string;
    /** The time as DES wrote it («14:00–15:30»), when any. */
    time?: string;
    /** Per-chat story day counter (1 = the first day the calendar saw, or N of «Day N»). */
    day: number;
    /** Minutes since midnight: DES end time, else its start. */
    minutes?: number;
    weekday?: number;
    anchor?: ClockAnchor;
}

export interface ObservedTime {
    date?: string;
    start?: string;
    end?: string;
}

export interface ClockStep {
    clock: StoryClock;
    /** Days the counter moved. */
    delta: number;
    reason: 'first' | 'same' | 'calendar' | 'relative' | 'number' | 'weekday' | 'changed' | 'wrap' | 'noise';
}

/* ------------------------------------------------------------------ words */

// prettier-ignore
const WEEKDAYS: Record<string, number> = {
    monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
    понедельник: 0, понедельника: 0, понедельнику: 0, вторник: 1, вторника: 1, вторнику: 1,
    среда: 2, среду: 2, среды: 2, среде: 2, четверг: 3, четверга: 3, четвергу: 3,
    пятница: 4, пятницу: 4, пятницы: 4, пятнице: 4, суббота: 5, субботу: 5, субботы: 5, субботе: 5,
    воскресенье: 6, воскресенья: 6, воскресенью: 6,
};

// prettier-ignore
const DAY_PART_WORDS: ReadonlySet<string> = new Set([
    'morning', 'afternoon', 'evening', 'night', 'tonight', 'noon', 'midday', 'midnight', 'dawn', 'dusk', 'sunrise',
    'sunset', 'twilight', 'nightfall', 'daybreak', 'late', 'early', 'mid', 'am', 'pm', 'a', 'p', 'm',
    'утро', 'утра', 'утром', 'утру', 'день', 'дня', 'днем', 'вечер', 'вечера', 'вечером', 'вечеру', 'ночь', 'ночи',
    'ночью', 'полдень', 'полдня', 'полудня', 'полночь', 'полуночи', 'рассвет', 'рассвета', 'рассвете', 'закат',
    'заката', 'закате', 'сумерки', 'сумерек', 'поздний', 'поздняя', 'позднее', 'поздно', 'поздним', 'ранний', 'раннее',
    'рано', 'ранним', 'раннее',
]);

// prettier-ignore
const LABEL_FILLER: ReadonlySet<string> = new Set(['of', 'a', 'an', 'at', 'on', 'in', 'day', 'г', 'год', 'года']);

const CLOCK_ANY_RE = /\d{1,2}\s*[:.hч]\s*\d{2}(?:\s*(?:a\.?\s?m\.?|p\.?\s?m\.?))?/gi;
const AMPM_RE = /\d{1,2}\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/gi;
const NONE_RE = /^(?:none|unknown|n\/a|-+|—|нет|неизвестно)$/i;

// prettier-ignore
const NUMBER_WORDS: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, couple: 2, few: 3, several: 3,
    один: 1, одна: 1, одну: 1, одного: 1, одни: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4,
    пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
    десять: 10, десяти: 10, одиннадцать: 11, двенадцать: 12, пару: 2, пара: 2, пары: 2, несколько: 3, нескольких: 3,
};

const QTY =
    '(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few|several)';
const QTY_RU =
    '(\\d{1,3}|одн(?:у|а|ого|и)|один|дв(?:а|е|ух)|тр(?:и|ех)|четыр(?:е|ех)|пят(?:ь|и)|шест(?:ь|и)|сем(?:ь|и)|вос(?:емь|ьми)|девят(?:ь|и)|десят(?:ь|и)|одиннадцать|двенадцать|пар(?:у|а|ы)|нескольк(?:о|их))';
const UNIT_EN = '(days?|weeks?|fortnights?|months?|years?|hours?)';
const UNIT_RU = '(дн(?:я|ей|ю)|день|сут(?:ки|ок)|недел(?:я|ю|и|ь)|месяц(?:а|ев)?|год(?:а)?|лет|час(?:а|ов)?)';
const L = '\\p{L}';

function quantity(word: string | undefined): number {
    if (!word) return 1;
    const clean = normalizeText(word)
        .replace(/^a\s+/, '')
        .replace(/\s+of$/, '');
    if (/^\d+$/.test(clean)) return Number(clean);
    return NUMBER_WORDS[clean] ?? 1;
}

/** Days (or minutes for hours) of one unit word. */
function unitSize(unit: string): { days?: number; minutes?: number } {
    const value = unit.toLowerCase();
    if (/^(hour|час)/.test(value)) return { minutes: 60 };
    if (/^fortnight/.test(value)) return { days: 14 };
    if (/^(week|недел)/.test(value)) return { days: 7 };
    if (/^(month|месяц)/.test(value)) return { days: 30 };
    if (/^(year|год|лет)/.test(value)) return { days: 365 };
    return { days: 1 };
}

/* ------------------------------------------------------------------ dates */

/** Days since 1970-01-01 of a Gregorian date (years below 100 are not shifted to the 1900s). */
export function daysFromEpoch(year: number, month: number, day: number): number {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return Math.round(date.getTime() / 86_400_000);
}

function dayOfYear(month: number, day: number): number {
    return daysFromEpoch(2001, month, day) - daysFromEpoch(2001, 1, 1) + 1;
}

/** The understood date of a text: a story day («Day 3») or a Gregorian date. */
export function calendarDate(text: string | undefined): CalendarDate | null {
    const parsed = parseDay(text);
    if (!parsed) return null;
    if (parsed.kind === 'day') return { kind: 'day', n: parsed.value };
    const month = parsed.month ?? 1;
    const day = parsed.day ?? 1;
    const date: CalendarDate = { kind: 'date', n: dayOfYear(month, day) };
    if (parsed.year !== undefined) date.abs = daysFromEpoch(parsed.year, month, day);
    return date;
}

/** Days from `a` to `b` of one kind; a date without a year is the nearest one (Dec 31 → Jan 1 is +1). */
export function dateDifference(a: CalendarDate, b: CalendarDate): number | null {
    if (a.kind !== b.kind) return null;
    if (a.kind === 'day') return b.n - a.n;
    if (a.abs !== undefined && b.abs !== undefined) return b.abs - a.abs;
    let days = b.n - a.n;
    if (days < -HALF_YEAR) days += 365;
    else if (days > HALF_YEAR) days -= 365;
    return days;
}

/** Weekday (0 = Monday) of a date with a written year. */
function weekdayOf(date: CalendarDate | undefined): number | undefined {
    if (!date || date.abs === undefined) return undefined;
    // 1970-01-01 was a Thursday.
    return (((date.abs + 3) % 7) + 7) % 7;
}

/* ------------------------------------------------------------------ relative words */

interface Found {
    start: number;
    end: number;
}

interface Offset extends Found {
    days?: number;
    minutes?: number;
}

/** Day offsets written in a text: «tomorrow», «через три дня», «three days later», «на следующий день». */
function findOffsets(text: string): Offset[] {
    const found: Offset[] = [];
    const add = (re: RegExp, make: (match: RegExpExecArray) => { days?: number; minutes?: number } | null) => {
        for (const match of text.matchAll(re)) {
            const start = match.index ?? 0;
            const end = start + match[0].length;
            if (found.some((item) => start < item.end && end > item.start)) continue;
            const value = make(match as RegExpExecArray);
            if (value) found.push({ start, end, ...value });
        }
    };
    const scaled = (qty: string | undefined, unit: string) => {
        const size = unitSize(unit);
        const count = quantity(qty);
        return size.minutes ? { minutes: size.minutes * count } : { days: (size.days ?? 1) * count };
    };
    // Longest phrases first: «day after tomorrow» before «tomorrow».
    add(/\b(?:the\s+)?day\s+after\s+tomorrow\b/giu, () => ({ days: 2 }));
    add(new RegExp(`(?<!${L})послезавтра\\p{L}*`, 'giu'), () => ({ days: 2 }));
    add(new RegExp(`\\b(?:in|within|after)\\s+(?:the\\s+next\\s+)?(?:${QTY}\\s+)?${UNIT_EN}\\b`, 'giu'), (match) =>
        scaled(match[1], match[2] as string),
    );
    add(new RegExp(`\\b${QTY}\\s+${UNIT_EN}\\s+(?:later|from\\s+now|hence|after)\\b`, 'giu'), (match) =>
        scaled(match[1], match[2] as string),
    );
    add(/\bnext\s+(week|month|year)\b/giu, (match) => scaled(undefined, match[1] as string));
    add(/\b(?:the\s+)?(?:next|following)\s+(?:day|morning|evening|night|afternoon|dawn)\b/giu, () => ({ days: 1 }));
    add(/\bthe\s+day\s+after\b/giu, () => ({ days: 1 }));
    add(/\btomorrow(?:'s)?\b/giu, () => ({ days: 1 }));
    add(/\b(?:today|tonight|this\s+(?:evening|afternoon|morning|night))\b/giu, () => ({ days: 0 }));
    add(new RegExp(`(?<!${L})(?:через|спустя|в\\s+течение)\\s+(?:${QTY_RU}\\s+)?${UNIT_RU}(?!${L})`, 'giu'), (match) =>
        scaled(match[1], match[2] as string),
    );
    add(new RegExp(`(?<!${L})(?:${QTY_RU}\\s+)?${UNIT_RU}\\s+спустя(?!${L})`, 'giu'), (match) =>
        scaled(match[1], match[2] as string),
    );
    add(
        new RegExp(
            `(?<!${L})(?:на|в|во)\\s+следующ${L}*\\s+(день|утро|утром|вечер|вечером|ночь|ночью|недел${L}*|месяц${L}*|год${L}*)(?!${L})`,
            'giu',
        ),
        (match) => {
            const unit = (match[1] as string).toLowerCase();
            return /^(недел|месяц|год)/.test(unit) ? scaled(undefined, unit) : { days: 1 };
        },
    );
    add(new RegExp(`(?<!${L})следующ${L}*\\s+(?:день|утро|вечер|ночь)(?!${L})`, 'giu'), () => ({ days: 1 }));
    add(new RegExp(`(?<!${L})(?:на)?завтра(?:шн${L}*)?(?!${L})`, 'giu'), () => ({ days: 1 }));
    add(new RegExp(`(?<!${L})сегодня(?:шн${L}*)?(?!${L})`, 'giu'), () => ({ days: 0 }));
    return found.sort((a, b) => a.start - b.start);
}

/** «The next day», «три дня спустя», «Day 2 (next morning)»: days after the previous label; null if not written. */
export function relativeDays(text: string | undefined): number | null {
    if (!text) return null;
    const offsets = findOffsets(lower(text)).filter((item) => item.days !== undefined && item.days > 0);
    return offsets.length ? (offsets[0]?.days ?? null) : null;
}

/* ------------------------------------------------------------------ labels */

/** Lower case with ё → е, keeping the length (spans found in it slice the original text). */
function lower(text: string): string {
    const value = text.replace(/ё/g, 'е').replace(/Ё/g, 'Е').toLowerCase();
    return value.length === text.length ? value : normalizeText(text);
}

/** Reads a DES date label; null for an empty or «None» date. */
export function readLabel(text: string | undefined): LabelInfo | null {
    const raw = (text ?? '').trim();
    if (!raw || NONE_RE.test(raw)) return null;
    const cleaned = normalizeText(raw).replace(CLOCK_ANY_RE, ' ').replace(AMPM_RE, ' ');
    let weekday: number | undefined;
    const keys = new Set<string>();
    for (const word of textWords(cleaned)) {
        const day = WEEKDAYS[word];
        if (day !== undefined) {
            weekday ??= day;
            continue;
        }
        if (/\d/.test(word) || DAY_PART_WORDS.has(word) || STOP_WORDS.has(word) || LABEL_FILLER.has(word)) continue;
        if (monthNumber(word) !== undefined) continue;
        keys.add(stemWord(word));
    }
    const info: LabelInfo = {
        text: raw,
        key: [...keys].sort().join(' '),
        numbers: [...cleaned.matchAll(/\d+/g)].map((match) => Number(match[0])),
    };
    const date = calendarDate(raw);
    if (date) info.date = date;
    const own = weekday ?? weekdayOf(date ?? undefined);
    if (own !== undefined) info.weekday = own;
    const relative = relativeDays(raw);
    if (relative !== null) info.relative = relative;
    return info;
}

/** A label that says nothing about the day («Evening»): treated as no date. */
function isBlank(info: LabelInfo): boolean {
    return !info.key && !info.numbers.length && info.weekday === undefined && !info.date && info.relative === undefined;
}

function sameLabel(a: LabelInfo, b: LabelInfo): boolean {
    return (
        a.key === b.key &&
        a.weekday === b.weekday &&
        a.numbers.length === b.numbers.length &&
        a.numbers.every((value, index) => value === b.numbers[index])
    );
}

/** Day step between two different labels of a calendar nobody can read. */
function labelStep(before: LabelInfo, after: LabelInfo): { delta: number; reason: ClockStep['reason'] } {
    if (after.relative !== undefined) return { delta: after.relative, reason: 'relative' };
    // «Day 3» → «Day 3 of the journey»: other words around the same understood day.
    if (before.date && after.date && dateDifference(before.date, after.date) === 0) return { delta: 0, reason: 'same' };
    // One changed number counts days only in a calendar nobody understands (Day 3 → March 5 is a new calendar).
    if (!before.date && !after.date && before.key === after.key && before.numbers.length === after.numbers.length) {
        const changed = after.numbers.map((value, index) => value - (before.numbers[index] ?? value));
        const moved = changed.filter((value) => value !== 0);
        if (moved.length === 1 && (moved[0] as number) > 0 && (moved[0] as number) <= MAX_NUMBER_STEP) {
            return { delta: moved[0] as number, reason: 'number' };
        }
    }
    if (before.weekday !== undefined && after.weekday !== undefined && before.weekday !== after.weekday) {
        return { delta: (after.weekday - before.weekday + 7) % 7, reason: 'weekday' };
    }
    return { delta: 1, reason: 'changed' };
}

/** «14:00–15:30», «evening», as written. */
function timeText(observed: ObservedTime): string | undefined {
    const start = observed.start?.trim();
    const end = observed.end?.trim();
    if (start && end && start !== end) return `${start}–${end}`;
    return start || end || undefined;
}

/** A label's date is measured against the anchor: same kind; story days only within one label key (one month). */
function comparable(anchor: ClockAnchor, info: LabelInfo): boolean {
    if (!info.date || anchor.kind !== info.date.kind) return false;
    return anchor.kind === 'date' || anchor.key === info.key;
}

function anchorOf(info: LabelInfo, day: number): ClockAnchor | undefined {
    if (!info.date) return undefined;
    return { ...info.date, key: info.date.kind === 'day' ? info.key : '', day };
}

/**
 * Moves the story clock to the time DES wrote for the next committed reply. Null when the reply has neither a date
 * nor a time (the clock stays). Never moves the counter back.
 */
export function advanceClock(previous: StoryClock | null, observed: ObservedTime): ClockStep | null {
    const time = timeText(observed);
    const label = readLabel(observed.date);
    if (!label && !time) return null;
    const end = parseClock(observed.end);
    const start = parseClock(observed.start);
    const minutes = end ?? start ?? undefined;
    const arriving = start ?? end;
    const usable = label && !isBlank(label) ? label : null;
    const before = previous ? readLabel(previous.label) : null;
    const prior = before && !isBlank(before) ? before : null;

    const build = (day: number, anchor: ClockAnchor | undefined, weekday: number | undefined): StoryClock => {
        // A blank or missing date keeps the last meaningful label: the next real date compares with it.
        const text = usable ? usable.text : prior ? (previous?.label ?? '') : (label?.text ?? previous?.label ?? '');
        const clock: StoryClock = { label: text, day };
        if (time) clock.time = time;
        if (minutes !== undefined) clock.minutes = minutes;
        if (weekday !== undefined) clock.weekday = weekday;
        if (anchor) clock.anchor = anchor;
        return clock;
    };
    const shiftWeekday = (delta: number): number | undefined =>
        usable?.weekday ?? (previous?.weekday !== undefined ? (previous.weekday + delta) % 7 : undefined);

    if (!previous) {
        const day = usable?.date?.kind === 'day' ? Math.max(1, usable.date.n) : 1;
        const first = usable ? anchorOf(usable, day) : undefined;
        return { clock: build(day, first, usable?.weekday), delta: 0, reason: 'first' };
    }

    // An understood calendar: the anchor tells the day; going back is noise and keeps the counter.
    const anchor = previous.anchor;
    if (usable?.date && anchor && comparable(anchor, usable)) {
        const difference = dateDifference(anchor, usable.date) as number;
        const candidate = anchor.day + difference;
        if (candidate < previous.day || Math.abs(difference) > MAX_JUMP_DAYS) {
            return { clock: build(previous.day, anchor, previous.weekday), delta: 0, reason: 'noise' };
        }
        const delta = candidate - previous.day;
        return {
            clock: build(candidate, anchorOf(usable, candidate), shiftWeekday(delta)),
            delta,
            reason: delta ? 'calendar' : 'same',
        };
    }

    let delta = 0;
    let reason: ClockStep['reason'] = 'same';
    if (usable && prior) {
        if (!sameLabel(prior, usable)) ({ delta, reason } = labelStep(prior, usable));
    } else if (usable && usable.relative !== undefined) {
        delta = usable.relative;
        reason = 'relative';
    } else if (!usable && !prior && arriving !== null && previous.minutes !== undefined) {
        if (previous.minutes - arriving >= WRAP_BACK_MINUTES) {
            delta = 1;
            reason = 'wrap';
        }
    }
    const day = previous.day + delta;
    // A new or changed understood calendar re-anchors at the counter; an unreadable label keeps the old anchor.
    const nextAnchor = usable?.date ? anchorOf(usable, day) : anchor;
    return { clock: build(day, nextAnchor, shiftWeekday(delta)), delta, reason };
}

/** The API moment of a clock. */
export function momentOf(clock: StoryClock | null | undefined): Moment | null {
    if (!clock) return null;
    const moment: Moment = { label: clock.label || clock.time || '', day: clock.day };
    if (clock.minutes !== undefined) moment.minutes = clock.minutes;
    return moment;
}

/**
 * Story minutes from `from` to `to`; null when a day is unknown. When either side has no time of day only the days
 * count (a deadline «by tomorrow» comes when tomorrow comes).
 */
export function elapsedMinutes(from: Moment, to: Moment): number | null {
    if (from.day === null || to.day === null) return null;
    const days = (to.day - from.day) * MINUTES_PER_DAY;
    if (from.minutes === undefined || to.minutes === undefined) return days;
    return days + to.minutes - from.minutes;
}

/** «07:05». */
export function formatMinutes(minutes: number): string {
    const value = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ deadlines */

/** A deadline phrase of a promise, before it is placed in story time. */
export interface DueExpression {
    /** The phrase as written («к закату», "by tomorrow evening"). */
    label: string;
    offsetDays?: number;
    offsetMinutes?: number;
    weekday?: number;
    date?: CalendarDate;
    /** Time of day. */
    minutes?: number;
    /** No day was written: the time of day is today, or tomorrow if it already passed. */
    nextIfPassed?: boolean;
    /** A morning part without a known clock means the next morning. */
    morning?: boolean;
}

interface DayPart {
    minutes: number;
    morning?: boolean;
}

function dayPart(word: string): DayPart | null {
    const value = word.toLowerCase();
    if (/^(dawn|sunrise|daybreak|first light|рассвет)/.test(value)) return { minutes: 6 * 60, morning: true };
    if (/^(morning|утр)/.test(value)) return { minutes: 8 * 60, morning: true };
    if (/^(noon|midday|полдень|полудн|обед)/.test(value)) return { minutes: 12 * 60 };
    if (/^(afternoon|днем|днём)/.test(value)) return { minutes: 15 * 60 };
    if (/^(midnight|полноч|полуноч|end of)/.test(value)) return { minutes: MINUTES_PER_DAY - 1 };
    if (/^(evening|sunset|sundown|dusk|nightfall|dark|вечер|закат|сумер|темнот)/.test(value))
        return { minutes: 19 * 60 };
    if (/^(night|tonight|ноч)/.test(value)) return { minutes: 22 * 60 };
    return null;
}

const PART_EN =
    '(dawn|sunrise|daybreak|first\\s+light|morning|noon|midday|afternoon|evening|sunset|sundown|dusk|nightfall|dark|night|midnight|end\\s+of\\s+(?:the\\s+)?day)';
const PART_RU =
    '(рассвет(?:а|у|е|ом)?|утр(?:о|а|у|ом)|полдень|полудн(?:я|ю)|обед(?:а|у)?|вечер(?:а|у|ом)?|закат(?:а|у|е|ом)?|сумер(?:ек|ки|кам)|темнот(?:ы|е|у)|ноч(?:ь|и|ью)|полноч(?:ь|и)|полуноч(?:и)|конц(?:а|у)\\s+дня)';

function findDayParts(text: string): (Found & DayPart)[] {
    const found: (Found & DayPart)[] = [];
    const add = (re: RegExp, group: number) => {
        for (const match of text.matchAll(re)) {
            const part = dayPart((match[group] as string).replace(/^конц\p{L}*\s+дня$/u, 'end of'));
            if (!part) continue;
            const start = match.index ?? 0;
            found.push({ start, end: start + match[0].length, ...part });
        }
    };
    add(
        new RegExp(
            `\\b(?:by|before|until|till|at|around|towards?|this|tomorrow|tonight|in\\s+the|the\\s+next|next|following)\\s+(?:the\\s+)?${PART_EN}\\b`,
            'giu',
        ),
        1,
    );
    add(/\b(tonight)\b/giu, 1);
    add(new RegExp(`(?<!${L})(?:к|ко|до|на|в|во|под|завтра|сегодня|послезавтра)\\s+${PART_RU}(?!${L})`, 'giu'), 1);
    add(new RegExp(`(?<!${L})(утром|вечером|ночью|днем)(?!${L})`, 'giu'), 1);
    return found;
}

const HOUR_WORDS =
    '(\\d{1,2}|часу|час|одного|двух|трех|четырех|пяти|шести|семи|восьми|девяти|десяти|одиннадцати|двенадцати|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)';

// prettier-ignore
const RU_HOURS: Record<string, number> = {
    часу: 1, час: 1, одного: 1, один: 1, двух: 2, два: 2, трех: 3, три: 3, четырех: 4, четыре: 4, пяти: 5, пять: 5, шести: 6,
    шесть: 6, семи: 7, семь: 7, восьми: 8, восемь: 8, девяти: 9, девять: 9, десяти: 10, десять: 10,
    одиннадцати: 11, одиннадцать: 11, двенадцати: 12, двенадцать: 12,
};

/** Clock times written as deadlines: "at 6 pm", "by 18:00", «к 8 утра», «в шесть вечера». */
function findClocks(text: string): (Found & { minutes: number })[] {
    const found: (Found & { minutes: number })[] = [];
    const push = (start: number, end: number, minutes: number | null) => {
        if (minutes === null || found.some((item) => start < item.end && end > item.start)) return;
        found.push({ start, end, minutes });
    };
    const ru = new RegExp(
        `(?<!${L})(?:к|до|в|во|около|после)\\s+${HOUR_WORDS}(?:[:.](\\d{2}))?\\s*(утра|дня|вечера|ночи)(?!${L})`,
        'giu',
    );
    for (const match of text.matchAll(ru)) {
        const word = (match[1] as string).toLowerCase();
        let hours = /^\d+$/.test(word) ? Number(word) : (RU_HOURS[word] ?? NaN);
        const minutes = match[2] ? Number(match[2]) : 0;
        const part = (match[3] as string).toLowerCase();
        if (!Number.isFinite(hours) || hours < 1 || hours > 12 || minutes > 59) continue;
        if (part === 'утра') hours = hours === 12 ? 0 : hours;
        else if (part === 'ночи') hours = hours >= 9 && hours < 12 ? hours + 12 : hours === 12 ? 0 : hours;
        else hours = hours === 12 ? 12 : hours + 12;
        const start = match.index ?? 0;
        push(start, start + match[0].length, (hours % 24) * 60 + minutes);
    }
    const plain =
        /(?:\b(?:at|by|before|until|till|around)|(?<!\p{L})(?:к|до|в|во|около))\s+(\d{1,2}(?:\s*[:.]\s*\d{2})?(?:\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z]))?)/giu;
    for (const match of text.matchAll(plain)) {
        const value = match[1] as string;
        if (!/[:.]|m/i.test(value)) continue; // a bare number («к 5») is not a time
        const start = match.index ?? 0;
        push(start, start + match[0].length, parseClock(value));
    }
    return found;
}

const WEEKDAY_EN = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const WEEKDAY_RU = '(понедельник[ау]?|вторник[ау]?|сред[аыуе]|четверг[ау]?|пятниц[аыуе]|суббот[аыуе]|воскресень[еяю])';

function weekdayOfWord(word: string): number | undefined {
    return WEEKDAYS[word.toLowerCase()];
}

function findWeekdays(text: string): (Found & { weekday: number })[] {
    const found: (Found & { weekday: number })[] = [];
    const add = (re: RegExp) => {
        for (const match of text.matchAll(re)) {
            const weekday = weekdayOfWord(match[1] as string);
            if (weekday === undefined) continue;
            const start = match.index ?? 0;
            found.push({ start, end: start + match[0].length, weekday });
        }
    };
    add(new RegExp(`\\b(?:by|on|until|till|before|next|this|coming)\\s+${WEEKDAY_EN}\\b`, 'giu'));
    add(
        new RegExp(
            `(?<!${L})(?:к|ко|до|в|во|на)\\s+(?:следующ${L}*\\s+|эт${L}*\\s+|ближайш${L}*\\s+)?${WEEKDAY_RU}(?!${L})`,
            'giu',
        ),
    );
    return found;
}

/** Explicit dates after a preposition: "by March 5", "on Day 7", «к 5 марта», «до Дня 7». */
function findDates(text: string): (Found & { date: CalendarDate })[] {
    const found: (Found & { date: CalendarDate })[] = [];
    const re =
        /(?:\b(?:by|on|until|till|before)|(?<!\p{L})(?:к|ко|до|на))\s+((?:the\s+)?(?:\d{1,4}[\p{L}.-]*\s+(?:of\s+)?\p{L}+|\p{L}+\s+\d{1,4}(?:st|nd|rd|th)?)(?:,?\s+\d{3,4})?|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})/giu;
    for (const match of text.matchAll(re)) {
        const date = calendarDate(match[1]);
        if (!date) continue;
        const start = match.index ?? 0;
        found.push({ start, end: start + match[0].length, date });
    }
    return found;
}

const LEAD_RE = /(?:^|[^\p{L}])((?:by|until|till|before|no\s+later\s+than|к|ко|до|не\s+позже)\s+)$/u;

/** The deadline phrase of a promise; null when the text names none. */
export function parseDueExpression(text: string | undefined): DueExpression | null {
    if (!text?.trim()) return null;
    const original = text;
    const value = lower(original);
    const offsets = findOffsets(value);
    const outside = (item: Found) => !offsets.some((offset) => item.start < offset.end && item.end > offset.start);
    const dates = findDates(value).filter(outside);
    const weekdays = findWeekdays(value).filter(outside);
    const clocks = findClocks(value);
    const parts = findDayParts(value).filter((part) => !clocks.some((c) => part.start < c.end && part.end > c.start));
    const spans: Found[] = [...offsets, ...dates, ...weekdays, ...clocks, ...parts];
    if (!spans.length) return null;

    const expression: DueExpression = { label: '' };
    const offset = offsets.find((item) => item.days !== undefined && item.days > 0) ?? offsets[0];
    const hours = offsets.find((item) => item.minutes !== undefined);
    if (offset?.days !== undefined) expression.offsetDays = offset.days;
    if (hours?.minutes !== undefined) expression.offsetMinutes = hours.minutes;
    if (dates[0]) expression.date = dates[0].date;
    else if (weekdays[0]) expression.weekday = weekdays[0].weekday;
    const clock = clocks[0] ?? parts[0];
    if (clock) {
        expression.minutes = clock.minutes;
        if ('morning' in clock && clock.morning) expression.morning = true;
    }
    const dayWritten =
        expression.date !== undefined ||
        expression.weekday !== undefined ||
        (expression.offsetDays !== undefined && expression.offsetDays > 0);
    if (expression.minutes !== undefined && !dayWritten && expression.offsetDays === undefined) {
        expression.nextIfPassed = true;
    }
    if (expression.offsetDays === 0 && expression.minutes !== undefined) expression.nextIfPassed = false;

    const end = Math.max(...spans.map((item) => item.end));
    const source = value.length === original.length ? original : value;
    const first = spans.reduce((a, b) => (b.start < a.start ? b : a));
    // «by» / «до» in front belongs to the phrase: "by tomorrow", «до завтра».
    const lead = LEAD_RE.exec(value.slice(Math.max(0, first.start - 24), first.start));
    const start = first.start - (lead?.[1]?.length ?? 0);
    const phrase = end - start <= 60 ? source.slice(start, end) : source.slice(start, first.end);
    expression.label = phrase.replace(/\s+/g, ' ').trim();
    return expression;
}

/**
 * Places a deadline in story time, relative to the clock when the promise was made. Without a clock (no DES) the
 * moment has only its label; an explicit date of a calendar the clock does not know, or a weekday with no known
 * weekday, likewise.
 */
export function resolveDue(expression: DueExpression, base: StoryClock | null): Moment {
    const moment: Moment = { label: expression.label, day: null };
    let minutes = expression.minutes;
    if (!base) {
        if (minutes !== undefined) moment.minutes = minutes;
        return moment;
    }
    let day: number | null = base.day;
    if (expression.date) {
        const anchor = base.anchor;
        const difference = anchor ? dateDifference(anchor, expression.date) : null;
        day = anchor && difference !== null ? anchor.day + difference : null;
    } else if (expression.weekday !== undefined) {
        day = base.weekday === undefined ? null : base.day + ((expression.weekday - base.weekday + 7) % 7 || 7);
    } else if (expression.offsetDays !== undefined) {
        day = base.day + expression.offsetDays;
    }
    if (day !== null && expression.offsetMinutes !== undefined) {
        if (base.minutes !== undefined) {
            const total = base.minutes + expression.offsetMinutes;
            day += Math.floor(total / MINUTES_PER_DAY);
            minutes = total % MINUTES_PER_DAY;
        } else {
            day += Math.floor(expression.offsetMinutes / MINUTES_PER_DAY);
        }
    }
    if (day !== null && expression.nextIfPassed && minutes !== undefined) {
        const passed = base.minutes !== undefined ? base.minutes >= minutes : !!expression.morning;
        if (passed) day += 1;
    }
    moment.day = day;
    if (minutes !== undefined) moment.minutes = minutes;
    return moment;
}

/** The day a written label stands for, compared with the clock's label (the add form: «15 Зимня» when it is «12 Зимня»). */
export function labelDay(text: string, base: StoryClock | null): number | null {
    const info = readLabel(text);
    if (!info || !base || isBlank(info)) return null;
    const anchor = base.anchor;
    if (info.date && anchor && comparable(anchor, info)) return anchor.day + (dateDifference(anchor, info.date) ?? 0);
    const current = readLabel(base.label);
    if (!current) return null;
    if (sameLabel(current, info)) return base.day;
    if (current.key === info.key && current.numbers.length === info.numbers.length) {
        const moved = info.numbers.map((value, index) => value - (current.numbers[index] ?? value)).filter(Boolean);
        if (moved.length === 1) return base.day + (moved[0] as number);
    }
    if (current.weekday !== undefined && info.weekday !== undefined && !info.key && !info.numbers.length) {
        return base.day + ((info.weekday - current.weekday + 7) % 7 || 7);
    }
    return null;
}
