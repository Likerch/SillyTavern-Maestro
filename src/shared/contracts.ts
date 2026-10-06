// Contracts between Maestro layers. Implementations live in src/host, src/core, src/adapters and
// src/ui; features only see these interfaces through the App object passed to init().
// Keep this file free of runtime code except tiny constants.

/* ------------------------------------------------------------------ basics */

export type Unsubscribe = () => void;
export type Dict = Record<string, string>;

export interface I18nParts {
    en: Dict;
    ru: Dict;
}

export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    /** A logger whose lines carry `[scope]`. */
    scope(name: string): Logger;
}

export interface I18n {
    /** Key like `m1.title`; `{name}` placeholders are filled from params. Falls back to English, then the key. */
    t(key: string, params?: Record<string, string | number>): string;
    register(parts: I18nParts): void;
    locale(): 'ru' | 'en';
}

/* ------------------------------------------------------------------ settings */

export interface CoreSettings {
    schemaVersion: number;
    mode: 'economy' | 'balanced' | 'cinema';
    debug: boolean;
    uiLanguage: 'auto' | 'ru' | 'en';
    /** Connection Manager profile ids by task kind ('default' is the fallback). */
    profiles: Record<string, string>;
    /** Daily cap for Maestro's own background LLM spend, USD. 0 = no cap. */
    backgroundDailyCapUsd: number;
    /** Overall daily limit (off by default). */
    dailyLimit: { enabled: boolean; usd: number; action: 'warn' | 'economy' | 'stopBackground' };
    /** Autonomy level per action kind (see Autonomy). Missing kinds use the module default. */
    autonomy: Record<string, AutonomyLevel>;
    /** Modules switched on/off by the user; missing = module default. */
    modules: Record<string, boolean>;
    firstRunDone: boolean;
}

export interface SettingsService {
    core(): CoreSettings;
    /** The settings slice of a module (created from its defaults). */
    module<T extends object>(key: string): T;
    isModuleEnabled(key: string): boolean;
    setModuleEnabled(key: string, enabled: boolean): void;
    save(): void;
    onChange(listener: (path: string) => void): Unsubscribe;
    /** Called by UI code after editing a value by path ("core.mode", "m1.keepTurns"). */
    notify(path: string): void;
    /** Re-reads extensionSettings (after an import replaced Maestro's settings object). */
    reload?(): void;
}

/* ------------------------------------------------------------------ host (SillyTavern) */

export type ListenerOrder = 'first' | 'last' | 'normal';

export interface HostEvents {
    /** Subscribes to a SillyTavern event (eventTypes key or raw name). */
    on(event: string, handler: (...args: unknown[]) => unknown, options?: { order?: ListenerOrder }): Unsubscribe;
    /** Re-asserts `last`/`first` positions (other extensions may register later). */
    reassertOrder(): void;
    emit(event: string, ...args: unknown[]): Promise<void>;
    /** Resolves an eventTypes key to the raw event name (undefined if this ST lacks it). */
    name(key: string): string | undefined;
    /** Reports how long each Maestro listener ran (until its promise settled); null stops it (metrics, P15). */
    setTimer?(sink: ((event: string, ms: number) => void) | null): void;
}

/** SillyTavern modules that are not in getContext(); loaded at runtime by URL. */
export interface HostModules {
    worldInfo(): Promise<Record<string, unknown>>;
    script(): Promise<Record<string, unknown>>;
    openai(): Promise<Record<string, unknown>>;
    presetManager(): Promise<Record<string, unknown>>;
    chats(): Promise<Record<string, unknown>>;
    regexEngine(): Promise<Record<string, unknown>>;
    utils(): Promise<Record<string, unknown>>;
    /** Any other module path under /scripts/. */
    load(path: string): Promise<Record<string, unknown>>;
}

export interface CapabilityReport {
    id: string;
    ok: boolean;
    detail?: string;
}

