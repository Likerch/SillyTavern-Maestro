// The assistant's cost explainer (M33, stage 13: «почему этот ход дорогой?»), pure: from the treasurer's spend lines
// of a turn (by source: main, regenerations, auto-swipes, Qvink, Maestro tasks, NAI), the inspector's prompt weights
// by source kind and the average of recent turns, a short list of reasons — retries, a low provider-cache share, a
// big prompt, lore- or history-heavy prompts, background work, pictures, a long reply, estimates.

export interface CostLineLike {
    source: string;
    usd: number;
    requests: number;
    tokens: { prompt: number; completion: number; cached?: number };
    estimated?: boolean;
    anlas?: number;
}

export interface CostTurnInput {
    lines: readonly CostLineLike[];
    /** Prompt tokens by source kind of the turn (inspector: preset, card, lore, extension, history). */
    promptByKind?: Readonly<Record<string, number>>;
    /** Average total USD of the recent turns (for «above average»). */
    averageUsd?: number;
}

export type CostHintCode =
    | 'retries'
    | 'autoSwipe'
    | 'lowCache'
    | 'bigPrompt'
    | 'loreHeavy'
    | 'historyHeavy'
    | 'background'
    | 'images'
    | 'longReply'
    | 'aboveAverage'
    | 'estimated';

export interface CostHint {
    code: CostHintCode;
    detail: string;
}

export interface CostTotals {
    usd: number;
    anlas: number;
    requests: number;
    prompt: number;
    completion: number;
    cached: number;
    /** cached / prompt of the main generation(s), null without prompt tokens. */
    cacheShare: number | null;
}

/** Thresholds of the hints (exported for tests and tuning). */
export const COST_THRESHOLDS = {
    /** Prompt tokens from which a low cache share matters. */
    cacheMinPrompt: 8000,
    lowCacheShare: 0.3,
    bigPrompt: 60000,
    loreShare: 0.35,
    historyShare: 0.6,
    /** Background (Qvink + Maestro) spend relative to the main generation. */
    backgroundShare: 0.5,
    longReply: 1500,
    aboveAverage: 1.5,
} as const;

const MAIN_SOURCES = new Set(['main', 'regeneration', 'autoSwipe']);

function round(value: number, digits = 4): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/** Sums of a turn's lines; the cache share counts the main generation and its retries only. */
export function costTotals(lines: readonly CostLineLike[]): CostTotals {
    let usd = 0;
    let anlas = 0;
    let requests = 0;
    let prompt = 0;
    let completion = 0;
    let cached = 0;
    let mainPrompt = 0;
    let mainCached = 0;
    for (const line of lines) {
        usd += line.usd;
        anlas += line.anlas ?? 0;
        requests += line.requests;
        prompt += line.tokens.prompt;
        completion += line.tokens.completion;
        cached += line.tokens.cached ?? 0;
        if (MAIN_SOURCES.has(line.source)) {
            mainPrompt += line.tokens.prompt;
            mainCached += line.tokens.cached ?? 0;
        }
    }
    return {
        usd: round(usd),
        anlas,
        requests,
        prompt,
        completion,
        cached,
        cacheShare: mainPrompt > 0 ? round(mainCached / mainPrompt, 3) : null,
    };
}

function percent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

