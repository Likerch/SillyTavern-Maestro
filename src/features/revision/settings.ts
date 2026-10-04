// Settings slice of M8 «Ревизия» (extensionSettings.maestro.modules.revision) and the module's constants.

export interface RevisionSettings {
    /** Pending signals that start a revision (plan M8: 3). */
    signalThreshold: number;
    /** Committed messages since the last revision that start one (plan M8: 10); 0 = off. */
    everyMessages: number;
    /** A finished scene (location change, time skip) starts a revision. */
    sceneEnd: boolean;
    /** Changes the model is less sure about are not proposed (0..1). */
    minConfidence: number;
}

export const REVISION_KEY = 'revision';
export const REVISION_ID = 'M8';
/** Background task kind (app.tasks) and its dedupe key. */
export const REVISION_TASK = 'revision.run';
export const REVISION_DEDUPE = 'revision';
/** LLM task (picks the connection profile, labels the cost). */
export const REVISION_LLM_TASK = 'revision';
/** Per-chat document (runs, deferred cards, the last revised message). */
export const REVISION_DOC = 'revision';
export const REVISION_TAB = 'revision';

export function defaultRevisionSettings(): RevisionSettings {
    return { signalThreshold: 3, everyMessages: 10, sceneEnd: true, minConfidence: 0.5 };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}

/** Repairs a stored slice in place (hand-edited or older settings) and returns it. */
export function readRevisionSettings(slice: Partial<RevisionSettings>): RevisionSettings {
    const defaults = defaultRevisionSettings();
    slice.signalThreshold = clampInt(slice.signalThreshold, 1, 50, defaults.signalThreshold);
    slice.everyMessages = clampInt(slice.everyMessages, 0, 500, defaults.everyMessages);
    slice.sceneEnd = typeof slice.sceneEnd === 'boolean' ? slice.sceneEnd : defaults.sceneEnd;
    const confidence = slice.minConfidence;
    slice.minConfidence =
        typeof confidence === 'number' && Number.isFinite(confidence)
            ? Math.min(1, Math.max(0, confidence))
            : defaults.minConfidence;
    return slice as RevisionSettings;
}
