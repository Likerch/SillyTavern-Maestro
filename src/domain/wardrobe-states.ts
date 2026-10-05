// Character and place states (plan M27 п.2–3, research/qvink-nai-studio.md §B6 «temporary condition → states[]»):
// the DES tracker says a character is wet, wounded, tired or drunk, a place is ruined, on fire, decorated, it is night
// or raining. Rules here turn that wording (Russian or English, negations skipped) into state ids with English NAI
// tags, find the matching state of a passport (NAI Studio's presets: wet, injured, sleepy…), and keep the two-turn
// bookkeeping: a state Maestro switched on goes off when its wording has been missing for two committed turns.
// Lasting place states (ruined, decorated, abandoned) do not go by themselves. No AI. Pure.

export interface StateRule {
    /** Maestro's id (also the passport state id when the passport has no matching state). */
    id: string;
    /** English NAI tags of a new state. */
    tags: string;
    /** Passport state ids or tags that mean the same (NAI presets first). */
    aliases: readonly string[];
    pattern: RegExp;
    /** Stays until changed by hand (places: ruined, decorated, abandoned). */
    lasting?: boolean;
    /** One of a group at a time (time of day, season): a new one switches the others off at once. */
    group?: string;
}

/** Turns that a state Maestro switched on may be missing before it goes off. */
export const MISSING_TURNS = 2;

const L = '(?<!\\p{L})';

function rule(
    id: string,
    tags: string,
    aliases: readonly string[],
    source: string,
    extra: Pick<StateRule, 'lasting' | 'group'> = {},
): StateRule {
    return { id, tags, aliases, pattern: new RegExp(source, 'giu'), ...extra };
}

