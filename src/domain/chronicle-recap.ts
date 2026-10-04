// M9 «Автопамять» and «Ранее в истории…» — pure parts (plan M9 п. 3–4, §5 phase 0, P15, P16).
// - message times: ST 1.19 writes `send_date` as an ISO string (RossAscends-mods.js getMessageTimeStamp); older chats
//   hold numbers or «October 4, 2026 3:45pm» / «2026-10-04@15h45m12s»;
// - the absence rule: the recap is due when the last message and the last recap are both older than the threshold;
// - the free recap (chapters, long-term memories, the latest events) and the background model's prompt;
// - cheap detection of important moments in a committed reply (oath, revealed secret, new quest), RU and EN.
// Pure: no DOM, no SillyTavern.

/* ------------------------------------------------------------------ time */

const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
];

/** «October 4, 2026 3:45pm» (ST's old meridiem format). */
const LEGACY_RE = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i;
/** «2026-10-04@15h45m12s» (humanizedDateTime), optionally with milliseconds. */
const HUMANIZED_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/i;

/** Milliseconds of a message's `send_date`; null when it cannot be read. */
export function parseSendDate(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    const humanized = HUMANIZED_RE.exec(text);
    if (humanized) {
        const [, y, mo, d, h, mi, s, ms] = humanized.map((part) => (part === undefined ? 0 : Number(part)));
        const time = new Date(y as number, (mo as number) - 1, d, h, mi, s, ms).getTime();
        return Number.isFinite(time) ? time : null;
    }
    const legacy = LEGACY_RE.exec(text);
    if (legacy) {
        const month = MONTHS.findIndex((name) => name.startsWith((legacy[1] ?? '').toLowerCase().slice(0, 3)));
        if (month < 0) return null;
        let hours = Number(legacy[4]) % 12;
        if ((legacy[6] ?? '').toLowerCase() === 'pm') hours += 12;
        if (!legacy[6]) hours = Number(legacy[4]);
        const time = new Date(Number(legacy[3]), month, Number(legacy[2]), hours, Number(legacy[5])).getTime();
        return Number.isFinite(time) ? time : null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Time of the newest message with a readable `send_date` (searching from the end); null when there is none. */
export function lastMessageTime(messages: readonly unknown[]): number | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || typeof message !== 'object') continue;
        const time = parseSendDate((message as Record<string, unknown>).send_date);
        if (time !== null) return time;
    }
    return null;
}

/**
 * The recap is due when the user has been away longer than `afterHours`: measured from the newest of the last
 * message and the last recap (so a recap is shown once per absence, on every device).
 */
export function recapDue(
    now: number,
    lastMessageAt: number | null,
    shownAt: number | null | undefined,
    afterHours: number,
): boolean {
    const since = Math.max(lastMessageAt ?? 0, shownAt ?? 0);
    if (since <= 0 || !(afterHours > 0)) return false;
    return now - since > afterHours * 3_600_000;
}

/* ------------------------------------------------------------------ language */

/** Russian when the texts hold more Cyrillic than Latin letters. */
export function chatLanguage(texts: readonly string[]): 'ru' | 'en' {
    let cyrillic = 0;
    let latin = 0;
    for (const text of texts) {
        for (const char of text) {
            if (/\p{Script=Cyrillic}/u.test(char)) cyrillic++;
            else if (/[A-Za-z]/.test(char)) latin++;
        }
    }
    return cyrillic > latin ? 'ru' : 'en';
}

/* ------------------------------------------------------------------ recap */

export interface RecapChapter {
    title: string;
    events: string[];
}

/** What the recap is made of: recent chronicle chapters, Qvink's long-term memories and the latest memories. */
export interface RecapMaterial {
    chapters: RecapChapter[];
    long: string[];
    recent: string[];
}

export function hasMaterial(material: RecapMaterial): boolean {
    return material.chapters.length > 0 || material.long.length > 0 || material.recent.length > 0;
}

