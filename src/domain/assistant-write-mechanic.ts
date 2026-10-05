// Mechanics made or changed by the assistant (M33 «механики», M25): a template or an existing definition with the
// model's changes laid over it — top-level fields replace, attributes and checks are merged by id (`{id, remove:
// true}` drops one) — then normalised and validated by the mechanics domain (domain/mechanics-defs.ts) before the
// card is shown. Pure: no DOM, no SillyTavern.
import { isDict, jsonCopy } from './assistant-write-args';
import type { Dict } from './assistant-write-args';
import {
    describeAttribute,
    describeCheck,
    describeHolders,
    newMechanicId,
    normalizeDef,
    validateDef,
} from './mechanics-defs';
import type { DefIssue, MechanicDef, MechanicScope, ScopeContext } from './mechanics-defs';

/** Fields the store owns: the model never moves a definition to another book entry. */
const STORE_FIELDS = ['book', 'uid', 'updatedAt'] as const;

/** Lists merged by item id. */
const BY_ID = ['attributes', 'checks'] as const;

function mergeList(base: unknown, patch: unknown): unknown {
    if (!Array.isArray(patch)) return patch;
    const result: unknown[] = Array.isArray(base) ? jsonCopy(base) : [];
    for (const item of patch) {
        if (!isDict(item) || typeof item.id !== 'string' || !item.id) {
            result.push(jsonCopy(item));
            continue;
        }
        const index = result.findIndex((other) => isDict(other) && other.id === item.id);
        if (item.remove === true) {
            if (index >= 0) result.splice(index, 1);
            continue;
        }
        const clean = jsonCopy(item);
        delete clean.remove;
        if (index >= 0) result[index] = { ...(result[index] as Dict), ...clean };
        else result.push(clean);
    }
    return result;
}

/** `base` with `patch` laid over it (copies; the store's own fields are never taken from the patch). */
export function mergeMechanic(base: Dict, patch: Dict): Dict {
    const result: Dict = jsonCopy(base);
    for (const [key, value] of Object.entries(patch)) {
        if ((STORE_FIELDS as readonly string[]).includes(key) || value === undefined) continue;
        if ((BY_ID as readonly string[]).includes(key)) result[key] = mergeList(result[key], value);
        else result[key] = jsonCopy(value);
    }
    return result;
}

/** A copy with an id: the given one, else a fresh readable one from the name (unique among `taken`). */
export function withMechanicId(raw: Dict, taken: Iterable<string>): Dict {
    const copy = jsonCopy(raw);
    if (typeof copy.id !== 'string' || !copy.id.trim()) {
        copy.id = newMechanicId(typeof copy.name === 'string' ? copy.name : '', taken);
    } else {
        copy.id = copy.id.trim();
    }
    return copy;
}

export type ScopeChoice = 'card' | 'chat' | 'global';
export const SCOPE_CHOICES: readonly ScopeChoice[] = ['card', 'chat', 'global'];

/** The scope for a choice in this chat; null when it is not possible here (no single character, no chat). */
export function scopeOf(choice: ScopeChoice, context: ScopeContext): MechanicScope | null {
    if (choice === 'global') return { kind: 'global' };
    if (choice === 'chat') return context.chatId ? { kind: 'chat', chatId: context.chatId } : null;
    return context.avatars.length === 1 && context.avatars[0] ? { kind: 'card', avatar: context.avatars[0] } : null;
}

/** The scope kind as a choice. */
export function scopeChoice(scope: MechanicScope): ScopeChoice {
    return scope.kind;
}

export interface CheckedMechanic {
    def: MechanicDef;
    errors: DefIssue[];
    warnings: DefIssue[];
}

/** Normalised and validated; null when it is not a definition at all (no object or no id). */
export function checkMechanic(raw: Dict): CheckedMechanic | null {
    const def = normalizeDef(raw);
    if (!def) return null;
    const issues = validateDef(def);
    return {
        def,
        errors: issues.filter((issue) => issue.level === 'error'),
        warnings: issues.filter((issue) => issue.level === 'warn'),
    };
}

function clipText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the card shows of a definition: names, holders, where it works, attributes and checks in short. */
export function mechanicView(def: MechanicDef): Dict {
    const view: Dict = {
        id: def.id,
        name: def.name,
        holders: describeHolders(def.holders),
        scope: def.scope.kind,
        tracking: def.tracking,
        attributes: def.attributes.map(describeAttribute),
        checks: def.checks.map(describeCheck),
    };
    if (def.summary) view.summary = clipText(def.summary, 300);
    if (def.rules) view.rules = clipText(def.rules, 600);
    return view;
}
