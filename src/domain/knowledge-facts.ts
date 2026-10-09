// M18 «Кто что знает», pure fact logic (plan M18 п. 1–2): what one committed turn adds to the chat's knowledge store
// without AI — the notable events of the turn's signals (quests, relationship changes, moves, characters who came or
// went, revealed names and aliases) and the reply's sentences that hold a key event word and name someone — as short
// English facts with topic words (names with their Russian forms, keywords) used later to decide whether the topic
// came up. The store document, its cap (oldest scene facts go first, secrets last) and rollback on invalidation.
// Pure: no DOM, no SillyTavern.
import { uniqueStrings } from './canon-keys';
import { truncate } from './dossier-data';
import { buildMentionMatcher, findMentions, mentionNeedles, nameList, normalizeName } from './world-names';

/** One fact (the same fields as `KnowledgeFact` in src/features/knowledge/api.ts). */
export interface KnowledgeFactData {
    id: string;
    /** English, short (the player's language for a secret the preparation of a Russian story made). */
    text: string;
    /** The English statement beside a `text` in the story's language (a Russian story's prepared secret). */
    english?: string;
    /** Topic words (RU/EN): capitalised ones are names, lower-case ones keywords. */
    topics: string[];
    /** Canonical names of the characters who know it. */
    knownBy: string[];
    secret: boolean;
    sourceMessage: number;
    at: number;
    /** The sentence of the reply (or the revision's quote) it came from, as written. */
    quote?: string;
}

/** The per-chat document 'knowledge'. */
export interface KnowledgeDocData {
    facts: KnowledgeFactData[];
}

export const DEFAULT_MAX_FACTS = 300;
export const MIN_MAX_FACTS = 50;
export const MAX_MAX_FACTS = 2000;
export const MAX_TEXT = 160;
export const MAX_QUOTE = 220;
export const MAX_TOPICS = 16;
/** Event facts one reply gives at most (sentences with a key event word). */
export const MAX_REPLY_EVENTS = 2;
/** Sentences longer than this are not read (a wall of text is not one event). */
const MAX_SENTENCE = 500;
const NAME_ALIASES = 3;
const NAME_FORMS = 8;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function emptyKnowledgeDoc(): KnowledgeDocData {
    return { facts: [] };
}

/** A stored fact repaired (null for junk). */
export function normalizeFact(raw: unknown): KnowledgeFactData | null {
    if (!isDict(raw)) return null;
    const id = str(raw.id);
    const text = str(raw.text);
    if (!id || !text) return null;
    const list = (value: unknown) => (Array.isArray(value) ? uniqueStrings(value) : []);
    const index = Number(raw.sourceMessage);
    const at = Number(raw.at);
    const fact: KnowledgeFactData = {
        id,
        text,
        topics: list(raw.topics),
        knownBy: nameList(list(raw.knownBy)),
        secret: raw.secret === true,
        sourceMessage: Number.isInteger(index) ? index : -1,
        at: Number.isFinite(at) ? at : 0,
    };
    const quote = str(raw.quote);
    if (quote) fact.quote = quote;
    const english = str(raw.english);
    if (english && english !== text) fact.english = english;
    return fact;
}

/** A fresh, repaired copy of a stored document (never the cached object). */
export function normalizeKnowledgeDoc(raw: unknown): KnowledgeDocData {
    const facts = isDict(raw) && Array.isArray(raw.facts) ? raw.facts : [];
    const seen = new Set<string>();
    const out: KnowledgeFactData[] = [];
    for (const item of facts) {
        const fact = normalizeFact(item);
        if (!fact || seen.has(fact.id)) continue;
        seen.add(fact.id);
        out.push(fact);
    }
    return { facts: out };
}

/* ------------------------------------------------------------------ names and topics */

/** A name the story knows: canonical name with aliases and Russian case forms (world model). */
export interface NameInfo {
    name: string;
    aliases?: readonly string[];
    forms?: readonly string[];
}

export type NameLookup = (name: string) => NameInfo | null | undefined;

const STOP_WORDS = new Set(
    [
        'the about after again against also and another any because been before being between both but came come could ' +
            'does down each even every find from have having here into just like make more most much must never none ' +
            'only other over quest same should some such than that their them then there these they this those through ' +
            'under until upon very want were what when where which while with within without would your',
        'быть было была были будет есть него неё нее ними нему этот этого этому этой этим эти этих ' +
            'такой такая такие того тому тоже только также когда тогда потом после перед через между около найти ' +
            'нужно надо можно чтобы если или либо даже уже ещё еще очень всех всем всего свой своя свои своих',
    ]
        .join(' ')
        .split(/\s+/),
);