export interface Capabilities {
    /** Registers a probe; probes run on activation and on demand. */
    register(id: string, probe: () => boolean | Promise<boolean>, detail?: string): void;
    has(id: string): boolean;
    report(): CapabilityReport[];
    refresh(): Promise<void>;
}

/** Hooks into window.fetch, installed once and never removed during a generation. */
export interface FetchGate {
    /** Called before a matching request leaves; may delay (await) or veto it by returning a Response. */
    beforeRequest(
        match: RegExp,
        hook: (url: string, init: RequestInit | undefined) => Promise<Response | void> | Response | void,
    ): Unsubscribe;
    /** Called with a clone of the response (streams are tee'd). */
    afterResponse(match: RegExp, hook: (url: string, response: Response, init?: RequestInit) => void): Unsubscribe;
}

export interface Host {
    ctx(): STContext;
    events: HostEvents;
    modules: HostModules;
    caps: Capabilities;
    fetchGate: FetchGate;
    /** SillyTavern version string, if known. */
    version(): string | undefined;
    /** Current chat id or null (no chat, group chat is reported separately). */
    chatId(): string | null;
    isGroupChat(): boolean;
    isChatCompletion(): boolean;
}

/* ------------------------------------------------------------------ storage */

/** Files under ST user files, always prefixed `maestro-`. */
export interface FileStore {
    /** `fresh` bypasses the in-memory cache (compare-and-swap, locks, other tabs). */
    read<T>(name: string, options?: { fresh?: boolean }): Promise<T | null>;
    write(name: string, data: unknown): Promise<void>;
    remove(name: string): Promise<void>;
    /** Safe file name for an arbitrary key (hash), keeping the `maestro-` prefix. */
    fileName(kind: string, key?: string): string;
}

/** Versioned per-chat documents (one file per chat and kind). */
export interface ChatStore {
    /** Loads (or creates from defaults) a document of the current chat. */
    get<T extends object>(kind: string, defaults: () => T): Promise<T>;
    /** Saves with a version check; returns false if another tab wrote a newer version. */
    put<T extends object>(kind: string, data: T): Promise<boolean>;
    /** Documents of an explicit chat id (export, branches). */
    getFor<T extends object>(chatId: string, kind: string, defaults: () => T): Promise<T>;
    /** Small pointers in chat metadata (counters, file ids). */
    pointer<T>(name: string): T | undefined;
    setPointer(name: string, value: unknown): Promise<void>;
    /** Registers a migration for a document kind: from version -> to version+1. */
    migration(
        kind: string,
        fromVersion: number,
        migrate: (doc: Record<string, unknown>) => Record<string, unknown>,
    ): void;
    exportChat(chatId: string): Promise<Record<string, unknown>>;
    importChat(chatId: string, bundle: Record<string, unknown>): Promise<void>;
    /** Deletes every document of a chat (ST deleted the chat); returns how many files were removed. */
    removeChat?(chatId: string): Promise<number>;
}

/* ------------------------------------------------------------------ leader, tasks */

export interface Leader {
    /** True when this tab owns background work and writes for the current chat. */
    isLeader(): boolean;
    onChange(listener: (leader: boolean) => void): Unsubscribe;
}

export interface TaskSpec {
    kind: string;
    /** Same dedupeKey replaces a pending task (roll-up). */
    dedupeKey?: string;
    payload: Record<string, unknown>;
    /** Chat the task belongs to (defaults to the current chat). */
    chatId?: string;
    priority?: number;
    /** Abort if not started within this many ms (stale work). */
    ttlMs?: number;
}

export interface TaskInfo extends TaskSpec {
    id: string;
    state: 'pending' | 'running' | 'done' | 'failed' | 'expired';
    attempts: number;
    createdAt: number;
    error?: string;
}

export type TaskRunner = (payload: Record<string, unknown>, info: TaskInfo) => Promise<void>;

