// Test app for M25 part C (checks, prompt, widgets): the M22 test app (ST mock, real settings, i18n and bus, recording
// journal/autonomy/UI) with the real ephemeral service (extension prompts recorded like ST keeps them), an in-memory
// chat store, and small fakes of the other parts: definitions, state (values, scene, history, events) and tracking.
import { createEphemeral } from '../../../src/core/ephemeral';
import type { EphemeralRunner } from '../../../src/core/turn';
import type {
    AttributeValue,
    FiredEvent,
    HolderState,
    MechanicDef,
    StateChange,
} from '../../../src/features/mechanics/api';
import { DEFAULT_MECHANICS_SETTINGS } from '../../../src/features/mechanics/parts';
import type {
    ChangeInput,
    DefinitionsPart,
    MechanicsSettings,
    PartDeps,
    StatePart,
    TrackingPart,
} from '../../../src/features/mechanics/parts';
import { CHECK_STRINGS } from '../../../src/features/mechanics/strings-checks';
import type { ChatStore, GenerationInfo, SlashCommandSpec, Unsubscribe } from '../../../src/shared/contracts';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { EVENT_TYPES, message } from '../../helpers/st-mock';

/* ------------------------------------------------------------------ definitions */

export function socialDef(): MechanicDef {
    return {
        id: 'social',
        name: 'Общение',
        summary: 'Social checks.',
        rules: 'Charisma helps persuade; stealth hides.',
        attributes: [
            { id: 'charisma', name: 'Обаяние', promptName: 'Charisma', kind: 'number', min: 1, max: 20, initial: 10 },
            { id: 'stealth', name: 'Скрытность', promptName: 'Stealth', kind: 'number', min: 0, max: 100, initial: 40 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'persuasion',
                name: 'Убеждение',
                promptName: 'Persuasion',
                dice: '1d20+mod(@charisma)',
                difficulty: 15,
                triggers: ['убед', 'уговор', 'persuad', 'convince'],
            },
            {
                id: 'stealth',
                name: 'Скрытность',
                promptName: 'Stealth',
                dice: '1d100<=@stealth',
                difficulty: null,
                triggers: ['крад', 'sneak'],
            },
        ],
        tracking: 'manual',
        scope: { kind: 'global' },
    };
}

export function magicDef(): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Mana fuels spells.',
        rules: 'Casting costs mana; at 0 mana no spells.',
        attributes: [
            {
                id: 'mana',
                name: 'Мана',
                promptName: 'Mana',
                kind: 'number',
                min: 0,
                max: 30,
                initial: 30,
                events: [{ id: 'empty', when: { op: '<=', value: 0 }, text: '{holder} is out of mana.' }],
            },
            {
                id: 'schools',
                name: 'Школы',
                promptName: 'Schools',
                kind: 'list',
                options: ['fire', 'water', 'air'],
                multi: true,
                initial: [],
            },
            {
                id: 'rank',
                name: 'Ранг',
                promptName: 'Rank',
                kind: 'scale',
                levels: ['novice', 'adept', 'master'],
                initial: 'novice',
            },
            { id: 'element', name: 'Стихия', promptName: 'Element', kind: 'list', options: ['fire', 'ice'] },
            { id: 'oath', name: 'Клятва', promptName: 'Oath', kind: 'text', initial: '' },
            { id: 'secret', name: 'Тайна', promptName: 'Secret', kind: 'number', visible: false, initial: 1 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'focus',
                name: 'Сосредоточение',
                promptName: 'Focus',
                dice: '1d20+@mana',
                difficulty: 20,
                triggers: ['сосредоточ', 'focus'],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
    };
}

export class FakeDefs implements DefinitionsPart {
    readonly off = new Set<string>();
    private readonly listeners = new Set<() => void>();

    constructor(public defs: MechanicDef[]) {}

    list(): MechanicDef[] {
        return this.defs;
    }
    active(): MechanicDef[] {
        return this.defs.filter((def) => !this.off.has(def.id));
    }
    get(id: string): MechanicDef | null {
        return this.defs.find((def) => def.id === id) ?? null;
    }
    async save(def: MechanicDef): Promise<MechanicDef> {
        this.defs = [...this.defs.filter((item) => item.id !== def.id), def];
        this.emit();
        return def;
    }
    async remove(id: string): Promise<void> {
        this.defs = this.defs.filter((def) => def.id !== id);
        this.emit();
    }
    async setEnabledInChat(id: string, on: boolean): Promise<void> {
        if (on) this.off.delete(id);
        else this.off.add(id);
        this.emit();
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
    dispose(): void {}
}

/* ------------------------------------------------------------------ state */

export class FakeState implements StatePart {
    readonly values = new Map<string, AttributeValue>();
    /** Holders in the scene per mechanic id. */
    scene: Record<string, string[]> = {};
    changes: StateChange[] = [];
    fired: FiredEvent[] = [];
    pending: FiredEvent[] = [];
    readonly applied: ChangeInput[][] = [];
    readonly delivered: FiredEvent[][] = [];
    failApply = false;
    private readonly listeners = new Set<() => void>();
    private next = 1;

