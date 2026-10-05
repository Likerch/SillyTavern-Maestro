// The assistant's lore explainer (M33, stage 13: «почему героиня не узнала сестру?»), pure: why a lorebook entry did
// or did not reach the prompt of a turn. ST never says why an entry stayed silent, so the reasons are reconstructed
// from the entry's fields (disabled, filters, probability, timed effects, groups, triggers, recursion-only) and from
// key matching over the turn's scan window with ST's rules (domain/lore-match.ts): no key in the last N messages, the
// key was said earlier than the scan depth, a Russian case form the key does not cover («Анна» vs «Анну»), the
// secondary keys' logic failed. An activation that the budget or a rule removed is reported as cut.
import { WI_LOGIC, findTriggerKey, matchKey, parseRegexKey } from './lore-match';
import type { GlobalMatchSettings, KeyedEntry } from './lore-match';

export type LoreReasonCode =
    | 'fired'
    | 'cut'
    | 'disabled'
    | 'constant'
    | 'noKeys'
    | 'keyMatched'
    | 'noKeyInScan'
    | 'beyondDepth'
    | 'otherCaseForm'
    | 'secondaryFailed'
    | 'probability'
    | 'characterFilter'
    | 'delay'
    | 'cooldown'
    | 'sticky'
    | 'group'
    | 'recursionOnly'
    | 'triggers'
    | 'vectorized';

export interface LoreReason {
    code: LoreReasonCode;
    /** Data for the reason (keys, numbers), as stored in the entry: untrusted text. */
    detail?: string;
}

export interface LoreEntryLike extends KeyedEntry {
    disable?: unknown;
    constant?: unknown;
    useProbability?: unknown;
    probability?: unknown;
    characterFilter?: unknown;
    delay?: unknown;
    cooldown?: unknown;
    sticky?: unknown;
    group?: unknown;
    scanDepth?: unknown;
    delayUntilRecursion?: unknown;
    triggers?: unknown;
    vectorized?: unknown;
}

export interface LoreExplainInput {
    /** Chat message texts, oldest first (system messages left out). */
    messages: readonly string[];
    /** Global scan depth in messages (`world_info_depth`). */
    depth: number;
    globals: GlobalMatchSettings;
    /** The entry's activation in the turn, when it activated. */
    activation?: { cut?: boolean; cutBy?: string } | null;
}

export interface LoreExplanation {
    fired: boolean;
    reasons: LoreReason[];
    /** The key that matches in the scan window (`primary` or `primary + secondary`). */
    matchedKey?: string;
}

