// The mechanics part of M37 «Подготовить к игре» behind one small adapter: the mechanics engine grows in release 1.14
// (statuses, inventory, visibility sets …) while preparation only needs «a definition from a template or from the
// story, saved for this chat or this card, with starting values per holder». Everything that touches MechanicsApi is
// here, so the new fields (e.g. the default visibility set «Игровой», plan-2 В21) are added in `withDefaults` alone.
import { checkMechanic } from '../../domain/assistant-write-mechanic';
import { uniqueId } from '../../domain/mechanics-defs';
import { mechanicDefOf, startingValues } from '../../domain/prepare-apply';
import type { StartingValue } from '../../domain/prepare-apply';
import type { ItemLinks, MechanicData } from '../../domain/prepare-plan';
import type { App } from '../../shared/contracts';
import type { AttributeValue, MechanicDef, MechanicScope, MechanicsApi } from '../mechanics/api';
import { apiOf, safely } from './collect';

export interface MechanicPlan {
    def: MechanicDef;
    /** The definition exists already (only starting values are written). */
    existing: boolean;
    values: StartingValue[];
    /** Starting values that did not fit the definition. */
    dropped: number;
    /** Validation errors (the definition is not saved then). */
    errors: string[];
}

export interface MechanicsPort {
    list(): MechanicDef[];
    get(id: string): MechanicDef | null;
    /** The definition for a plan item: an existing one, a template's, or a new one; scope set for new ones. */
    plan(data: MechanicData, links: ItemLinks | undefined, scope: MechanicScope): MechanicPlan;
    save(def: MechanicDef): Promise<MechanicDef>;
    remove(id: string): Promise<void>;
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null;
    setValue(mechanicId: string, holder: string, attribute: string, value: AttributeValue): Promise<void>;
}

/** Fields of later mechanics releases get their preparation defaults here (none yet in the current engine). */
function withDefaults(def: MechanicDef): MechanicDef {
    return def;
}

/** The port over the mechanics module; null when the module is off. */
export function mechanicsPort(app: App): MechanicsPort | null {
    const api = apiOf<MechanicsApi>(app, 'mechanics');
    if (!api) return null;
    const locale = safely(() => app.i18n.locale(), 'ru' as const);
    return {
        list: () => safely(() => api.list(), []),
        get: (id) => safely(() => api.get(id), null),
        plan(data, links, scope) {
            const all = safely(() => api.list(), [] as MechanicDef[]);
            const existing = links?.mechanicId ? (all.find((def) => def.id === links.mechanicId) ?? null) : null;
            let def: MechanicDef;
            if (existing) {
                def = existing;
            } else {
                const template = data.template.trim()
                    ? safely(() => api.templates().find((item) => item.id === data.template.trim()) ?? null, null)
                    : null;
                const base = template
                    ? ({
                          ...template.build(locale),
                          id: '',
                          scope,
                          template: template.id,
                      } as MechanicDef)
                    : null;
                const taken = all.map((item) => item.id);
                def = mechanicDefOf(data, base, scope, taken);
                if (template) def.id = uniqueId(template.id, taken);
                def = withDefaults(def);
            }
            const checked = existing ? null : checkMechanic(def as unknown as Record<string, unknown>);
            const finalDef = checked?.def ?? def;
            const { values, dropped } = startingValues(data, finalDef);
            return {
                def: finalDef,
                existing: !!existing,
                values,
                dropped,
                errors: (checked?.errors ?? []).map((issue) => issue.code),
            };
        },
        save: (def) => api.save(def),
        remove: (id) => api.remove(id),
        value: (mechanicId, holder, attribute) => safely(() => api.value(mechanicId, holder, attribute), null),
        setValue: (mechanicId, holder, attribute, value) => api.set(mechanicId, holder, attribute, value),
    };
}