// prettier-ignore
export const CHARACTER_STATE_RULES: readonly StateRule[] = [
    rule('wet', 'wet, wet hair, wet clothes', ['wet', 'soaked', 'drenched'],
        `${L}(?:мокр|промок|вымок|промоч)\\p{L}*(?!\\p{L})(?!\\s+от\\s+(?:пота|крови))|\\b(?:wet|soaked|drenched|dripping)\\b(?!\\s+(?:in|with)\\s+(?:sweat|blood))`),
    rule('injured', 'injury, bandages, bruise', ['injured', 'wounded', 'injury', 'hurt', 'bandages', 'bruise'],
        `${L}(?:ранен\\p{L}*|ран(?:а|ы|ой|ами|ах)(?!\\p{L})|перевязан\\p{L}*|забинтован\\p{L}*|бинт\\p{L}*|синяк\\p{L}*|ушиб\\p{L}*|ссадин\\p{L}*|порез\\p{L}*)|\\b(?:wound(?:ed|s)?|injur(?:ed|y|ies)|bandage[sd]?|bruise[sd]?|hurt)\\b`),
    rule('bloody', 'blood, blood on clothes', ['bloody', 'blood', 'bloodied'],
        `${L}(?:в\\s+крови|окровавлен\\p{L}*|кровь\\s+на|в\\s+пятнах\\s+крови|кровоточ\\p{L}*|забрызган\\p{L}*\\s+кровью)|\\b(?:blood(?:y|ied|-?stained|-?soaked)?|bleeding|covered\\s+in\\s+blood)\\b`),
    rule('tired', 'tired, half-closed eyes', ['tired', 'sleepy', 'exhausted', 'fatigued'],
        `${L}(?:устал\\p{L}*|уставш\\p{L}*|утомл\\p{L}*|измотан\\p{L}*|изнур\\p{L}*|вымотан\\p{L}*|обессил\\p{L}*|сонн\\p{L}*|без\\s+сил)|\\b(?:tired|exhausted|weary|fatigued?|sleepy|drowsy|worn\\s+out)\\b`),
    rule('dirty', 'dirty, dirty face, dirty clothes', ['dirty', 'muddy', 'grimy'],
        `${L}(?:грязн\\p{L}*|в\\s+грязи|испачкан\\p{L}*|перепачкан\\p{L}*|чумаз\\p{L}*)|\\b(?:dirty|muddy|grimy|filthy|covered\\s+in\\s+(?:mud|dirt|soot))\\b`),
    rule('sweaty', 'sweat', ['sweaty', 'sweat', 'sweating'],
        `${L}(?:вспотевш\\p{L}*|вспотел\\p{L}*|потн\\p{L}*|в\\s+поту|испарин\\p{L}*)|\\b(?:sweaty|sweating|drenched\\s+in\\s+sweat|covered\\s+in\\s+sweat)\\b`),
    rule('drunk', 'drunk, blush', ['drunk', 'tipsy'],
        `${L}(?:пьян\\p{L}*|опьянен\\p{L}*|нетрезв\\p{L}*|захмелевш\\p{L}*|подвыпивш\\p{L}*|навеселе|под\\s+хмелем)|\\b(?:drunk(?:en)?|tipsy|intoxicated|inebriated)\\b`),
    rule('messy', 'messy hair, disheveled', ['messy', 'disheveled', 'dishevelled'],
        `${L}(?:растреп\\p{L}*|взъерош\\p{L}*|всклокоч\\p{L}*|встрепан\\p{L}*)|\\b(?:dishevell?ed|messy\\s+hair|tousled|unkempt)\\b`),
    rule('tears', 'tears, crying', ['tears', 'crying'],
        `${L}(?:в\\s+слезах|слезы|слезами|заплакан\\p{L}*|плачет|плачущ\\p{L}*|рыдает|рыдающ\\p{L}*|всхлипыва\\p{L}*)|\\b(?:in\\s+tears|tearful|crying|sobbing|weeping|tear-streaked)\\b`),
    rule('sick', 'sick, pale skin', ['sick', 'ill', 'fever'],
        `${L}(?:болен|больна|болеет|болезненн\\p{L}*|лихорад\\p{L}*|простужен\\p{L}*|в\\s+жару)|\\b(?:sick|ill|feverish|fever|nauseous)\\b`),
    rule('cold', 'shivering, cold', ['cold', 'shivering', 'freezing'],
        `${L}(?:замерз\\p{L}*|продрог\\p{L}*|озяб\\p{L}*|окоченел\\p{L}*|дрожит\\s+от\\s+холода)|\\b(?:shivering|freezing|frozen|chilled\\s+to\\s+the\\s+bone)\\b`),
    rule('bound', 'bound, restrained', ['bound', 'restrained', 'tied up'],
        `${L}(?:связан\\p{L}*|в\\s+цепях|в\\s+оковах|скован\\p{L}*|в\\s+наручниках)|\\b(?:tied\\s+up|in\\s+chains|shackled|handcuffed|restrained)\\b`),
];

