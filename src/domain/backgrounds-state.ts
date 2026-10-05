// M29 «Фоны»: what Maestro remembers per chat (a small pointer in the chat metadata) and the value formats around the
// chat background. ST keeps a chat's own background as a CSS value — `url("backgrounds/<encoded file>")` for a file
// of the backgrounds library — and does not say who put it there, so Maestro stores the exact value it wrote last:
// any other chat background is the user's (plan M29 п.4). Also: NAI Studio's «free only» switch, its free-only
// refusal and the tags Maestro sends when it asks NAI Studio for a background. Pure: no DOM, no SillyTavern.
import type { PlaceProfile, SceneConditions } from './backgrounds-score';

export type ChoiceSource = 'library' | 'generated' | 'user';

export interface StoredChoice {
    placeId: string;
    file: string;
    variant: string[];
    source: ChoiceSource;
    score: number;
    /** Picked by the user in the pult: kept while the scene stays in that place. */
    manual?: boolean;
}

export interface BackgroundsPointer {
    v: 1;
    /** The chat background value Maestro wrote (or took over on «release»); '' = none. */
    url: string;
    /** What that value is, when Maestro chose it. */
    choice: StoredChoice | null;
    /** Files NAI Studio generated for this chat. */
    generated: string[];
    /** Automatic choices the user undid: not chosen automatically again for that place. */
    undone: { placeId: string; file: string }[];
}

export const GENERATED_MAX = 100;
export const UNDONE_MAX = 30;

const SOURCES: readonly ChoiceSource[] = ['library', 'generated', 'user'];

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

export function emptyPointer(): BackgroundsPointer {
    return { v: 1, url: '', choice: null, generated: [], undone: [] };
}

export function readChoice(raw: unknown): StoredChoice | null {
    if (!isDict(raw)) return null;
    if (typeof raw.placeId !== 'string' || !raw.placeId || typeof raw.file !== 'string' || !raw.file) return null;
    const source = SOURCES.find((item) => item === raw.source) ?? 'library';
    const choice: StoredChoice = {
        placeId: raw.placeId,
        file: raw.file,
        variant: strings(raw.variant),
        source,
        score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0,
    };
    if (raw.manual === true) choice.manual = true;
    return choice;
}

/** A clean copy of a stored pointer (junk and unknown versions give the empty one). */
export function readPointer(raw: unknown): BackgroundsPointer {
    if (!isDict(raw) || raw.v !== 1) return emptyPointer();
    const undone = Array.isArray(raw.undone)
        ? raw.undone
              .filter(isDict)
              .filter((item) => typeof item.placeId === 'string' && typeof item.file === 'string')
              .map((item) => ({ placeId: item.placeId as string, file: item.file as string }))
        : [];
    return {
        v: 1,
        url: typeof raw.url === 'string' ? raw.url : '',
        choice: readChoice(raw.choice),
        generated: strings(raw.generated).slice(-GENERATED_MAX),
        undone: undone.slice(-UNDONE_MAX),
    };
}

/** The live chat background is not the one Maestro wrote: the user put (or removed) it. */
export function isUserPinned(live: string, pointer: BackgroundsPointer): boolean {
    return live !== pointer.url;
}

export function isUndone(pointer: BackgroundsPointer, placeId: string, file: string): boolean {
    return pointer.undone.some((item) => item.placeId === placeId && item.file === file);
}

export function withUndone(pointer: BackgroundsPointer, placeId: string, file: string): BackgroundsPointer {
    const undone = pointer.undone.filter((item) => !(item.placeId === placeId && item.file === file));
    undone.push({ placeId, file });
    return { ...pointer, undone: undone.slice(-UNDONE_MAX) };
}

export function withGenerated(pointer: BackgroundsPointer, file: string): BackgroundsPointer {
    const generated = pointer.generated.filter((item) => item !== file);
    generated.push(file);
    return { ...pointer, generated: generated.slice(-GENERATED_MAX) };
}

/* ------------------------------------------------------------------ CSS values */

/** The chat background value ST writes for a library file (backgrounds.js generateUrlParameter(bg, false)). */
export function libraryCssUrl(file: string): string {
    return `url("backgrounds/${encodeURIComponent(file)}")`;
}

/** The path inside `url(…)`, unquoted; null for anything else. */
export function cssUrlPath(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const match = /^\s*url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)\s*$/i.exec(value);
    if (!match) return null;
    const path = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return path || null;
}

/** The library file of a chat background value; null for other images (chat uploads, generated by ST's SD). */
export function libraryFileOf(value: string | null | undefined): string | null {
    const path = cssUrlPath(value);
    if (!path) return null;
    const match = /^\/?backgrounds\/([^/?#]+)$/.exec(path);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

/* ------------------------------------------------------------------ NAI Studio */

/** NAI Studio's «free only» switch (on unless explicitly off); null when its settings cannot be read. */
export function naiFreeOnly(settings: unknown): boolean | null {
    if (!isDict(settings) || !isDict(settings.anlas)) return null;
    return settings.anlas.freeOnly !== false;
}

/** NAI Studio refused because the request would spend Anlas in «free only» mode (its NaiError 'free-only-blocked'). */
export function isFreeOnlyRefusal(error: unknown): boolean {
    if (isDict(error) && typeof error.code === 'string' && /free[-_ ]?only/i.test(error.code)) return true;
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /free[-_ ]?only/i.test(message);
}

const CONCEPT_TAGS: Record<string, string> = {
    lab: 'laboratory',
    space: 'outer space',
    square: 'town square',
    room: 'indoors',
    sea: 'ocean',
    harbor: 'harbor',
};
const TIME_WORDS: Record<string, string> = {
    morning: 'morning',
    day: 'daytime',
    evening: 'evening, sunset',
    night: 'night',
};
const WEATHER_WORDS: Record<string, string> = {
    clear: 'clear sky',
    cloudy: 'cloudy sky',
    rain: 'rain',
    storm: 'storm, lightning',
    snow: 'snow',
    fog: 'fog',
};
const STATE_WORDS: Record<string, string> = {
    ruined: 'ruins',
    burning: 'fire',
    abandoned: 'abandoned',
    flooded: 'flooded',
    festive: 'festival, decorations',
};

/** English setting tags for a generated background: the place's concepts, its state, then the scene. */
export function generationTags(profile: PlaceProfile, conditions: SceneConditions): string {
    const tags: string[] = [];
    const add = (value: string | undefined) => {
        for (const part of (value ?? '').split(',')) {
            const tag = part.trim();
            if (tag && !tags.includes(tag)) tags.push(tag);
        }
    };
    for (const concept of profile.own.concepts) add(CONCEPT_TAGS[concept] ?? concept);
    if (!profile.own.concepts.length)
        for (const concept of profile.parents[0]?.concepts ?? []) add(CONCEPT_TAGS[concept] ?? concept);
    for (const state of profile.state) add(STATE_WORDS[state]);
    if (conditions.time) add(TIME_WORDS[conditions.time]);
    for (const weather of conditions.weather) add(WEATHER_WORDS[weather]);
    if (conditions.season) add(conditions.season);
    return tags.join(', ');
}
