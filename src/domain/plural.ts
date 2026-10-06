// Plural categories for counted phrases («3 факта», «5 фактов»). Strings come in three keys: `.one`, `.few`, `.many`
// (English uses `.one` and `.many`; its `.few` repeats `.many`).

/** Plural category of `count`: Russian one/few/many, English one/many. */
export function pluralForm(count: number, locale: 'ru' | 'en'): 'one' | 'few' | 'many' {
    const value = Math.abs(Math.floor(count));
    if (locale === 'en') return value === 1 ? 'one' : 'many';
    const ten = value % 10;
    const hundred = value % 100;
    if (ten === 1 && hundred !== 11) return 'one';
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'few';
    return 'many';
}
