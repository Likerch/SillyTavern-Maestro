// One-shot flags of the director (M13 п.2–4, M34 п.8, P15): `chat_metadata.variables['maestro_…'] = '1'` for the next
// generation only (app.ephemeral clears them after it), read by conditional preset blocks
// `{{if .maestro_scene_combat}}…{{/if}}` (new macro engine). DIRECTOR_FLAGS is the static catalogue of every flag the
// director can set — the Preset Studio lists it when the user writes a conditional block.
// Also here: the reply-length hint per scene type, picture moments (first appearance, place change, climax; NAI
// Studio's Anlas settings make the rule stricter when pictures are paid) and the chat language.
// Pure: no DOM, no SillyTavern.
import { SCENE_KINDS } from './director-scene';
import type { SceneKind } from './director-scene';
import { normalizeText } from './signals-tokens';

export interface DirectorFlagInfo {
    /** Variable name as set in chat_metadata.variables (`{{if .<name>}}`). */
    name: string;
    titleKey: string;
    descriptionKey: string;
}

export type ReplyLength = 'short' | 'medium' | 'long';

/** Reply length that suits a scene type: action is quick, description and intimacy take their time. */
export const REPLY_LENGTH: Record<SceneKind, ReplyLength> = {
    dialogue: 'short',
    combat: 'short',
    intimate: 'long',
    exploration: 'long',
    timeskip: 'medium',
    social: 'medium',
    drama: 'medium',
};

export const REPLY_LENGTHS: readonly ReplyLength[] = ['short', 'medium', 'long'];

/** Chat languages the director can tell apart (by letters). */
export const DIRECTOR_LANGUAGES: readonly ('ru' | 'en')[] = ['ru', 'en'];

export const FLAG_EXPLICIT = 'maestro_explicit';
export const FLAG_PICTURE = 'maestro_picture_moment';

export function sceneFlag(type: SceneKind): string {
    return `maestro_scene_${type}`;
}

export function languageFlag(code: string): string {
    return `maestro_lang_${code}`;
}

export function replyFlag(length: ReplyLength): string {
    return `maestro_reply_${length}`;
}

function info(name: string): DirectorFlagInfo {
    const suffix = name.replace(/^maestro_/, '');
    return { name, titleKey: `m13.flag.${suffix}`, descriptionKey: `m13.flag.${suffix}.hint` };
}

/** Every flag the director can set, in the order the Preset Studio shows them. */
export const DIRECTOR_FLAGS: readonly DirectorFlagInfo[] = [
    ...SCENE_KINDS.map((type) => info(sceneFlag(type))),
    info(FLAG_EXPLICIT),
    ...DIRECTOR_LANGUAGES.map((code) => info(languageFlag(code))),
    info(FLAG_PICTURE),
    ...REPLY_LENGTHS.map((length) => info(replyFlag(length))),
];

export interface FlagState {
    /** Effective scene type (the user's override first); null before the first decision. */
    scene: SceneKind | null;
    explicit: boolean;
    language: string | null;
    picture: boolean;
}

/** Flags for the next generation, all with the value '1' (ST variables are strings; absent means false). */
export function buildDirectorFlags(state: FlagState): Record<string, string> {
    const flags: Record<string, string> = {};
    if (state.scene) {
        flags[sceneFlag(state.scene)] = '1';
        flags[replyFlag(REPLY_LENGTH[state.scene])] = '1';
    }
    if (state.explicit) flags[FLAG_EXPLICIT] = '1';
    if (state.language && (DIRECTOR_LANGUAGES as readonly string[]).includes(state.language)) {
        flags[languageFlag(state.language)] = '1';
    }
    if (state.picture) flags[FLAG_PICTURE] = '1';
    return flags;
}

/* ------------------------------------------------------------------ language */

const MIN_LETTERS = 20;

/** The chat language by letters (Cyrillic → ru, Latin → en); null with too few letters or a mix. */
export function dominantLanguage(texts: readonly string[]): 'ru' | 'en' | null {
    let cyrillic = 0;
    let latin = 0;
    for (const text of texts) {
        cyrillic += String(text ?? '').match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
        latin += String(text ?? '').match(/[A-Za-z]/g)?.length ?? 0;
    }
    const total = cyrillic + latin;
    if (total < MIN_LETTERS) return null;
    if (cyrillic / total >= 0.6) return 'ru';
    if (latin / total >= 0.8) return 'en';
    return null;
}

/* ------------------------------------------------------------------ picture moments */

export type PictureCue = 'firstAppearance' | 'placeChange' | 'climax';

const CLIMAX_RE =
    /(?<!\p{L})(?:наконец|впервые|кульминац|взрыв|рухнул|обрушил|вспыхнул|превратил|ослепительн|грандиозн|величествен|захватывающ|finally|for the first time|climax|explosion|exploded|collapsed|erupted|transformed|unveil|breathtaking|majestic|magnificent|towering|blinding)/giu;

/** Climax words in a reply (each distinct word once). */
export function climaxWords(text: string): number {
    const found = new Set<string>();
    for (const match of normalizeText(text).matchAll(CLIMAX_RE)) found.add(match[0]);
    return found.size;
}

export type PictureBudget = 'free' | 'paid' | 'unknown';

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a marker picture costs under NAI Studio's settings: 'free' when «free only» is on or paid marker pictures are
 * off (NAI Studio then never spends Anlas on them), 'paid' when they may spend, 'unknown' without readable settings.
 */
export function pictureBudget(naiSettings: unknown): PictureBudget {
    if (!isDict(naiSettings)) return 'unknown';
    const anlas = isDict(naiSettings.anlas) ? naiSettings.anlas : undefined;
    const markers = isDict(naiSettings.markers) ? naiSettings.markers : undefined;
    if (!anlas && !markers) return 'unknown';
    if (anlas?.freeOnly !== false) return 'free';
    return markers?.allowPaid === true ? 'paid' : 'free';
}

export interface PictureInput {
    cues: readonly PictureCue[];
    /** Climax words of the reply plus one when the scene just turned into combat or intimacy. */
    climax: number;
    mode: 'economy' | 'balanced' | 'cinema';
    budget: PictureBudget;
}

/**
 * A picture fits the next reply: never in «Экономный» (pictures on request only), key moments in «Сбалансированный»,
 * more generously in «Кино»; paid pictures need a stronger moment. First appearance and a place change weigh 2,
 * every climax word 1 (at most 3).
 */
export function pictureMoment(input: PictureInput): boolean {
    if (input.mode === 'economy') return false;
    let score = Math.min(3, Math.max(0, input.climax));
    if (input.cues.includes('firstAppearance')) score += 2;
    if (input.cues.includes('placeChange')) score += 2;
    const paid = input.budget === 'paid';
    const threshold = input.mode === 'cinema' ? (paid ? 2 : 1) : paid ? 3 : 2;
    return score >= threshold;
}
