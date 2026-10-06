// Which script a model's text is written in: canon texts must be English (P6), sentences for the user Russian
// (plan-2 §3). Pure.

/** English text: Latin letters, Cyrillic only for a name or two. */
export function isEnglishText(value: string): boolean {
    const latin = (value.match(/[A-Za-z]/g) ?? []).length;
    const cyrillic = (value.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    return latin >= 8 && cyrillic <= latin * 0.3;
}

/** Russian text: Cyrillic letters, Latin only for a name or two. */
export function isRussianText(value: string): boolean {
    const latin = (value.match(/[A-Za-z]/g) ?? []).length;
    const cyrillic = (value.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    return cyrillic >= 8 && latin <= cyrillic * 0.3;
}

/** Longest sentence for the user. */
export const RUSSIAN_MAX = 300;

/** The model's Russian sentence for the user (spaces folded, clipped), or '' when it is missing or not Russian. */
export function russianSentence(value: unknown, max = RUSSIAN_MAX): string {
    if (typeof value !== 'string') return '';
    const sentence = value.replace(/\s+/g, ' ').trim().slice(0, max);
    return sentence && isRussianText(sentence) ? sentence : '';
}