function list(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function shortList(items: readonly string[], max = 5): string {
    const shown = items.slice(0, max).join(', ');
    return items.length > max ? `${shown}, …` : shown;
}

/** Whether the secondary keys of a selective entry pass on this text (ST's four logics). */
export function secondaryPasses(entry: KeyedEntry, text: string, globals: GlobalMatchSettings): boolean {
    const secondary = list(entry.keysecondary);
    if (!entry.selective || !secondary.length) return true;
    const caseSensitive = typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : globals.caseSensitive;
    const matchWholeWords =
        typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : globals.matchWholeWords;
    const options = { caseSensitive, matchWholeWords };
    const hits = secondary.filter((key) => matchKey(text, key.trim(), options)).length;
    const logic = typeof entry.selectiveLogic === 'number' ? entry.selectiveLogic : WI_LOGIC.AND_ANY;
    switch (logic) {
        case WI_LOGIC.AND_ALL:
            return hits === secondary.length;
        case WI_LOGIC.NOT_ALL:
            return hits < secondary.length;
        case WI_LOGIC.NOT_ANY:
            return hits === 0;
        default:
            return hits > 0;
    }
}

const LOGIC_NAMES: Record<number, string> = {
    [WI_LOGIC.AND_ANY]: 'AND ANY',
    [WI_LOGIC.NOT_ALL]: 'NOT ALL',
    [WI_LOGIC.NOT_ANY]: 'NOT ANY',
    [WI_LOGIC.AND_ALL]: 'AND ALL',
};

/** Russian stem of a one-word key («Анна» → «анн»), null for regex, Latin, multi-word or short keys. */
export function russianStem(key: string): string | null {
    if (parseRegexKey(key)) return null;
    const word = key.trim().toLowerCase().replace(/ё/g, 'е');
    if (!/^[а-я-]+$/.test(word) || word.length < 4) return null;
    const stripped = word.replace(/(?:ой|ей|ий|ый|ая|яя|ое|ее|ом|ем|ам|ям|ах|ях|ью|[аяоеыиуюьй])$/, '');
    return stripped.length >= 3 ? stripped : null;
}

/** A word of the text that shares the key's Russian stem but is not the key itself («Анну» for «Анна»). */
export function otherCaseForm(key: string, text: string): string | null {
    const stemmed = russianStem(key);
    if (!stemmed) return null;
    const lowerKey = key.trim().toLowerCase().replace(/ё/g, 'е');
    const words =
        text
            .toLowerCase()
            .replace(/ё/g, 'е')
            .match(/[а-я]+/g) ?? [];
    for (const word of words) {
        if (word !== lowerKey && word.startsWith(stemmed) && word.length - stemmed.length <= 3) return word;
    }
    return null;
}

/** The scan window: the last `depth` messages (ST scans newest first; order does not matter for matching). */
export function scanWindow(messages: readonly string[], depth: number): { window: string; older: string[] } {
    const size = Math.max(0, Math.floor(depth));
    const cutAt = Math.max(0, messages.length - size);
    return { window: messages.slice(cutAt).join('\n'), older: messages.slice(0, cutAt) };
}

/** Why one entry did or did not reach the prompt of the turn. */
export function explainLoreEntry(entry: LoreEntryLike, input: LoreExplainInput): LoreExplanation {
    const reasons: LoreReason[] = [];
    const depth = num(entry.scanDepth) ?? input.depth;
    const { window, older } = scanWindow(input.messages, depth);
    const keys = list(entry.key);
    const matchedKey = keys.length ? findTriggerKey(entry, window, input.globals) : null;
    const result = (fired: boolean): LoreExplanation => {
        const explanation: LoreExplanation = { fired, reasons };
        if (matchedKey) explanation.matchedKey = matchedKey;
        return explanation;
    };

    if (input.activation) {
        if (input.activation.cut) {
            const detail = input.activation.cutBy ?? 'other';
            reasons.push({ code: 'cut', detail });
        } else {
            reasons.push(matchedKey ? { code: 'fired', detail: matchedKey } : { code: 'fired' });
        }
        return result(true);
    }

    if (entry.disable === true) reasons.push({ code: 'disabled' });
    const triggers = list(entry.triggers);
    if (triggers.length) reasons.push({ code: 'triggers', detail: triggers.join(', ') });
    const filter = entry.characterFilter;
    if (filter && typeof filter === 'object') {
        const names = list((filter as { names?: unknown }).names);
        const tags = list((filter as { tags?: unknown }).tags);
        if (names.length || tags.length) {
            const exclude = (filter as { isExclude?: unknown }).isExclude === true;
            reasons.push({
                code: 'characterFilter',
                detail: `${exclude ? 'except' : 'only'}: ${shortList([...names, ...tags])}`,
            });
        }
    }
    const probability = num(entry.probability);
    if (entry.useProbability !== false && probability !== null && probability < 100) {
        reasons.push({ code: 'probability', detail: `${probability}%` });
    }
    const delay = num(entry.delay);
    if (delay && delay > 0 && input.messages.length < delay) {
        reasons.push({ code: 'delay', detail: `${delay}` });
    }
    const cooldown = num(entry.cooldown);
    if (cooldown && cooldown > 0) reasons.push({ code: 'cooldown', detail: `${cooldown}` });
    const sticky = num(entry.sticky);
    if (sticky && sticky > 0) reasons.push({ code: 'sticky', detail: `${sticky}` });
    if (typeof entry.group === 'string' && entry.group.trim()) {
        reasons.push({ code: 'group', detail: entry.group.trim() });
    }
    if (entry.delayUntilRecursion === true || (num(entry.delayUntilRecursion) ?? 0) > 0) {
        reasons.push({ code: 'recursionOnly' });
    }
    if (entry.vectorized === true) reasons.push({ code: 'vectorized' });
    if (entry.constant === true) {
        reasons.push({ code: 'constant' });
        return result(false);
    }

    if (!keys.length) {
        reasons.push({ code: 'noKeys' });
        return result(false);
    }
    if (matchedKey) {
        if (secondaryPasses(entry, window, input.globals)) {
            reasons.push({ code: 'keyMatched', detail: matchedKey });
        } else {
            const logic = typeof entry.selectiveLogic === 'number' ? entry.selectiveLogic : WI_LOGIC.AND_ANY;
            reasons.push({
                code: 'secondaryFailed',
                detail: `${LOGIC_NAMES[logic] ?? logic}: ${shortList(list(entry.keysecondary))}`,
            });
        }
        return result(false);
    }
    // No primary key in the window: said too early, or said in another case form, or not at all.
    for (let back = older.length - 1; back >= 0; back--) {
        const text = older[back] ?? '';
        const key = findTriggerKey(entry, text, input.globals);
        if (key) {
            const ago = input.messages.length - back;
            reasons.push({ code: 'beyondDepth', detail: `${key} · ${ago} > ${depth}` });
            return result(false);
        }
    }
    for (const key of keys) {
        const form = otherCaseForm(key, window);
        if (form) {
            reasons.push({ code: 'otherCaseForm', detail: `${key} ≠ ${form}` });
            return result(false);
        }
    }
    reasons.push({ code: 'noKeyInScan', detail: shortList(keys) });
    return result(false);
}

/** Short texts of the reasons (the model gets the code, the detail and this line). */
export const LORE_REASON_TEXT: Record<'en' | 'ru', Record<LoreReasonCode, string>> = {
    en: {
        fired: 'Reached the prompt.',
        cut: 'Activated but was cut (by the lore budget, a Maestro rule or another extension).',
        disabled: 'The entry is switched off.',
        constant: 'Constant: it should always fire, so a filter, the probability or the budget stopped it.',
        noKeys: 'The entry has no primary keys (only constant, vector or recursion activation can bring it in).',
        keyMatched:
            'A key is in the scan window, yet the entry is not in the turn: probability, an inclusion group, a timed effect or a filter stopped it, or the scan ran on older text.',
        noKeyInScan: 'None of its keys appear in the last messages ST scans.',
        beyondDepth: 'Its key was said, but earlier than the scan depth (messages back > depth).',
        otherCaseForm:
            'The key covers one Russian form only; the text uses another case form. Add case forms (DES-RU / Lorebook Localizer keys) or a regex key.',
        secondaryFailed: 'A primary key matched, but the secondary keys did not satisfy the entry logic.',
        probability: 'It fires only with this probability.',
        characterFilter: 'A character filter limits it to (or excludes) certain characters or tags.',
        delay: 'Delay: it may fire only after this many messages in the chat.',
        cooldown: 'Cooldown: after firing it rests this many messages.',
        sticky: 'Sticky: it stays this many messages after firing (dry runs cannot see it).',
        group: 'In an inclusion group: only one entry of the group fires per scan.',
        recursionOnly: 'Delayed until recursion: only other entries can activate it, not the chat.',
        triggers: 'Fires only for these generation types.',
        vectorized: 'Vectorized: activated by vector search, not by keys.',
    },
    ru: {
        fired: 'Ушла в промпт.',
        cut: 'Сработала, но её срезали (бюджет лора, правило Maestro или другое расширение).',
        disabled: 'Запись выключена.',
        constant: 'Постоянная: должна срабатывать всегда, значит, её остановили фильтр, вероятность или бюджет.',
        noKeys: 'У записи нет основных ключей (её может включить только «постоянно», вектор или рекурсия).',
        keyMatched:
            'Ключ есть в окне сканирования, но записи в ходе нет: остановили вероятность, группа, таймер или фильтр, либо сканировался более старый текст.',
        noKeyInScan: 'Ни один её ключ не встречается в последних сообщениях, которые сканирует ST.',
        beyondDepth: 'Ключ звучал, но раньше глубины сканирования (сообщений назад > глубина).',
        otherCaseForm:
            'Ключ покрывает одну форму слова, а в тексте другой падеж. Добавь падежные формы (ключи DES-RU / Lorebook Localizer) или ключ-регекс.',
        secondaryFailed: 'Основной ключ совпал, но вторичные ключи не прошли логику записи.',
        probability: 'Срабатывает только с этой вероятностью.',
        characterFilter: 'Фильтр персонажей ограничивает её определёнными персонажами или тегами (или исключает их).',
        delay: 'Задержка: может сработать только после стольких сообщений в чате.',
        cooldown: 'Перезарядка: после срабатывания отдыхает столько сообщений.',
        sticky: 'Липкая: держится столько сообщений после срабатывания (пробный прогон этого не видит).',
        group: 'В группе включения: за одно сканирование срабатывает только одна запись группы.',
        recursionOnly: 'Только через рекурсию: её включают другие записи, а не чат.',
        triggers: 'Срабатывает только для этих видов генерации.',
        vectorized: 'Векторная: включается векторным поиском, а не ключами.',
    },
};
