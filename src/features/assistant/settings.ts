// Settings slice of the assistant (M33). The connection profile is not here: it is CoreSettings.profiles.assistant
// like every task kind (empty = the background profile, `profiles.default`). The assistant never sees or changes
// this slice itself (safety.ts excludes it), so it cannot lift its own limits.

export const ASSISTANT_KEY = 'assistant';
/** Task kind of the assistant's requests: picks the profile (CoreSettings.profiles) and labels the cost. */
export const ASSISTANT_TASK = 'assistant';

export interface AssistantSettings {
    /** Longest answer per model request, tokens. */
    maxTokens: number;
    /** Budget of the conversation history sent with every request, tokens. */
    historyTokens: number;
    /** Applied changes per hour and chat. */
    writesPerHour: number;
    /** Longest tool result the model receives, characters. */
    resultChars: number;
}

export function defaultAssistantSettings(): AssistantSettings {
    return { maxTokens: 2000, historyTokens: 6000, writesPerHour: 20, resultChars: 12000 };
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
