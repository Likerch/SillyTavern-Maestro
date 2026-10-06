// M38 «Проверка промпта», the cheap rules layer (plan-2 §2 п. 3, P4 «сначала правила»), pure. Every instruction of the
// map (prompt-audit-map.ts) is split into sentences and clauses; a clause with a negation forbids what it names, a
// clause with a demand cue requires it. Topics, English and Russian wording:
// - language, narration person, tense, length limits (clause patterns of preset-analysis-contradictions.ts);
// - required parts of the reply and formats: JSON blocks, image markers, info boxes, HTML, markdown, code fences,
//   «plain text only»;
// - who writes for the user (speaking / acting for {{user}}) and consent loops (asking the user, ending with a question);
// - how many images; «every turn» demands; the story pushed every turn against «let the user lead»;
// - a tight length cap against the parts other instructions make mandatory (the real case: «one line, ≤150 words»
//   against the tracker JSON, 1–3 image markers and «something happens in the world every turn»);
// - the same instruction from different owners (word shingles);
// - roles and places that are risky on the active model (DeepSeek V4: system messages inside the history are glued to
//   the neighbouring turns, an assistant message at the end is closed by EOS, assistant messages at a depth read as
//   the model's own replies) — a trailing system block glued from the tracker rules, the preset's task and the image
//   rules is what stopped the tracker JSON on the user's model.
// Each hit names both quotes, and proposes a fix on the side that is safest to change (the user's preset layer first,
// then a neighbour's text, then Maestro's setting; read-only owners get advice only).
import {
    CLAUSE_SPLIT,
    LANGUAGE_PATTERNS,
    LANGUAGES,
    LIMIT_PHRASES,
    NEGATION,
    POV_PATTERNS,
    TENSE_PATTERNS,
    lengthLimits,
    word,
} from './preset-analysis-contradictions';
import type { LengthLimit } from './preset-analysis-contradictions';
import { DUPLICATE_THRESHOLDS, isOverlapping, overlap, shingleSet } from './preset-analysis-text';
import type { AuditCapture, AuditItem, AuditOwner, AuditRole } from './prompt-audit-map';

export type AuditTopic =
    | 'language'
    | 'pov'
    | 'tense'
    | 'length'
    | 'format'
    | 'userAgency'
    | 'askUser'
    | 'images'
    | 'pacing'
    | 'tight'
    | 'duplicate'
    | 'role'
    | 'prefill'
    | 'assistantDepth'
    | 'unused'
    | 'ai';

export const AUDIT_TOPICS: readonly AuditTopic[] = [
    'language',
    'pov',
    'tense',
    'length',
    'format',
    'userAgency',
    'askUser',
    'images',
    'pacing',
    'tight',
    'duplicate',
    'role',
    'prefill',
    'assistantDepth',
    'unused',
    'ai',
];

export type AuditSeverity = 'high' | 'medium' | 'low';
export const SEVERITIES: readonly AuditSeverity[] = ['high', 'medium', 'low'];

export type FixKind = 'edit' | 'toggle' | 'role' | 'move' | 'remove';
export const FIX_KINDS: readonly FixKind[] = ['edit', 'toggle', 'role', 'move', 'remove'];

export type FixScope = 'global' | 'character' | 'chat';

export interface AuditSide {
    ref: string;
    /** What the instruction says (a sentence of it, shortened for display). */
    quote: string;
}

export interface AuditFix {
    side: 'a' | 'b' | 'both';
    kind: FixKind;
    /** The item to change (its ref). */
    target: string;
    /** edit/remove: the exact text of the target that changes. */
    before?: string;
    /** edit: the replacement ('' for remove). */
    after?: string;
    /** role: the new role. */
    role?: AuditRole;
    /** move: the new depth. */
    depth?: number;
    /** toggle: the new state (false = switch off). */
    enabled?: boolean;
    /** Rules: a reason code the feature words; AI: the model's own words. */
    reason?: string;
    scopeHint?: FixScope;
}

export interface RuleHit {
    topic: AuditTopic;
    severity: AuditSeverity;
    a: AuditSide;
    b?: AuditSide;
    /** Further instructions taking part (the tight-reply rule lists every demand). */
    also?: AuditSide[];
    /** What each side asks for (value codes: 'ru', 'first', '≤150 words', '!html' = forbids HTML). */
    values?: { a?: string; b?: string };
    /** Tight reply: the parts other instructions demand (part codes). */
    demands?: string[];
    /** Role risks: the model quirk behind it. */
    quirk?: string;
    fix?: AuditFix;
}

/* ------------------------------------------------------------------ sentences */

export interface Sentence {
    /** Exact substring of the text (trimmed). */
    text: string;
    start: number;
}

/** Sentences of a text as exact substrings: lines, then `. ! ? …` followed by whitespace. */
export function sentences(text: string): Sentence[] {
    const result: Sentence[] = [];
    const push = (start: number, end: number) => {
        const raw = text.slice(start, end);
        const lead = raw.length - raw.trimStart().length;
        const trimmed = raw.trim();
        if (trimmed && /\p{L}/u.test(trimmed)) result.push({ text: trimmed, start: start + lead });
    };
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (char === '\n') {
            push(start, i);
            start = i + 1;
            continue;
        }
        if ('.!?…'.includes(char)) {
            let end = i + 1;
            while (end < text.length && '.!?…»")'.includes(text[end]!)) end++;
            if (end >= text.length || /\s/.test(text[end]!)) {
                push(start, end);
                start = end;
                i = end - 1;
            }
        }
    }
    push(start, text.length);
    return result;
}