export interface RecapLabels {
    chapters: string;
    long: string;
    recent: string;
}

export const RECAP_LIMITS = { chapters: 3, long: 6, recent: 3, line: 220, chars: 1400 } as const;

function shorten(text: string, max: number): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function lastItems<T>(list: readonly T[], count: number): T[] {
    return count > 0 ? list.slice(-count) : [];
}

/**
 * The free recap: up to three recent chapters (title and first events), the newest long-term memories and the latest
 * events, as short bullet sections; older long-term memories are dropped first to stay within `maxChars`.
 * '' when there is nothing to tell.
 */
export function freeRecap(material: RecapMaterial, labels: RecapLabels, maxChars: number = RECAP_LIMITS.chars): string {
    const chapterLines = lastItems(material.chapters, RECAP_LIMITS.chapters).map((chapter) => {
        const events = chapter.events.slice(0, 2).join(' ');
        return `• ${shorten(events ? `${chapter.title}: ${events}` : chapter.title, RECAP_LIMITS.line)}`;
    });
    const recent = lastItems(material.recent, RECAP_LIMITS.recent).map(
        (text) => `• ${shorten(text, RECAP_LIMITS.line)}`,
    );
    const recentSet = new Set(material.recent.map((text) => text.trim()));
    let long = lastItems(
        material.long.filter((text) => !recentSet.has(text.trim())),
        RECAP_LIMITS.long,
    ).map((text) => `• ${shorten(text, RECAP_LIMITS.line)}`);
    const compose = () => {
        const parts: string[] = [];
        if (chapterLines.length) parts.push([labels.chapters, ...chapterLines].join('\n'));
        if (long.length) parts.push([labels.long, ...long].join('\n'));
        if (recent.length) parts.push([labels.recent, ...recent].join('\n'));
        return parts.join('\n\n');
    };
    let text = compose();
    while (text.length > maxChars && long.length) {
        long = long.slice(1);
        text = compose();
    }
    return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

/** Messages for the background model: a ≤ `maxWords` recap in the chat's language, from the material only. */
export function recapPrompt(
    material: RecapMaterial,
    language: 'ru' | 'en',
    maxWords = 120,
): { system: string; user: string } {
    const system = [
        'You write a short «Previously in the story…» recap for a reader who returns to an interactive story after a break.',
        'Use only the material below; do not invent events. Keep names exactly as written.',
        `At most ${maxWords} words of plain prose: no headings, no lists, no quotes around the text, past tense.`,
        language === 'ru' ? 'Write in natural Russian (translate the English material).' : 'Write in English.',
        'Answer with the recap only.',
    ].join('\n');
    const block = (title: string, lines: readonly string[]) =>
        lines.length ? `${title}:\n${lines.map((line) => `- ${line.replace(/\s+/g, ' ').trim()}`).join('\n')}` : '';
    const chapters = lastItems(material.chapters, RECAP_LIMITS.chapters).map((chapter) =>
        chapter.events.length ? `${chapter.title}: ${chapter.events.join(' ')}` : chapter.title,
    );
    const user = [
        block('Chronicle chapters (oldest first)', chapters),
        block('Long-term memories (oldest first)', lastItems(material.long, RECAP_LIMITS.long * 2)),
        block('Latest events (oldest first)', lastItems(material.recent, RECAP_LIMITS.recent + 2)),
    ]
        .filter(Boolean)
        .join('\n\n');
    return { system, user };
}

/** The model's answer made safe to show: no reasoning blocks or wrapping quotes, at most ~`maxWords` words. */
export function tidyRecap(text: unknown, maxWords = 120): string {
    if (typeof text !== 'string') return '';
    let out = text
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/^```[a-z]*\s*|```\s*$/gi, '')
        .trim();
    out = out.replace(/^["«“]+|["»”]+$/g, '').trim();
    out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    const words = out.split(/\s+/).filter(Boolean);
    const limit = Math.ceil(maxWords * 1.25);
    if (words.length > limit) out = `${words.slice(0, maxWords).join(' ')}…`;
    return out;
}

