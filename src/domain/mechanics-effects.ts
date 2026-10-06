// M25 «Механики», consequences (plan-2 §6 п. 1 «Последствия бросков», п. 2 «Действия событий», п. 10 level ups): a
// ChangeAction of a check's effect, a threshold event or a level up becomes state operations for concrete holders.
// - who: 'actor' (who rolled / the event's holder), 'target' (the other side of an opposed check), 'persona', or a
//   holder name of the attribute's mechanic;
// - attr: an attribute of the mechanic, 'mechanic.attr' of another one, or 'status' / 'item' / 'reveal' / 'combat';
// - value: a number, a text, or a formula evaluated now — references read the ACTOR's values ('@strength',
//   '@magic.mana'), '@roll.total' / '@roll.margin' / '@roll.natural' the roll, dice ('1d6') are rolled;
// - numbers: add/sub are deltas, set absolute, mul a factor; lists: push/pull (set replaces); scales: add/sub steps;
//   statuses: push applies (the catalogue of the mechanic fills duration and modifiers), pull removes; items: push
//   gives, pull takes; reveal: the attribute named by `value` becomes visible to the player; combat: push joins the
//   fight, pull takes the holder out of it.
// Also the English note of what happened, for the facts block, honouring each attribute's visibility (numbers, words,
// nothing). Pure: no DOM, no SillyTavern.
import { normalizeStatusSpec } from './mechanics-defs';
import type { AttributeDef, ChangeAction, MechanicDef, StatusSpec } from './mechanics-defs';
import { computeFormula, constantOf } from './mechanics-formula';
import type { Rng } from './mechanics-dice';
import { parseDurationText } from './mechanics-status';
import type { OpBase, OpInput } from './mechanics-state';
import { resolveVisibility } from './mechanics-visibility';

export interface ActionContext {
    /** The mechanic the actions belong to. */
    def: MechanicDef;
    actor: string;
    /** The other side of an opposed check. */
    target?: string | null;
    persona: string;
    getDef(id: string): MechanicDef | null;
    /** The holder of a mechanic a raw name stands for, or null. */
    resolveHolder(def: MechanicDef, raw: string): string | null;
    /** A number for formulas: the holder's effective value (scale: level index), null when none. */
    numberOf(mechanicId: string, holder: string, attribute: string): number | null;
    roll?: { total: number; margin: number; natural: number } | null;
    rng?: Rng;
    base: OpBase;
}

export type ActionRejectReason = 'who' | 'attribute' | 'mechanic' | 'value' | 'op';

export interface ResolvedActions {
    ops: OpInput[];
    rejected: { action: ChangeAction; reason: ActionRejectReason }[];
    /** English notes for the model ("Kai: mana -10", "Kai is now poisoned"). */
    notes: string[];
}

function findAttr(def: MechanicDef, id: string): AttributeDef | null {
    const key = id.trim().toLowerCase();
    return (
        def.attributes.find((attr) => attr.id === key) ??
        def.attributes.find((attr) => attr.promptName.toLowerCase() === key || attr.name.toLowerCase() === key) ??
        null
    );
}

function whoOf(action: ChangeAction, def: MechanicDef, context: ActionContext): string | null {
    const who = (action.who || 'actor').trim();
    const lower = who.toLowerCase();
    if (lower === 'actor' || lower === 'holder' || lower === 'self') return context.actor || null;
    if (lower === 'target' || lower === 'opponent') return context.target || null;
    if (lower === 'persona' || lower === 'user' || lower === '{{user}}') {
        return context.resolveHolder(def, context.persona || 'user') ?? (context.persona || null);
    }
    return context.resolveHolder(def, who);
}

/** A number for an action: a constant, or the formula evaluated over the actor's values and the roll. */
function numberOf(action: ChangeAction, context: ActionContext): number | null {
    const constant = constantOf(action.value);
    if (constant !== null) return constant;
    const result = computeFormula(
        action.value,
        {
            ref: (path) => {
                if (path[0] === 'roll' && path.length === 2) {
                    const roll = context.roll;
                    if (!roll) return null;
                    return path[1] === 'total' ? roll.total : path[1] === 'margin' ? roll.margin : roll.natural;
                }
                if (path.length === 1) return context.numberOf(context.def.id, context.actor, path[0] as string);
                return context.numberOf(path[0] as string, context.actor, path[1] as string);
            },
            ...(context.rng ? { rng: context.rng } : {}),
        },
        { dice: true },
    );
    return result ? result.value : null;
}

function statusSpecOf(action: ChangeAction): StatusSpec | null {
    if (action.status) return action.status;
    const raw = String(action.value ?? '').trim();
    if (!raw) return null;
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(raw);
    const name = (paren?.[1] ?? raw).trim();
    const spec = normalizeStatusSpec(name);
    if (!spec) return null;
    const duration = paren?.[2] ? parseDurationText(paren[2]) : null;
    if (duration) spec.duration = duration;
    return spec;
}

/** How the model hears about a change of this attribute: with numbers, in words, or not at all. */
function noteMode(def: MechanicDef, attr: AttributeDef): 'numbers' | 'words' | 'none' {
    const visibility = resolveVisibility(def, attr);
    if (visibility.prompt === 'none') return 'none';
    return visibility.mention === 'numbers' ? 'numbers' : visibility.mention === 'words' ? 'words' : 'none';
}

