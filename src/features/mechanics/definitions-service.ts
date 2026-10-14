// M25 «Механики», the definitions door (release 1.24.1): app.modules.api<MechanicDefinitionsApi>('mechanicsDefinitions').
// The definitions live in Maestro books and have nothing to do with the open chat, so a service chat (M42) keeps them:
// there index.ts runs this door over a definitions part of its own (MaestroModule.whileSuspended) while the prompt,
// the reply handling, the checks, the HUD and the state stay paused, and MAESTRO_API.mechanics reads and writes through
// it (Officina publishes mechanics from its co-author chat). In a story chat the full service (service.ts) is the door
// and delegates its definition calls here.
import { scopeForNew } from '../../domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../domain/mechanics-templates';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { MechanicDef, MechanicDefinitionsApi, MechanicTemplate } from './api';
import { scopeContextOf } from './definitions';
import { offeredTemplates } from './dramatis';
import type { DefinitionsPart } from './parts';
import { worldOf } from './state-holders';

/** Factions of the lore a reputation template starts with. */
const TEMPLATE_FACTIONS = 12;

/** The definitions part, optionally with every definition of every scope (fresh ids must not repeat any of them). */
export type Definitions = DefinitionsPart & { all?(): MechanicDef[] };

export class MechanicDefinitionsService implements MechanicDefinitionsApi {
    constructor(
        private readonly defs: Definitions,
        /** The app (locale, the open chat, Dramatis, the lore's factions); without it templates are English and global. */
        private readonly app?: App,
    ) {}

    list(): MechanicDef[] {
        return this.defs.list();
    }

    /** Every definition of every Maestro book, whatever its scope. */
    all(): MechanicDef[] {
        return this.defs.all?.() ?? this.defs.list();
    }

    get(id: string): MechanicDef | null {
        return this.defs.get(id);
    }

    save(def: MechanicDef, by?: string): Promise<MechanicDef> {
        return this.defs.save(def, by);
    }

    remove(id: string, by?: string): Promise<void> {
        return this.defs.remove(id, by);
    }

    /** The ready-made templates; «relationships» and «social» leave while Dramatis replaces them (release 1.17). */
    templates(): MechanicTemplate[] {
        return this.app ? offeredTemplates(this.app, MECHANIC_TEMPLATES) : [...MECHANIC_TEMPLATES];
    }

    /** Factions of the lore (world model entities of type faction; none while the world model is paused). */
    private factions(): string[] {
        if (!this.app) return [];
        try {
            return (worldOf(this.app)?.entities('faction') ?? [])
                .map((entity) => entity.name)
                .slice(0, TEMPLATE_FACTIONS);
        } catch {
            return [];
        }
    }

    /**
     * An unsaved definition from a template: a fresh readable id, scope — this character's card (else this chat); a
     * reputation template gets the factions of the lore.
     */
    fromTemplate(templateId: string): MechanicDef | null {
        const item = templateById(templateId);
        if (!item) return null;
        const app = this.app;
        const locale = app?.i18n.locale() ?? 'en';
        const context = app ? scopeContextOf(app) : { avatars: [], chatId: null };
        const taken = [...(this.defs.all?.() ?? []), ...this.defs.list()].map((def) => def.id);
        return defFromTemplate(item, locale, app ? scopeForNew(context) : { kind: 'global' }, taken, {
            factions: this.factions(),
        });
    }

    onChange(listener: () => void): Unsubscribe {
        return this.defs.onChange(listener);
    }
}
