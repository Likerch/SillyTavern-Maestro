// M25 «Механики», what the HUD marks besides the values (release 1.25):
// - the latest story reply's changes, a small chip next to each value it changed («−15», «+1»; «→ ранен» in the words
//   view), lit up for a moment when it first shows (not with reduced motion); its tooltip says where it came from and,
//   while that reply is not committed yet (MechanicsApi.provisionalIndex), that a swipe takes it back. Values only:
//   conditions and items have their own chips. changesOf with place 'hud' already drops what the player may not see
//   (hidden-unrevealed and secret values), and a chip only stands next to a value the HUD draws;
// - why values may not follow the story now (MechanicsApi.trackingHealth): the 'warn' ones behind ⚠ in the HUD's
//   header, the 'info' ones a quiet line under the side panel (hud.ts).
// Both are optional parts of the API (fakes of older contracts lack them): without them nothing is marked.
import { formatNumber, listDelta, plainValue, sameWords, shownValue } from '../../domain/mechanics-view';
import type { I18n } from '../../shared/contracts';
import { el } from '../../ui/components/dom';
import type { AttributeDef, AttributeValue, MechanicDef, MechanicsApi, TrackingProblem, Visibility } from './api';
import { translator, visibilityOf, wordsText } from './view-values';

type T = (key: string, params?: Record<string, string | number>) => string;

/** A chip stays «new» (its highlight runs on) this long after it first shows, through the HUD's redraws. */
export const DELTA_FRESH_MS = 1600;
/** Longer chips are cut («→ очень длинное сл…»). */
const DELTA_MAX = 24;

/** The key of a value of a holder: `mechanic.attribute@holder` (the holder in lower case, ё as е). */
export function deltaKey(mechanicId: string, attribute: string, holder: string): string {
    return `${mechanicId}.${attribute}@${holder.trim().toLowerCase().replace(/ё/g, 'е')}`;
}

/** The latest story reply of the chat (not the user's, not a system message); -1 when there is none. */
export function latestReplyIndex(chat: readonly STChatMessage[] | null | undefined): number {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) return i;
    }
    return -1;
}

const cut = (text: string) => (text.length > DELTA_MAX ? `${text.slice(0, DELTA_MAX - 1)}…` : text);

/**
 * How a value's change reads on its chip: numbers by how much («−15», «+1»; the «icon» view ↑ / ↓), the words view by
 * the new words («→ ранен»), lists by what came and went («+ огонь»), the rest by the new value («→ тепло»). Null when
 * nothing the player sees changed (the same number, a change inside one band of words).
 */
export function deltaText(
    t: T,
    attribute: AttributeDef,
    visibility: Pick<Visibility, 'view' | 'words'>,
    from: AttributeValue | null,
    to: AttributeValue,
): string | null {
    const after = shownValue(attribute, visibility, to);
    if (!after) return null;
    if (after.view === 'words') {
        const before = shownValue(attribute, visibility, from);
        if (before && sameWords(before.words, after.words)) return null;
        return cut(`→ ${wordsText(t, after.words)}`);
    }
    if (attribute.kind === 'number') {
        if (typeof to !== 'number') return null;
        if (typeof from !== 'number') return `→ ${formatNumber(to)}`;
        const difference = to - from;
        if (Math.abs(difference) < 1e-9) return null;
        if (after.view === 'icon') return difference > 0 ? '↑' : '↓';
        return `${difference > 0 ? '+' : '−'}${formatNumber(Math.abs(difference))}`;
    }
    if (attribute.kind === 'list') {
        const { added, removed } = listDelta(from, to);
        const parts = [...added.map((item) => `+ ${item}`), ...removed.map((item) => `− ${item}`)];
        return parts.length ? cut(parts.join(', ')) : null;
    }
    if (plainValue(from) === plainValue(to)) return null;
    return cut(`→ ${after.text}`);
}

/** The value changes a reply made, by deltaKey, as their chips read (one value changed twice: first to last). */
export function replyDeltas(i18n: Pick<I18n, 't'>, api: MechanicsApi, index: number): Map<string, string> {
    const out = new Map<string, string>();
    if (index < 0 || !api.changesOf) return out;
    let changes: ReturnType<NonNullable<MechanicsApi['changesOf']>>;
    try {
        changes = api.changesOf(index, { place: 'hud' });
    } catch {
        return out;
    }
    const spans = new Map<
        string,
        { def: MechanicDef; attribute: AttributeDef; from: AttributeValue | null; to: AttributeValue }
    >();
    for (const change of Array.isArray(changes) ? changes : []) {
        // Values only: conditions, items, reveals and the fight are not values.
        if (change.kind) continue;
        const key = deltaKey(change.mechanicId, change.attribute, change.holder);
        const known = spans.get(key);
        if (known) {
            known.to = change.to;
            continue;
        }
        let def: MechanicDef | null;
        try {
            def = api.get(change.mechanicId);
        } catch {
            def = null;
        }
        const attribute = def?.attributes.find((item) => item.id === change.attribute);
        if (!def || !attribute) continue;
        spans.set(key, { def, attribute, from: change.from, to: change.to });
    }
    const t = translator(i18n);
    for (const [key, span] of spans) {
        const visibility = visibilityOf(api, span.def, span.attribute);
        if (!visibility) continue;
        const text = deltaText(t, span.attribute, visibility, span.from, span.to);
        if (text) out.set(key, text);
    }
    return out;
}