/** The recap as a one-turn note for the model (P16: injected near the end, cleared after the generation). */
export function promptRecap(text: string): string {
    const body = text.trim();
    return body ? `[Previously in the story — the user returns after a break:\n${body}]` : '';
}

/* ------------------------------------------------------------------ important moments */

export type ImportantCode = 'oath' | 'secret' | 'quest';

/** Left word boundary that also works for Cyrillic (`\b` is ASCII-only in JavaScript). */
const B = '(?<![\\p{L}\\p{N}_])';

/** «тайна» / «секрет» in any case form, but not «секретарь», «тайник» or «секретный». */
const SECRET_NOUN = `${B}(?:тайн(?:а|у|ы|е|ой|ою|ам|ами|ах)?|секрет(?:а|у|ом|е|ы|ов|ам|ами|ах)?)(?![\\p{L}])`;

const PATTERNS: Record<ImportantCode, RegExp[]> = {
    oath: [
        new RegExp(`${B}(?:клян[уеёи]|клятв|поклял|присягн|присяг[аеиу])`, 'iu'),
        new RegExp(`${B}обет(?:а|у|ом|ы)?(?![\\p{L}])`, 'iu'),
        new RegExp(
            `${B}да(?:ю|л|ла|ли|ём|ем)\\s+(?:(?:тебе|вам|мне|нам|ему|ей|им)\\s+)?(?:честное\\s+|сво[её]\\s+)?слово`,
            'iu',
        ),
        /\b(?:i|we|he|she|they)\s+(?:solemnly\s+)?(?:swear|vow)s?\b/i,
        /\b(?:swore|sworn|vowed)\b/i,
        /\b(?:an|the|my|his|her|their|our|a blood)\s+oath\b/i,
    ],
    secret: [
        new RegExp(
            `${B}(?:раскры|открыл|открыла|открыли|выдал|выдала|поведал|рассказал|рассказала|призна)\\p{L}*[^.!?…]{0,40}${SECRET_NOUN}`,
            'iu',
        ),
        new RegExp(`${SECRET_NOUN}[^.!?…]{0,30}${B}(?:раскрыт|раскрыл|открыл|выдал|вышл)`, 'iu'),
        /\b(?:reveal(?:s|ed)?|confess(?:es|ed)?|admit(?:s|ted)?|told|tells?|shared?)\b[^.!?]{0,40}\bsecret\b/i,
        /\bsecret\b[^.!?]{0,20}\b(?:is out|was out|revealed|came out)\b/i,
        /\bthe truth (?:is|was|about)\b/i,
    ],
    quest: [
        new RegExp(`${B}нов(?:ое|ый|ая|ую|ым|ой)\\s+(?:задани|поручени|квест|мисси)`, 'iu'),
        new RegExp(
            `${B}(?:взял|взяла|взяли|принял|приняла|приняли|получил|получила|получили)\\p{L}*\\s+(?:на\\s+себя\\s+)?(?:задани|квест|поручени|мисси)`,
            'iu',
        ),
        /\bnew (?:quest|mission)\b/i,
        /\bquest (?:accepted|started|begins|received|given)\b/i,
        /\baccept(?:s|ed)? (?:the |a |your |his |her )?(?:quest|mission)\b/i,
    ],
};

/** Important moments a committed reply announces (cheap regexes; one code per kind, in a fixed order). */
export function detectImportant(text: string): ImportantCode[] {
    if (typeof text !== 'string' || !text.trim()) return [];
    return (Object.keys(PATTERNS) as ImportantCode[]).filter((code) =>
        (PATTERNS[code] as RegExp[]).some((pattern) => pattern.test(text)),
    );
}
