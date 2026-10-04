// Settings slice of M18 «Кто что знает» (`extensionSettings.maestro.modules.knowledge`) and the module's constants.
import { DEFAULT_MAX_FACTS, MAX_MAX_FACTS, MIN_MAX_FACTS } from '../../domain/knowledge-facts';

export const KNOWLEDGE_KEY = 'knowledge';
export const KNOWLEDGE_ID = 'M18';
/** Per-chat document (the facts). */
export const KNOWLEDGE_DOC = 'knowledge';
export const KNOWLEDGE_TAB = 'knowledge';
/** Journal targets (undo handlers). */
export const KNOWN_TARGET = 'knowledge.known';
export const SECRET_TARGET = 'knowledge.secret';

export interface KnowledgeSettings {
    /** Facts kept per chat (the oldest scene facts go first, secrets last). */
    maxFacts: number;
    /** Also read the reply's sentences with key event words (a kiss, a death, a theft…) that name someone. */
    replyEvents: boolean;
}

export function defaultKnowledgeSettings(): KnowledgeSettings {
    return { maxFacts: DEFAULT_MAX_FACTS, replyEvents: true };
}

export function cleanMaxFacts(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_FACTS;
    return Math.max(MIN_MAX_FACTS, Math.min(MAX_MAX_FACTS, Math.round(value)));
}

/** The stored slice, repaired in place (a hand-edited settings file never breaks the module). */
export function readKnowledgeSettings(slice: Partial<KnowledgeSettings>): KnowledgeSettings {
    const raw = slice as Record<string, unknown>;
    if (raw.maxFacts !== cleanMaxFacts(raw.maxFacts)) raw.maxFacts = cleanMaxFacts(raw.maxFacts);
    if (typeof raw.replyEvents !== 'boolean') raw.replyEvents = defaultKnowledgeSettings().replyEvents;
    return slice as KnowledgeSettings;
}