/** Up to `max` topic words of a free text (a quest title, a place): names keep their case, other words go lower. */
export function keywordTopics(text: string, max = 4): string[] {
    const words = text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];
    const out: string[] = [];
    words.forEach((word, index) => {
        const lower = normalizeName(word);
        const name = index > 0 && /^\p{Lu}/u.test(word);
        if (lower.length < (name ? 3 : 4) || STOP_WORDS.has(lower)) return;
        out.push(name ? word : lower);
    });
    return uniqueStrings(out).slice(0, Math.max(0, max));
}

/** Topic words of a name: the name, a few aliases and its Russian forms (when the world model knows them). */
export function nameTopics(name: string, lookup?: NameLookup): string[] {
    const info = lookup?.(name) ?? null;
    const canonical = info?.name || name;
    return uniqueStrings([
        canonical,
        name,
        ...(info?.aliases ?? []).slice(0, NAME_ALIASES),
        ...(info?.forms ?? []).slice(0, NAME_FORMS),
    ]);
}

/** Topics without the persona's names (the persona comes up in every message) and capped. */
export function cleanTopics(topics: readonly string[], persona: readonly string[]): string[] {
    const skip = new Set(persona.map(normalizeName).filter(Boolean));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const topic of topics) {
        const key = normalizeName(topic);
        if (key.length < 2 || skip.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(topic.trim());
    }
    return out.slice(0, MAX_TOPICS);
}

