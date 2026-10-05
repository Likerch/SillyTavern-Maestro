// M29 «Фоны»: how well a background of ST's library suits a place now. A place is its own name and other names, its
// parents (the city around a tavern) and its state; the scene is the time of day, weather and season from DES. The
// place part decides whether a background is about this place at all; time, weather and season pick a variant
// («tavern day» by day, «tavern night» at night) and push wrong ones down. A place's bound background (the user's
// choice) always wins; its variants for time and weather live in the place state under `bg:<tags>`, and a bound
// file's library siblings («tavern day.jpg» → «tavern night.jpg») count as variants too. Pure: no DOM, no SillyTavern.
import {
    TIME_TAGS,
    emptyTokens,
    fileTitle,
    mergeTokens,
    namesMatch,
    nearConcepts,
    seasonOf,
    timeOfDay,
    tokenizeFile,
    tokenizeName,
    variantKind,
    weatherTags,
} from './backgrounds-tokens';
import type { NameTokens, SeasonTag, StateTag, TimeTag, VariantTag, WeatherTag } from './backgrounds-tokens';

/** Points of the score parts (exported for the tests and the pult's threshold hint). */
export const SCORE = {
    /** The first of the place's own concepts in the file name; each further one adds `conceptMore`. */
    concept: 3,
    conceptMore: 1.5,
    /** A related concept (inn ~ tavern) when no own concept matched. */
    near: 1.5,
    /** A proper-name word of the place in the file name; `nameSimilar` across scripts («Ройал» ~ «royal»). */
    name: 3,
    nameSimilar: 2,
    nameCap: 6,
    /** The nearest parent's concept or name; farther parents give `parentFar`; capped below the default threshold. */
    parent: 1.5,
    parentFar: 1,
    parentCap: 2,
    /** Matches found only in the file's folder names count this much. */
    folder: 0.6,
    /** A file concept the place has nothing to do with («tavern bedroom» for a plain tavern). */
    extraConcept: -0.75,
    extraCap: -1.5,
    stateMatch: 1.5,
    stateMismatch: -1.5,
    timeMatch: 1,
    /** Morning and day: both daylight. */
    timeDaylight: 0,
    timeNear: -0.75,
    timeConflict: -1.5,
    weatherMatch: 1,
    weatherConflict: -1,
    weatherMild: -0.25,
    /** Rain, snow, storm or fog in the name while the weather is unknown. */
    weatherUnknownHeavy: -0.5,
    seasonMatch: 0.5,
    seasonConflict: -1,
} as const;

/** Default score a library match needs to be set automatically (one own concept or one proper name). */
export const DEFAULT_THRESHOLD = 3;
/** Place state keys holding variants of the bound background: `bg:night`, `bg:night+rain`. */
export const VARIANT_PREFIX = 'bg:';

const VIDEO_RE = /\.(?:mp4|webm|mov|avi|mkv|m4v|ogv)$/i;
const HEAVY: ReadonlySet<WeatherTag> = new Set<WeatherTag>(['rain', 'storm', 'snow', 'fog']);
const DAYLIGHT: ReadonlySet<TimeTag> = new Set<TimeTag>(['morning', 'day']);

/* ------------------------------------------------------------------ library */

export interface LibraryFile {
    file: string;
    /** Names of the ST background folders the file is in. */
    folders?: readonly string[];
}

export interface LibraryItem {
    file: string;
    title: string;
    tokens: NameTokens;
    /** Tokens of the folder names. */
    folder: NameTokens;
    /** The name without variant tags: siblings («tavern day» / «tavern night») share it; '' when nothing is left. */
    base: string;
    /** May be chosen automatically: not one of ST's system files (`_black.jpg`), not a video. */
    usable: boolean;
}

/** Identity of a name without its time, weather and season words. */
export function baseKey(tokens: NameTokens): string {
    return [
        ...tokens.concepts.map((value) => `c:${value}`),
        ...tokens.names.map((value) => `n:${value}`),
        ...tokens.state.map((value) => `s:${value}`),
    ]
        .sort()
        .join(' ');
}

export function indexLibrary(files: readonly LibraryFile[]): LibraryItem[] {
    const out: LibraryItem[] = [];
    const seen = new Set<string>();
    for (const entry of files) {
        const file = typeof entry?.file === 'string' ? entry.file : '';
        if (!file || seen.has(file)) continue;
        seen.add(file);
        const tokens = tokenizeFile(file);
        const folders = Array.isArray(entry.folders) ? entry.folders.filter((name) => typeof name === 'string') : [];
        const base = file.split(/[\\/]/).pop() ?? file;
        out.push({
            file,
            title: fileTitle(file) || file,
            tokens,
            folder: mergeTokens(...folders.map(tokenizeName)),
            base: baseKey(tokens),
            usable: !base.startsWith('_') && !VIDEO_RE.test(file),
        });
    }
    return out;
}

