// Slash commands through ST's SlashCommandParser. ST cannot unregister a command, so each name is registered
// once per page and routed through a slot: after a module drops its command (or Maestro is disabled) the
// command stays in ST's list but answers with a short localized explanation instead of acting.
import type { Host, I18n, Logger, SlashCommandSpec, Unsubscribe } from '../../shared/contracts';

/** By convention an argument named `value` is the unnamed argument (the text after the command). */
export const UNNAMED_ARGUMENT = 'value';

type SlotState = 'active' | 'moduleOff' | 'maestroOff';

interface Slot {
    spec: SlashCommandSpec;
    state: SlotState;
    i18n: I18n;
    log: Logger;
    owner: SlashCommands;
}

/** Page-wide: survives a UI rebuild (disable → activate without reload) so ST never sees a duplicate. */
const slots = new Map<string, Slot>();

function unnamedText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : String(item))).join(' ');
    if (value === undefined || value === null) return '';
    return String(value);
}

function namedArgs(named: unknown): Record<string, unknown> {
    if (!named || typeof named !== 'object') return {};
    // ST adds service keys (_scope, _parserFlags, _abortController, …).
    return Object.fromEntries(Object.entries(named as Record<string, unknown>).filter(([key]) => !key.startsWith('_')));
}

export class SlashCommands {
    private readonly owned = new Set<string>();

    constructor(
        private readonly host: Host,
        private readonly i18n: I18n,
        private readonly log: Logger,
    ) {}

    add(spec: SlashCommandSpec): Unsubscribe {
        const name = spec.name.replace(/^\//, '');
        let slot = slots.get(name);
        if (slot) {
            slot.spec = spec;
            slot.state = 'active';
            slot.i18n = this.i18n;
            slot.log = this.log;
            slot.owner = this;
        } else {
            slot = { spec, state: 'active', i18n: this.i18n, log: this.log, owner: this };
            if (!this.register(name, spec)) return () => {};
            slots.set(name, slot);
        }
        this.owned.add(name);
        const current = slot;
        return () => {
            if (current.spec !== spec || current.state !== 'active') return;
            current.state = 'moduleOff';
        };
    }

    /** Maestro is going away: every command it owns answers "Maestro is disabled". */
    dispose(): void {
        for (const name of this.owned) {
            const slot = slots.get(name);
            if (slot && slot.owner === this) slot.state = 'maestroOff';
        }
        this.owned.clear();
    }

    private register(name: string, spec: SlashCommandSpec): boolean {
        const c = this.host.ctx();
        if (!c.SlashCommandParser?.addCommandObject || !c.SlashCommand?.fromProps) {
            this.log.warn(`slash commands unavailable; /${name} not registered`);
            return false;
        }
        const t = this.i18n.t.bind(this.i18n);
        const stringType = c.ARGUMENT_TYPE?.STRING ?? 'string';
        const args = spec.args ?? [];
        const unnamed = args.filter((arg) => arg.name === UNNAMED_ARGUMENT);
        const named = args.filter((arg) => arg.name !== UNNAMED_ARGUMENT);
        const props: Record<string, unknown> = {
            name,
            helpString: t(spec.helpKey),
            returns: 'string',
            callback: (namedArguments: unknown, unnamedArgument: unknown) => run(name, namedArguments, unnamedArgument),
        };
        if (unnamed.length && c.SlashCommandArgument?.fromProps) {
            props.unnamedArgumentList = unnamed.map((arg) =>
                c.SlashCommandArgument.fromProps({
                    description: t(arg.descriptionKey),
                    typeList: [stringType],
                    isRequired: !arg.optional,
                }),
            );
        }
        if (named.length && c.SlashCommandNamedArgument?.fromProps) {
            props.namedArgumentList = named.map((arg) =>
                c.SlashCommandNamedArgument.fromProps({
                    name: arg.name,
                    description: t(arg.descriptionKey),
                    typeList: [stringType],
                    isRequired: !arg.optional,
                }),
            );
        }
        try {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps(props));
            return true;
        } catch (error) {
            this.log.error(`failed to register /${name}`, error);
            return false;
        }
    }
}

async function run(name: string, named: unknown, unnamed: unknown): Promise<string> {
    const slot = slots.get(name);
    if (!slot) return '';
    if (slot.state === 'maestroOff') return slot.i18n.t('ui.slash.maestroOff');
    if (slot.state === 'moduleOff') return slot.i18n.t('ui.slash.moduleOff', { name });
    try {
        return await slot.spec.callback(namedArgs(named), unnamedText(unnamed));
    } catch (error) {
        slot.log.error(`/${name} failed`, error);
        return slot.i18n.t('ui.slash.failed', { name, error: error instanceof Error ? error.message : String(error) });
    }
}

/** Test helper: forget registrations (ST is re-mocked per test file). */
export function resetSlashSlots(): void {
    slots.clear();
}
