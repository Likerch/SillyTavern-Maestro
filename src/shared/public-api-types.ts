// The whole MAESTRO_API v1 as Maestro 1.24 publishes it (`globalThis.MAESTRO_API`, docs/integration-officina.md and
// docs/integration-dramatis.md). Self-contained — types and two constants, no imports — so a neighbour (Officina) can
// copy this file verbatim. src/adapters/dramatis/apis.ts stays the Dramatis contract (copied from Dramatis); this file
// is a superset of its MaestroApiV1 (src/app/public-api.ts checks it at compile time).
//
// `version` stays 1: members are only ever added. A consumer checks `features` (1.24+) or the member itself before
// using anything newer than 1.17. Task ids, action kinds, journal kinds and journal targets of a neighbour start with
// its prefix (EXTERNAL_PREFIXES: 'dramatis.', 'officina.'; targets also 'dramatis-', 'officina-'); its journal records
// and Inbox cards go under the module of that prefix ('dramatis', 'officina').

export const MAESTRO_API_GLOBAL = 'MAESTRO_API';
export const MAESTRO_API_READY_EVENT = 'maestro-api-ready';

export type ApiUnsubscribe = () => void;

/** What this build offers (MaestroApi.features). */
export type MaestroApiFeature =
    | 'prefix:dramatis'
    | 'prefix:officina'
    | 'cost'
    | 'lore'
    | 'bookRoles'
    | 'mechanics'
    | 'presets'
    | 'promptAudit'
    | 'persona'
    | 'serviceCard'
    | 'prepareScenes';

/**
 * Errors of the service facades (1.24): 'off' — the module that owns it is switched off or paused (a service chat
 * pauses the story modules; the mechanics definitions stay, 1.24.1); 'bad-args' — the call did not pass validation;
 * 'read-only' — a BunnyMo book or another book Maestro never writes; 'not-found'; 'exists' — the name is taken;
 * 'unsaved' — the working preset has unsaved edits; 'no-chat' — it needs an open chat; 'unavailable' — the host cannot
 * do it now; 'maestro-stopped'; 'failed' — anything else (`message` says what).
 */
export type ApiError =
    | 'off'
    | 'bad-args'
    | 'read-only'
    | 'not-found'
    | 'exists'
    | 'unsaved'
    | 'no-chat'
    | 'unavailable'
    | 'maestro-stopped'
    | 'failed';

export type ApiResult<T extends object = object> =
    ({ ok: true } & T) | { ok: false; error: ApiError; message?: string };

/**
 * Options of a facade write. `by`: the neighbour the journal record goes under (default 'officina'). `summary`: the
 * words of the journal record — taken by the lore writes, the layer edits and presets.saveAs; the other writes use
 * Maestro's own words.
 */
export interface ApiWriteOptions {
    by?: 'officina' | 'dramatis';
    summary?: string;
}

/* ------------------------------------------------------------------ LLM, Inbox, journal (1.17) */

export interface ApiLlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ApiLlmRequest {
    /** Task id registered with llm.registerTask ('dramatis.turn', 'officina.bible'); picks the profile, labels the cost. */
    task: string;
    messages: ApiLlmMessage[];
    maxTokens: number;
    temperature?: number;
    /** Sent named after the task (`officina.bible` → `officina_bible`), whatever `name` says. */
    schema?: { name: string; schema: Record<string, unknown> };
    /**
     * Background work: refused (ok:false, error 'not-leader' / 'cap') when this tab is not the chat's leader or the
     * daily background cap is reached. Interactive tasks (the user pressed a button) pass false. In a service chat
     * (Maestro 1.21+) `dramatis.*` requests are refused with 'workshop'; `officina.*` ones go through (1.24+).
     */
    background: boolean;
    signal?: AbortSignal;
}

