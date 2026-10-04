// Test app for M15 «Голоса персонажей»: the M22 test app (ST mock, real settings, i18n and bus) with the real
// ephemeral service (its extension prompts recorded in the mock like ST keeps them), small fakes of the world model,
// M19, M35 and the architect, a DES-RU adapter with its 0.8 API, archive lorebooks served by loadWorldInfo, and DES
// tracker fixtures. The voices service is started the way its module does it, with a handle kept for the tests.
import { createEphemeral } from '../../../src/core/ephemeral';
import type { EphemeralRunner } from '../../../src/core/turn';
import type { ArchitectApi, SourceBudget } from '../../../src/features/architect/api';
import type { ArchiveSheet, BunnyMoModeApi } from '../../../src/features/bunnymoMode/api';
import type { Relation, RelationsApi } from '../../../src/features/relations/api';
import type { VoicesApi } from '../../../src/features/voices/api';
import { VoicesService } from '../../../src/features/voices/service';
import { defaultVoicesSettings } from '../../../src/features/voices/settings';
import { VOICES_STRINGS } from '../../../src/features/voices/strings';
import type { Entity, EntityKind, EntitySource, WorldModelApi } from '../../../src/features/world/api';
import type { GenerationInfo, Unsubscribe } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { EVENT_TYPES, message } from '../../helpers/st-mock';

export const ARCHIVES = 'Velmora Archives';

/** Anna: Baby Bunny layout, LING tags in the block and in the Linguistics prose, a healthy INFP. */
export const ANNA_ARCHIVE = [
    '<BunnymoTags><Name:Anna>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:ELF>, <GENDER:FEMALE> </PHYSICAL>',
    '<PERSONALITY><Dere:Kuudere>, <INFP-H>, <TRAIT:STOIC>, <LING:BLUNT>, <LING:SOFT_SPOKEN> </PERSONALITY></BunnymoTags>',
    '<Linguistics> Character uses <LING:FORMAL> speech with an archaic register. She often trails off mid-sentence when',
    'nervous. Speaks with a faint northern lilt. Calls Kai "little fox".</linguistics>',
].join('\n');

/** Corvin: an unhealthy ENTJ written as a `<MBTI:…>` tag, no Linguistics block. */
export const CORVIN_ARCHIVE =
    '<BunnymoTags><Name:Corvin>, <MBTI:ENTJ-U>, <LING:COMMANDING>, <TRAIT:CRUEL></BunnymoTags>';

function norm(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е').trim();
}

/* ------------------------------------------------------------------ world model */

export interface EntitySpec {
    name: string;
    kind?: EntityKind;
    aliases?: string[];
    forms?: string[];
    /** `book#uid` of the character's CK archive. */
    archive?: string;
}

export class FakeWorld implements WorldModelApi {
    private list: Entity[];
    private readonly listeners = new Set<() => void>();
    calls = { resolve: 0 };

    constructor(specs: EntitySpec[]) {
        this.list = specs.map((spec) => this.entity(spec));
    }

    private entity(spec: EntitySpec): Entity {
        const kind = spec.kind ?? 'character';
        const sources: EntitySource[] = [{ kind: 'des.character', ref: spec.name, label: spec.name }];
        if (spec.archive) {
            const at = spec.archive.lastIndexOf('#');
            const world = spec.archive.slice(0, at);
            const uid = Number(spec.archive.slice(at + 1));
            sources.push({ kind: 'ck.archive', ref: spec.archive, label: spec.name, world, uid });
        }
        return {
            id: `${kind}:${norm(spec.name)}`,
            kind,
            name: spec.name,
            aliases: spec.aliases ?? [],
            forms: spec.forms ?? [],
            sources,
        };
    }

    set(specs: EntitySpec[]): void {
        this.list = specs.map((spec) => this.entity(spec));
        for (const listener of [...this.listeners]) listener();
    }