// prettier-ignore
export const PLACE_STATE_RULES: readonly StateRule[] = [
    rule('ruined', 'ruins, rubble', ['ruined', 'ruins', 'destroyed'],
        `${L}(?:руин\\p{L}*|разрушен\\p{L}*|разгром\\p{L}*|развалин\\p{L}*|обрушен\\p{L}*|разоренн?\\p{L}*)|\\b(?:ruin(?:s|ed)|destroyed|wrecked|collapsed|in\\s+ruins|rubble)\\b`,
        { lasting: true }),
    rule('decorated', 'decorations, festive', ['decorated', 'decorations', 'festive'],
        `${L}(?:украшен\\p{L}*|празднично|праздничн\\p{L}*\\s+убранств\\p{L}*|гирлянд\\p{L}*|убран\\p{L}*\\s+(?:цвет|лент|флаг))|\\b(?:decorated|decorations|festooned|garlands|festive)\\b`,
        { lasting: true }),
    rule('abandoned', 'abandoned, overgrown', ['abandoned', 'overgrown'],
        `${L}(?:заброшен\\p{L}*|запустени\\p{L}*|покинут\\p{L}*)|\\b(?:abandoned|derelict|deserted|overgrown)\\b`,
        { lasting: true }),
    rule('burning', 'fire, burning, smoke', ['burning', 'fire', 'on fire'],
        `${L}(?:пожар\\p{L}*|в\\s+огне|полыха\\p{L}*|охвачен\\p{L}*\\s+(?:огнем|пламенем)|в\\s+пламени|объят\\p{L}*\\s+пламенем)|\\b(?:on\\s+fire|ablaze|in\\s+flames|aflame|burn(?:ing|ed|t)\\s+down|engulfed)\\b`),
    rule('night', 'night, dark', ['night', 'dark'],
        `${L}(?:ночь|ночью|ночн\\p{L}*|полноч\\p{L}*|глубокой\\s+ночи)|\\b(?:night|nighttime|midnight)\\b`,
        { group: 'time' }),
    rule('evening', 'evening, sunset', ['evening', 'sunset', 'dusk'],
        `${L}(?:вечер(?!инк)\\p{L}*|закат\\p{L}*|сумерк\\p{L}*|сумерек)|\\b(?:evening|sunset|dusk|twilight)\\b`,
        { group: 'time' }),
    rule('dawn', 'dawn, morning', ['dawn', 'morning', 'sunrise'],
        `${L}(?:рассвет\\p{L}*|утро|утром|утрен\\p{L}*|заря|зари|на\\s+заре)|\\b(?:dawn|sunrise|daybreak|morning)\\b`,
        { group: 'time' }),
    rule('rain', 'rain', ['rain', 'raining'],
        `${L}(?:дожд\\p{L}*|ливн\\p{L}*|ливень|морос\\p{L}*)|\\b(?:rain(?:ing|y|s)?|downpour|drizzl(?:e|ing))\\b`),
    rule('snow', 'snow, snowing', ['snow', 'snowing'],
        `${L}(?:снег\\p{L}*|снеж\\p{L}*|метел\\p{L}*|метель|вьюг\\p{L}*|пург\\p{L}*)|\\b(?:snow(?:ing|y|fall)?|blizzard)\\b`),
    rule('fog', 'fog', ['fog', 'mist', 'foggy'],
        `${L}(?:туман\\p{L}*|мгл\\p{L}*|дымк\\p{L}*)|\\b(?:fog(?:gy)?|mist(?:y)?|haze)\\b`),
    rule('storm', 'storm, lightning, dark clouds', ['storm', 'thunderstorm', 'lightning'],
        `${L}(?:гроз\\p{L}*|шторм\\p{L}*|бур[яиеюй](?!\\p{L})|бурей|молни\\p{L}*|гром\\p{L}*)|\\b(?:storm(?:y|ing)?|thunder(?:storm)?|lightning|tempest)\\b`),
    rule('winter', 'winter', ['winter'],
        `${L}(?:зим\\p{L}*|декабр\\p{L}*|январ\\p{L}*|феврал\\p{L}*)|\\b(?:winter|december|january|february)\\b`,
        { group: 'season' }),
    rule('spring', 'spring (season)', ['spring'],
        `${L}(?:весн\\p{L}*|весен\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йя](?!\\p{L}))|\\b(?:spring|springtime|april)\\b|\\b(?:march|may)\\s+\\d|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:march|may)\\b`,
        { group: 'season' }),
    rule('summer', 'summer', ['summer'],
        `${L}(?:лет(?:о|ом|а|ний|няя|нее|них|ним|нюю)(?!\\p{L})|июн\\p{L}*|июл\\p{L}*|август\\p{L}*)|\\b(?:summer|june|july|august)\\b`,
        { group: 'season' }),
    rule('autumn', 'autumn, autumn leaves', ['autumn', 'fall'],
        `${L}(?:осен\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*)|\\b(?:autumn|september|october|november)\\b`,
        { group: 'season' }),
];