export interface TaskQueue {
    register(kind: string, runner: TaskRunner): Unsubscribe;
    enqueue(task: TaskSpec): Promise<string>;
    list(): TaskInfo[];
    /** Runs pending tasks now if idle (leader only). */
    kick(): void;
}

/* ------------------------------------------------------------------ LLM and cost */

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
}

export interface LlmRequest {
    /** Task kind: picks the profile and labels the cost. */
    task: string;
    messages: LlmMessage[];
    maxTokens: number;
    temperature?: number;
    /** JSON schema for structured output; the result is parsed and validated. */
    schema?: { name: string; schema: Record<string, unknown> };
    /** Tool definitions (assistant loop). */
    tools?: unknown[];
    signal?: AbortSignal;
}

export interface LlmResult<T = unknown> {
    ok: boolean;
    /** Parsed JSON when a schema was given, otherwise the text. */
    data?: T;
    text?: string;
    toolCalls?: unknown[];
    refusal?: boolean;
    error?: string;
    costUsd?: number;
    tokens?: { prompt: number; completion: number };
}

export interface LlmClient {
    request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>>;
    /** False when no usable profile exists or the circuit breaker is open for the task's profile. */
    available(task: string): boolean;
}

export interface CostEntry {
    source: 'main' | 'qvink' | 'maestro' | 'nai' | 'other';
    task?: string;
    usd: number;
    /** `cached`: prompt tokens served from the provider's prompt cache, when it reports them. */
    tokens?: { prompt: number; completion: number; cached?: number };
    estimated?: boolean;
    at: number;
    chatId?: string | null;
}

export interface CostSummary {
    todayUsd: number;
    todayBySource: Record<string, number>;
    backgroundTodayUsd: number;
    anlasToday: number;
}

export interface CostMeter {
    record(entry: Omit<CostEntry, 'at'>): void;
    recordAnlas(amount: number): void;
    summary(): CostSummary;
    backgroundCapReached(): boolean;
    /** Today's recent cost entries, oldest first (metrics). */
    recent?(): readonly CostEntry[];
    onChange(listener: () => void): Unsubscribe;
    /** Fired once per day when the overall daily limit (CoreSettings.dailyLimit) is reached. */
    onLimitReached?(
        listener: (info: { usd: number; limit: number; action: CoreSettings['dailyLimit']['action'] }) => void,
    ): Unsubscribe;
}

/* ------------------------------------------------------------------ journal, autonomy, inbox */

export type AutonomyLevel = 'auto' | 'notify' | 'inbox' | 'ask' | 'off';

export interface JournalChange {
    /** What was changed: 'lorebook-entry', 'chat-flag', 'qvink-memory', 'passport', 'setting', ... */
    target: string;
    /** Locator understood by the undo handler (book+uid, message index, settings path, ...). */
    ref: Record<string, unknown>;
    before: unknown;
    after: unknown;
}

export interface JournalAction {
    module: string;
    kind: string;
    /** Human-readable summary (already translated). */
    summary: string;
    changes: JournalChange[];
    /** Message index the action came from (for invalidation on swipe/delete/edit). */
    sourceMessage?: number;
}

export interface JournalRecord extends JournalAction {
    id: string;
    at: number;
    chatId: string | null;
    undone?: boolean;
}

export type UndoHandler = (change: JournalChange) => Promise<boolean>;

export interface Journal {
    record(action: JournalAction): Promise<string>;
    undo(id: string): Promise<boolean>;
    /** Undo every action recorded for one message (turn rollback). */
    undoForMessage(messageIndex: number): Promise<number>;
    list(filter?: { module?: string; limit?: number }): JournalRecord[];
    /** Registers how to revert changes of a target type. */
    registerUndo(target: string, handler: UndoHandler): void;
}