/** Reasons a turn cost what it did, most expensive first in spirit (retries, cache, size, background). */
export function costHints(input: CostTurnInput): CostHint[] {
    const hints: CostHint[] = [];
    const bySource = new Map<string, CostLineLike>();
    for (const line of input.lines) bySource.set(line.source, line);
    const regeneration = bySource.get('regeneration');
    if (regeneration && (regeneration.usd > 0 || regeneration.requests > 0)) {
        hints.push({ code: 'retries', detail: `${regeneration.requests} × $${round(regeneration.usd)}` });
    }
    const autoSwipe = bySource.get('autoSwipe');
    if (autoSwipe && (autoSwipe.usd > 0 || autoSwipe.requests > 0)) {
        hints.push({ code: 'autoSwipe', detail: `${autoSwipe.requests} × $${round(autoSwipe.usd)}` });
    }
    const main = bySource.get('main');
    const mainPrompt = main?.tokens.prompt ?? 0;
    if (main && mainPrompt >= COST_THRESHOLDS.cacheMinPrompt) {
        const share = (main.tokens.cached ?? 0) / mainPrompt;
        if (share < COST_THRESHOLDS.lowCacheShare) hints.push({ code: 'lowCache', detail: percent(share) });
    }
    if (mainPrompt >= COST_THRESHOLDS.bigPrompt) hints.push({ code: 'bigPrompt', detail: `${mainPrompt}` });
    const kinds = input.promptByKind ?? {};
    const promptTotal = Object.values(kinds).reduce((sum, value) => sum + value, 0);
    if (promptTotal > 0) {
        const lore = (kinds.lore ?? 0) / promptTotal;
        if (lore >= COST_THRESHOLDS.loreShare) hints.push({ code: 'loreHeavy', detail: percent(lore) });
        const history = (kinds.history ?? 0) / promptTotal;
        if (history >= COST_THRESHOLDS.historyShare) hints.push({ code: 'historyHeavy', detail: percent(history) });
    }
    const background = (bySource.get('qvink')?.usd ?? 0) + (bySource.get('maestro')?.usd ?? 0);
    const mainUsd = main?.usd ?? 0;
    if (background > 0 && background >= mainUsd * COST_THRESHOLDS.backgroundShare) {
        hints.push({ code: 'background', detail: `$${round(background)}` });
    }
    const nai = bySource.get('nai');
    if (nai && ((nai.anlas ?? 0) > 0 || nai.usd > 0)) {
        hints.push({ code: 'images', detail: nai.anlas ? `${nai.anlas} Anlas` : `$${round(nai.usd)}` });
    }
    if (main && main.tokens.completion >= COST_THRESHOLDS.longReply) {
        hints.push({ code: 'longReply', detail: `${main.tokens.completion}` });
    }
    const total = costTotals(input.lines).usd;
    if (input.averageUsd && input.averageUsd > 0 && total >= input.averageUsd * COST_THRESHOLDS.aboveAverage) {
        hints.push({ code: 'aboveAverage', detail: `×${round(total / input.averageUsd, 1)}` });
    }
    if (input.lines.some((line) => line.estimated)) hints.push({ code: 'estimated', detail: '' });
    return hints;
}

export const COST_HINT_TEXT: Record<'en' | 'ru', Record<CostHintCode, string>> = {
    en: {
        retries: 'Regenerations or swipes of this turn were paid too.',
        autoSwipe: 'Maestro swiped automatically (reply quality) — that generation was paid as well.',
        lowCache: 'Little of the prompt came from the provider cache: something early in the prompt changed.',
        bigPrompt: 'The prompt itself is very large.',
        loreHeavy: 'Lore takes a large share of the prompt.',
        historyHeavy: 'Chat history takes most of the prompt.',
        background: 'Background work (Qvink summaries, Maestro tasks) cost a lot next to the main reply.',
        images: 'NAI pictures were generated for this turn.',
        longReply: 'The reply was long (completion tokens are the expensive ones).',
        aboveAverage: 'Above the average of the recent turns.',
        estimated: 'Some costs are estimates from token counts (the provider sent no price).',
    },
    ru: {
        retries: 'Оплачены и перегенерации или свайпы этого хода.',
        autoSwipe: 'Maestro сам сделал свайп (качество ответа) — эта генерация тоже оплачена.',
        lowCache: 'Из кэша провайдера пришла малая часть промпта: что-то в начале промпта изменилось.',
        bigPrompt: 'Сам промпт очень большой.',
        loreHeavy: 'Лор занимает большую долю промпта.',
        historyHeavy: 'Большую часть промпта занимает история чата.',
        background: 'Фоновая работа (пересказы Qvink, задачи Maestro) стоила много рядом с основным ответом.',
        images: 'Для этого хода рисовались картинки NAI.',
        longReply: 'Ответ длинный (токены ответа — самые дорогие).',
        aboveAverage: 'Дороже среднего за последние ходы.',
        estimated: 'Часть стоимости — оценка по токенам (провайдер не прислал цену).',
    },
};
