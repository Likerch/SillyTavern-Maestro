// M25 «Механики», the public API (app.modules.api<MechanicsApi>('mechanics')): a thin façade over the parts —
// definitions (definitions.ts), state (state.ts), checks (checks.ts), the prompt (prompt.ts) and fights (combat.ts) —
// plus the templates of the domain. Everything the UI wave needs (plan-2 §6.А surfaces) is read here; see api.ts.
import {
    resolveVisibility,
    shownIn,
    withPreset,
    wordsFor,
    normalizeVisibilityInput,
} from '../../domain/mechanics-visibility';
import type { VisibilityInput, VisibilityPreset } from '../../domain/mechanics-visibility';
import { findAttribute, nameKey, resolveHolder } from '../../domain/mechanics-state';
import { scopeForNew } from '../../domain/mechanics-defs';
import { defFromTemplate, MECHANIC_TEMPLATES, templateById } from '../../domain/mechanics-templates';
import type { Unsubscribe } from '../../shared/contracts';
import type {
    AttributeValue,
    CheckResult,
    CombatState,
    DerivedValue,
    EquipSlot,
    FiredEvent,
    HolderState,
    ItemSpec,
    ItemState,
    MechanicDef,
    MechanicsApi,
    MechanicsClock,
    MechanicsEvent,
    MechanicsPromptPreview,
    MechanicTemplate,
    StateChange,
    StatusSpec,
    StatusState,
    Visibility,
    VisibilityPlace,
} from './api';
import type { MechanicCombat } from './combat';
import { scopeContextOf } from './definitions';
import { offeredTemplates } from './dramatis';
import { mechanicFlag, mechanicFlags } from './prompt';
import type { MechanicPrompt } from './prompt';
import type { ChecksPart, DefinitionsPart, PartDeps, RollOptions, StateOp, StatePart } from './parts';
import { ITEM_KIND, REVEAL_KIND, STATUS_KIND } from './state';
import { holderContextOf, personaOf, worldOf } from './state-holders';
import { renderHolderInto } from './view-values';

/** Recent threshold events offered to the director as twist sources. */
const TWIST_EVENTS = 5;
/** Factions of the lore a reputation template starts with. */
const TEMPLATE_FACTIONS = 12;

/** The definitions part, optionally with every definition of every scope (fresh ids must not repeat any of them). */
type Definitions = DefinitionsPart & { all?(): MechanicDef[] };

export interface ServiceExtras {
    prompt?: Pick<MechanicPrompt, 'preview'>;
    combat?: MechanicCombat;
}