/** A quote for display: the sentence, shortened around its middle when long. */
export function shortQuote(text: string, max = 240): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ------------------------------------------------------------------ facets */

interface Mark {
    required?: string;
    forbidden?: string;
}

export type PartKind = 'json' | 'images' | 'infobox' | 'html' | 'markdown' | 'code';
export const PART_KINDS: readonly PartKind[] = ['json', 'images', 'infobox', 'html', 'markdown', 'code'];
/** Parts that add to the reply (the tight-reply rule counts them). */
const ADDED_PARTS: readonly PartKind[] = ['json', 'images', 'infobox', 'html'];

export interface LengthQuote {
    limit: LengthLimit | { unit: 'lines'; min: number; max: number };
    quote: string;
}

export interface ItemFacets {
    pov: Map<string, Mark>;
    tense: Map<string, Mark>;
    language: Map<string, Mark>;
    lengths: LengthQuote[];
    parts: Map<PartKind, Mark>;
    /** «Plain text only» (the sentence). */
    plain?: string;
    userAgency: Mark;
    askUser: Mark;
    images: { min: number; max: number; quote: string }[];
    everyTurn: string[];
    pacing: Map<'drive' | 'hold', string>;
}

const DEMAND = word(
    'must|always|include|includes|attach|add|insert|place|put|output|start|begin|end|provide|generate|wrap|format|required|mandatory|every|each|should|need|needs|use|write|обязательн\\p{L}*|всегда|добав\\p{L}*|включ\\p{L}*|встав\\p{L}*|помест\\p{L}*|размест\\p{L}*|начин\\p{L}*|заканчив\\p{L}*|выведи|выводи|пиши|используй|кажд\\p{L}*|нужно|должен|должна|должно|оформ\\p{L}*|прикрепл\\p{L}*',
);

const PART_PATTERNS: Record<PartKind, RegExp> = {
    json: /(?<!\p{L})json(?!\p{L})|```json|tracker block|трекер\p{L}*/iu,
    images: /(?<!\p{L})(?:image|picture|illustration|img)s?\s*(?:markers?|tags?|prompts?)?(?!\p{L})|<img|\[img|картин\p{L}*|изображени\p{L}*|иллюстрац\p{L}*/iu,
    infobox:
        /info[- ]?box|status (?:block|box|panel|window)|stat block|инфобокс\p{L}*|статус-?блок\p{L}*|блок\p{L}* статуса|информационн\p{L}* блок\p{L}*/iu,
    html: /(?<!\p{L})html(?!\p{L})|<div|<details|<span|(?<!\p{L})css(?!\p{L})/iu,
    markdown:
        /markdown|маркдаун\p{L}*|asterisks?|звёздочк\p{L}*|звездочк\p{L}*|(?<!\p{L})italics?(?!\p{L})|курсив\p{L}*|(?<!\p{L})bold(?!\p{L})|жирн\p{L}*/iu,
    code: /code ?(?:blocks?|fences?)|```|блок\p{L}* кода|код-блок\p{L}*/iu,
};

const PLAIN =
    /plain text(?: only)?|only plain|no formatting|without (?:any )?formatting|только (?:обычн\p{L}*|прост\p{L}*) текст\p{L}*|без (?:какого-либо |всякого )?форматировани\p{L}*/iu;

/** Clauses about image tags, captions, JSON fields or thoughts: their language/person/tense is not the reply's. */
const SUBPART =
    /(?<!\p{L})(?:tags?|captions?|danbooru|markers?|images?|pictures?|illustrations?|fields?|keys?|json|thoughts?|monologue|summary|summaries|memor(?:y|ies)|titles?|names?|entries|entry|descriptions?)(?!\p{L})|тег\p{L}*|подпис\p{L}*|маркер\p{L}*|картин\p{L}*|изображ\p{L}*|пол[еяю](?!\p{L})|ключ\p{L}*|мысл\p{L}*|сводк\p{L}*|памят\p{L}*|заголов\p{L}*|описани\p{L}*/iu;

const ONE_LINE =
    /(?<!\p{L})(?:one|a single|single)[- ](?:line|sentence|paragraph)(?!\p{L})|(?:в |одн\p{L}* )?(?:одну|одной) (?:строк\p{L}*|строчк\p{L}*)|одним предложением|одной фразой|одним абзацем/iu;

