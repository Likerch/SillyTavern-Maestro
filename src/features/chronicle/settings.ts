// M9 settings slice (extensionSettings.maestro.modules.chronicle).
import type { RecapSettings } from './api';

export const CHRONICLE_ID = 'M9';
export const CHRONICLE_KEY = 'chronicle';

export interface ChronicleSettings {
    /** п. 1–2: chapters from memories that fell out of Qvink's long-term memory; merging small neighbours. */
    chapters: boolean;
    /** Most characters of one chapter (and at most a quarter of the canon budget). */
    maxChapterChars: number;
    /** п. 3: Maestro sets Qvink's «remember» on important moments. */
    autoMemory: boolean;
    /** Own cheap detection (oath, revealed secret, new quest) on committed replies. */
    keywords: boolean;
    /** п. 4: «Ранее в истории…». */
    recap: RecapSettings;
}

export const RECAP_TARGETS: readonly RecapSettings['target'][] = ['user', 'userAndPrompt', 'off'];
export const RECAP_SOURCES: readonly RecapSettings['source'][] = ['memory', 'ai'];

export function defaultChronicleSettings(): ChronicleSettings {
    return {
        chapters: true,
        maxChapterChars: 1200,
        autoMemory: true,
        keywords: true,
        recap: { afterHours: 12, target: 'user', source: 'memory' },
    };
}

/** Repairs the live slice in place (hand-edited settings, older versions) and returns it. */
export function readChronicleSettings(slice: Partial<ChronicleSettings>): ChronicleSettings {
    const defaults = defaultChronicleSettings();
    for (const key of ['chapters', 'autoMemory', 'keywords'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    if (
        typeof slice.maxChapterChars !== 'number' ||
        !Number.isFinite(slice.maxChapterChars) ||
        slice.maxChapterChars < 100
    ) {
        slice.maxChapterChars = defaults.maxChapterChars;
    }
    const recap = (
        typeof slice.recap === 'object' && slice.recap !== null ? slice.recap : {}
    ) as Partial<RecapSettings>;
    if (typeof recap.afterHours !== 'number' || !Number.isFinite(recap.afterHours) || recap.afterHours <= 0) {
        recap.afterHours = defaults.recap.afterHours;
    }
    if (!RECAP_TARGETS.includes(recap.target as RecapSettings['target'])) recap.target = defaults.recap.target;
    if (!RECAP_SOURCES.includes(recap.source as RecapSettings['source'])) recap.source = defaults.recap.source;
    slice.recap = recap as RecapSettings;
    return slice as ChronicleSettings;
}