/* ------------------------------------------------------------------ place and scene */

export interface PlaceInput {
    name: string;
    aliases?: readonly string[];
    /** Names of the containing places, nearest first. */
    parents?: readonly string[];
    state?: Readonly<Record<string, string>>;
}

export interface SceneConditions {
    time: TimeTag | null;
    weather: WeatherTag[];
    season: SeasonTag | null;
}

export interface PlaceProfile {
    own: NameTokens;
    parents: NameTokens[];
    state: StateTag[];
    /** Time, weather or season the place state fixes («зима», «вечная ночь»): they override the scene's. */
    fixed: Partial<SceneConditions>;
}

export function placeProfile(input: PlaceInput): PlaceProfile {
    const own = mergeTokens(tokenizeName(input.name ?? ''), ...(input.aliases ?? []).map(tokenizeName));
    const stateTokens = mergeTokens(
        emptyTokens(),
        ...Object.entries(input.state ?? {})
            .filter(([key, value]) => !key.startsWith(VARIANT_PREFIX) && typeof value === 'string')
            .map(([, value]) => tokenizeName(value)),
    );
    const state = [...own.state];
    for (const tag of stateTokens.state) if (!state.includes(tag)) state.push(tag);
    const fixed: Partial<SceneConditions> = {};
    if (stateTokens.time[0]) fixed.time = stateTokens.time[0];
    if (stateTokens.weather.length) fixed.weather = [...stateTokens.weather];
    if (stateTokens.season[0]) fixed.season = stateTokens.season[0];
    return { own, parents: (input.parents ?? []).map(tokenizeName), state, fixed };
}

export interface DesScene {
    time?: { start?: string; end?: string } | null;
    weather?: { emoji?: string; forecast?: string } | null;
    date?: string | null;
}

export function emptyConditions(): SceneConditions {
    return { time: null, weather: [], season: null };
}

/** Time of day (the end of the scene's time span, else its start), weather and season of a DES info box. */
export function sceneConditions(scene: DesScene | null | undefined): SceneConditions {
    if (!scene) return emptyConditions();
    const time = timeOfDay(scene.time?.end) ?? timeOfDay(scene.time?.start);
    return { time, weather: weatherTags(scene.weather), season: seasonOf(scene.date ?? undefined) };
}

/** The scene with what the place state fixes laid over it. */
export function withPlace(conditions: SceneConditions, profile: PlaceProfile): SceneConditions {
    return {
        time: profile.fixed.time ?? conditions.time,
        weather: profile.fixed.weather ? [...profile.fixed.weather] : [...conditions.weather],
        season: profile.fixed.season ?? conditions.season,
    };
}

/** The scene's variant tags: time of day, weather, season. */
export function conditionTags(conditions: SceneConditions): VariantTag[] {
    const tags: VariantTag[] = [];
    if (conditions.time) tags.push(conditions.time);
    for (const tag of conditions.weather) if (!tags.includes(tag)) tags.push(tag);
    if (conditions.season) tags.push(conditions.season);
    return tags;
}

/** A stable key of the scene (change detection). */
export function conditionsKey(conditions: SceneConditions): string {
    return `${conditions.time ?? '-'}|${[...conditions.weather].sort().join(',') || '-'}|${conditions.season ?? '-'}`;
}

/* ------------------------------------------------------------------ scoring */

export interface ScoreOptions {
    /** Time, weather and season pick variants; off: only the place matters. */
    variants: boolean;
}