    entities(kind?: EntityKind): Entity[] {
        return this.list.filter((entity) => !kind || entity.kind === kind);
    }
    get(id: string): Entity | undefined {
        return this.list.find((entity) => entity.id === id);
    }
    resolve(name: string, kind?: EntityKind): Entity | undefined {
        this.calls.resolve++;
        const key = norm(name);
        return this.list.find(
            (entity) =>
                (!kind || entity.kind === kind) &&
                [entity.name, ...entity.aliases, ...entity.forms].some((item) => norm(item) === key),
        );
    }
    mentions(): Entity[] {
        return [];
    }
    facts() {
        return [];
    }
    async rebuild(): Promise<void> {}
    chatAliases(): Record<string, string> {
        return {};
    }
    async setChatAlias(): Promise<void> {}
    async merge(): Promise<void> {}
    async separate(): Promise<void> {}
    mergeCandidates() {
        return [];
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/* ------------------------------------------------------------------ M19, M35, M20 */

export class FakeRelations implements RelationsApi {
    private readonly listeners = new Set<() => void>();

    constructor(public list: Relation[] = []) {}

    set(list: Relation[]): void {
        this.list = list;
        for (const listener of [...this.listeners]) listener();
    }
    all(): Relation[] {
        return this.list;
    }
    of(name: string): Relation[] {
        return this.list.filter((relation) => relation.from === name || relation.to === name);
    }
    between(from: string, to: string): Relation | undefined {
        return this.list.find((relation) => relation.from === from && relation.to === to);
    }
    async rebuild(): Promise<void> {}
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/** A relation with one point per status: `[messageIndex, status]`. */
export function relation(from: string, to: string, points: [number, string][]): Relation {
    return {
        from,
        to,
        current: points[points.length - 1]?.[1] ?? '',
        history: points.map(([messageIndex, status]) => ({ messageIndex, status, source: 'des' as const })),
    };
}

export class FakeBunnyMoMode implements Partial<BunnyMoModeApi> {
    readonly reads: string[] = [];
    constructor(public sheets: Record<string, ArchiveSheet | null>) {}
    async readSheet(book: string, uid: number): Promise<ArchiveSheet | null> {
        this.reads.push(`${book}#${uid}`);
        return this.sheets[`${book}#${uid}`] ?? null;
    }
}

export class FakeArchitect implements Partial<ArchitectApi> {
    constructor(public voices: number) {}
    budgets(): SourceBudget[] {
        return [
            { source: 'lore', tokens: 4000 },
            { source: 'voices', tokens: this.voices },
        ];
    }
}

/* ------------------------------------------------------------------ DES-RU */

export const DESRU_FUNCTIONS = ['bunnymo.structuralPatches', 'ck.consistencyRebuild', 'bunnymo.scanTags'];

/** DES-RU's API v1 ownership part (maestro-api.js: replace semantics, known ids only, MAESTRO_FUNCTIONS order). */
export class FakeDesRuApi {
    readonly version = 1;
    owned = new Set<string>();
    calls: string[][] = [];
    functions(): string[] {
        return [...DESRU_FUNCTIONS];
    }
    setMaestroOwned(ids: string[]): void {
        this.calls.push([...ids]);
        this.owned = new Set(ids.filter((id) => DESRU_FUNCTIONS.includes(id)));
    }
    maestroOwned(): string[] {
        return DESRU_FUNCTIONS.filter((id) => this.owned.has(id));
    }
}

/** The DES-RU adapter's surface M15 uses (api(), setMaestroOwned filtering by functions()). */
export function fakeDesRuAdapter(state: { api: FakeDesRuApi | undefined }) {
    return {
        id: 'desru',
        present: () => state.api !== undefined,
        version: () => '0.8.0',
        capabilities: () => [],
        ready: async () => {},
        api: () => state.api,
        setMaestroOwned(ids: readonly string[]): boolean {
            const api = state.api;
            if (!api) return false;
            const offered = new Set(api.functions());
            api.setMaestroOwned([...new Set(ids)].filter((id) => offered.has(id)));
            return true;
        },
    };
}

/* ------------------------------------------------------------------ chat fixtures */

export interface TrackerCharacter {
    name: string;
    details?: Record<string, string>;
    relationship?: string;
    thoughts?: string;
    present?: boolean;
}

/** An assistant reply with a DES tracker (DES 2.6 shapes: relationship.status, thoughts.content). */
export function trackerReply(
    characters: TrackerCharacter[],
    quests?: { main?: string; optional?: string[] },
    text = 'reply',
): STChatMessage {
    const list = characters.map((item) => ({
        name: item.name,
        ...(item.details ? { details: item.details } : {}),
        ...(item.relationship ? { relationship: { status: item.relationship } } : {}),
        ...(item.thoughts ? { thoughts: { content: item.thoughts } } : {}),
        ...(item.present === false ? { present: false } : {}),
    }));
    const questData = quests
        ? JSON.stringify({
              main: quests.main ? { title: quests.main } : 'None',
              optional: (quests.optional ?? []).map((title) => ({ title })),
          })
        : null;
    return message(text, {
        extra: {
            dooms_tracker_swipes: [{ characterThoughts: JSON.stringify(list), quests: questData, infoBox: null }],
        },
    });
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Kai' });
}

/* ------------------------------------------------------------------ the app */

export interface SlotRecord {
    value: string;
    position: number;
    depth: number;
    scan: boolean;
    role: number;
}

export interface VoicesTestApp {
    env: RulesTestApp;
    service: VoicesService;
    api: VoicesApi;
    ephemeral: EphemeralRunner;
    world: FakeWorld;
    relations: FakeRelations;
    desru: { api: FakeDesRuApi | undefined };
    books: Record<string, { entries: Record<string, Record<string, unknown>> }>;
    loads: string[];
    prompts(): Record<string, SlotRecord>;
    stop(): Promise<void>;
    stopped: boolean;
}

export interface StartOptions {
    world?: EntitySpec[];
    relations?: Relation[];
    chat?: STChatMessage[];
    desru?: FakeDesRuApi | null;
    /** Extra setup before the service starts (fakes of M35, M20, DES). */
    before?(app: VoicesTestApp): void;
}

export const DEFAULT_WORLD: EntitySpec[] = [
    { name: 'Kai', kind: 'persona' },
    { name: 'Anna', aliases: ['Annie'], forms: ['Анна', 'Анной'], archive: `${ARCHIVES}#1` },
    { name: 'Corvin', archive: `${ARCHIVES}#2` },
    { name: 'Bob' },
];

export function defaultBooks(): VoicesTestApp['books'] {
    return {
        [ARCHIVES]: {
            entries: {
                '1': { uid: 1, comment: 'Anna Character Archive', content: ANNA_ARCHIVE },
                '2': { uid: 2, comment: 'Corvin Character Archive', content: CORVIN_ARCHIVE },
            },
        },
    };
}

/** Kai is the persona; Anna and Corvin are in the scene, Bob has left, a stranger has no world entity. */
export function defaultChat(): STChatMessage[] {
    return [
        userMessage('We need to leave.'),
        trackerReply(
            [
                {
                    name: 'Anna',
                    details: { appearance: 'tall elf', demeanor: 'guarded, tired', current_goal: 'find the map' },
                    relationship: 'Friend',
                    thoughts: 'He is right.',
                },
                { name: 'Corvin', details: { demeanor: 'cold' }, relationship: 'Enemy' },
                { name: 'Bob', thoughts: 'Not currently in the scene; he is at the docks.' },
                { name: 'Kai', relationship: 'Self' },
                { name: 'Stranger', details: { demeanor: 'nervous' } },
            ],
            { main: 'Escape Velmora with Anna', optional: ['Pay Bob back'] },
        ),
        userMessage('Anna, the map?'),
    ];
}

export async function tick(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function startVoices(options: StartOptions = {}): Promise<VoicesTestApp> {
    const env = createRulesTestApp({ firstRunDone: true });
    env.settings.registerModule('voices', defaultVoicesSettings, true);
    env.app.i18n.register(VOICES_STRINGS);
    env.mock.context.name1 = 'Kai';
    env.mock.chat = options.chat ?? defaultChat();

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
    (env.app as { ephemeral: unknown }).ephemeral = ephemeral;

    const world = new FakeWorld(options.world ?? DEFAULT_WORLD);
    const relations = new FakeRelations(options.relations ?? []);
    env.modules.expose('world', world);
    env.modules.expose('relations', relations);

    const desru = { api: options.desru === null ? undefined : (options.desru ?? new FakeDesRuApi()) };
    (env.app.adapters as unknown as Record<string, unknown>).desru = fakeDesRuAdapter(desru);

    const books = defaultBooks();
    const loads: string[] = [];
    context.loadWorldInfo = async (name: string) => {
        loads.push(name);
        return books[name] ? structuredClone(books[name]) : null;
    };

    const disposers: (() => void | Promise<void>)[] = [];
    const service = new VoicesService(env.app, env.log);
    const app: VoicesTestApp = {
        env,
        service,
        api: service.api(),
        ephemeral,
        world,
        relations,
        desru,
        books,
        loads,
        prompts: () => slots,
        stopped: false,
        async stop() {
            if (app.stopped) return;
            app.stopped = true;
            for (const dispose of disposers.splice(0).reverse()) await dispose();
        },
    };
    options.before?.(app);
    service.install((dispose) => disposers.push(dispose));
    env.modules.expose('voices', app.api);
    await tick();
    return app;
}

/** Another chat the way Maestro sees it: ST's CHAT_CHANGED, then the turn pipeline's `chat:changed`. */
export async function changeChat(app: VoicesTestApp, chatId: string | undefined): Promise<void> {
    await switchChat(app.env.mock, chatId);
    await app.env.app.bus.emit('chat:changed', { chatId: chatId ?? null });
}

export const NORMAL: GenerationInfo = { type: 'normal', dryRun: false, quiet: false };

export type Msg = { role: string; content: unknown };

/** One generation the way ST runs it: Maestro's interceptor (producers), CK's insert, PROMPT_READY with messages. */
export async function generate(
    app: VoicesTestApp,
    messages: Msg[],
    options: { info?: Partial<GenerationInfo>; ck?: string; dryRun?: boolean } = {},
): Promise<Msg[]> {
    await app.ephemeral.run({ ...NORMAL, ...options.info });
    if (options.ck !== undefined) {
        app.prompts()['script_inject_carrot-consistency'] = {
            value: options.ck,
            position: 1,
            depth: 4,
            scan: true,
            role: 0,
        };
    }
    await app.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, {
        chat: messages,
        dryRun: options.dryRun ?? false,
    });
    return messages;
}