/** «A», «A and B», «A, B and C». */
export function joinNames(names: readonly string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ drafts */

/** A fact before it is stored: the cast of the turn is added as the knowers. */
export interface FactDraft {
    text: string;
    topics: string[];
    /** Who knows it besides the cast (the subject of the event, the people a sentence names). */
    subjects: string[];
    quote?: string;
}

/** What a signal of the signals service carries (Signal of src/shared/contracts.ts). */
export interface SignalLike {
    kind: string;
    data?: Record<string, unknown>;
}

export interface DraftOptions {
    /** The persona's canonical name ('' when unknown). */
    persona: string;
    /** Every name and form of the persona (left out of topics). */
    personaNames?: readonly string[];
    lookup?: NameLookup;
}

/** Every name of the persona: left out of topics (the persona comes up in every message). */
function personaTopics(options: DraftOptions): string[] {
    const own = options.persona.trim() ? nameTopics(options.persona, options.lookup) : [];
    return [...own, ...(options.personaNames ?? [])];
}

function draft(text: string, topics: string[], subjects: string[], options: DraftOptions): FactDraft {
    return {
        text: truncate(text, MAX_TEXT),
        topics: cleanTopics(topics, personaTopics(options)),
        subjects: nameList(subjects),
    };
}

/** Facts of one turn's signals (kinds that tell what happened in the scene; the rest says nothing new to know). */
export function eventsFromSignals(signals: readonly SignalLike[], options: DraftOptions): FactDraft[] {
    const persona = options.persona.trim() || 'the user';
    const out: FactDraft[] = [];
    const names = (name: string) => nameTopics(name, options.lookup);
    for (const signal of signals) {
        const data = isDict(signal.data) ? signal.data : {};
        const name = str(data.name);
        switch (signal.kind) {
            case 'quest.added':
            case 'quest.removed': {
                const title = str(data.title);
                if (!title) break;
                const label = signal.kind === 'quest.added' ? 'Quest begun' : 'Quest over';
                out.push(draft(`${label}: ${title}`, keywordTopics(title), [], options));
                break;
            }
            case 'relationship.changed': {
                const to = str(data.to);
                if (!name || !to) break;
                const from = str(data.from);
                const text = `${name} now regards ${persona} as ${to}${from ? ` (was ${from})` : ''}`;
                out.push(draft(text, names(name), [name], options));
                break;
            }
            case 'location.changed': {
                const to = str(data.to);
                if (!to) break;
                const place = options.lookup?.(to);
                const topics = place ? nameTopics(to, options.lookup) : [];
                out.push(draft(`${persona} went to ${to}`, [...topics, ...keywordTopics(to)], [], options));
                break;
            }
            case 'character.appeared':
                if (name) out.push(draft(`${name} joined the scene`, names(name), [name], options));
                break;
            case 'character.left':
                if (name) out.push(draft(`${name} left the scene`, names(name), [name], options));
                break;
            case 'name.new':
                if (name) out.push(draft(`The name ${name} came up`, [name], [], options));
                break;
            case 'alias.added': {
                const aliases = Array.isArray(data.aliases) ? uniqueStrings(data.aliases).slice(0, 3) : [];
                if (!name || !aliases.length) break;
                out.push(
                    draft(
                        `${name} is also called ${joinNames(aliases)}`,
                        [...names(name), ...aliases],
                        [name],
                        options,
                    ),
                );
                break;
            }
            default:
                break;
        }
    }
    return dedupeDrafts(out);
}

interface EventWord {
    gloss: string;
    re: RegExp;
    topics: string[];
}

// A left boundary that works for Cyrillic too (`\b` only knows ASCII letters).
const L = '(?<![\\p{L}\\p{N}_])';

function word(pattern: string): RegExp {
    return new RegExp(`${L}(?:${pattern})`, 'iu');
}

/** Key event words (RU/EN), in priority order; topics are what makes the topic «come up» again. */
export const EVENT_WORDS: readonly EventWord[] = [
    {
        gloss: 'killing',
        re: word('убил|убила|убили|убит|убийств|зарезал|застрелил|прикончил|kill(?:ed|s|ing)?\\b|murder'),
        topics: ['убийство', 'убит', 'kill', 'murder'],
    },
    {
        gloss: 'death',
        re: word('умер|умерла|умерли|погиб|скончал|мёртв|мертв|died\\b|dead\\b|death\\b'),
        topics: ['смерть', 'погиб', 'умер', 'death', 'dead'],
    },
    {
        gloss: 'betrayal',
        re: word('предал|предала|предательств|betray'),
        topics: ['предательство', 'предал', 'betray'],
    },
    {
        gloss: 'confession of love',
        re: word('люблю тебя|признал(?:ся|ась) в любви|i love you|confess(?:ed|es)? (?:her|his|their) love'),
        topics: ['любовь', 'люблю', 'love'],
    },
    { gloss: 'kiss', re: word('поцелу|поцелов|kiss'), topics: ['поцелуй', 'поцеловал', 'kiss'] },
    {
        gloss: 'theft',
        re: word('украл|украла|украли|похитил|кража|stole\\b|stolen\\b|theft'),
        topics: ['кража', 'украл', 'похищ', 'stole', 'theft'],
    },
    {
        gloss: 'injury',
        re: word('ранен|ранил|ранила|wounded|injured'),
        topics: ['ранен', 'рана', 'wound', 'injur'],
    },
    { gloss: 'pregnancy', re: word('беремен|pregnan'), topics: ['беременность', 'pregnan'] },
    {
        gloss: 'engagement or marriage',
        re: word('помолв|обручил|свадьб|женил|замуж|married|engaged|wedding'),
        topics: ['свадьба', 'помолвка', 'marriage', 'wedding', 'engage'],
    },
    {
        gloss: 'escape',
        re: word('сбежал|сбежала|сбежали|побег|escaped'),
        topics: ['побег', 'сбежал', 'escape'],
    },
    { gloss: 'arrest', re: word('арестова|под арест|arrested'), topics: ['арест', 'arrest'] },
    {
        gloss: 'a revealed secret',
        re: word('тайн|секрет|настоящее имя|secret|real name|true identity'),
        topics: ['тайна', 'секрет', 'secret'],
    },
];

/** Sentences of a reply (line breaks and sentence ends split; quotes and dialogue dashes stay). */
export function splitSentences(text: string): string[] {
    return text
        .split(/\n+|(?<=[.!?…])["»”]?\s+/u)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part.length <= MAX_SENTENCE);
}

export interface ReplyEventOptions extends DraftOptions {
    /** Characters (and the persona) the reply may name; a sentence must name one of them. */
    names: readonly NameInfo[];
    max?: number;
}

/** The first key event of each sentence that names someone: «Kiss involving Anna and Kai», at most `max` per reply. */
export function eventsFromReply(text: string, options: ReplyEventOptions): FactDraft[] {
    const max = options.max ?? MAX_REPLY_EVENTS;
    if (!text.trim() || max <= 0 || !options.names.length) return [];
    const matcher = buildMentionMatcher(
        options.names.map((info) => ({
            id: info.name,
            needles: mentionNeedles([info.name, ...(info.aliases ?? [])], info.forms ?? [], !info.forms?.length),
        })),
    );
    const out: FactDraft[] = [];
    for (const sentence of splitSentences(text)) {
        const event = EVENT_WORDS.find((item) => item.re.test(sentence));
        if (!event) continue;
        const named = findMentions(matcher, sentence);
        if (!named.length) continue;
        const gloss = `${event.gloss.charAt(0).toUpperCase()}${event.gloss.slice(1)}`;
        const topics = [...named.flatMap((name) => nameTopics(name, options.lookup)), ...event.topics];
        const fact = draft(`${gloss} involving ${joinNames(named)}`, topics, named, options);
        fact.quote = truncate(sentence, MAX_QUOTE);
        if (out.some((item) => normalizeName(item.text) === normalizeName(fact.text))) continue;
        out.push(fact);
        if (out.length >= max) break;
    }
    return out;
}

function dedupeDrafts(drafts: FactDraft[]): FactDraft[] {
    const seen = new Set<string>();
    return drafts.filter((item) => {
        const key = normalizeName(item.text);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/* ------------------------------------------------------------------ the store */

export interface AddOptions {
    /** The cast of the turn (canonical names) and the persona. */
    knownBy: readonly string[];
    sourceMessage: number;
    at: number;
    newId: () => string;
    max: number;
}

/** Same text from the same message is one fact (a turn read twice adds nothing). */
export function sameFact(a: Pick<KnowledgeFactData, 'text' | 'sourceMessage'>, b: typeof a): boolean {
    return a.sourceMessage === b.sourceMessage && normalizeName(a.text) === normalizeName(b.text);
}

/** Adds the drafts of one turn (knowers: the cast plus each draft's subjects) and caps the store; returns the new facts. */
export function addDrafts(
    doc: KnowledgeDocData,
    drafts: readonly FactDraft[],
    options: AddOptions,
): KnowledgeFactData[] {
    const added: KnowledgeFactData[] = [];
    for (const item of drafts) {
        const candidate = { text: item.text, sourceMessage: options.sourceMessage };
        if (!item.text.trim() || doc.facts.some((fact) => !fact.secret && sameFact(fact, candidate))) continue;
        const fact: KnowledgeFactData = {
            id: options.newId(),
            text: item.text,
            topics: [...item.topics],
            knownBy: nameList([...options.knownBy, ...item.subjects]),
            secret: false,
            sourceMessage: options.sourceMessage,
            at: options.at,
        };
        if (item.quote) fact.quote = item.quote;
        doc.facts.push(fact);
        added.push(fact);
    }
    if (added.length) doc.facts = capFacts(doc.facts, options.max);
    return added.filter((fact) => doc.facts.includes(fact));
}

/** At most `max` facts: the oldest scene facts go first, secrets only when nothing else is left. */
export function capFacts(facts: readonly KnowledgeFactData[], max: number): KnowledgeFactData[] {
    const limit = Math.max(0, Math.floor(max));
    if (facts.length <= limit) return [...facts];
    let excess = facts.length - limit;
    const drop = new Set<KnowledgeFactData>();
    const order = [...facts].sort((a, b) => a.at - b.at || a.sourceMessage - b.sourceMessage);
    for (const fact of order) {
        if (excess <= 0) break;
        if (fact.secret) continue;
        drop.add(fact);
        excess--;
    }
    for (const fact of order) {
        if (excess <= 0) break;
        if (drop.has(fact)) continue;
        drop.add(fact);
        excess--;
    }
    return facts.filter((fact) => !drop.has(fact));
}

/**
 * A swiped, deleted or edited message takes its facts with it: a deletion everything from that index on (ST reports
 * the new chat length), a swipe the facts of that message, an edit only its scene facts (they are read again; secrets
 * came from the revision and keep the user's marks). Returns the number removed.
 */
export function dropForMessage(doc: KnowledgeDocData, index: number, reason: 'swiped' | 'deleted' | 'edited'): number {
    const before = doc.facts.length;
    doc.facts = doc.facts.filter((fact) => {
        if (reason === 'deleted') return fact.sourceMessage < index;
        if (fact.sourceMessage !== index) return true;
        return reason === 'edited' && fact.secret;
    });
    return before - doc.facts.length;
}

/** The fact names this character among its knowers (normalised names). */
export function knows(fact: Pick<KnowledgeFactData, 'knownBy'>, names: readonly string[]): boolean {
    const keys = new Set(names.map(normalizeName).filter(Boolean));
    return fact.knownBy.some((name) => keys.has(normalizeName(name)));
}

/** Marks the character as knowing (or not knowing) the fact; false when nothing changed. */
export function setKnown(fact: KnowledgeFactData, name: string, known: boolean): boolean {
    const key = normalizeName(name);
    if (!key) return false;
    const has = fact.knownBy.some((item) => normalizeName(item) === key);
    if (has === known) return false;
    fact.knownBy = known ? [...fact.knownBy, name.trim()] : fact.knownBy.filter((item) => normalizeName(item) !== key);
    return true;
}