export interface ApiLlmResult<T = unknown> {
    ok: boolean;
    data?: T;
    text?: string;
    refusal?: boolean;
    /** 'not-leader' | 'cap' | 'no-profile' | 'breaker' | 'workshop' | 'bad-task' | 'bad-request' | free text. */
    error?: string;
    costUsd?: number;
    tokens?: { prompt: number; completion: number };
}

export interface ApiJournalChange {
    target: string;
    ref: Record<string, unknown>;
    before: unknown;
    after: unknown;
}

/** A proposal routed by Maestro's autonomy levels; applied through the applier registered for its kind. */
export interface ApiProposal {
    /** Action kind ('dramatis.intent', 'officina.release'…); Maestro shows its label in Settings and the Inbox. */
    kind: string;
    /** Plain story words (already translated). */
    title: string;
    description?: string;
    details?: string;
    changes: ApiJournalChange[];
    /** JSON-serialisable: stored in the Inbox and handed to the applier. */
    payload: unknown;
    sourceMessage?: number;
    /** Default level when the user never chose one for this kind. */
    fallback: 'auto' | 'notify' | 'inbox' | 'ask' | 'off';
    ttlMs?: number;
    acceptLabel?: string;
    rejectLabel?: string;
}

export type ApiDecision = 'applied' | 'queued' | 'notified' | 'rejected' | 'skipped';

export type ApiTurnEvent =
    | { type: 'chat:changed'; chatId: string | null }
    | { type: 'reply:ready'; messageIndex: number }
    | { type: 'turn:committed'; messageIndex: number }
    | { type: 'message:invalidated'; messageIndex: number; reason: 'swiped' | 'deleted' | 'edited' }
    | { type: 'generation:before'; generation: string; dryRun: boolean; quiet: boolean }
    | { type: 'generation:ended'; generation: string; stopped: boolean };

export interface ApiEntityRef {
    id: string;
    name: string;
    aliases: string[];
    /** Search forms (Russian cases, short names) — for matching text, not for display. */
    forms: string[];
}

export type MaestroQuietFunction = 'voices' | 'ck.consistency' | 'bunnymo.medicineCheck';

/* ------------------------------------------------------------------ cost (1.24) */

/** A spend the neighbour made through its OWN channel (not llm.request): Maestro counts it into the day and the cap. */
export interface ApiCostRecord {
    /** The neighbour's task id ('officina.bible'); only `officina.` tasks (Dramatis spends through llm.request). */
    task: string;
    model?: string;
    provider?: string;
    tokens?: { prompt?: number; completion?: number; cached?: number };
    /** Real cost in USD (0 when the provider did not say: the entry is marked as an estimate). */
    usd: number;
    /** When it was spent (ms); today only — another value counts as now. */
    at?: number;
}

/**
 * The shared daily limit: Maestro's «background tasks: at most $ a day» (core setting backgroundDailyCapUsd) against
 * today's background spend (Maestro's tasks and the neighbours' recorded spends); the overall daily limit with the
 * action «stop background tasks» lowers `remainingUsd` too. null: no cap.
 */
export interface ApiCostRemaining {
    capUsd: number | null;
    spentUsd: number;
    remainingUsd: number | null;
}

/* ------------------------------------------------------------------ lore (1.24) */

export interface ApiLoreEntry {
    uid: number;
    key: string[];
    keysecondary: string[];
    content: string;
    comment: string;
    disable?: boolean;
    constant?: boolean;
    position?: number;
    depth?: number;
    role?: number | null;
    order?: number;
    /** Every other World Info field, round-tripped as ST stores it. */
    [field: string]: unknown;
}

