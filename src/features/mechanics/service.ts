// M25 «Механики», the public API (app.modules.api<MechanicsApi>('mechanics')): a thin façade over the three parts —
// definitions (definitions.ts), state (state.ts) and checks (checks.ts) — plus the templates of the domain.
import { scopeForNew } from '../../domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../domain/mechanics-templates';
import type { Unsubscribe } from '../../shared/contracts';
import type {
    AttributeValue,
    CheckResult,
    FiredEvent,
    HolderState,
    MechanicDef,
    MechanicsApi,
    MechanicTemplate,
    StateChange,
} from './api';
import { scopeContextOf } from './definitions';
import { mechanicFlag, mechanicFlags } from './prompt';
import type { ChecksPart, DefinitionsPart, PartDeps, StatePart } from './parts';

/** Recent threshold events offered to the director as twist sources. */
const TWIST_EVENTS = 5;

/** The definitions part, optionally with every definition of every scope (fresh ids must not repeat any of them). */
type Definitions = DefinitionsPart & { all?(): MechanicDef[] };

export class MechanicsService implements MechanicsApi {
    constructor(
        private readonly defs: Definitions,
        private readonly statePart: StatePart,
        private readonly checksPart: ChecksPart,
        /** The app (locale and the open chat for fromTemplate); without it templates are English and global. */
        private readonly deps?: Pick<PartDeps, 'app'>,
    ) {}

    list(): MechanicDef[] {
        return this.defs.list();
    }

    active(): MechanicDef[] {
        return this.defs.active();
    }

    get(id: string): MechanicDef | null {
        return this.defs.get(id);
    }

    save(def: MechanicDef): Promise<MechanicDef> {
        return this.defs.save(def);
    }

    remove(id: string): Promise<void> {
        return this.defs.remove(id);
    }

    templates(): MechanicTemplate[] {
        return [...MECHANIC_TEMPLATES];
    }

    /** An unsaved definition from a template: a fresh readable id, scope — this character's card (else this chat). */
    fromTemplate(templateId: string): MechanicDef | null {
        const item = templateById(templateId);
        if (!item) return null;
        const app = this.deps?.app;
        const locale = app?.i18n.locale() ?? 'en';
        const context = app ? scopeContextOf(app) : { avatars: [], chatId: null };
        const taken = [...(this.defs.all?.() ?? []), ...this.defs.list()].map((def) => def.id);
        return defFromTemplate(item, locale, app ? scopeForNew(context) : { kind: 'global' }, taken);
    }

    setEnabledInChat(id: string, on: boolean): Promise<void> {
        return this.defs.setEnabledInChat(id, on);
    }

    state(holder?: string): HolderState[] {
        return this.statePart.state(holder);
    }

    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null {
        return this.statePart.value(mechanicId, holder, attribute);
    }

    async set(mechanicId: string, holder: string, attribute: string, value: AttributeValue): Promise<void> {
        await this.statePart.apply([{ mechanicId, holder, attribute, value, source: 'user', messageIndex: -1 }]);
    }

    history(limit?: number): StateChange[] {
        return this.statePart.history(limit);
    }

    roll(mechanicId: string, checkId: string, holder: string, options?: { difficulty?: number }): Promise<CheckResult> {
        return this.checksPart.roll(mechanicId, checkId, holder, options);
    }

    checks(limit?: number): CheckResult[] {
        return this.checksPart.checks(limit);
    }

    events(limit?: number): FiredEvent[] {
        return this.statePart.events(limit);
    }

    /** Twist sources of the director (M13, duck-typed there): the latest threshold events. */
    twists(): FiredEvent[] {
        return this.statePart.events(TWIST_EVENTS);
    }

    /** Flags of all visible mechanics for the Preset Studio's conditions (duck-typed there). */
    flagCatalogue(): { flag: string; label: string }[] {
        return mechanicFlags(this.defs.list());
    }

    /** Flags that are on now: active mechanics with a holder in the scene (the simulator's «Как сейчас»). */
    flagsOn(): string[] {
        return this.defs
            .active()
            .filter((def) => this.statePart.holdersInScene(def).length > 0)
            .map((def) => mechanicFlag(def.id));
    }

    onChange(listener: () => void): Unsubscribe {
        const offs = [
            this.defs.onChange(listener),
            this.statePart.onChange(listener),
            this.checksPart.onChange(listener),
        ];
        return () => {
            for (const off of offs) off();
        };
    }
}