export interface Proposal<T = unknown> {
    module: string;
    /** Action kind used for the autonomy level, e.g. 'canon.fact', 'qc.swipe'. */
    kind: string;
    title: string;
    description?: string;
    /** Diff shown to the user. */
    changes: JournalChange[];
    payload: T;
    sourceMessage?: number;
    /** Lifetime of the Inbox card when the proposal is queued. */
    ttlMs?: number;
    /** Inbox button texts when «Accept» / «Reject» would not say it (a question: «Тот же» / «Другой»). */
    acceptLabel?: string;
    rejectLabel?: string;
    /** Apply the proposal (called when allowed or accepted). */
    apply(payload: T): Promise<void>;
    /** Optional check that "before" still matches the live data. */
    stillValid?(): Promise<boolean>;
}

export type Decision = 'applied' | 'queued' | 'notified' | 'rejected' | 'skipped';

export interface AutonomyStats {
    kind: string;
    accepted: number;
    edited: number;
    rejected: number;
    undone: number;
    streak: number;
}

export interface Autonomy {
    level(kind: string, fallback: AutonomyLevel): AutonomyLevel;
    /** Routes a proposal: applies, notifies, queues to the Inbox, asks, or skips. */
    decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision>;
    record(kind: string, outcome: 'accepted' | 'edited' | 'rejected' | 'undone'): void;
    stats(): AutonomyStats[];
    /** Kinds that must never be promoted to 'auto'. */
    neverAuto(kind: string): void;
    /** Kinds registered with neverAuto() (Settings hides "auto" for them). */
    isNeverAuto?(kind: string): boolean;
    /** Sets the user's level for a kind (Inbox «Всегда так», trust offer); 'auto' is refused for never-auto kinds. */
    setLevel?(kind: string, level: AutonomyLevel): boolean;
}

export interface InboxCard {
    id: string;
    module: string;
    kind: string;
    title: string;
    description?: string;
    changes: JournalChange[];
    /** JSON-serialisable payload passed to the registered applier. */
    payload: unknown;
    createdAt: number;
    sourceMessage?: number;
    /** Deferred cards wait for a module of a later stage. */
    deferred?: boolean;
    expiresAt?: number;
    /** The proposal's own button texts (Proposal.acceptLabel / rejectLabel), already translated. */
    acceptLabel?: string;
    rejectLabel?: string;
}

export interface Inbox {
    /**
     * Cards survive page reloads but closures do not: modules register how to apply (and re-validate)
     * a card of their kind from its stored JSON payload.
     */
    registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
        /** Called after the user rejected a card of this kind (e.g. world.merge → «these are different»). */
        onReject?: (payload: unknown) => Promise<void>,
    ): Unsubscribe;
    add(proposal: Proposal, options?: { deferred?: boolean; ttlMs?: number }): Promise<string>;
    list(): InboxCard[];
    accept(id: string, edited?: unknown): Promise<boolean>;
    reject(id: string): Promise<void>;
    snooze(id: string, ms: number): Promise<void>;
    /** Drops cards that came from this message (swipe/delete/edit). */
    invalidateMessage(messageIndex: number): Promise<number>;
    onChange(listener: () => void): Unsubscribe;
    count(): number;
    /** Loads the cards of the current chat (called lazily by readers that need them before the first change). */
    load?(): Promise<void>;
}

/* ------------------------------------------------------------------ ephemeral flags and injections */

export interface InjectionSpec {
    text: string;
    /** -1 none (scan only), 0 in prompt, 1 in chat at depth, 2 before prompt (ST extension_prompt_types). */
    position: -1 | 0 | 1 | 2;
    depth?: number;
    /** 0 system, 1 user, 2 assistant. */
    role?: 0 | 1 | 2;
    scan?: boolean;
}

/** Everything here is set right before a generation and cleared after it (P8, P11). */
export interface Ephemeral {
    setFlag(name: string, value: string | number | boolean): void;
    setInjection(key: string, spec: InjectionSpec): void;
    /** Producers called on every generation (non-dry): they set flags/injections for that turn. */
    addProducer(name: string, producer: (gen: GenerationInfo) => void | Promise<void>): Unsubscribe;
    clearAll(): void;
}

