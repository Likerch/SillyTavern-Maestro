// Settings slice of the assistant (M33). The connection profile is not here: it is CoreSettings.profiles.assistant
// like every task kind (empty = the background profile, `profiles.default`). The assistant never sees or changes
// this slice itself (safety.ts excludes it), so it cannot lift its own limits.

export const ASSISTANT_KEY = 'assistant';
/** Task kind of the assistant's requests: picks the profile (CoreSettings.profiles) and labels the cost. */
export const ASSISTANT_TASK = 'assistant';
/** The assistant's pult tab and the window that shows it (plan-2 §10; the pult tab when there are no windows). */
export const ASSISTANT_TAB = 'assistant';
export const ASSISTANT_WINDOW = 'assistant';
/**
 * Answer length while the conversation works on a preset (a block attached, or preset tools in use): a block text or a
 * pack of edits travels in the tool call's arguments, and a cut call is lost. The setting wins when it is higher.
 */
export const PRESET_MAX_TOKENS = 4000;

export interface AssistantSettings {
    /** Longest answer per model request, tokens. */
    maxTokens: number;
    /** Budget of the conversation history sent with every request, tokens. */
    historyTokens: number;
    /** Applied changes per hour and chat (every applied change of a pack counts). */
    writesPerHour: number;
    /** Longest tool result the model receives, characters. */
    resultChars: number;
}

export function defaultAssistantSettings(): AssistantSettings {
    // 40 changes an hour: preset work comes in packs of several edits, each applied edit counts.
    return { maxTokens: 2000, historyTokens: 6000, writesPerHour: 40, resultChars: 12000 };
}

export const ASSISTANT_LIMITS: Readonly<Record<keyof AssistantSettings, readonly [number, number]>> = {
    maxTokens: [256, 16000],
    historyTokens: [1000, 64000],
    writesPerHour: [1, 200],
    resultChars: [1000, 60000],
};

/** The stored slice with every value clamped (hand-edited or imported settings cannot break the loop). */
export function readAssistantSettings(raw: Partial<AssistantSettings> | undefined): AssistantSettings {
    const defaults = defaultAssistantSettings();
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof AssistantSettings)[]) {
        const value = raw?.[key];
        const [min, max] = ASSISTANT_LIMITS[key];
        out[key] =
            typeof value === 'number' && Number.isFinite(value)
                ? Math.min(max, Math.max(min, Math.round(value)))
                : defaults[key];
    }
    return out;
}
