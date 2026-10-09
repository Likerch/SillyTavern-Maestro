// The director's chat document 'director' (plan §2.1: Maestro data per chat lives in Maestro files): the scene memory
// with its hysteresis, the user's override, the flags' inputs of the last committed turn, the pacing window, the
// characters already seen (first appearance → picture moment) and the recent director's notes. Small by design.
import { SCENE_KINDS } from '../../domain/director-scene';
import type { SceneDecision, SceneKind, SceneMemory } from '../../domain/director-scene';
import type { PictureCue } from '../../domain/director-flags';
import type { TurnRecord } from '../../domain/director-pacing';
import type { DirectorNote } from './api';

export const DIRECTOR_DOC = 'director';
/** Committed turns kept for the pacing window. */
export const TURNS_KEPT = 12;
export const NOTES_KEPT = 10;
export const SEEN_KEPT = 400;

export interface DirectorDoc {
    memory: SceneMemory;
    override: SceneKind | null;
    /** Committed turns since the override was set. */
    overrideHeld: number;
    /** Explicit-scene words of the last committed reply. */
    explicitHits: number;
    language: 'ru' | 'en' | null;
    /** A picture fits the next reply (decided after the last committed turn). */
    picture: { messageIndex: number; cues: PictureCue[] } | null;
    turns: TurnRecord[];
    /** Normalised names of characters seen in this chat. */
    seen: string[];
    /** Place key of the last committed turn. */
    lastPlace: string | null;
    notes: DirectorNote[];
    /** Committed turns since the last written note (large at the start: the first stall may get a note). */
    turnsSinceNote: number;
    /** Index of the last committed reply the director read (-1: none). */
    lastCommitted: number;
}

export function emptyDirectorDoc(): DirectorDoc {
    return {
        memory: { current: null, candidate: null },
        override: null,
        overrideHeld: 0,
        explicitHits: 0,
        language: null,
        picture: null,
        turns: [],
        seen: [],
        lastPlace: null,
        notes: [],
        turnsSinceNote: 1000,
        lastCommitted: -1,
    };
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSceneKind(value: unknown): value is SceneKind {
    return typeof value === 'string' && (SCENE_KINDS as readonly string[]).includes(value);
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function decisionOf(value: unknown): SceneDecision | null {
    if (!isDict(value) || !isSceneKind(value.type)) return null;
    const decision: SceneDecision = {
        type: value.type,
        confidence: Math.min(1, Math.max(0, num(value.confidence, 0.5))),
        messageIndex: num(value.messageIndex, -1),
        by: value.by === 'model' ? 'model' : 'rules',
        held: Math.max(1, Math.floor(num(value.held, 1))),
    };
    if (value.fromUserMessage === true) decision.fromUserMessage = true;
    return decision;
}

function memoryOf(value: unknown): SceneMemory {
    if (!isDict(value)) return { current: null, candidate: null };
    const candidate = isDict(value.candidate) && isSceneKind(value.candidate.type) ? value.candidate : null;
    return {
        current: decisionOf(value.current),
        candidate: candidate
            ? {
                  type: candidate.type as SceneKind,
                  confidence: Math.min(1, Math.max(0, num(candidate.confidence, 0.5))),
                  messageIndex: num(candidate.messageIndex, -1),
              }
            : null,
    };
}

function turnOf(value: unknown): TurnRecord | null {
    if (!isDict(value) || typeof value.index !== 'number') return null;
    return {
        index: value.index,
        place: typeof value.place === 'string' ? value.place : null,
        events: Math.max(0, Math.floor(num(value.events, 0))),
        known: value.known === true,
        repetition: value.repetition === true,
        topic: strings(value.topic).slice(0, 20),
    };
}

const NOTE_SOURCES = ['quest', 'thread', 'deadline', 'offscreen', 'mechanic', 'agenda'] as const;
const REASONS = ['samePlace', 'noEvents', 'repetition', 'loop'] as const;

function noteOf(value: unknown): DirectorNote | null {
    if (!isDict(value) || typeof value.text !== 'string') return null;
    const source = NOTE_SOURCES.find((item) => item === value.source);
    if (!source) return null;
    const note: DirectorNote = {
        at: num(value.at, 0),
        messageIndex: num(value.messageIndex, -1),
        text: value.text,
        source,
    };
    if (typeof value.detail === 'string') note.detail = value.detail;
    const reasons = strings(value.reasons).filter((item): item is (typeof REASONS)[number] =>
        (REASONS as readonly string[]).includes(item),
    );
    if (Array.isArray(value.reasons)) note.reasons = reasons;
    if (value.nudged === true) note.nudged = true;
    return note;
}

const CUES: readonly PictureCue[] = ['firstAppearance', 'placeChange', 'climax'];

/** Repairs a stored document in place (unknown fields are dropped from the typed parts only). */
export function readDirectorDoc(raw: Dict): DirectorDoc {
    const doc = raw as unknown as DirectorDoc;
    doc.memory = memoryOf(raw.memory);
    doc.override = isSceneKind(raw.override) ? raw.override : null;
    doc.overrideHeld = Math.max(0, Math.floor(num(raw.overrideHeld, 0)));
    doc.explicitHits = Math.max(0, Math.floor(num(raw.explicitHits, 0)));
    doc.language = raw.language === 'ru' || raw.language === 'en' ? raw.language : null;
    const picture = isDict(raw.picture) ? raw.picture : null;
    doc.picture = picture
        ? {
              messageIndex: num(picture.messageIndex, -1),
              cues: strings(picture.cues).filter((cue): cue is PictureCue => (CUES as readonly string[]).includes(cue)),
          }
        : null;
    doc.turns = (Array.isArray(raw.turns) ? raw.turns : [])
        .map(turnOf)
        .filter((turn): turn is TurnRecord => turn !== null)
        .slice(-TURNS_KEPT);
    doc.seen = strings(raw.seen).slice(-SEEN_KEPT);
    doc.lastPlace = typeof raw.lastPlace === 'string' ? raw.lastPlace : null;
    doc.notes = (Array.isArray(raw.notes) ? raw.notes : [])
        .map(noteOf)
        .filter((note): note is DirectorNote => note !== null)
        .slice(-NOTES_KEPT);
    doc.turnsSinceNote = Math.max(0, Math.floor(num(raw.turnsSinceNote, 1000)));
    doc.lastCommitted = Math.floor(num(raw.lastCommitted, -1));
    return doc;
}