export interface GenerationInfo {
    type: string;
    dryRun: boolean;
    quiet: boolean;
    /** True when the last user message is a BunnyMo sheet command. */
    sheetCommand?: string;
}

/* ------------------------------------------------------------------ Maestro internal events */

export interface MaestroEvents {
    'chat:changed': { chatId: string | null };
    /** The user sent a message: the previous assistant reply is now committed (P14). */
    'turn:committed': { messageIndex: number };
    'generation:before': GenerationInfo;
    'generation:ended': { type: string; stopped: boolean };
    /** Reply finished and DES / DES-RU / NAI markers already processed it. */
    'reply:ready': { messageIndex: number; type: string };
    /** Quality check passed for this reply (NAI Studio waits for it from stage 6). */
    'reply:ok': { messageIndex: number };
    'message:invalidated': { messageIndex: number; reason: 'swiped' | 'deleted' | 'edited' };
    signal: Signal;
    'settings:changed': { path: string };
    'leader:changed': { leader: boolean };
}

export interface Signal {
    kind: string;
    chatId: string | null;
    messageIndex?: number;
    entity?: string;
    data?: Record<string, unknown>;
    at: number;
}

export interface Bus {
    on<K extends keyof MaestroEvents>(
        event: K,
        handler: (payload: MaestroEvents[K]) => void | Promise<void>,
    ): Unsubscribe;
    emit<K extends keyof MaestroEvents>(event: K, payload: MaestroEvents[K]): Promise<void>;
}

/* ------------------------------------------------------------------ UI registry */

export interface PultTab {
    id: string;
    /** i18n key of the tab title. */
    titleKey: string;
    icon: string;
    order: number;
    render(container: HTMLElement): void | Unsubscribe;
    /** Badge number (e.g. Inbox count). */
    badge?(): number;
    /**
     * Sidebar group (plan §7): 'turn', 'inbox', 'canon', 'dossier', 'world', 'mechanics', 'health', 'journal',
     * 'assistant', 'extensions', 'settings', or 'top' (above the groups, no heading). Missing or unknown: the UI's
     * central map by tab id (src/ui/views/pult-groups.ts), else «Ещё».
     */
    group?: string;
}

/** A block of the Settings tab added by a module (shown after the built-in blocks, by order). */
export interface SettingsSection {
    id: string;
    /** i18n key of the section heading. */
    titleKey: string;
    order: number;
    /** Renders into its own container; the returned disposer runs on every re-render and when the tab closes. */
    render(container: HTMLElement): void | Unsubscribe;
}

export interface HealthCheck {
    id: string;
    module: string;
    titleKey: string;
    run(): Promise<{ status: 'ok' | 'warn' | 'error' | 'skip'; message?: string; fix?: () => Promise<void> }>;
}

export interface WizardStep {
    id: string;
    order: number;
    titleKey: string;
    render(container: HTMLElement, done: () => void): void;
    /** Called when the user leaves the step with the forward/back button (before the next step renders). */
    leave?(direction: 'next' | 'back'): void | Promise<void>;
}

export interface SlashCommandSpec {
    name: string;
    helpKey: string;
    callback: (args: Record<string, unknown>, value: string) => string | Promise<string>;
    args?: { name: string; descriptionKey: string; optional?: boolean }[];
}

