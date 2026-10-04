// M22 «Показ тегов BunnyMo» (audit T10): ST's sanitizer drops unknown `<tags>` when it renders a message, so BunnyMo
// tags vanish from the chat. The display hook escapes exactly the BunnyMo shapes to `&lt;…&gt;` (shown as text);
// real HTML is never touched. The prompt is not affected (the hook runs only when a message is rendered).
import { isHtmlElementName } from './text-clean';

/**
 * One pass over the text, alternatives in priority order:
 * 1. BunnyMo wrappers in any case: `<BunnymoTags>`, `</BunnyMoTags>`, `<Linguistics>`, `</linguistics>`, and the
 *    prose blocks of the V3 fullsheet (`<Genre>`, `<MentalHealth>`, `<PhysicalConditions>`, `<Medications>`);
 * 2. `<KEY:VALUE>`: the key starts with an upper-case letter (`<SPECIES:ELF>`, `<Name:Lira>`, `<Dere:Sadodere>`,
 *    `<BunnymoTags:Entry Name>`), the value has no `<`, `>` or line break and is not a URL (`//`);
 * 3. bare MBTI `<INTJ-U>` / `<ENFP-H>`;
 * 4. other bare upper-case tags (`<PHYSICAL>`, `</NSFW>`, `<PTSD>`) unless the name is an HTML element (`<BR>`).
 */
const TAG_RE =
    /<\/?(?:bunnymotags|linguistics|genre|mentalhealth|physicalconditions|medications)>|<[A-Z][A-Za-z0-9_]*:(?!\/\/)[^<>\n]{1,200}>|<[A-Z]{4}-[HU]>|<\/?([A-Z][A-Z0-9_]{1,40})>/gi;

/** Case-insensitive flag is needed for the wrappers only; the other alternatives re-check case here. */
function isBunnyMoTag(match: string, bareName: string | undefined): boolean {
    const inner = match.replace(/^<\/?|>$/g, '');
    if (/^(?:bunnymotags|linguistics|genre|mentalhealth|physicalconditions|medications)$/i.test(inner)) return true;
    if (bareName !== undefined) {
        // Bare tags must be really upper case and not an HTML element written in capitals.
        return /^[A-Z][A-Z0-9_]+$/.test(bareName) && !isHtmlElementName(bareName);
    }
    if (/^[A-Z]{4}-[HU]$/.test(inner)) return true;
    return /^[A-Z][A-Za-z0-9_]*:/.test(inner);
}

/** Escapes BunnyMo tags so they are displayed as text. Idempotent; text without `<` is returned as is. */
export function escapeBunnyMoTags(text: string): string {
    if (typeof text !== 'string' || !text.includes('<')) return text;
    return text.replace(TAG_RE, (match: string, bareName: string | undefined) =>
        isBunnyMoTag(match, bareName) ? `&lt;${match.slice(1, -1)}&gt;` : match,
    );
}