function valueNote(holder: string, attr: AttributeDef, op: string, value: number | string, mode: string): string {
    const name = attr.promptName || attr.id;
    if (mode === 'words') {
        if (op === 'add') return `${holder}: ${name} goes up`;
        if (op === 'sub') return `${holder}: ${name} goes down`;
        return `${holder}: ${name} changes`;
    }
    if (op === 'add') return `${holder}: ${name} +${value}`;
    if (op === 'sub') return `${holder}: ${name} -${value}`;
    if (op === 'mul') return `${holder}: ${name} x${value}`;
    if (op === 'push') return `${holder}: ${name} + ${value}`;
    if (op === 'pull') return `${holder}: ${name} - ${value}`;
    return `${holder}: ${name} = ${value}`;
}

/** Actions → state operations for concrete holders, with notes for the model. */
export function resolveActions(actions: readonly ChangeAction[], context: ActionContext): ResolvedActions {
    const result: ResolvedActions = { ops: [], rejected: [], notes: [] };
    const reject = (action: ChangeAction, reason: ActionRejectReason) => result.rejected.push({ action, reason });
    const base = context.base;
    for (const action of actions) {
        const attrName = action.attr.trim().toLowerCase();
        const dot = attrName.indexOf('.');
        const special = ['status', 'item', 'reveal', 'combat'].includes(attrName);
        const def = !special && dot > 0 ? context.getDef(attrName.slice(0, dot)) : context.def;
        if (!def) {
            reject(action, 'mechanic');
            continue;
        }
        const holder = whoOf(action, def, context);
        if (!holder) {
            reject(action, 'who');
            continue;
        }
        if (attrName === 'status') {
            const spec = statusSpecOf(action);
            if (!spec) {
                reject(action, 'value');
                continue;
            }
            if (action.op === 'pull' || action.op === 'sub') {
                result.ops.push({ ...base, kind: 'status', op: 'remove', mechanicId: def.id, holder, ref: spec.name });
                result.notes.push(`${holder} is no longer ${spec.promptName ?? spec.name}`);
            } else {
                result.ops.push({ ...base, kind: 'status', op: 'add', mechanicId: def.id, holder, status: spec });
                result.notes.push(`${holder} is now ${spec.promptName ?? spec.name}`);
            }
            continue;
        }
        if (attrName === 'item') {
            const name = action.item?.name ?? String(action.value ?? '').trim();
            if (!name) {
                reject(action, 'value');
                continue;
            }
            const counted = action.item?.qty ?? (typeof action.value === 'number' ? action.value : undefined);
            const qty = counted !== undefined && Number.isFinite(counted) && counted > 0 ? counted : 1;
            const item = action.item ? { ...action.item, name } : { name };
            const take = action.op === 'pull' || action.op === 'sub';
            result.ops.push({
                ...base,
                kind: 'item',
                op: take ? 'take' : 'give',
                mechanicId: def.id,
                holder,
                item,
                qty,
            });
            result.notes.push(`${holder} ${take ? 'loses' : 'gets'} ${name}${qty !== 1 ? ` x${qty}` : ''}`);
            continue;
        }
        if (attrName === 'reveal') {
            const attr = findAttr(def, String(action.value ?? ''));
            if (!attr) {
                reject(action, 'attribute');
                continue;
            }
            result.ops.push({ ...base, kind: 'reveal', mechanicId: def.id, holder, attribute: attr.id });
            continue;
        }
        if (attrName === 'combat') {
            const out = action.op === 'pull' || action.op === 'sub';
            result.ops.push({ ...base, kind: 'combat', op: out ? 'out' : 'join', mechanicId: def.id, holder });
            result.notes.push(`${holder} ${out ? 'is out of the fight' : 'joins the fight'}`);
            continue;
        }
        const attr = findAttr(def, dot > 0 ? attrName.slice(dot + 1) : attrName);
        if (!attr || attr.formula) {
            reject(action, 'attribute');
            continue;
        }
        const mode = noteMode(def, attr);
        const note = (op: string, value: number | string) => {
            if (mode !== 'none') result.notes.push(valueNote(holder, attr, op, value, mode));
        };
        const target = { ...base, mechanicId: def.id, holder, attribute: attr.id };
        if (attr.kind === 'number' || (attr.kind === 'scale' && (action.op === 'add' || action.op === 'sub'))) {
            if (
                attr.kind === 'scale' ||
                action.op !== 'set' ||
                typeof action.value !== 'string' ||
                /[\d@(]/.test(action.value)
            ) {
                const number = numberOf(action, context);
                if (number === null) {
                    reject(action, 'value');
                    continue;
                }
                switch (action.op) {
                    case 'add':
                        result.ops.push({ ...target, value: number, delta: true });
                        note('add', number);
                        break;
                    case 'sub':
                        result.ops.push({ ...target, value: -number, delta: true });
                        note('sub', number);
                        break;
                    case 'mul':
                        result.ops.push({ ...target, value: number, op: 'mul' });
                        note('mul', number);
                        break;
                    case 'set':
                        result.ops.push({ ...target, value: number });
                        note('set', number);
                        break;
                    default:
                        reject(action, 'op');
                }
                continue;
            }
        }
        const text = typeof action.value === 'number' ? String(action.value) : String(action.value ?? '').trim();
        if (
            attr.kind === 'list' &&
            (action.op === 'push' || action.op === 'pull' || action.op === 'add' || action.op === 'sub')
        ) {
            const op = action.op === 'push' || action.op === 'add' ? 'push' : 'pull';
            result.ops.push({ ...target, value: text, op });
            note(op, text);
        } else if (action.op === 'set') {
            result.ops.push({ ...target, value: text });
            note('set', text);
        } else reject(action, 'op');
    }
    return result;
}