export interface Ui {
    addTab(tab: PultTab): Unsubscribe;
    addHealthCheck(check: HealthCheck): Unsubscribe;
    addWizardStep(step: WizardStep): Unsubscribe;
    /** ST cannot unregister: the remover makes the command answer "module is off" (own() it). */
    addSlashCommand(command: SlashCommandSpec): Unsubscribe;
    openPult(tabId?: string): void;
    closePult?(): void;
    /** Badge refresh after state changes. */
    refresh(): void;
    /** Non-blocking notice; `urgent` uses a toast, otherwise only the badge/log. */
    notice(
        text: string,
        options?: { urgent?: boolean; level?: 'info' | 'warn' | 'error'; action?: { label: string; run: () => void } },
    ): void;
    /** Modal confirmation through ST Popup (only for urgent Maestro-initiated questions). */
    confirm(title: string, body: string | HTMLElement): Promise<boolean>;
    /** Message badge with an action button (M12 notify). */
    messageBadge(
        messageIndex: number,
        badge: { id: string; text: string; action?: { label: string; run: () => void } },
    ): Unsubscribe;
    /** Adds CSS that is removed on dispose. */
    style(id: string, css: string): Unsubscribe;
    /** Adds a section to the Settings tab (same id replaces); the remover takes it away (own() it). */
    addSettingsSection?(section: SettingsSection): Unsubscribe;
}

/* ------------------------------------------------------------------ adapters */

export interface NeighbourAdapter {
    readonly id: 'des' | 'desru' | 'ck' | 'bunnymo' | 'qvink' | 'nai' | 'localizer' | 'preset';
    /** Installed and enabled in this ST. */
    present(): boolean;
    version(): string | undefined;
    /** Capability ids this adapter provides when present. */
    capabilities(): string[];
    /** One-time async setup (module imports); safe to call repeatedly. */
    ready(): Promise<void>;
}

/* ------------------------------------------------------------------ modules and app */

export interface ModuleContext<S extends object> {
    app: App;
    settings: S;
    log: Logger;
    /** Everything registered through this helper is disposed automatically on module disable. */
    own(dispose: Unsubscribe | (() => void | Promise<void>)): void;
}

export interface MaestroModule<S extends object = object> {
    /** Plan id: 'M1'. */
    id: string;
    /** Settings key and folder name: 'loreJournal'. */
    key: string;
    /** Stage of the plan that introduces it. */
    stage: number;
    titleKey: string;
    enabledByDefault: boolean;
    defaults(): S;
    /** Capability ids that must be present; otherwise the module stays off with a health warning. */
    requires?: string[];
    i18n?: I18nParts;
    init(ctx: ModuleContext<S>): void | Promise<void>;
    /** Optional extra cleanup; owned disposers run anyway. */
    dispose?(): void | Promise<void>;
}

export interface ModuleManager {
    list(): { module: MaestroModule; enabled: boolean; running: boolean; missing: string[] }[];
    enable(key: string): Promise<void>;
    disable(key: string): Promise<void>;
    /** Typed access to another module's public API (registered with expose()). */
    api<T>(key: string): T | undefined;
    expose(key: string, api: unknown): void;
}

/** Hooks of the turn pipeline (src/core/turn.ts). */
export interface TurnHooks {
    /**
     * Runs inside Maestro's generate_interceptor (after Qvink, CK and NAI Studio, before the WI scan).
     * `chat` is ST's coreChat array: replace entries with copies, never mutate shared `extra`.
     */
    onIntercept(handler: (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>): Unsubscribe;
    /** Index of the last assistant message in the live chat, -1 if none. */
    lastAssistantIndex(): number;
    /** performance.now() timing of the last run of Maestro's generate interceptor (metrics); null before the first. */
    lastIntercept?(): { type: string; startedAt: number; endedAt: number } | null;
    /** Info about the generation in progress, if any. */
    current(): GenerationInfo | null;
}

export interface App {
    host: Host;
    turn: TurnHooks;
    log: Logger;
    i18n: I18n;
    settings: SettingsService;
    files: FileStore;
    chat: ChatStore;
    leader: Leader;
    tasks: TaskQueue;
    llm: LlmClient;
    cost: CostMeter;
    journal: Journal;
    autonomy: Autonomy;
    inbox: Inbox;
    ephemeral: Ephemeral;
    bus: Bus;
    ui: Ui;
    adapters: Record<NeighbourAdapter['id'], NeighbourAdapter>;
    modules: ModuleManager;
}