export interface Scored {
    file: string;
    score: number;
    /** Something of the place (a concept, a name, a parent) is in the name or folders. */
    matched: boolean;
    /** Tags of the background that fit now: time, weather, season, state. */
    variant: string[];
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function timeDistance(a: TimeTag, b: TimeTag): number {
    return Math.abs(TIME_TAGS.indexOf(a) - TIME_TAGS.indexOf(b));
}

/** How the time, weather and season words of a name fit the scene. */
export function variantFit(tokens: NameTokens, conditions: SceneConditions): { score: number; matched: VariantTag[] } {
    let score = 0;
    const matched: VariantTag[] = [];
    if (tokens.time.length && conditions.time) {
        const now = conditions.time;
        let best = Number.NEGATIVE_INFINITY;
        for (const tag of tokens.time) {
            const distance = timeDistance(tag, now);
            const daylight = DAYLIGHT.has(tag) && DAYLIGHT.has(now);
            const points =
                distance === 0
                    ? SCORE.timeMatch
                    : daylight
                      ? SCORE.timeDaylight
                      : distance === 1
                        ? SCORE.timeNear
                        : SCORE.timeConflict;
            best = Math.max(best, points);
        }
        score += best;
        if (best === SCORE.timeMatch) matched.push(now);
    }
    if (tokens.weather.length) {
        const hits = tokens.weather.filter((tag) => conditions.weather.includes(tag));
        if (hits.length) {
            score += SCORE.weatherMatch;
            matched.push(...hits);
        } else if (conditions.weather.length) {
            const heavyName = tokens.weather.some((tag) => HEAVY.has(tag));
            const clearInBad = tokens.weather.includes('clear') && conditions.weather.some((tag) => HEAVY.has(tag));
            score += heavyName || clearInBad ? SCORE.weatherConflict : SCORE.weatherMild;
        } else if (tokens.weather.some((tag) => HEAVY.has(tag))) {
            score += SCORE.weatherUnknownHeavy;
        }
    }
    if (tokens.season.length && conditions.season) {
        if (tokens.season.includes(conditions.season)) {
            score += SCORE.seasonMatch;
            matched.push(conditions.season);
        } else score += SCORE.seasonConflict;
    }
    return { score, matched };
}

function nameScore(name: string, names: readonly string[]): number {
    let best = 0;
    for (const other of names) {
        const match = namesMatch(name, other);
        if (match === 'exact') return SCORE.name;
        if (match === 'similar') best = SCORE.nameSimilar;
    }
    return best;
}

function relatedToPlace(concept: string, own: readonly string[]): boolean {
    if (own.includes(concept)) return true;
    if (own.some((id) => nearConcepts(id).includes(concept))) return true;
    return nearConcepts(concept).some((id) => own.includes(id));
}

/** Scores one library file for a place now. Unmatched files (nothing of the place in them) score 0. */
export function scoreItem(
    item: LibraryItem,
    profile: PlaceProfile,
    conditions: SceneConditions,
    options: ScoreOptions,
): Scored {
    const own = profile.own;
    const counted = new Set<string>();
    let place = 0;

    let concepts = 0;
    for (const concept of own.concepts) {
        const inFile = item.tokens.concepts.includes(concept);
        if (!inFile && !item.folder.concepts.includes(concept)) continue;
        const points = concepts === 0 ? SCORE.concept : SCORE.conceptMore;
        place += inFile ? points : points * SCORE.folder;
        concepts++;
        counted.add(concept);
    }
    if (concepts === 0) {
        let best = 0;
        for (const concept of own.concepts) {
            for (const near of nearConcepts(concept)) {
                if (item.tokens.concepts.includes(near)) best = Math.max(best, SCORE.near);
                else if (item.folder.concepts.includes(near)) best = Math.max(best, SCORE.near * SCORE.folder);
                else continue;
                counted.add(near);
            }
        }
        place += best;
    }

    let names = 0;
    for (const name of own.names) {
        const inFile = nameScore(name, item.tokens.names);
        names += inFile || nameScore(name, item.folder.names) * SCORE.folder;
    }
    place += Math.min(names, SCORE.nameCap);

    let parents = 0;
    profile.parents.forEach((parent, index) => {
        const weight = index === 0 ? SCORE.parent : SCORE.parentFar;
        for (const concept of parent.concepts) {
            if (counted.has(concept)) continue;
            if (item.tokens.concepts.includes(concept)) parents += weight;
            else if (item.folder.concepts.includes(concept)) parents += weight * SCORE.folder;
            else continue;
            counted.add(concept);
        }
        for (const name of parent.names) {
            const inFile = nameScore(name, item.tokens.names) ? weight : 0;
            parents += inFile || (nameScore(name, item.folder.names) ? weight * SCORE.folder : 0);
        }
    });
    place += Math.min(parents, SCORE.parentCap);

    if (place <= 0) return { file: item.file, score: 0, matched: false, variant: [] };

    let extra = 0;
    const context = [...own.concepts, ...profile.parents.flatMap((parent) => parent.concepts)];
    for (const concept of item.tokens.concepts) {
        if (!counted.has(concept) && !relatedToPlace(concept, context)) extra += SCORE.extraConcept;
    }

    const variant: string[] = [];
    let state = 0;
    const named = mergeTokens(item.tokens, item.folder);
    for (const tag of named.state) {
        if (profile.state.includes(tag)) {
            state += SCORE.stateMatch;
            variant.push(tag);
        } else state += SCORE.stateMismatch;
    }

    let fit = 0;
    if (options.variants) {
        const result = variantFit(named, conditions);
        fit = result.score;
        variant.unshift(...result.matched);
    }

    return {
        file: item.file,
        score: round(place + Math.max(extra, SCORE.extraCap) + state + fit),
        matched: true,
        variant,
    };
}

/** Matching files of the library, best first (ties by title); only those scoring above zero. */
export function rankLibrary(
    items: readonly LibraryItem[],
    profile: PlaceProfile,
    conditions: SceneConditions,
    options: ScoreOptions,
    limit = 5,
): Scored[] {
    const titles = new Map(items.map((item) => [item.file, item.title]));
    return items
        .filter((item) => item.usable)
        .map((item) => scoreItem(item, profile, conditions, options))
        .filter((scored) => scored.matched && scored.score > 0)
        .sort((a, b) => b.score - a.score || (titles.get(a.file) ?? a.file).localeCompare(titles.get(b.file) ?? b.file))
        .slice(0, Math.max(0, limit));
}

/** The best library file when it reaches the threshold; null otherwise. */
export function bestMatch(
    items: readonly LibraryItem[],
    profile: PlaceProfile,
    conditions: SceneConditions,
    options: ScoreOptions,
    threshold: number,
): Scored | null {
    const [best] = rankLibrary(items, profile, conditions, options, 1);
    return best && best.score >= threshold ? best : null;
}

/* ------------------------------------------------------------------ bound backgrounds */

export interface BoundVariant {
    tags: VariantTag[];
    file: string;
}

export interface BoundSet {
    main: string | null;
    variants: BoundVariant[];
}

/** `bg:` + the valid variant tags, sorted and joined by `+`; null when none is valid. */
export function variantKey(tags: readonly string[]): string | null {
    const valid = [...new Set(tags.filter((tag) => variantKind(tag) !== null))].sort();
    return valid.length ? `${VARIANT_PREFIX}${valid.join('+')}` : null;
}

/** Tags of a `bg:` state key; null for other keys or junk. */
export function parseVariantKey(key: string): VariantTag[] | null {
    if (typeof key !== 'string' || !key.startsWith(VARIANT_PREFIX)) return null;
    const tags = key.slice(VARIANT_PREFIX.length).split('+').filter(Boolean);
    if (!tags.length || tags.some((tag) => variantKind(tag) === null)) return null;
    return [...new Set(tags)].sort() as VariantTag[];
}

/** The place's bound background and its variants (from the place state). */
export function boundSet(place: {
    background?: string | null;
    state?: Readonly<Record<string, string>> | null;
}): BoundSet {
    const variants: BoundVariant[] = [];
    for (const [key, file] of Object.entries(place.state ?? {})) {
        const tags = parseVariantKey(key);
        if (tags && typeof file === 'string' && file) variants.push({ tags, file });
    }
    variants.sort((a, b) => a.tags.join('+').localeCompare(b.tags.join('+')));
    const main = typeof place.background === 'string' && place.background ? place.background : null;
    return { main, variants };
}

/** A copy of the place state with the variant for `tags` set to `file` (null removes it). */
export function withVariant(
    state: Readonly<Record<string, string>> | null | undefined,
    tags: readonly string[],
    file: string | null,
): Record<string, string> {
    const next: Record<string, string> = { ...(state ?? {}) };
    const key = variantKey(tags);
    if (!key) return next;
    if (file) next[key] = file;
    else delete next[key];
    return next;
}

/**
 * The bound background for now: the bound variant whose tags all hold (most tags first, a time tag breaks ties),
 * else the main file's best library sibling by time and weather, else the main file. Null without a main file and a
 * fitting variant. Variants off: the main file only.
 */
export function chooseBound(
    bound: BoundSet,
    conditions: SceneConditions,
    options: ScoreOptions,
    library: readonly LibraryItem[] = [],
): { file: string; variant: VariantTag[] } | null {
    if (!options.variants) return bound.main ? { file: bound.main, variant: [] } : null;
    const now = conditionTags(conditions);
    let best: BoundVariant | null = null;
    const hasTime = (variant: BoundVariant) => variant.tags.some((tag) => variantKind(tag) === 'time');
    for (const variant of bound.variants) {
        if (!variant.tags.every((tag) => now.includes(tag))) continue;
        if (
            !best ||
            variant.tags.length > best.tags.length ||
            (variant.tags.length === best.tags.length && hasTime(variant) && !hasTime(best))
        ) {
            best = variant;
        }
    }
    if (best) return { file: best.file, variant: [...best.tags] };
    if (!bound.main) return null;
    const main = library.find((item) => item.file === bound.main);
    if (!main || !main.base) return { file: bound.main, variant: [] };
    let pick = { file: main.file, fit: variantFit(main.tokens, conditions) };
    for (const item of library) {
        if (!item.usable || item.file === main.file || item.base !== main.base) continue;
        const fit = variantFit(item.tokens, conditions);
        if (fit.score > pick.fit.score) pick = { file: item.file, fit };
    }
    return { file: pick.file, variant: pick.fit.matched };
}
