// M38 «Проверка промпта», where a fix goes (plan-2 §2 п. 5), pure: the user's preset layer for preset blocks (every
// kind, with the scope switch), a neighbour's own prompt text for the neighbours' slots (text edits only: roles and
// places are the neighbour's own settings), a Maestro setting for its own injections (switching a line off, moving the
// wardrobe line), advice only for the rest — the card, the author's note, lorebooks; BunnyMo never (P13). A role change
// to «system» for something inside the chat history is risky on a model that glues such messages to the turns around
// them (DeepSeek V4: that is how the tracker JSON and the dialogue colours were lost), so it is advice, not a button.
import type { AuditCapture, AuditItem, AuditRole } from './prompt-audit-map';
import type { AuditFix, FixScope } from './prompt-audit-rules';

/** Maestro's own injections that a setting switches off (and moves, for the wardrobe line). */
export const MAESTRO_SWITCHES: Readonly<Record<string, { path: string; off: unknown; depthPath?: string }>> = {
    wardrobe: { path: 'promptLine', off: false, depthPath: 'promptDepth' },
    messageStyle: { path: 'hint', off: false },
    offscreen: { path: 'rumours', off: false },
};

/** Neighbours whose prompt texts Maestro can change (through M36). */
const TEXT_OWNERS = new Set(['des', 'nai', 'qvink', 'desru', 'ck']);

export type AdviceReason =
    | 'bunnymo'
    | 'lore'
    | 'card'
    | 'authorsNote'
    | 'neighbourSetting'
    | 'maestro'
    | 'dramatis'
    | 'risky'
    | 'other'
    | 'missing';

export type FixRoute =
    | { route: 'preset'; identifier: string }
    | { route: 'neighbour'; candidates: string[] }
    | { route: 'maestro'; module: string; path: string; value: unknown }
    | { route: 'advice'; reason: AdviceReason };

/** A role change that the model's quirks make risky (null: safe). */
export function fixRisk(fix: AuditFix, item: AuditItem | undefined, quirks: readonly string[]): string | null {
    if (fix.kind !== 'role' || !item) return null;
    const inHistory = item.place === 'chat';
    if (fix.role === 'system' && inHistory && quirks.includes('systemMerge')) return 'systemMerge';
    if (fix.role === 'assistant' && inHistory && quirks.includes('assistantDepth')) return 'assistantDepth';
    return null;
}

/** Where a fix of this item goes. */
export function routeOf(item: AuditItem | undefined, fix: AuditFix, quirks: readonly string[] = []): FixRoute {
    if (!item) return { route: 'advice', reason: 'missing' };
    if (fixRisk(fix, item, quirks)) return { route: 'advice', reason: 'risky' };
    switch (item.owner) {
        case 'preset':
            return item.key ? { route: 'preset', identifier: item.key } : { route: 'advice', reason: 'missing' };
        case 'bunnymo':
            return { route: 'advice', reason: 'bunnymo' };
        case 'lore':
            return { route: 'advice', reason: 'lore' };
        case 'card':
            return { route: 'advice', reason: 'card' };
        case 'authorsNote':
            return { route: 'advice', reason: 'authorsNote' };
        case 'dramatis':
            // Dramatis's own block (release 1.17): Maestro never changes it, it only says where to change it.
            return { route: 'advice', reason: 'dramatis' };
        case 'maestro': {
            const module = item.module ?? '';
            const spec = MAESTRO_SWITCHES[module];
            if (spec && fix.kind === 'toggle') return { route: 'maestro', module, path: spec.path, value: spec.off };
            if (spec?.depthPath && fix.kind === 'move' && fix.depth !== undefined) {
                return { route: 'maestro', module, path: spec.depthPath, value: fix.depth };
            }
            return { route: 'advice', reason: 'maestro' };
        }
        default:
            if (
                TEXT_OWNERS.has(item.owner) &&
                (fix.kind === 'edit' || fix.kind === 'remove') &&
                item.neighbours?.length
            ) {
                return { route: 'neighbour', candidates: [...item.neighbours] };
            }
            return { route: 'advice', reason: TEXT_OWNERS.has(item.owner) ? 'neighbourSetting' : 'other' };
    }
}

/** Scopes a route can write to (the neighbour's depend on the entry: the feature narrows them). */
export function routeScopes(route: FixRoute): FixScope[] {
    switch (route.route) {
        case 'preset':
        case 'neighbour':
            return ['global', 'character', 'chat'];
        case 'maestro':
            return ['global'];
        default:
            return [];
    }
}

/**
 * The text with `before` replaced by `after` (first occurrence); a removed sentence takes its spare space or its empty
 * line with it. Null when `before` is not in the text.
 */
export function applyText(text: string, before: string, after: string): string | null {
    if (!before) return null;
    const index = text.indexOf(before);
    if (index < 0) return null;
    let left = text.slice(0, index);
    let right = text.slice(index + before.length);
    if (!after) {
        if (/(^|\n)[ \t]*$/.test(left) && /^[ \t]*(\n|$)/.test(right)) {
            left = left.replace(/[ \t]*$/, '');
            right = right.replace(/^[ \t]*\n?/, '');
            if (!right && left.endsWith('\n')) left = left.replace(/\n+$/, '');
        } else if (/[ \t]$/.test(left) && /^[ \t]/.test(right)) {
            right = right.replace(/^[ \t]+/, '');
        } else if (/(^|\n)$/.test(left)) {
            right = right.replace(/^[ \t]+/, '');
        } else if (/[ \t]$/.test(left) && /^[.,;:!?]/.test(right)) {
            left = left.replace(/[ \t]+$/, '');
        }
    }
    return left + after + right;
}

/** The text a neighbour stores for a quote seen in the prompt (DES keeps `{userName}` where the prompt has the name). */
export function neighbourNeedles(quote: string, userName: string): string[] {
    const needles = [quote];
    if (userName && quote.includes(userName)) needles.push(quote.split(userName).join('{userName}'));
    return needles;
}

/** A role word for the role a fix sets. */
export function isRole(value: unknown): value is AuditRole {
    return value === 'system' || value === 'user' || value === 'assistant';
}

/**
 * The capture after a fix was applied, so «Проверить ещё раз» checks what goes out now without a new turn: an edited
 * text is changed in place, a switched-off block leaves the map, a role or depth change is noted.
 */
export function patchCapture(capture: AuditCapture, fix: AuditFix): AuditCapture {
    const index = capture.items.findIndex((entry) => entry.ref === fix.target);
    if (index < 0) return capture;
    const item = capture.items[index]!;
    switch (fix.kind) {
        case 'edit':
        case 'remove': {
            const next = applyText(item.text, fix.before ?? '', fix.after ?? '');
            if (next !== null) {
                item.chars = Math.max(0, item.chars + next.length - item.text.length);
                item.text = next;
            }
            break;
        }
        case 'toggle':
            if (fix.enabled === false) {
                capture.items.splice(index, 1);
                for (const message of capture.messages) message.refs = message.refs.filter((ref) => ref !== item.ref);
            }
            break;
        case 'role':
            if (fix.role) {
                item.role = fix.role;
                const message = capture.messages[item.message];
                if (message && message.refs.length === 1) message.role = fix.role;
            }
            break;
        case 'move':
            if (fix.depth !== undefined) item.depth = fix.depth;
            break;
        default:
            break;
    }
    return capture;
}