/** A negation right before the match in the same clause («не ранен», "not wounded", "no longer wet"). */
const NEGATION_RE =
    /(?:^|[\s,(])(?:не|нет|без|уже\s+не|ни|not|no|never|without|no\s+longer|isn't|aren't|wasn't|weren't|barely|hardly)\s+(?:\S+\s+)?$/iu;
const CLAUSE_BREAK_RE = /[.;!?\n]/;

function normalize(text: string): string {
    return String(text ?? '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ');
}

function negated(text: string, at: number): boolean {
    let start = Math.max(0, at - 24);
    const before = text.slice(start, at);
    const cut = Math.max(...[...before].map((char, index) => (CLAUSE_BREAK_RE.test(char) ? index : -1)));
    if (cut >= 0) start += cut + 1;
    return NEGATION_RE.test(text.slice(start, at));
}

/** State ids whose wording occurs in a text (not negated), in rule order. */
export function detectStates(text: string, rules: readonly StateRule[] = CHARACTER_STATE_RULES): string[] {
    const value = normalize(text);
    if (!value.trim()) return [];
    const out: string[] = [];
    for (const item of rules) {
        item.pattern.lastIndex = 0;
        for (const match of value.matchAll(item.pattern)) {
            if (negated(value, match.index ?? 0)) continue;
            out.push(item.id);
            break;
        }
    }
    // One state of a group: the last one written wins (a time of day, a season).
    const groups = new Map<string, string>();
    for (const id of out) {
        const group = rules.find((item) => item.id === id)?.group;
        if (!group) continue;
        const previous = groups.get(group);
        if (previous === undefined || lastIndexOf(value, id, rules) > lastIndexOf(value, previous, rules)) {
            groups.set(group, id);
        }
    }
    return out.filter((id) => {
        const group = rules.find((item) => item.id === id)?.group;
        return !group || groups.get(group) === id;
    });
}

function lastIndexOf(text: string, id: string, rules: readonly StateRule[]): number {
    const item = rules.find((candidate) => candidate.id === id);
    if (!item) return -1;
    let last = -1;
    item.pattern.lastIndex = 0;
    for (const match of text.matchAll(item.pattern)) last = match.index ?? last;
    return last;
}

/** Hour of a DES time («23:40», "11:40 PM", «7 утра»); null when none. */
export function hourOf(time: string | undefined): number | null {
    if (!time) return null;
    const value = normalize(time);
    const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/.exec(value);
    if (!match?.[1]) return null;
    let hour = Number(match[1]);
    if (!Number.isFinite(hour) || hour > 24) return null;
    const suffix = match[3]?.replace(/\./g, '');
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (!suffix && /вечер/.test(value) && hour < 12) hour += 12;
    else if (!suffix && /ночи/.test(value) && hour >= 6 && hour < 12) hour += 12;
    return hour % 24;
}

/** Time of day by the clock: night 22–4, dawn 5–7, evening 18–21; null by day or when unknown. */
export function timeOfDayState(time: string | undefined): 'night' | 'dawn' | 'evening' | null {
    const hour = hourOf(time);
    if (hour === null) return null;
    if (hour >= 22 || hour <= 4) return 'night';
    if (hour >= 5 && hour <= 7) return 'dawn';
    if (hour >= 18) return 'evening';
    return null;
}

export function stateRule(id: string, rules: readonly StateRule[]): StateRule | undefined {
    return rules.find((item) => item.id === id);
}

function tagSet(tags: string): Set<string> {
    return new Set(
        tags
            .split(',')
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean),
    );
}

/**
 * The passport state that stands for a rule: same id, an alias as id, or the rule's first tag among its tags
 * (NAI's preset 'sleepy' stands for 'tired'). Null when the passport has none.
 */