const USER = String.raw`(?:\{\{user\}\}|the user|the player|user|player|игрок\p{L}*|пользовател\p{L}*)`;
const USER_AGENCY: readonly RegExp[] = [
    new RegExp(
        String.raw`(?<!\p{L})(?:speak|act|write|talk|decide|narrate|describe|control|play|respond|reply)(?!\p{L})[^.\n]{0,40}?(?<!\p{L})(?:for|as|on behalf of)\s+${USER}`,
        'iu',
    ),
    new RegExp(
        String.raw`${USER}['’]s\s+(?:actions|dialogue|lines|words|speech|thoughts|reactions|decisions|feelings)`,
        'iu',
    ),
    new RegExp(
        String.raw`(?:пиш\p{L}*|говор\p{L}*|действ\p{L}*|реш\p{L}*|описыва\p{L}*|управля\p{L}*|отвеча\p{L}*)[^.\n]{0,40}?(?<!\p{L})(?:за|вместо|от лица)\s+${USER}`,
        'iu',
    ),
    new RegExp(
        String.raw`(?:действия|реплики|слова|речь|мысли|решения|реакции|чувства)\s+(?:\{\{user\}\}|игрока|пользователя)`,
        'iu',
    ),
];

const ASK_USER: readonly RegExp[] = [
    new RegExp(String.raw`(?<!\p{L})(?:ask|check with|confirm with)(?!\p{L})[^.\n]{0,30}?${USER}`, 'iu'),
    /(?<!\p{L})(?:consent|permission)(?!\p{L})/iu,
    /end (?:each|every|the|your) (?:reply|response|message|turn) with (?:a )?question/iu,
    /(?:спрашивай|спроси|уточняй|уточни)(?!\p{L})[^.\n]{0,40}/iu,
    /(?:согласи\p{L}*|разрешени\p{L}*)/iu,
    /заканчива\p{L}*[^.\n]{0,30}вопрос\p{L}*/iu,
];

const EVERY_TURN =
    /(?<!\p{L})(?:every|each) (?:turn|reply|response|message|answer|output)(?!\p{L})|in all (?:replies|responses)|каждый ход|кажд\p{L}* (?:ответ\p{L}*|сообщени\p{L}*|ход\p{L}*|реплик\p{L}*)|в каждом/iu;

const DRIVE: readonly RegExp[] = [
    /(?<!\p{L})(?:advance|move|push|drive|progress)(?!\p{L})[^.\n]{0,20}?(?<!\p{L})(?:the )?(?:plot|story|narrative)(?!\p{L})/iu,
    /(?:something|an event|a complication|a twist)[^.\n]{0,40}?(?:happens|occurs|changes|must happen)/iu,
    /(?:introduce|add)[^.\n]{0,20}?(?:events?|complications?|twists?|obstacles?)/iu,
    /(?:продвига\p{L}*|двига\p{L}*|развива\p{L}*)[^.\n]{0,15}?(?:сюжет\p{L}*|истори\p{L}*)/iu,
    /(?:что-то|что-нибудь|событи\p{L}*|осложнени\p{L}*)[^.\n]{0,40}?(?:происход\p{L}*|случа\p{L}*|меня\p{L}*)/iu,
    /в мире[^.\n]{0,30}?происход\p{L}*/iu,
];
const HOLD: readonly RegExp[] = [
    new RegExp(String.raw`(?:let|allow)\s+${USER}[^.\n]{0,20}?(?:lead|drive|decide)`, 'iu'),
    new RegExp(String.raw`(?:wait for|follow)\s+${USER}`, 'iu'),
    new RegExp(String.raw`(?:пусть|дай)\s+${USER}[^.\n]{0,20}?(?:вед\p{L}*|реша\p{L}*)`, 'iu'),
    new RegExp(String.raw`(?:жди|следуй за)\s+${USER}`, 'iu'),
];

const IMAGE_WORD = String.raw`(?:image|picture|illustration|img|marker|картин\p{L}*|изображ\p{L}*|иллюстрац\p{L}*|маркер\p{L}*)`;
const IMAGE_RANGE = new RegExp(
    String.raw`(\d{1,2})\s*(?:-|–|—|to|до)\s*(\d{1,2})\s*(?:\p{L}+\s+){0,2}?${IMAGE_WORD}`,
    'iu',
);
const IMAGE_MAX = new RegExp(
    String.raw`(?:up to|no more than|not more than|at most|max(?:imum)?|не более|не больше|максимум|до)\s+(\d{1,2})\s*(?:\p{L}+\s+){0,2}?${IMAGE_WORD}`,
    'iu',
);
const IMAGE_EXACT = new RegExp(
    String.raw`(?<!\p{L})(?:exactly |only )?(one|a single|single|одн\p{L}*|\d{1,2})\s+(?:\p{L}+\s+){0,1}?${IMAGE_WORD}`,
    'iu',
);

/** Language codes of «по-русски»-style words. */
const PO_LANGUAGE: Record<string, string> = {
    русски: 'ru',
    английски: 'en',
    японски: 'ja',
    китайски: 'zh',
    немецки: 'de',
    французски: 'fr',
    испански: 'es',
};
const PO_LANGUAGE_RE = /(?<!\p{L})по-(русски|английски|японски|китайски|немецки|французски|испански)(?!\p{L})/iu;

function mark(map: Map<string, Mark>, key: string, negated: boolean, quote: string): void {
    const value = map.get(key) ?? {};
    if (negated) value.forbidden ??= quote;
    else value.required ??= quote;
    map.set(key, value);
}