/** The reply whose changes are not committed yet (a swipe takes them back); -1 when none or unknown. */
export function provisionalReply(api: MechanicsApi): number {
    try {
        const index = api.provisionalIndex?.();
        return typeof index === 'number' && Number.isInteger(index) ? index : -1;
    } catch {
        return -1;
    }
}

/**
 * The chip of a change: «−15» with «Из последнего ответа» (and «· свайп отменит» while the reply is provisional);
 * `age`: how long ago it first showed while it is new (its highlight goes on from there), null when it is not new.
 */
export function deltaChip(t: T, text: string, provisional: boolean, age: number | null): HTMLElement {
    const title = provisional ? `${t('m25.hud.delta')} · ${t('m25.hud.delta.swipe')}` : t('m25.hud.delta');
    const chip = el('span', {
        class: [
            'maestro-m25-hud-delta',
            provisional ? 'maestro-m25-hud-delta-provisional' : null,
            age !== null ? 'maestro-m25-hud-delta-new' : null,
        ],
        text,
        title,
        attrs: { 'aria-label': `${text} · ${title}` },
    });
    if (age) chip.style.animationDelay = `-${Math.round(age)}ms`;
    return chip;
}

/** When each chip first showed, for its highlight through the HUD's redraws; forgotten when the latest reply changes. */
export class DeltaFreshness {
    private index = -1;
    private readonly first = new Map<string, number>();

    /** How long ago this chip first showed (ms) while it is new; null once its highlight is over. */
    age(index: number, key: string, text: string, now = Date.now()): number | null {
        if (index !== this.index) {
            this.index = index;
            this.first.clear();
        }
        const id = `${key}|${text}`;
        const at = this.first.get(id);
        if (at === undefined) {
            this.first.set(id, now);
            return 0;
        }
        const age = now - at;
        return age < DELTA_FRESH_MS ? age : null;
    }
}

/** What keeps values from following the story: the 'warn' ones (⚠) and the 'info' ones (a quiet line). */
export function trackingProblems(api: MechanicsApi): { warn: TrackingProblem[]; info: TrackingProblem[] } {
    let list: unknown;
    try {
        list = api.trackingHealth?.() ?? [];
    } catch {
        list = [];
    }
    const problems = (Array.isArray(list) ? list : []).filter(
        (item): item is TrackingProblem => !!item && typeof (item as TrackingProblem).text === 'string',
    );
    return {
        warn: problems.filter((problem) => problem.level === 'warn'),
        info: problems.filter((problem) => problem.level === 'info'),
    };
}

/** Styles of the chips and the problems; scoped under the HUD's id. */
export function marksCss(id: string): string {
    const hud = `#${id}`;
    return `
${hud} .maestro-m25-hud-delta { display: inline-flex; align-items: center; flex: none; padding: 0 5px; border-radius: 8px;
    font-size: 0.85em; line-height: 1.4; white-space: nowrap; font-variant-numeric: tabular-nums; font-style: normal;
    background: rgba(127, 127, 127, 0.18); border: 1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.35)); }
${hud} .maestro-m25-hud-delta-provisional { border-style: dashed; }
${hud} .maestro-m25-hud-delta-new { animation: maestro-m25-hud-delta-in ${DELTA_FRESH_MS}ms ease-out both; }
@keyframes maestro-m25-hud-delta-in {
    0% { transform: scale(1.25); box-shadow: 0 0 0 2px var(--SmartThemeQuoteColor, #e0a84f);
        background: var(--SmartThemeQuoteColor, #e0a84f); }
    100% { transform: none; box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
    ${hud} .maestro-m25-hud-delta-new { animation: none; }
}
${hud} .maestro-btn.maestro-m25-hud-warn { color: var(--maestro-warn, #da5); }
${hud} .maestro-m25-hud-health { flex-direction: column; align-items: stretch; }
${hud} .maestro-m25-hud-health-item { overflow-wrap: anywhere; }
${hud} .maestro-m25-hud-health-item .maestro-muted { display: block; font-size: 0.9em; }
${hud} .maestro-m25-hud-health .maestro-btn { align-self: flex-start; }
${hud} .maestro-m25-hud-foot { flex: none; font-size: 0.85em; opacity: 0.75; overflow-wrap: anywhere; }
`;
}