export class MechanicsService implements MechanicsApi {
    constructor(
        private readonly defs: Definitions,
        private readonly statePart: StatePart,
        private readonly checksPart: ChecksPart,
        /** The app (locale and the open chat for fromTemplate); without it templates are English and global. */
        private readonly deps?: Pick<PartDeps, 'app'>,
        private readonly extras: ServiceExtras = {},
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

    /** The ready-made templates; «relationships» and «social» leave while Dramatis replaces them (release 1.17). */
    templates(): MechanicTemplate[] {
        const app = this.deps?.app;
        return app ? offeredTemplates(app, MECHANIC_TEMPLATES) : [...MECHANIC_TEMPLATES];
    }

    /** Factions of the lore (world model entities of type faction). */
    private factions(): string[] {
        const app = this.deps?.app;
        if (!app) return [];
        try {
            return (worldOf(app)?.entities('faction') ?? []).map((entity) => entity.name).slice(0, TEMPLATE_FACTIONS);
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
        const app = this.deps?.app;
        const locale = app?.i18n.locale() ?? 'en';
        const context = app ? scopeContextOf(app) : { avatars: [], chatId: null };
        const taken = [...(this.defs.all?.() ?? []), ...this.defs.list()].map((def) => def.id);
        return defFromTemplate(item, locale, app ? scopeForNew(context) : { kind: 'global' }, taken, {
            factions: this.factions(),
        });
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

    roll(mechanicId: string, checkId: string, holder: string, options?: RollOptions): Promise<CheckResult> {
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

    /* ---------------------------------------------------------------- plan-2 §6: per message, undo, reset */

    changesOf(messageIndex: number, options?: { place?: VisibilityPlace }): StateChange[] {
        return this.statePart.changesOf?.(messageIndex, options) ?? [];
    }

    rollsOf(messageIndex: number): CheckResult[] {
        return this.checksPart.rollsOf?.(messageIndex) ?? [];
    }

    undoChange(changeId: string): Promise<boolean> {
        return this.statePart.undoChange?.(changeId) ?? Promise.resolve(false);
    }

    undoRoll(rollId: string): Promise<boolean> {
        return this.checksPart.undoRoll?.(rollId) ?? Promise.resolve(false);
    }

    reset(target: { mechanicId?: string; holder?: string }): Promise<number> {
        return this.statePart.reset?.(target) ?? Promise.resolve(0);
    }

    /* ---------------------------------------------------------------- visibility */

    visibilityOf(mechanicId: string, attribute?: string): Visibility | null {
        const def = this.defs.get(mechanicId);
        if (!def) return null;
        const attr = attribute ? findAttribute(def, attribute) : null;
        if (attribute && !attr) return null;
        return resolveVisibility(def, attr ?? undefined);
    }

    isRevealed(mechanicId: string, holder: string, attribute: string): boolean {
        return this.statePart.isRevealed?.(mechanicId, holder, attribute) ?? false;
    }

    shown(mechanicId: string, attribute: string, place: VisibilityPlace, holder?: string): boolean {
        const visibility = this.visibilityOf(mechanicId, attribute);
        if (!visibility) return false;
        const revealed = holder ? this.isRevealed(mechanicId, holder, attribute) : false;
        return shownIn(visibility, place, revealed);
    }

    wordsOf(
        mechanicId: string,
        attribute: string,
        value: AttributeValue | null,
    ): { label: string; display?: string; band?: number } | null {
        const def = this.defs.get(mechanicId);
        const attr = def ? findAttribute(def, attribute) : null;
        if (!def || !attr) return null;
        return wordsFor(attr, resolveVisibility(def, attr), value);
    }

    async setVisibility(
        mechanicId: string,
        attribute: string | null,
        visibility: VisibilityPreset | VisibilityInput,
    ): Promise<void> {
        const def = this.defs.get(mechanicId);
        if (!def) throw new Error(`unknown mechanic ${mechanicId}`);
        const attr = attribute ? findAttribute(def, attribute) : null;
        if (attribute && !attr) throw new Error(`unknown attribute ${attribute}`);
        const target = attr ?? def;
        const next =
            typeof visibility === 'string'
                ? withPreset(visibility, target.visibility)
                : normalizeVisibilityInput({ ...(target.visibility ?? {}), ...visibility });
        if (next) target.visibility = next;
        else delete target.visibility;
        await this.defs.save(def);
    }

    async reveal(mechanicId: string, holder: string, attribute: string, on = true): Promise<void> {
        await this.applyUser(
            [{ kind: 'reveal', mechanicId, holder, attribute, hide: !on, source: 'user', messageIndex: -1 }],
            REVEAL_KIND,
        );
    }

    derived(mechanicId: string, holder: string): DerivedValue[] {
        return this.statePart.derived?.(mechanicId, holder) ?? [];
    }

    /* ---------------------------------------------------------------- statuses and items */

    private async applyUser(ops: StateOp[], kind: string): Promise<StateChange[]> {
        if (!this.statePart.applyOps) return [];
        return this.statePart.applyOps(ops, { kind });
    }

    /** The mechanic that keeps a part (statuses / inventory) for a holder: the given one, else the first that fits. */
    private owner(holder: string, has: (def: MechanicDef) => boolean, mechanicId?: string): MechanicDef | null {
        if (mechanicId) return this.defs.get(mechanicId);
        const context = this.deps ? holderContextOf(this.deps.app) : { persona: '' };
        const candidates = this.defs.active().filter(has);
        return candidates.find((def) => resolveHolder(def, holder, context) !== null) ?? candidates[0] ?? null;
    }

    statuses(holder?: string): { holder: string; statuses: StatusState[] }[] {
        return this.statePart.statuses?.(holder) ?? [];
    }

    async addStatus(holder: string, status: StatusSpec, mechanicId?: string): Promise<StateChange | null> {
        const def = this.owner(holder, (item) => item.statuses !== undefined, mechanicId);
        if (!def) return null;
        const [change] = await this.applyUser(
            [{ kind: 'status', op: 'add', mechanicId: def.id, holder, status, source: 'user', messageIndex: -1 }],
            STATUS_KIND,
        );
        return change ?? null;
    }

    async removeStatus(holder: string, status: string): Promise<boolean> {
        const entry = this.statuses(holder)[0];
        const found = entry?.statuses.find(
            (item) => item.id === status || item.statusId === status || nameKey(item.name) === nameKey(status),
        );
        if (!found || !entry) return false;
        const changes = await this.applyUser(
            [
                {
                    kind: 'status',
                    op: 'remove',
                    mechanicId: found.mechanicId ?? '',
                    holder: entry.holder,
                    ref: found.id,
                    source: 'user',
                    messageIndex: -1,
                },
            ],
            STATUS_KIND,
        );
        return changes.length > 0;
    }

    items(holder?: string): { holder: string; items: ItemState[] }[] {
        return this.statePart.items?.(holder) ?? [];
    }

    async giveItem(holder: string, item: ItemSpec, qty?: number, mechanicId?: string): Promise<StateChange | null> {
        const def = this.owner(holder, (entry) => entry.inventory !== undefined, mechanicId);
        if (!def) return null;
        const [change] = await this.applyUser(
            [
                {
                    kind: 'item',
                    op: 'give',
                    mechanicId: def.id,
                    holder,
                    item,
                    ...(qty !== undefined ? { qty } : {}),
                    source: 'user',
                    messageIndex: -1,
                },
            ],
            ITEM_KIND,
        );
        return change ?? null;
    }

    async takeItem(holder: string, name: string, qty?: number): Promise<StateChange | null> {
        const def = this.owner(holder, (entry) => entry.inventory !== undefined);
        const [change] = await this.applyUser(
            [
                {
                    kind: 'item',
                    op: 'take',
                    mechanicId: def?.id ?? '',
                    holder,
                    item: { name },
                    ...(qty !== undefined ? { qty } : {}),
                    source: 'user',
                    messageIndex: -1,
                },
            ],
            ITEM_KIND,
        );
        return change ?? null;
    }

    async equipItem(holder: string, name: string, slot: EquipSlot | null): Promise<StateChange | null> {
        const def = this.owner(holder, (entry) => entry.inventory !== undefined);
        const [change] = await this.applyUser(
            [
                {
                    kind: 'item',
                    op: 'equip',
                    mechanicId: def?.id ?? '',
                    holder,
                    item: { name },
                    slot,
                    source: 'user',
                    messageIndex: -1,
                },
            ],
            ITEM_KIND,
        );
        return change ?? null;
    }

    /** The inventory's money: its mechanic and attribute ('coins' of the same mechanic, or 'money.coins'). */
    private money(def: MechanicDef): { mechanicId: string; attribute: string } | null {
        const money = def.inventory?.money;
        if (!money) return null;
        const dot = money.indexOf('.');
        return dot > 0
            ? { mechanicId: money.slice(0, dot), attribute: money.slice(dot + 1) }
            : { mechanicId: def.id, attribute: money };
    }

    async buy(holder: string, item: ItemSpec, qty = 1, price?: number): Promise<boolean> {
        const def = this.owner(holder, (entry) => entry.inventory !== undefined);
        if (!def) return false;
        const money = this.money(def);
        const unit = price ?? item.value ?? 0;
        const total = Math.max(0, unit * qty);
        const ops: StateOp[] = [];
        if (money && total > 0) {
            const purse = this.statePart.numberOf?.(money.mechanicId, holder, money.attribute) ?? null;
            if (purse === null || purse < total) return false;
            ops.push({
                ...money,
                holder,
                value: -total,
                delta: true,
                source: 'user',
                messageIndex: -1,
                reason: item.name,
            });
        }
        const bought: ItemSpec = { ...item, ...(item.value === undefined && unit > 0 ? { value: unit } : {}) };
        ops.push({
            kind: 'item',
            op: 'give',
            mechanicId: def.id,
            holder,
            item: bought,
            qty,
            source: 'user',
            messageIndex: -1,
        });
        return (await this.applyUser(ops, ITEM_KIND)).length > 0;
    }

    async sell(holder: string, name: string, qty = 1, price?: number): Promise<boolean> {
        const def = this.owner(holder, (entry) => entry.inventory !== undefined);
        if (!def) return false;
        const owned = this.items(holder)[0]?.items.find((item) => nameKey(item.name) === nameKey(name));
        if (!owned || owned.qty < qty) return false;
        const money = this.money(def);
        const unit = price ?? Math.floor((owned.value ?? 0) / 2);
        const ops: StateOp[] = [
            {
                kind: 'item',
                op: 'take',
                mechanicId: def.id,
                holder,
                item: { name: owned.name },
                qty,
                source: 'user',
                messageIndex: -1,
            },
        ];
        if (money && unit * qty > 0) {
            ops.push({
                ...money,
                holder,
                value: unit * qty,
                delta: true,
                source: 'user',
                messageIndex: -1,
                reason: owned.name,
            });
        }
        return (await this.applyUser(ops, ITEM_KIND)).length > 0;
    }

    /* ---------------------------------------------------------------- fights, clock, prompt, events */

    combat(): CombatState | null {
        return this.statePart.combat?.() ?? null;
    }

    startCombat(options?: { enemies?: string[]; mechanicId?: string }): Promise<CombatState | null> {
        return this.extras.combat?.start(options) ?? Promise.resolve(null);
    }

    async endCombat(): Promise<void> {
        await this.extras.combat?.end();
    }

    nextTurn(): Promise<CombatState | null> {
        return this.extras.combat?.nextTurn() ?? Promise.resolve(this.combat());
    }

    async addEnemy(name: string, values?: Record<string, number>): Promise<void> {
        await this.extras.combat?.addEnemy(name, values);
    }

    clock(): MechanicsClock | null {
        return this.statePart.clock?.() ?? null;
    }

    previewPrompt(): MechanicsPromptPreview | null {
        return this.extras.prompt?.preview() ?? null;
    }

    onEvent(listener: (event: MechanicsEvent) => void): Unsubscribe {
        return this.statePart.onEvent?.(listener) ?? (() => undefined);
    }

    /* ---------------------------------------------------------------- the play surfaces (plan-2 §6.А) */

    holdersInScene(mechanicId: string): string[] {
        const def = this.defs.get(mechanicId);
        if (!def) return [];
        try {
            return this.statePart.holdersInScene(def);
        } catch {
            return [];
        }
    }

    persona(): string {
        return this.deps ? personaOf(this.deps.app) : '';
    }

    renderHolder(container: HTMLElement, holder: string, place: VisibilityPlace): Unsubscribe | null {
        if (!this.deps) return null;
        return renderHolderInto(this.deps.app.i18n, this, container, holder, place);
    }
}