export interface ApiLoreBook {
    entries: Record<string, ApiLoreEntry>;
    originalData?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export type ApiBookRole =
    | 'bunnymo.core'
    | 'bunnymo.pack'
    | 'ck.archive'
    | 'world'
    | 'card'
    | 'npc'
    | 'canon'
    | 'maestro'
    | 'chat'
    | 'persona'
    | 'backup'
    | 'unknown';

export interface ApiBookRoleInfo {
    book: string;
    role: ApiBookRole;
    /** Detected automatically or set by the user (or a neighbour through bookRoles.set). */
    source: 'auto' | 'user';
    /** BunnyMo core and packs: never written. */
    readOnly: boolean;
    /** Localizer may add Russian keys (false for BunnyMo). */
    localizable: boolean;
}

export interface ApiLoreBookInfo {
    name: string;
    /** Null while Maestro's book roles are off. */
    role: ApiBookRole | null;
    readOnly: boolean;
}

export type ApiEntryType =
    'character' | 'place' | 'item' | 'faction' | 'event' | 'tradition' | 'mechanic' | 'rule' | 'chapter' | 'note';

export interface ApiEntryTypeInfo {
    id: ApiEntryType;
    /** English type name of the composed content's first line («Character: Anna»). */
    label: string;
    /** The first field is the name; labels are the English ones written into the content. */
    fields: { id: string; label: string; multiline?: boolean }[];
}

export interface ApiTypedEntry {
    type: ApiEntryType;
    /** Field values by field id. */
    fields: Record<string, string>;
}

/* ------------------------------------------------------------------ mechanics (1.24) */

export type ApiAttributeKind = 'number' | 'scale' | 'list' | 'text';
export type ApiTrackingMode = 'desStats' | 'block' | 'background' | 'manual';
export type ApiAttributeValue = number | string | string[];
export type ApiChangeOp = 'add' | 'sub' | 'set' | 'mul' | 'push' | 'pull';
export type ApiVisibilityPreset = 'game' | 'book' | 'hidden' | 'secret';
export type ApiVisibilityPlace = 'hud' | 'strip' | 'narrator' | 'statusBlock' | 'des' | 'dossier';

/** Any subset; `preset` fills the rest (default 'game'). */
export interface ApiVisibilityInput {
    preset?: ApiVisibilityPreset;
    prompt?: 'value' | 'words' | 'none';
    mention?: 'none' | 'words' | 'numbers';
    places?: Partial<Record<ApiVisibilityPlace, boolean>>;
    view?: 'number' | 'bar' | 'words' | 'icon' | 'hidden';
    words?: { upTo?: number; level?: string; label: string; display?: string }[];
}

export interface ApiStatusDuration {
    turns?: number;
    minutes?: number;
    until?: { day: number; minutes?: number };
}

export interface ApiStatusSpec {
    id?: string;
    name: string;
    promptName?: string;
    duration?: ApiStatusDuration | null;
    modifiers?: Record<string, number>;
    stacks?: number;
    maxStacks?: number;
    text?: string;
    icon?: string;
}

export interface ApiItemSpec {
    name: string;
    qty?: number;
    desc?: string;
    equipped?: 'worn' | 'hand' | null;
    tags?: string[];
    value?: number;
    modifiers?: Record<string, number>;
}

export interface ApiChangeAction {
    who: string;
    attr: string;
    op: ApiChangeOp;
    value: number | string;
    status?: ApiStatusSpec;
    item?: ApiItemSpec;
}

export interface ApiAttributeDef {
    /** snake_case, unique within the mechanic. */
    id: string;
    /** Display name in the user's language. */
    name: string;
    /** English, for the model and DES stats. */
    promptName: string;
    kind: ApiAttributeKind;
    min?: number;
    max?: number;
    initial?: ApiAttributeValue;
    levels?: string[];
    options?: string[];
    multi?: boolean;
    tracking?: ApiTrackingMode;
    visible?: boolean;
    events?: {
        id: string;
        when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
        text: string;
        once?: boolean;
        actions?: ApiChangeAction[];
        chain?: string;
    }[];
    formula?: string;
    growth?: { perUse: number; cap?: number; on?: 'success' | 'any' };
    visibility?: ApiVisibilityInput;
    icon?: string;
}

export type ApiHolderSpec =
    | { kind: 'persona' }
    | { kind: 'characters'; includePersona?: boolean }
    | { kind: 'named'; names: string[] }
    | { kind: 'world' }
    | { kind: 'factions'; names: string[] };

export interface ApiCheckDef {
    id: string;
    name: string;
    promptName: string;
    /** 'NdM', 'NdM+@attr', '1d100<=@attr', '4d6kh3', '1d6!' … */
    dice: string;
    difficulty: number | null;
    triggers: string[];
    criticals?: boolean;
    effects?: {
        on: 'success' | 'failure' | 'critical' | 'fumble' | 'any';
        changes: ApiChangeAction[];
        text?: string;
    }[];
    /** Triggers count in quoted speech too, and questions do not stop the roll (persuasion, deception…). */
    speech?: boolean;
}

/** Where a mechanic applies: everywhere, in every chat of a card (its avatar file), or in one chat. */
export type ApiMechanicScope = { kind: 'global' } | { kind: 'card'; avatar: string } | { kind: 'chat'; chatId: string };

export interface ApiMechanicDef {
    id: string;
    name: string;
    promptName?: string;
    /** English, for the model. */
    summary: string;
    rules: string;
    attributes: ApiAttributeDef[];
    holders: ApiHolderSpec;
    checks: ApiCheckDef[];
    tracking: ApiTrackingMode;
    scope: ApiMechanicScope;
    template?: string;
    /** Storage, set by Maestro. */
    book?: string;
    uid?: number;
    updatedAt?: number;
    visibility?: ApiVisibilityInput;
    statuses?: ApiStatusSpec[];
    inventory?: { money?: string };
    time?: {
        attr: string;
        amount: number | string;
        per: 'turn' | 'hour' | 'day';
        when?: 'always' | 'rest' | 'awake';
    }[];
    progression?: {
        xp: string;
        level: string;
        thresholds: number[];
        onLevelUp?: ApiChangeAction[];
        /** Experience the roller gains by the outcome of a check of this mechanic. */
        awards?: { critical?: number; success?: number; failure?: number; fumble?: number };
    };
    combat?: { initiative?: string; enemy?: Record<string, number> };
    pinned?: boolean;
    keys?: string[];
    summarySource?: string;
    rulesSource?: string;
    translatedFrom?: { summary?: string; rules?: string };
    narratorToModel?: boolean;
}

export interface ApiMechanicTemplate {
    id: string;
    /** In the UI language. */
    title: string;
    description: string;
}

/** A `<mechanics>` block read the way Maestro reads a reply (nothing applied). */
export interface ApiMechanicsBlock {
    found: boolean;
    items: { holder: string; attribute: string; op: string; value: string | number; reason?: string; line: string }[];
    /** What was repaired: 'unclosed', 'unopened', 'fence', 'bracket', 'escaped', 'stray', 'many'. */
    repaired: string[];
    /** Lines inside a block that could not be read. */
    dropped: string[];
    rolls: {
        head: string;
        vs?: { holder: string; check?: string };
        mode?: string;
        level?: string;
        difficulty?: number;
        line: string;
    }[];
    combat: { action: string; names: string[]; stats?: Record<string, number>; line: string }[];
}

/* ------------------------------------------------------------------ presets (1.24) */

export interface ApiPresetPrompt {
    identifier: string;
    name: string;
    role?: 'system' | 'user' | 'assistant';
    content?: string;
    system_prompt?: boolean;
    marker?: boolean;
    /** 0 = relative (in order), 1 = in-chat at depth. */
    injection_position?: 0 | 1;
    injection_depth?: number;
    injection_order?: number;
    injection_trigger?: string[];
    forbid_overrides?: boolean;
    [field: string]: unknown;
}

/** A Chat Completion preset body as stored in the file (preset keys, not oai_settings keys). */
export type ApiPresetBody = Record<string, unknown> & {
    prompts?: ApiPresetPrompt[];
    prompt_order?: { character_id: number; order: { identifier: string; enabled: boolean }[] }[];
};

/** Where a layer edit lives: everywhere, in every chat of a card, or in one chat. */
export type ApiLayerScope = 'global' | 'character' | 'chat';

export type ApiLayerAnchor =
    | { kind: 'after'; identifier: string }
    | { kind: 'before'; identifier: string }
    /** After the block whose content contains this text (portable between presets). */
    | { kind: 'afterText'; text: string }
    | { kind: 'start' }
    | { kind: 'end' };

/** One edit of the user's layer over a base preset (the base values are filled in by Maestro). */
export type ApiLayerOp =
    /** A block of one's own after an anchor. */
    | { op: 'add'; prompt: ApiPresetPrompt; anchor: ApiLayerAnchor; enabled: boolean }
    /** Changed fields of a base block; `baseHash` is taken from the base when left ''. */
    | {
          op: 'edit';
          identifier: string;
          patch: Partial<ApiPresetPrompt>;
          baseHash: string;
          baseText?: string;
          baseFields?: Partial<ApiPresetPrompt>;
          baseMissing?: string[];
      }
    | { op: 'toggle'; identifier: string; enabled: boolean; baseEnabled?: boolean }
    | { op: 'move'; identifier: string; anchor: ApiLayerAnchor; baseAnchor?: ApiLayerAnchor | null }
    /** A body key override (`temperature`, not `temp_openai`). */
    | { op: 'key'; key: string; value: unknown; baseValue?: unknown; baseUnset?: boolean };

/* ------------------------------------------------------------------ prompt audit, persona (1.24) */

export interface ApiAuditConflict {
    id: string;
    source: 'rules' | 'ai';
    topic: string;
    severity: 'high' | 'medium' | 'low';
    /** Story words, the UI language. */
    title: string;
    why: string;
    risk?: string;
    /** The instructions in conflict: `ref` (`preset:<identifier>`, `card:system`, `slot:<key>`, `lore:<book>#<uid>`). */
    a: { ref: string; quote: string };
    b?: { ref: string; quote: string };
    also?: { ref: string; quote: string }[];
}

export interface ApiAuditReport {
    at: number;
    /** The last real turn, or a test assembly (`dry`). */
    source: 'turn' | 'dry';
    conflicts: ApiAuditConflict[];
    /** Conflicts the user marked «Не считать конфликтом». */
    hidden: number;
}

export interface ApiPersonaOutfit {
    /** Short name («Повседневный»). */
    name: string;
    /** One line: what it is made of. */
    wording: string;
    /** English NovelAI tags for the passport ('' none). */
    tags?: string;
}

export interface ApiPersonaInput {
    name: string;
    /** The persona description as ST keeps it (written as given: no model call). */
    description: string;
    title?: string;
    wardrobe?: ApiPersonaOutfit[];
    /** Connect the persona to this card (avatar file). */
    linkAvatar?: string;
    /** NAI Studio passport with the wardrobe (needs NAI Studio 0.14+; NAI Studio makes its own request). */
    passport?: boolean;
    /** NAI Studio draws the avatar from the passport (default: as `passport`). */
    picture?: boolean;
    /** English look for the passport (default: the description). */
    appearanceEn?: string;
    /** Make it the current persona. */
    makeCurrent?: boolean;
}

export interface ApiPersonaOutcome {
    avatarId: string;
    name: string;
    linked: boolean;
    passport: boolean;
    picture: boolean;
    current: boolean;
    /** Every step with its state and, when skipped or failed, why (UI language). */
    steps: { id: string; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; detail?: string }[];
}

/* ------------------------------------------------------------------ Officina's starting scenes (1.24) */

/**
 * `data.extensions.officina.scenes` of a card: one item per greeting, aligned with `[first_mes, ...alternate_greetings]`
 * (null: no scene for that greeting). «Подготовка к игре» (M37) takes place, time and who is present as given and the
 * mood and hook as the author's words about the start.
 */
export interface OfficinaStartScene {
    place?: string;
    time?: string;
    present?: string[];
    mood?: string;
    hook?: string;
}

/* ------------------------------------------------------------------ the API */

export interface MaestroApi {
    version: 1;
    maestroVersion: string;
    /** 1.24+: what this build offers (absent before: check members one by one). */
    features?: readonly MaestroApiFeature[];
    llm: {
        request<T = unknown>(request: ApiLlmRequest): Promise<ApiLlmResult<T>>;
        available(task: string): boolean;
        /** Shows the task in Maestro's profile list (per-task connection profile); returns a remover. */
        registerTask(id: string, label: { ru: string; en: string }): ApiUnsubscribe;
    };
    leader: { isLeader(): boolean; onChange(listener: (leader: boolean) => void): ApiUnsubscribe };
    /** Routes through autonomy: applied now, queued to the Inbox, notified or skipped. */
    propose(proposal: ApiProposal): Promise<ApiDecision>;
    /** How a stored Inbox card of this kind is applied after a reload (and optional checks). */
    registerApplier(
        kind: string,
        label: { ru: string; en: string },
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): ApiUnsubscribe;
    journal: {
        record(action: {
            kind: string;
            summary: string;
            changes: ApiJournalChange[];
            sourceMessage?: number;
        }): Promise<string>;
        registerUndo(target: string, handler: (change: ApiJournalChange) => Promise<boolean>): ApiUnsubscribe;
    };
    notice(
        text: string,
        options?: { importance?: 'info' | 'important' | 'urgent'; action?: { label: string; run: () => void } },
    ): void;
    /** Maestro's turn pipeline (swipes, edits and branches already handled); silent in a service chat (1.21+). */
    onTurn(listener: (event: ApiTurnEvent) => void | Promise<void>): ApiUnsubscribe;
    names: {
        /** The world-model entity for a name in the current chat (aliases, Russian forms), or null. */
        resolve(name: string): ApiEntityRef | null;
        /** Same person in the current chat (aliases, forms, chat alias map). */
        same(a: string, b: string): boolean;
    };
    /** Characters present after the last committed turn (DES tracker, Maestro's view), names as in the story. */
    present(): string[];
    /** The speech digest Maestro's voice cards would show for this character (CK LING + Linguistics, MBTI), or null. */
    speech(name: string): string | null;
    /** Silences a function on Maestro's side while Dramatis owns it; the remover gives it back. */
    quiet(fn: MaestroQuietFunction, owner: string): ApiUnsubscribe;
    /** Give a new NPC a CK archive with these BunnyMo tags («Оформить»); false when not possible. */
    styleUp?(name: string, tags: string[]): Promise<boolean>;
    /** Write goals into the chat canon entry of this character (canon `goals` field). */
    setCanonGoals?(name: string, goals: string[]): Promise<boolean>;
    /** 1.20+: the language the story is told in — Maestro's «Язык истории» setting, auto-detected. */
    storyLanguage?(): 'ru' | 'en';
    /**
     * 1.21+: «Служебный режим» (M42, called «Мастерская» before 1.24). The chat open now belongs to a service card (a
     * card with one of Maestro's service tags: «служебная», «мастерская», «workshop» by default): the story machinery
     * stays silent there. `active()` is current from the very start of ST's CHAT_CHANGED; `onChange` fires when it
     * flips — on a chat switch (inside Maestro's first CHAT_CHANGED listener, awaited up to 1.5 s) and when the tag is
     * set or removed while the chat is open. A listener may return a promise.
     */
    workshop?: {
        active(): boolean;
        onChange(listener: (active: boolean) => void | Promise<void>): ApiUnsubscribe;
        /** 1.24+: the card (avatar file) carries a service tag. */
        isServiceCard?(avatar: string): boolean;
        /** 1.24+: sets (the first tag of the setting) or removes (every service tag) — journaled with undo. */
        setCard?(avatar: string, on: boolean, options?: ApiWriteOptions): Promise<ApiResult>;
    };
    /**
     * 1.23+: the scene and the world around it are kept apart. While `active()`, the model narrates only the
     * characters present and puts what happens elsewhere into one block at the end of the reply, `<offscreen>…</offscreen>`.
     */
    sceneSplit?: {
        active(): boolean;
        /** The tag of the block: 'offscreen'. */
        tag: string;
    };
    /** 1.24+: the shared daily limit for a neighbour's own LLM channel. */
    cost?: {
        /** Counts a spend under the neighbour (the «Расходы» tab shows it as its own row; it counts toward the cap). */
        record(spend: ApiCostRecord): ApiResult;
        remaining(): ApiCostRemaining;
        /**
         * Maestro's meter leaves requests sent with this AbortSignal to the neighbour (they are reported through
         * record()); requests whose JSON schema is named `officina_*` are left out without it. The remover ends it.
         */
        claim(signal: AbortSignal): ApiUnsubscribe;
    };
    /** 1.24+: Lore Studio's store (M23): one save queue per book, ST's editor and DES's cache refreshed, journaled. */
    lore?: {
        listBooks(): ApiResult<{ books: ApiLoreBookInfo[] }>;
        load(book: string): Promise<ApiResult<{ book: ApiLoreBook }>>;
        /** A new empty book; resolves to the name ST gave it. */
        createBook(name: string, options?: ApiWriteOptions): Promise<ApiResult<{ name: string }>>;
        createEntry(
            book: string,
            entry: Partial<ApiLoreEntry>,
            options?: ApiWriteOptions,
        ): Promise<ApiResult<{ uid: number }>>;
        updateEntry(
            book: string,
            uid: number,
            patch: Partial<ApiLoreEntry>,
            options?: ApiWriteOptions,
        ): Promise<ApiResult>;
        deleteEntry(book: string, uid: number, options?: ApiWriteOptions): Promise<ApiResult>;
        /** The primary book of a card (null: none), any card, not only the open one. */
        setCharacterBook(avatar: string, book: string | null, options?: ApiWriteOptions): Promise<ApiResult>;
        entryTypes(): ApiEntryTypeInfo[];
        /** The content Maestro composes from typed fields («Character: Anna», «Role: …»). */
        composeContent(type: ApiEntryType, fields: Record<string, string>): string;
        /** The typed fields of an entry (Maestro and canon books: in the entry; other books: Maestro's sidecar). */
        typeFields(book: string, uid: number): Promise<ApiResult<{ typed: ApiTypedEntry | null }>>;
        /** Writes them (null: the entry is untyped again); `compose`: the content is composed from them too. */
        setTypeFields(
            book: string,
            uid: number,
            typed: ApiTypedEntry | null,
            options?: ApiWriteOptions & { compose?: boolean },
        ): Promise<ApiResult<{ storage: 'entry' | 'sidecar' }>>;
    };
    /** 1.24+: roles of lorebooks (M35). */
    bookRoles?: {
        get(book: string): ApiResult<{ info: ApiBookRoleInfo | null }>;
        /** 'unknown' gives the book back to detection. BunnyMo books cannot be changed ('read-only'). */
        set(book: string, role: ApiBookRole, options?: ApiWriteOptions): Promise<ApiResult>;
    };
    /**
     * 1.24+: mechanics (M25), definitions only. 'off' while the module is off; in a service chat (1.24.1+) the
     * definitions stay (list, get, save, remove, templates, fromTemplate) and only `setEnabledInChat` answers 'off'.
     */
    mechanics?: {
        /** Every definition whatever its scope, or those of one scope (a card's by avatar, a chat's by id). */
        list(filter?: { scope?: ApiMechanicScope['kind']; avatar?: string; chatId?: string }): ApiResult<{
            defs: ApiMechanicDef[];
        }>;
        get(id: string): ApiResult<{ def: ApiMechanicDef | null }>;
        /** Validated, written into Maestro's mechanics book, journaled with undo; resolves to what was stored. */
        save(
            def: ApiMechanicDef,
            options: { scope: ApiMechanicScope } & ApiWriteOptions,
        ): Promise<ApiResult<{ def: ApiMechanicDef }>>;
        remove(id: string, options?: ApiWriteOptions): Promise<ApiResult>;
        /** Works while the module is off too. */
        templates(): ApiResult<{ templates: ApiMechanicTemplate[] }>;
        /** An unsaved definition from a template (fresh id; scope global unless given). Works while the module is off. */
        fromTemplate(id: string, options?: { scope?: ApiMechanicScope }): ApiResult<{ def: ApiMechanicDef }>;
        /** Pure: a reply's `<mechanics>` block as Maestro reads it (works while the module is off). */
        parseBlock(text: string): ApiMechanicsBlock;
        /** The per-chat switch of the chat open now ('off' in a service chat: the module is paused there). */
        setEnabledInChat(id: string, on: boolean): Promise<ApiResult>;
    };
    /** 1.24+: the Preset Studio's store and the user's layer (M34). */
    presets?: {
        list(): ApiResult<{ names: string[]; current: string }>;
        /** The working copy (what generation uses now). */
        working(): ApiResult<{ name: string; body: ApiPresetBody }>;
        saved(name: string): ApiResult<{ body: ApiPresetBody }>;
        /** Switches the preset; the model and providers stay. 'unsaved' when the working copy has unsaved edits. */
        select(name: string, options?: { force?: boolean }): Promise<ApiResult>;
        /**
         * A new preset file: from `body` (keys it lacks come from the current preset; addresses and passwords never),
         * else the working copy saved under a new name (ST then selects it). Journaled.
         */
        saveAs(
            name: string,
            body?: ApiPresetBody,
            options?: ApiWriteOptions & { overwrite?: boolean; select?: boolean },
        ): Promise<ApiResult<{ name: string }>>;
        /** The layer part of a scope by base preset, and the preset bound there. `owner`: the avatar (character) or chat id. */
        ops(
            scope: ApiLayerScope,
            owner?: string,
        ): Promise<ApiResult<{ layers: Record<string, ApiLayerOp[]>; binding: string | null }>>;
        /**
         * Records an edit (add / edit / toggle / move / key) over `base` into a scope: 'global', 'character' of any card
         * (`owner` = avatar; default the open card) or 'chat' (the open chat only). Journaled with undo.
         */
        record(
            base: string,
            op: ApiLayerOp,
            scope: ApiLayerScope,
            owner?: string,
            options?: ApiWriteOptions,
        ): Promise<ApiResult>;
        /** Removes the edit at `index` of `ops(scope, owner).layers[base]`. */
        remove(
            base: string,
            index: number,
            scope: ApiLayerScope,
            owner?: string,
            options?: ApiWriteOptions,
        ): Promise<ApiResult>;
        /** Binds a whole preset to a card (`owner` avatar; default the open card) or the open chat. Journaled. */
        bind(
            scope: 'character' | 'chat',
            preset: string,
            owner?: string,
            options?: ApiWriteOptions,
        ): Promise<ApiResult>;
        unbind(scope: 'character' | 'chat', owner?: string, options?: ApiWriteOptions): Promise<ApiResult>;
    };
    /** 1.24+: «Проверка промпта» (M38), findings only (no fixes through the API). */
    promptAudit?: {
        /** The rules over the last real turn, or (`dry`) over a test assembly of the chat open now. */
        run(options?: { dry?: boolean }): Promise<ApiResult<{ report: ApiAuditReport | null }>>;
    };
    /** 1.24+: «Создать персону» (M41) from a ready description (no model call of Maestro's). No undo, as in M41. */
    persona?: {
        create(input: ApiPersonaInput): Promise<ApiResult<ApiPersonaOutcome>>;
    };
}