/** A length rule that already leaves the extra parts out of its limit (the fix's own wording included). */
const LIMIT_EXCEPTION =
    /do(?:es)? not count|don['’]t count|not counting|excluding|except(?:ing)?|apart from|aside from|on top of|не входят|не входит|не считая|без учёта|без учета|кроме|за исключением|сверх/iu;

function isNegated(clause: string): boolean {
    return NEGATION.test(clause.replace(LIMIT_PHRASES, ' '));
}

function numberWord(value: string): number {
    const lower = value.toLowerCase();
    if (/^\d+$/.test(lower)) return Number(lower);
    return 1;
}

/** What one instruction asks for, by topic, with the sentence that says it. */
export function itemFacets(text: string): ItemFacets {
    const facets: ItemFacets = {
        pov: new Map(),
        tense: new Map(),
        language: new Map(),
        lengths: [],
        parts: new Map(),
        userAgency: {},
        askUser: {},
        images: [],
        everyTurn: [],
        pacing: new Map(),
    };
    for (const sentence of sentences(text)) {
        const quote = sentence.text;
        let everyTurn = false;
        for (const clause of quote.split(CLAUSE_SPLIT)) {
            // «…do not count toward the limit» names parts without forbidding them.
            if (!clause.trim() || LIMIT_EXCEPTION.test(clause)) continue;
            const negated = isNegated(clause);
            const subpart = SUBPART.test(clause);
            const demand = DEMAND.test(clause);
            if (!subpart) {
                for (const [key, pattern] of POV_PATTERNS)
                    if (pattern.test(clause)) mark(facets.pov, key, negated, quote);
                for (const [key, pattern] of TENSE_PATTERNS)
                    if (pattern.test(clause)) mark(facets.tense, key, negated, quote);
                for (const pattern of LANGUAGE_PATTERNS) {
                    const found = pattern.exec(clause)?.[1]?.toLowerCase();
                    const code = found ? LANGUAGES[found] : undefined;
                    if (code) mark(facets.language, code, negated, quote);
                }
                const po = PO_LANGUAGE_RE.exec(clause)?.[1]?.toLowerCase();
                if (po && PO_LANGUAGE[po]) mark(facets.language, PO_LANGUAGE[po], negated, quote);
                if (!negated) {
                    for (const limit of lengthLimits(clause)) facets.lengths.push({ limit, quote });
                    if (ONE_LINE.test(clause)) {
                        const unit = /sentence|предложени|фраз/i.test(clause)
                            ? 'sentences'
                            : /paragraph|абзац/i.test(clause)
                              ? 'paragraphs'
                              : 'lines';
                        facets.lengths.push({
                            limit: unit === 'lines' ? { unit, min: 0, max: 1 } : { unit, min: 0, max: 1 },
                            quote,
                        });
                    }
                }
            }
            for (const kind of PART_KINDS) {
                if (!PART_PATTERNS[kind].test(clause)) continue;
                if (negated) mark(facets.parts, kind, true, quote);
                else if (demand) {
                    mark(facets.parts, kind, false, quote);
                    if (kind === 'json' && /```|code ?block|блок\p{L}* кода/iu.test(clause))
                        mark(facets.parts, 'code', false, quote);
                }
            }
            if (PLAIN.test(clause) && !negated) facets.plain ??= quote;
            if (USER_AGENCY.some((pattern) => pattern.test(clause))) {
                if (negated) facets.userAgency.forbidden ??= quote;
                else if (demand || /describe|write|пиш|описыв/iu.test(clause)) facets.userAgency.required ??= quote;
            }
            if (ASK_USER.some((pattern) => pattern.test(clause))) {
                if (negated) facets.askUser.forbidden ??= quote;
                else if (demand || /(?:always|всегда|ask|спрашива|спроси|уточня)/iu.test(clause))
                    facets.askUser.required ??= quote;
            }
            if (!negated && new RegExp(IMAGE_WORD, 'iu').test(clause)) {
                const range = IMAGE_RANGE.exec(clause);
                const max = IMAGE_MAX.exec(clause);
                const exact = IMAGE_EXACT.exec(clause);
                if (range) {
                    const low = Number(range[1]);
                    const high = Number(range[2]);
                    facets.images.push({ min: Math.min(low, high), max: Math.max(low, high), quote });
                } else if (max) facets.images.push({ min: 0, max: Number(max[1]), quote });
                else if (exact && /exactly|only|ровно|только/iu.test(clause)) {
                    const count = numberWord(exact[1] ?? '1');
                    facets.images.push({ min: count, max: count, quote });
                }
            } else if (negated && new RegExp(IMAGE_WORD, 'iu').test(clause) && !/marker|маркер/iu.test(clause)) {
                facets.images.push({ min: 0, max: 0, quote });
            }
            if (!negated && EVERY_TURN.test(clause)) everyTurn = true;
            if (DRIVE.some((pattern) => pattern.test(clause))) {
                if (negated) {
                    if (!facets.pacing.has('hold')) facets.pacing.set('hold', quote);
                } else if (!facets.pacing.has('drive')) facets.pacing.set('drive', quote);
            }
            if (!negated && HOLD.some((pattern) => pattern.test(clause)) && !facets.pacing.has('hold')) {
                facets.pacing.set('hold', quote);
            }
        }
        if (everyTurn && !facets.everyTurn.includes(quote)) facets.everyTurn.push(quote);
    }
    return facets;
}

/* ------------------------------------------------------------------ fixes */

/** Owners whose text Maestro can change: the user's preset layer, the neighbours' editable prompts, its settings. */
const EDIT_RANK: Record<AuditOwner, number> = {
    preset: 0,
    des: 1,
    nai: 1,
    qvink: 2,
    maestro: 3,
    card: 5,
    authorsNote: 5,
    desru: 6,
    ck: 6,
    lore: 7,
    bunnymo: 9,
    other: 8,
};

/** The side that is safest to change (the preset layer first; ties: the later one). */
export function pickSide(a: AuditItem, b: AuditItem): 'a' | 'b' {
    return EDIT_RANK[a.owner] < EDIT_RANK[b.owner] ? 'a' : 'b';
}

/** A sentence without a requirement: removed from the text. */
function removeFix(side: 'a' | 'b', item: AuditItem, sentence: string, reason: string): AuditFix {
    return { side, kind: 'remove', target: item.ref, before: sentence, after: '', reason };
}

const PART_NAMES: Record<'en' | 'ru', Record<string, string>> = {
    en: {
        json: 'the tracker JSON',
        images: 'picture markers',
        infobox: 'the info box',
        html: 'HTML pieces',
        event: 'the world event',
    },
    ru: {
        json: 'JSON трекера',
        images: 'маркеры картинок',
        infobox: 'инфобокс',
        html: 'HTML-вставки',
        event: 'событие мира',
    },
};

function isRussian(text: string): boolean {
    const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    return cyrillic > latin;
}

/**
 * A length rule with an exception for the parts other instructions make mandatory (in the language of the rule):
 * «Reply in one line, ≤150 words (the tracker JSON and picture markers do not count toward this limit).»
 */
export function withLengthException(sentence: string, demands: readonly string[]): string {
    const ru = isRussian(sentence);
    const names = demands.map((demand) => PART_NAMES[ru ? 'ru' : 'en'][demand] ?? demand);
    const list =
        names.length <= 1
            ? (names[0] ?? '')
            : `${names.slice(0, -1).join(', ')} ${ru ? 'и' : 'and'} ${names[names.length - 1]}`;
    const note = ru
        ? `(лимит — только для текста истории; ${list} в него не входят)`
        : `(the limit is for the story text only; ${list} do not count toward it)`;
    const match = /^(.*?)([.!?…]*)$/su.exec(sentence.trimEnd());
    const body = match?.[1] ?? sentence;
    const end = match?.[2] ?? '';
    return `${body} ${note}${end}`;
}

/* ------------------------------------------------------------------ pair rules */

interface Faceted {
    item: AuditItem;
    facets: ItemFacets;
}

function side(item: AuditItem, quote: string): AuditSide {
    return { ref: item.ref, quote: shortQuote(quote) };
}

const POLARITY_SEVERITY: Record<'language' | 'pov' | 'tense', AuditSeverity> = {
    language: 'high',
    pov: 'medium',
    tense: 'medium',
};

function polarityHit(
    topic: 'language' | 'pov' | 'tense',
    left: Faceted,
    right: Faceted,
    l: Map<string, Mark>,
    r: Map<string, Mark>,
): RuleHit | null {
    const build = (qa: string, qb: string, va: string, vb: string): RuleHit => {
        const pick = pickSide(left.item, right.item);
        const target = pick === 'a' ? left.item : right.item;
        return {
            topic,
            severity: POLARITY_SEVERITY[topic],
            a: side(left.item, qa),
            b: side(right.item, qb),
            values: { a: va, b: vb },
            fix: removeFix(pick, target, pick === 'a' ? qa : qb, 'removeSide'),
        };
    };
    for (const [key, mine] of l) {
        const theirs = r.get(key);
        if (mine.required && theirs?.forbidden) return build(mine.required, theirs.forbidden, key, `!${key}`);
        if (mine.forbidden && theirs?.required) return build(mine.forbidden, theirs.required, `!${key}`, key);
    }
    const required = (map: Map<string, Mark>) => [...map].filter(([, value]) => value.required);
    const mine = required(l);
    const theirs = required(r);
    if (mine.length === 1 && theirs.length === 1 && mine[0]![0] !== theirs[0]![0]) {
        return build(mine[0]![1].required!, theirs[0]![1].required!, mine[0]![0], theirs[0]![0]);
    }
    return null;
}

function formatLimit(limit: LengthQuote['limit']): string {
    if (limit.max === Number.POSITIVE_INFINITY) return `≥${limit.min} ${limit.unit}`;
    if (limit.min === 0) return `≤${limit.max} ${limit.unit}`;
    return limit.min === limit.max ? `${limit.min} ${limit.unit}` : `${limit.min}-${limit.max} ${limit.unit}`;
}

function lengthHit(left: Faceted, right: Faceted): RuleHit | null {
    for (const mine of left.facets.lengths) {
        for (const theirs of right.facets.lengths) {
            if (mine.limit.unit !== theirs.limit.unit) continue;
            if (mine.limit.max < theirs.limit.min || theirs.limit.max < mine.limit.min) {
                const pick = pickSide(left.item, right.item);
                const target = pick === 'a' ? left.item : right.item;
                return {
                    topic: 'length',
                    severity: 'medium',
                    a: side(left.item, mine.quote),
                    b: side(right.item, theirs.quote),
                    values: { a: formatLimit(mine.limit), b: formatLimit(theirs.limit) },
                    fix: removeFix(pick, target, pick === 'a' ? mine.quote : theirs.quote, 'removeSide'),
                };
            }
        }
    }
    return null;
}

/** Formats that «plain text only» rules out. */
const PLAIN_FORBIDS: readonly PartKind[] = ['html', 'markdown', 'code', 'json'];

function formatHit(left: Faceted, right: Faceted): RuleHit | null {
    const build = (kind: string, qa: string, qb: string, va: string, vb: string): RuleHit => {
        const pick = pickSide(left.item, right.item);
        const target = pick === 'a' ? left.item : right.item;
        return {
            topic: 'format',
            severity: 'high',
            a: side(left.item, qa),
            b: side(right.item, qb),
            values: { a: va, b: vb },
            demands: [kind],
            fix: removeFix(pick, target, pick === 'a' ? qa : qb, 'removeSide'),
        };
    };
    for (const kind of PART_KINDS) {
        const mine = left.facets.parts.get(kind);
        const theirs = right.facets.parts.get(kind);
        if (mine?.required && theirs?.forbidden) return build(kind, mine.required, theirs.forbidden, kind, `!${kind}`);
        if (mine?.forbidden && theirs?.required) return build(kind, mine.forbidden, theirs.required, `!${kind}`, kind);
    }
    for (const kind of PLAIN_FORBIDS) {
        const mine = left.facets.parts.get(kind);
        const theirs = right.facets.parts.get(kind);
        if (left.facets.plain && theirs?.required)
            return build(kind, left.facets.plain, theirs.required, 'plain', kind);
        if (mine?.required && right.facets.plain) return build(kind, mine.required, right.facets.plain, kind, 'plain');
    }
    return null;
}

function markHit(
    topic: 'userAgency' | 'askUser',
    severity: AuditSeverity,
    left: Faceted,
    right: Faceted,
    l: Mark,
    r: Mark,
): RuleHit | null {
    const build = (qa: string, qb: string, va: string, vb: string): RuleHit => {
        const pick = pickSide(left.item, right.item);
        const target = pick === 'a' ? left.item : right.item;
        return {
            topic,
            severity,
            a: side(left.item, qa),
            b: side(right.item, qb),
            values: { a: va, b: vb },
            fix: removeFix(pick, target, pick === 'a' ? qa : qb, 'removeSide'),
        };
    };
    if (l.required && r.forbidden) return build(l.required, r.forbidden, 'yes', 'no');
    if (l.forbidden && r.required) return build(l.forbidden, r.required, 'no', 'yes');
    return null;
}

function imagesHit(left: Faceted, right: Faceted): RuleHit | null {
    for (const mine of left.facets.images) {
        for (const theirs of right.facets.images) {
            if (mine.max < theirs.min || theirs.max < mine.min) {
                const pick = pickSide(left.item, right.item);
                const target = pick === 'a' ? left.item : right.item;
                const range = (value: { min: number; max: number }) =>
                    value.min === value.max ? String(value.min) : `${value.min}-${value.max}`;
                return {
                    topic: 'images',
                    severity: 'medium',
                    a: side(left.item, mine.quote),
                    b: side(right.item, theirs.quote),
                    values: { a: range(mine), b: range(theirs) },
                    fix: removeFix(pick, target, pick === 'a' ? mine.quote : theirs.quote, 'removeSide'),
                };
            }
        }
    }
    return null;
}

function pacingHit(left: Faceted, right: Faceted): RuleHit | null {
    const pairs: ['drive' | 'hold', 'drive' | 'hold'][] = [
        ['drive', 'hold'],
        ['hold', 'drive'],
    ];
    for (const [mine, theirs] of pairs) {
        const qa = left.facets.pacing.get(mine);
        const qb = right.facets.pacing.get(theirs);
        if (!qa || !qb) continue;
        const pick = pickSide(left.item, right.item);
        const target = pick === 'a' ? left.item : right.item;
        return {
            topic: 'pacing',
            severity: 'low',
            a: side(left.item, qa),
            b: side(right.item, qb),
            values: { a: mine, b: theirs },
            fix: removeFix(pick, target, pick === 'a' ? qa : qb, 'removeSide'),
        };
    }
    return null;
}

/** The first sentence of `small` that shares shingles with `large` (the duplicate's quote). */
function sharedSentence(small: string, large: ReadonlySet<string>): string | null {
    let best: { text: string; shared: number } | null = null;
    for (const sentence of sentences(small)) {
        const shingles = shingleSet(sentence.text);
        let shared = 0;
        for (const shingle of shingles) if (large.has(shingle)) shared++;
        if (shared > 0 && (!best || shared > best.shared)) best = { text: sentence.text, shared };
    }
    return best?.text ?? null;
}

function duplicateHit(left: Faceted, right: Faceted, shingles: Map<string, Set<string>>): RuleHit | null {
    // Preset blocks among themselves: the Preset Studio's own analysis reports those.
    if (left.item.owner === 'preset' && right.item.owner === 'preset') return null;
    if (left.item.owner === right.item.owner && left.item.owner !== 'preset') return null;
    const a = shingles.get(left.item.ref)!;
    const b = shingles.get(right.item.ref)!;
    const value = overlap(a, b);
    if (!isOverlapping(value, DUPLICATE_THRESHOLDS)) return null;
    const qa = sharedSentence(left.item.text, b) ?? left.item.text.slice(0, 200);
    const qb = sharedSentence(right.item.text, a) ?? right.item.text.slice(0, 200);
    const pick = pickSide(left.item, right.item);
    const target = pick === 'a' ? left.item : right.item;
    const targetSize = pick === 'a' ? a.size : b.size;
    const whole = value.containment >= 0.9 && targetSize <= Math.min(a.size, b.size);
    const fix: AuditFix =
        whole && target.owner === 'preset'
            ? { side: pick, kind: 'toggle', target: target.ref, enabled: false, reason: 'duplicateBlock' }
            : removeFix(pick, target, pick === 'a' ? qa : qb, 'duplicate');
    return {
        topic: 'duplicate',
        severity: 'low',
        a: side(left.item, qa),
        b: side(right.item, qb),
        values: { a: String(value.shared), b: String(Math.round(value.containment * 100)) },
        fix,
    };
}

/* ------------------------------------------------------------------ the tight reply */

/** A cap that leaves no room for extra parts: ≤ 200 words, ≤ 2 paragraphs, ≤ 3 sentences, ≤ 300 tokens, one line. */
function isTight(limit: LengthQuote['limit']): boolean {
    switch (limit.unit) {
        case 'words':
            return limit.max <= 200;
        case 'paragraphs':
            return limit.max <= 2;
        case 'sentences':
            return limit.max <= 3;
        case 'tokens':
            return limit.max <= 300;
        case 'lines':
            return limit.max <= 2;
        default:
            return false;
    }
}

function tightHits(list: readonly Faceted[]): RuleHit[] {
    const hits: RuleHit[] = [];
    for (const capped of list) {
        const tight = capped.facets.lengths.find((entry) => isTight(entry.limit) && !LIMIT_EXCEPTION.test(entry.quote));
        if (!tight) continue;
        const demands: { code: string; item: AuditItem; quote: string }[] = [];
        for (const other of list) {
            if (other === capped) continue;
            for (const part of ADDED_PARTS) {
                const required = other.facets.parts.get(part)?.required;
                if (required && !demands.some((demand) => demand.code === part)) {
                    demands.push({ code: part, item: other.item, quote: required });
                }
            }
            const drive = other.facets.pacing.get('drive');
            if (drive && other.facets.everyTurn.length && !demands.some((demand) => demand.code === 'event')) {
                demands.push({ code: 'event', item: other.item, quote: drive });
            }
        }
        if (!demands.length) continue;
        demands.sort((x, y) => ADDED_ORDER.indexOf(x.code) - ADDED_ORDER.indexOf(y.code));
        const [first, ...rest] = demands;
        const codes = demands.map((demand) => demand.code);
        hits.push({
            topic: 'tight',
            severity: demands.length >= 2 || codes.includes('json') ? 'high' : 'medium',
            a: side(capped.item, tight.quote),
            b: side(first!.item, first!.quote),
            also: rest.map((demand) => side(demand.item, demand.quote)),
            values: { a: formatLimit(tight.limit) },
            demands: codes,
            fix: {
                side: 'a',
                kind: 'edit',
                target: capped.item.ref,
                before: tight.quote,
                after: withLengthException(
                    tight.quote,
                    codes.filter((code) => code !== 'event'),
                ),
                reason: 'exception',
            },
        });
    }
    return hits;
}

const ADDED_ORDER = ['json', 'images', 'infobox', 'html', 'event'];

/* ------------------------------------------------------------------ roles and places */

/** First and last message of the chat history (messages with no instruction found in them, user or assistant). */
function historyBounds(capture: AuditCapture): { first: number; last: number } {
    let first = -1;
    let last = -1;
    capture.messages.forEach((message, index) => {
        if (message.refs.length || (message.role !== 'user' && message.role !== 'assistant')) return;
        if (first < 0) first = index;
        last = index;
    });
    return { first, last };
}

const DES_TRACKER_SLOT = /^slot:dooms[-_]tracker[-_]inject/i;

/** Risks of roles and places on the active model (its quirks). */
export function roleHits(capture: AuditCapture): RuleHit[] {
    const quirks = new Set(capture.connection?.quirks ?? []);
    if (!quirks.size) return [];
    const byRef = new Map(capture.items.map((entry) => [entry.ref, entry]));
    const { first, last } = historyBounds(capture);
    const hits: RuleHit[] = [];
    const biggest = (refs: readonly string[]) =>
        refs
            .map((ref) => byRef.get(ref))
            .filter((entry): entry is AuditItem => !!entry)
            .sort((x, y) => y.chars - x.chars);
    capture.messages.forEach((message, index) => {
        if (!message.refs.length) return;
        const items = biggest(message.refs);
        const main = items.find((entry) => DES_TRACKER_SLOT.test(entry.ref)) ?? items[0];
        if (!main) return;
        const other = items.find((entry) => entry !== main && entry.owner !== main.owner);
        const lastMessage = index === capture.messages.length - 1;
        if (message.role === 'system' && quirks.has('systemMerge') && first >= 0 && index > first) {
            const trailing = last >= 0 && index > last;
            const owners = new Set(items.map((entry) => entry.owner));
            const tracker = items.some((entry) => DES_TRACKER_SLOT.test(entry.ref));
            const heavy = message.chars >= 6000 || (trailing && owners.size >= 2);
            // Small system blocks of a preset built for it (Marinara's tags, output format) work in practice: a note,
            // no one-click role change. What broke for real is the tracker or a big merged trailing system block.
            const risky = tracker || heavy;
            hits.push({
                topic: 'role',
                severity: risky ? 'high' : 'low',
                a: side(main, main.text.slice(0, 200)),
                b: other ? side(other, other.text.slice(0, 200)) : undefined,
                values: { a: trailing ? 'trailing' : 'middle', b: String(message.chars) },
                quirk: 'systemMerge',
                // A neighbour's or Maestro's role is advice anyway; a preset's own small block gets no one-click fix.
                fix: risky || main.owner !== 'preset' ? roleFix(main, 'user') : undefined,
            });
        }
        if (message.role === 'assistant' && lastMessage && quirks.has('prefillEos')) {
            hits.push({
                topic: 'prefill',
                severity: 'high',
                a: side(main, main.text.slice(0, 200)),
                quirk: 'prefillEos',
                fix:
                    main.owner === 'preset'
                        ? { side: 'a', kind: 'toggle', target: main.ref, enabled: false, reason: 'prefill' }
                        : undefined,
            });
        } else if (message.role === 'assistant' && quirks.has('assistantDepth') && first >= 0 && index > first) {
            hits.push({
                topic: 'assistantDepth',
                severity: 'medium',
                a: side(main, main.text.slice(0, 200)),
                quirk: 'assistantDepth',
                fix: roleFix(main, 'user'),
            });
        }
    });
    return hits.map((hit) => (hit.b === undefined ? withoutB(hit) : hit));
}

function withoutB(hit: RuleHit): RuleHit {
    const copy = { ...hit };
    delete copy.b;
    return copy;
}

/** A role change (a neighbour's or Maestro's role is their own setting: the route makes it advice). */
function roleFix(item: AuditItem, role: AuditRole): AuditFix | undefined {
    if (item.role === role) return undefined;
    return { side: 'a', kind: 'role', target: item.ref, role, reason: 'roleUser' };
}

/* ------------------------------------------------------------------ the whole rules layer */

/** Every rule over a capture, most severe first. */
export function auditRules(capture: AuditCapture): RuleHit[] {
    const list: Faceted[] = capture.items.map((entry) => ({ item: entry, facets: itemFacets(entry.text) }));
    const shingles = new Map(capture.items.map((entry) => [entry.ref, shingleSet(entry.text)]));
    const hits: RuleHit[] = [];
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const left = list[i]!;
            const right = list[j]!;
            const found = [
                polarityHit('language', left, right, left.facets.language, right.facets.language),
                polarityHit('pov', left, right, left.facets.pov, right.facets.pov),
                polarityHit('tense', left, right, left.facets.tense, right.facets.tense),
                lengthHit(left, right),
                formatHit(left, right),
                markHit('userAgency', 'medium', left, right, left.facets.userAgency, right.facets.userAgency),
                markHit('askUser', 'low', left, right, left.facets.askUser, right.facets.askUser),
                imagesHit(left, right),
                pacingHit(left, right),
                duplicateHit(left, right, shingles),
            ];
            for (const hit of found) if (hit) hits.push(hit);
        }
    }
    hits.push(...tightHits(list), ...roleHits(capture));
    return sortHits(hits);
}

export function sortHits<T extends { severity: AuditSeverity }>(hits: T[]): T[] {
    return hits
        .map((hit, index) => ({ hit, index }))
        .sort((x, y) => SEVERITIES.indexOf(x.hit.severity) - SEVERITIES.indexOf(y.hit.severity) || x.index - y.index)
        .map(({ hit }) => hit);
}

/* ------------------------------------------------------------------ fingerprints */

/**
 * What «Не считать конфликтом» remembers: the topic, the two instructions and what they ask for (not the quotes, so
 * the same disagreement stays hidden after small edits; AI findings: the pair of instructions).
 */
export function fingerprintOf(hit: {
    topic: AuditTopic;
    a: AuditSide;
    b?: AuditSide;
    values?: { a?: string; b?: string };
}): string {
    const refs = [hit.a.ref, hit.b?.ref ?? ''].sort();
    const values =
        hit.topic === 'ai' || hit.topic === 'duplicate'
            ? ''
            : [hit.values?.a ?? '', hit.values?.b ?? ''].sort().join('/');
    return `${hit.topic}|${refs.join('|')}|${values}`;
}