    private key(mechanicId: string, holder: string, attribute: string): string {
        return `${mechanicId}|${holder}|${attribute}`;
    }

    set(mechanicId: string, holder: string, attribute: string, value: AttributeValue): void {
        this.values.set(this.key(mechanicId, holder, attribute), value);
    }

    state(holder?: string): HolderState[] {
        const result = new Map<string, HolderState>();
        for (const [key, value] of this.values) {
            const [mechanicId, name, attribute] = key.split('|') as [string, string, string];
            if (holder && holder !== name) continue;
            const id = `${mechanicId}|${name}`;
            const entry = result.get(id) ?? { mechanicId, holder: name, values: {}, updatedAt: -1 };
            entry.values[attribute] = value;
            result.set(id, entry);
        }
        return [...result.values()];
    }
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null {
        return this.values.get(this.key(mechanicId, holder, attribute)) ?? null;
    }
    async apply(changes: ChangeInput[]): Promise<StateChange[]> {
        this.applied.push(changes);
        if (this.failApply) throw new Error('state is busy');
        const made: StateChange[] = [];
        for (const change of changes) {
            const from = this.value(change.mechanicId, change.holder, change.attribute);
            const to =
                change.delta && typeof change.value === 'number' && typeof from === 'number'
                    ? from + change.value
                    : change.value;
            this.set(change.mechanicId, change.holder, change.attribute, to);
            const record: StateChange = {
                id: `c${this.next++}`,
                mechanicId: change.mechanicId,
                holder: change.holder,
                attribute: change.attribute,
                from,
                to,
                source: change.source,
                messageIndex: change.messageIndex,
                at: Date.now(),
            };
            if (change.reason) record.reason = change.reason;
            made.push(record);
        }
        this.changes = [...made.reverse(), ...this.changes];
        this.emit();
        return made;
    }
    history(limit = 50): StateChange[] {
        return this.changes.slice(0, limit);
    }
    events(limit = 20): FiredEvent[] {
        return this.fired.slice(0, limit);
    }
    pendingEvents(): FiredEvent[] {
        return [...this.pending];
    }
    async markEventsDelivered(events: FiredEvent[]): Promise<void> {
        this.delivered.push(events);
        this.pending = this.pending.filter((event) => !events.includes(event));
    }
    holdersInScene(def: MechanicDef): string[] {
        return [...(this.scene[def.id] ?? [])];
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
    dispose(): void {}
}

export class FakeTracking implements TrackingPart {
    instruction = '';
    readonly calls: { defs: string[]; holders: Record<string, string[]> }[] = [];
    blockInstruction(defs: MechanicDef[], holdersByMechanic: Record<string, string[]>): string {
        this.calls.push({ defs: defs.map((def) => def.id), holders: holdersByMechanic });
        return this.instruction;
    }
    desStatsStatus() {
        return [];
    }
    async enableDesStats(): Promise<boolean> {
        return false;
    }
    dispose(): void {}
}

/* ------------------------------------------------------------------ chat store */

export class FakeChatStore implements ChatStore {
    readonly docs = new Map<string, unknown>();
    readonly puts: { chatId: string; kind: string; data: unknown }[] = [];
    /** The next put fails like a newer write of another tab (the stored doc is replaced by `conflict`). */
    conflict: unknown = null;

    constructor(private readonly chatId: () => string | null) {}