export function findPassportState<T extends { id: string; tags: string }>(
    states: readonly T[],
    item: StateRule,
): T | null {
    const id = item.id.toLowerCase();
    const byId = states.find((state) => state.id.trim().toLowerCase() === id);
    if (byId) return byId;
    const aliases = item.aliases.map((alias) => alias.toLowerCase());
    const byAlias = states.find((state) => aliases.includes(state.id.trim().toLowerCase()));
    if (byAlias) return byAlias;
    return (
        states.find((state) => {
            const tags = tagSet(state.tags);
            return aliases.some((alias) => tags.has(alias));
        }) ?? null
    );
}

/** A state Maestro switched on (or is waiting on), per passport or place. */
export interface TrackedState {
    /** Committed message index it was switched on at. */
    since: number;
    /** Committed turns in a row without its wording. */
    missing: number;
    /** The passport state id it was written to. */
    stateId: string;
    /** The user undid it: not switched on again until its wording is gone. */
    suppressed?: boolean;
    /** Place passports: tags added to `tags` (only these are removed again). */
    added?: string[];
    /** Place states: the location passport written to. */
    passportId?: string;
}

export interface StepOptions {
    rules: readonly StateRule[];
    /** The passport has this rule's state on already (by the card or by hand): not Maestro's to track. */
    alreadyOn?: (id: string) => boolean;
}

export interface StepResult {
    /** Rules to switch on now (new wording). */
    on: string[];
    /** Rules to switch off now (wording gone for MISSING_TURNS turns, or replaced in its group). */
    off: string[];
    /** Suppressed rules whose wording is gone: forgotten without a write. */
    forgotten: string[];
}

/**
 * One committed turn of a subject: `detected` rule ids against what is tracked. Updates the counters of `tracked`
 * in place (the caller adds entries for `on` once written and removes those of `off` / `forgotten`).
 */
export function stepTracked(
    tracked: Record<string, TrackedState>,
    detected: readonly string[],
    options: StepOptions,
): StepResult {
    const result: StepResult = { on: [], off: [], forgotten: [] };
    const now = new Set(detected);
    for (const id of detected) {
        const entry = tracked[id];
        if (entry) {
            entry.missing = 0;
            continue;
        }
        if (options.alreadyOn?.(id)) continue;
        result.on.push(id);
        const group = stateRule(id, options.rules)?.group;
        if (!group) continue;
        for (const [other, item] of Object.entries(tracked)) {
            if (other === id || now.has(other) || stateRule(other, options.rules)?.group !== group) continue;
            if (item.suppressed) result.forgotten.push(other);
            else result.off.push(other);
        }
    }
    for (const [id, entry] of Object.entries(tracked)) {
        if (now.has(id) || result.off.includes(id) || result.forgotten.includes(id)) continue;
        if (stateRule(id, options.rules)?.lasting && !entry.suppressed) continue;
        entry.missing += 1;
        if (entry.missing < MISSING_TURNS) continue;
        if (entry.suppressed) result.forgotten.push(id);
        else result.off.push(id);
    }
    return result;
}

/** Tags of `extra` not yet in `tags` (case-insensitive). */
export function missingTags(tags: string, extra: string): string[] {
    const have = tagSet(tags);
    const out: string[] = [];
    for (const tag of extra.split(',')) {
        const value = tag.trim().toLowerCase();
        if (value && !have.has(value) && !out.includes(value)) out.push(value);
    }
    return out;
}

/** `tags` plus `extra` (as a comma list, no duplicates). */
export function addTags(tags: string, extra: readonly string[]): string {
    const list = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    const have = new Set(list.map((tag) => tag.toLowerCase()));
    for (const tag of extra) {
        const value = tag.trim();
        if (value && !have.has(value.toLowerCase())) {
            have.add(value.toLowerCase());
            list.push(value);
        }
    }
    return list.join(', ');
}

/** `tags` without `drop` (case-insensitive). */
export function removeTags(tags: string, drop: readonly string[]): string {
    const gone = new Set(drop.map((tag) => tag.trim().toLowerCase()));
    return tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag && !gone.has(tag.toLowerCase()))
        .join(', ');
}
