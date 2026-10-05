// The optional hint to the model (M32 «Стиль сообщений»): one short instruction in the chat language that describes
// the format the enabled rules expect from the characters' replies — e.g. «Прямую речь пиши в кавычках "…", мысли
// и выделения — *курсивом*.» It describes what the model writes (the marks it types), not how Maestro displays it.
// Pure: no DOM, no SillyTavern.
import { DIALOGUE_KINDS, activeRules } from './message-style';
import type { MatchKind, StyleRule } from './message-style';

export type HintLanguage = 'ru' | 'en';

const PHRASES: Readonly<Record<HintLanguage, Partial<Record<MatchKind, string>>>> = {
    ru: {
        doubleQuotes: 'прямую речь пиши в кавычках "…"',
        guillemets: 'прямую речь пиши в кавычках-ёлочках «…»',
        dashDialogue: 'прямую речь оформляй с новой строки через тире: «— Реплика, — сказал он.»',
        asterisk: 'мысли и выделения — *курсивом*',
        underscore: 'мысли и выделения — _курсивом_',
        parentheses: 'короткие ремарки — в (скобках)',
        brackets: 'служебные пометки — в [квадратных скобках]',
        backticks: 'надписи и записки — в `обратных кавычках`',
    },
    en: {
        doubleQuotes: 'write direct speech in double quotes "…"',
        guillemets: 'write direct speech in guillemets «…»',
        dashDialogue: 'write direct speech on a new line after a dash: "— A line, — he said."',
        asterisk: 'thoughts and emphasis in *italics*',
        underscore: 'thoughts and emphasis in _italics_',
        parentheses: 'short asides in (parentheses)',
        brackets: 'service notes in [square brackets]',
        backticks: 'signs and notes in `backticks`',
    },
};

/** Kinds the hint mentions after dialogue and thoughts, in this order. */
const EXTRA_KINDS: readonly MatchKind[] = ['parentheses', 'brackets', 'backticks'];

/**
 * The instruction for the characters' replies (rules for all messages or the characters'), '' when the rules ask
 * for nothing the model writes. Only the first dialogue kind is named: the model needs one convention.
 */
export function buildFormatHint(rules: readonly StyleRule[], language: HintLanguage): string {
    const active = activeRules(rules, 'char');
    const phrases = PHRASES[language] ?? PHRASES.en;
    const parts: string[] = [];
    const dialogue = active.find((rule) => DIALOGUE_KINDS.includes(rule.match.kind));
    if (dialogue) parts.push(phrases[dialogue.match.kind]!);
    const thoughts = active.find((rule) => rule.match.kind === 'asterisk' || rule.match.kind === 'underscore');
    if (thoughts) parts.push(phrases[thoughts.match.kind]!);
    for (const kind of EXTRA_KINDS) {
        if (active.some((rule) => rule.match.kind === kind)) parts.push(phrases[kind]!);
    }
    if (!parts.length) return '';
    const text = parts.join(', ');
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}
