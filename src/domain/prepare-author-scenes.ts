// «Подготовить к игре» (M37), starting scenes the card's author set down (Officina, release 1.24): a card may carry
// `data.extensions.officina.scenes` — one item per greeting, aligned with `[first_mes, ...alternate_greetings]`, each
// `{ place?, time?, present?, mood?, hook? }` or null (docs/integration-officina.md). They are the author's word, not a
// guess: the analysis gets them as authoritative hints for the greetings of its part, and the plan's scene of such a
// greeting takes their place, time and cast (and is made from them when the analysis gave none). Pure.
import { mergeItems } from './prepare-merge';
import { sceneId } from './prepare-plan';
import type { AnyPrepareItem, PrepareItem, SceneData } from './prepare-plan';
import { greetingSourceId } from './prepare-sources';

type Dict = Record<string, unknown>;

/** One author scene, cleaned: its greeting (0 the first message, n alternate greeting n) and the given parts. */
export interface AuthorScene {
    greeting: number;
    place: string;
    time: string;
    present: string[];
    mood: string;
    hook: string;
}

const NAME_MAX = 120;
const TEXT_MAX = 400;
const PRESENT_MAX = 16;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function names(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const name = clean(item, NAME_MAX);
        if (name && !out.some((other) => other.toLowerCase() === name.toLowerCase())) out.push(name);
        if (out.length >= PRESENT_MAX) break;
    }
    return out;
}

/**
 * The author scenes of a card (ST's character object or its `data`): one per greeting that has one, in greeting
 * order; items past the last greeting (`greetings` = 1 + alternate greetings) and empty ones are left out.
 */
export function readAuthorScenes(character: unknown, greetings: number): AuthorScene[] {
    const data = isDict(character) && isDict(character.data) ? character.data : character;
    const extensions = isDict(data) && isDict(data.extensions) ? data.extensions : null;
    const officina = extensions && isDict(extensions.officina) ? extensions.officina : null;
    const list = officina && Array.isArray(officina.scenes) ? officina.scenes : [];
    const out: AuthorScene[] = [];
    list.slice(0, Math.max(0, Math.floor(greetings))).forEach((raw, greeting) => {
        if (!isDict(raw)) return;
        const scene: AuthorScene = {
            greeting,
            place: clean(raw.place, NAME_MAX),
            time: clean(raw.time, NAME_MAX),
            present: names(raw.present),
            mood: clean(raw.mood, TEXT_MAX),
            hook: clean(raw.hook, TEXT_MAX),
        };
        if (scene.place || scene.time || scene.present.length || scene.mood || scene.hook) out.push(scene);
    });
    return out;
}

/** The scenes of these greetings (a part of the analysis sends some of the greetings only). */
export function scenesOf(scenes: readonly AuthorScene[], greetings: Iterable<number>): AuthorScene[] {
    const wanted = new Set(greetings);
    return scenes.filter((scene) => wanted.has(scene.greeting));
}

/** One line per scene for the request: `greeting N — place: …; time: …; present: …; mood: …; hook: …`. */
export function authorScenesText(scenes: readonly AuthorScene[]): string {
    return scenes
        .map((scene) => {
            const parts = [
                scene.place ? `place: ${scene.place}` : '',
                scene.time ? `time: ${scene.time}` : '',
                scene.present.length ? `present: ${scene.present.join(', ')}` : '',
                scene.mood ? `mood: ${scene.mood}` : '',
                scene.hook ? `hook: ${scene.hook}` : '',
            ].filter(Boolean);
            return `greeting ${scene.greeting} — ${parts.join('; ')}`;
        })
        .join('\n');
}

/** What the author said is going on: the hook, then the mood. */
function situationOf(scene: AuthorScene): string {
    return [scene.hook, scene.mood ? `Mood: ${scene.mood}` : ''].filter(Boolean).join(' ');
}

/**
 * The plan's items with the author scenes in force: a scene item of such a greeting takes the given place, time and
 * cast (its situation, outfits and the type of the first scene stay as the analysis read them; an empty situation
 * gets the hook and the mood); a greeting the analysis gave no scene gets one made from the author's scene.
 */
export function withAuthorScenes(items: readonly AnyPrepareItem[], scenes: readonly AuthorScene[]): AnyPrepareItem[] {
    if (!scenes.length) return [...items];
    const out = [...items];
    for (const scene of scenes) {
        const id = sceneId(scene.greeting);
        const index = out.findIndex((item) => item.kind === 'scene' && item.id === id);
        const found = index >= 0 ? (out[index] as PrepareItem<'scene'>) : null;
        if (found) {
            const data: SceneData = { ...found.data, greeting: scene.greeting };
            if (scene.place) data.place = scene.place;
            if (scene.time) data.time = scene.time;
            if (scene.present.length) data.present = [...scene.present];
            if (!data.situation.trim()) data.situation = situationOf(scene);
            out[index] = {
                ...found,
                data,
                russian: found.russian || scene.hook || scene.mood || scene.place,
            };
            continue;
        }
        out.push({
            id,
            kind: 'scene',
            data: {
                greeting: scene.greeting,
                place: scene.place,
                date: '',
                time: scene.time,
                present: [...scene.present],
                situation: situationOf(scene),
                outfits: [],
                firstScene: '',
            },
            russian: scene.hook || scene.mood || scene.place,
            sources: [greetingSourceId(scene.greeting)],
            scope: 'chat',
        });
    }
    // Sorted as the plan is (sections, then scenes by greeting).
    return mergeItems([out]);
}