    async get<T extends object>(kind: string, defaults: () => T): Promise<T> {
        const chatId = this.chatId();
        if (!chatId) return defaults();
        const key = `${chatId}|${kind}`;
        if (!this.docs.has(key)) this.docs.set(key, defaults());
        return structuredClone(this.docs.get(key)) as T;
    }
    async put<T extends object>(kind: string, data: T): Promise<boolean> {
        const chatId = this.chatId();
        if (!chatId) return false;
        const key = `${chatId}|${kind}`;
        if (this.conflict !== null) {
            this.docs.set(key, this.conflict);
            this.conflict = null;
            return false;
        }
        this.docs.set(key, structuredClone(data));
        this.puts.push({ chatId, kind, data: structuredClone(data) });
        return true;
    }
    async getFor<T extends object>(chatId: string, kind: string, defaults: () => T): Promise<T> {
        return (this.docs.get(`${chatId}|${kind}`) as T) ?? defaults();
    }
    pointer<T>(): T | undefined {
        return undefined;
    }
    async setPointer(): Promise<void> {}
    migration(): void {}
    async exportChat(): Promise<Record<string, unknown>> {
        return {};
    }
    async importChat(): Promise<void> {}
}

/* ------------------------------------------------------------------ the env */

export interface SlotRecord {
    value: string;
    position: number;
    depth: number;
    scan: boolean;
    role: number;
}

export interface BadgeRecord {
    index: number;
    id: string;
    text: string;
    removed: boolean;
}

export interface ChecksEnv {
    env: RulesTestApp;
    deps: PartDeps;
    settings: MechanicsSettings;
    defs: FakeDefs;
    state: FakeState;
    tracking: FakeTracking;
    store: FakeChatStore;
    ephemeral: EphemeralRunner;
    slashes: SlashCommandSpec[];
    badges: BadgeRecord[];
    notices: { text: string; urgent: boolean }[];
    prompts(): Record<string, SlotRecord>;
    flags(): Record<string, unknown>;
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Kai' });
}

export function reply(text = 'The guard listens.'): STChatMessage {
    return message(text, { name: 'Guard' });
}

export function createChecksEnv(options: { defs?: MechanicDef[]; chat?: STChatMessage[] } = {}): ChecksEnv {
    const env = createRulesTestApp({ firstRunDone: true });
    env.app.i18n.register(CHECK_STRINGS);
    env.mock.context.name1 = 'Kai';
    env.mock.chat = options.chat ?? [reply('Hello, traveller.')];

    const slots: Record<string, SlotRecord> = {};
    const context = env.mock.context as unknown as Record<string, unknown>;
    context.extensionPrompts = slots;
    context.setExtensionPrompt = (
        key: string,
        value: string,
        position: number,
        depth: number,
        scan = false,
        role = 0,
    ) => {
        slots[key] = { value, position, depth, scan, role };
    };
    const ephemeral = createEphemeral({ host: env.host, log: env.log });
    const store = new FakeChatStore(() => env.host.chatId());
    Object.assign(env.app as unknown as Record<string, unknown>, { ephemeral, chat: store });

    const slashes: SlashCommandSpec[] = [];
    const badges: BadgeRecord[] = [];
    const notices: { text: string; urgent: boolean }[] = [];
    env.ui.addSlashCommand = (spec) => {
        slashes.push(spec);
        return () => {
            const index = slashes.indexOf(spec);
            if (index >= 0) slashes.splice(index, 1);
        };
    };
    env.ui.messageBadge = (index, spec) => {
        const record: BadgeRecord = { index, id: spec.id, text: spec.text, removed: false };
        badges.push(record);
        return () => {
            record.removed = true;
        };
    };
    env.ui.notice = (text, noticeOptions) => {
        notices.push({ text, urgent: noticeOptions?.urgent === true });
    };

    const settings: MechanicsSettings = { ...DEFAULT_MECHANICS_SETTINGS };
    const deps: PartDeps = { app: env.app, log: env.log, settings: () => settings };
    return {
        env,
        deps,
        settings,
        defs: new FakeDefs(options.defs ?? [socialDef(), magicDef()]),
        state: new FakeState(),
        tracking: new FakeTracking(),
        store,
        ephemeral,
        slashes,
        badges,
        notices,
        prompts: () => slots,
        flags: () => {
            const variables = env.mock.chatMetadata.variables;
            return (variables && typeof variables === 'object' ? variables : {}) as Record<string, unknown>;
        },
    };
}

/** An RNG that makes dice of `sides` show the given faces in order (then the middle face). */
export function faces(sides: number, ...values: number[]): () => number {
    let i = 0;
    return () => {
        const value = values[i++];
        return value === undefined ? 0.5 : (value - 0.5) / sides;
    };
}

/** A queue of faces for mixed dice: `[sides, face]` pairs in order. */
export function dice(...rolls: [number, number][]): () => number {
    let i = 0;
    return () => {
        const roll = rolls[i++];
        return roll === undefined ? 0.5 : (roll[1] - 0.5) / roll[0];
    };
}

export async function tick(ms = 0): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The user sends a message the way ST does: pushed into the chat, then MESSAGE_SENT with its index. */
export async function send(env: ChecksEnv, text: string): Promise<number> {
    env.env.mock.chat.push(userMessage(text));
    const index = env.env.mock.chat.length - 1;
    await env.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, index);
    return index;
}

export const NORMAL: GenerationInfo = { type: 'normal', dryRun: false, quiet: false };

export interface Generated {
    /** Extension prompt slots with text as the generation saw them. */
    slots: Record<string, SlotRecord>;
    flags: Record<string, unknown>;
}

/** One generation: the producers (Maestro's interceptor), then the end the pipeline reports. */
export async function generate(
    env: ChecksEnv,
    info: Partial<GenerationInfo> = {},
    end: { stopped?: boolean; skip?: boolean } = {},
): Promise<Generated> {
    const full: GenerationInfo = { ...NORMAL, ...info };
    await env.ephemeral.run(full);
    const slots = Object.fromEntries(
        Object.entries(structuredClone(env.prompts())).filter(([, slot]) => slot.value !== ''),
    );
    const flags = { ...env.flags() };
    if (!end.skip) {
        env.ephemeral.clearAll();
        await env.env.app.bus.emit('generation:ended', { type: full.type, stopped: end.stopped === true });
    }
    return { slots, flags };
}

/** Another chat the way Maestro sees it: ST's CHAT_CHANGED, then the pipeline's `chat:changed`. */
export async function changeChat(
    env: ChecksEnv,
    chatId: string | undefined,
    chat: STChatMessage[] = [],
): Promise<void> {
    env.env.mock.chatId = chatId;
    env.env.mock.chatMetadata = {};
    env.env.mock.chat = chat;
    await env.env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, chatId);
    await env.env.app.bus.emit('chat:changed', { chatId: chatId ?? null });
}
