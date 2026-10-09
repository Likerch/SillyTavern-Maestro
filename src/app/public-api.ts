// Maestro's public API for neighbours (release 1.17, docs/integration-dramatis.md): `globalThis.MAESTRO_API`, version 1,
// the contract of src/adapters/dramatis/apis.ts (copied from Dramatis). Installed after the modules started, removed
// when Maestro stops; `maestro-api-ready` ({ detail: { version: 1 } }) is dispatched on window each time it appears.
//
// What it gives (each through Maestro's own services, so the rules of the stack hold for the neighbour too):
// - llm: Maestro's LLM client — per-task connection profile, cost recorded as Maestro's background spend (source
//   'maestro', task label), the circuit breaker; background work only in the leader tab and under the daily cap. Task
//   ids start with `dramatis.`; the JSON schema goes out named after the task (`dramatis.turn` → `dramatis_turn`).
// - propose / registerApplier: autonomy levels and the Inbox; the applier makes stored cards work after a reload, its
//   label names the kind in Settings, the Inbox and the journal (`kind.<kind>`).
// - journal (module 'dramatis') with undo handlers per target; notices; the turn pipeline's events.
// - names (world model + DES-RU forms), present() (the cast the voice cards see), speech() (the voice cards' digest of
//   the CK archive, also while the voice cards are off), quiet() (claims kept by the Dramatis adapter).
// - stage 3: styleUp() (the dossier's «Оформить» with given BunnyMo tags), setCanonGoals() (the chat canon's `goals`).
// - 1.20: storyLanguage() — «Язык истории» (the setting, else the player's messages, else the interface language).
import manifest from '../../manifest.json';
import { MAESTRO_API_GLOBAL, MAESTRO_API_READY_EVENT, adaptersOf, dramatisOf, isQuietFunction } from '../adapters';
import type {
    ApiDecision,
    ApiEntityRef,
    ApiJournalChange,
    ApiLlmRequest,
    ApiLlmResult,
    ApiProposal,
    ApiTurnEvent,
    MaestroApiV1,
    MaestroQuietFunction,
} from '../adapters';
import { storyLanguage } from '../core/language';
import type { Labels } from '../core/labels';
import { uniqueStrings } from '../domain/canon-keys';
import { composeContent, fieldsFromContent, readTypedMeta, TYPED_FIELDS_KEY } from '../domain/entry-types';
import { lastCommittedIndex } from '../domain/relations-history';
import { sceneCast } from '../domain/scene-cast';
import { sceneTracker } from '../domain/voices-cards';
import { normalizeName } from '../domain/world-names';
import type { CanonApi, CanonDraft, CanonItem } from '../features/canon/api';
import type { DossierApi } from '../features/dossier/api';
import type { Entity, WorldModelApi } from '../features/world/api';
import type {
    App,
    AutonomyLevel,
    JournalChange,
    LlmMessage,
    LlmResult,
    Logger,
    Proposal,
    Unsubscribe,
} from '../shared/contracts';
import { registerProfileTask as registerProfileTaskUi } from '../ui';
import { ArchiveSpeech } from './archive-speech';

/** Ids of tasks and action kinds a neighbour may use (one neighbour so far). */
export const EXTERNAL_PREFIX = 'dramatis.';
/** The journal and Inbox module of everything that comes through the API. */
export const API_MODULE = 'dramatis';
/** The label of journal targets registered through the API (their values are technical: shown under «Подробнее»). */
export const API_TARGET_LABEL = 'core.dramatis.target';
/** `generation:before` runs inside Maestro's generate interceptor: a listener is awaited at most this long (P15). */
export const BEFORE_TIMEOUT_MS = 1500;
const MAX_TOKENS = 32_000;
const LEVELS: readonly AutonomyLevel[] = ['auto', 'notify', 'inbox', 'ask', 'off'];

const ID_RE = /^dramatis\.[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/;
const TARGET_RE = /^dramatis[.-][A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A task or kind id a neighbour may use (`dramatis.turn`). */
export function isExternalId(value: unknown): value is string {
    return typeof value === 'string' && ID_RE.test(value);
}

/** A journal target id a neighbour may use (`dramatis.intent`, `dramatis-stance`). */
export function isExternalTarget(value: unknown): value is string {
    return typeof value === 'string' && TARGET_RE.test(value);
}

/** The JSON schema name of a task: `dramatis.turn` → `dramatis_turn` (the bench's mock model picks its reply by it). */
export function schemaNameOf(task: string): string {
    return task.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Maestro's LLM errors in the contract's words: 'breaker', 'no-profile'; others as they are. */
export function apiError(error: string | undefined): string | undefined {
    if (error === 'breaker-open') return 'breaker';
    if (error === 'no-cm') return 'no-profile';
    return error;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function jsonCopy<T>(value: T): T {
    const json = JSON.stringify(value);
    return json === undefined ? value : (JSON.parse(json) as T);
}

function cleanChanges(changes: unknown): JournalChange[] {
    if (!Array.isArray(changes)) return [];
    return changes
        .filter((change): change is ApiJournalChange => isDict(change) && typeof change.target === 'string')
        .map((change) => ({
            target: change.target,
            ref: isDict(change.ref) ? jsonCopy(change.ref) : {},
            before: jsonCopy(change.before),
            after: jsonCopy(change.after),
        }));
}

function label(value: unknown): { ru: string; en: string } | null {
    if (!isDict(value)) return null;
    const ru = text(value.ru);
    const en = text(value.en);
    if (!ru && !en) return null;
    return { ru: ru || en, en: en || ru };
}

/** Waits for a listener's promise, at most `ms` (a slow neighbour must not hold the generation). */
async function within(result: unknown, ms: number, log: Logger, what: string): Promise<void> {
    if (!(result instanceof Promise)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
        const outcome = await Promise.race([result.then(() => 'done' as const), timeout]);
        if (outcome === 'timeout') log.warn(`${what}: a MAESTRO_API listener took longer than ${ms} ms`);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

interface Applier {
    apply: (payload: unknown) => Promise<void>;
    stillValid?: (payload: unknown) => Promise<boolean>;
}

export interface MaestroApiDeps {
    app: App;
    /** Journal target labels (src/core/labels.ts); targets registered through the API join it. */
    labels?: Labels;
    /** Maestro's version (manifest). */
    version?: string;
    /** Settings → profiles row of a task (tests pass a fake). */
    registerProfileTask?: (id: string, labelKey: string) => Unsubscribe;
}

export interface MaestroApiHandle {
    api: MaestroApiV1;
    speech: ArchiveSpeech;
    dispose(): void;
}

export function createMaestroApi(deps: MaestroApiDeps): MaestroApiHandle {
    const { app } = deps;
    const log = app.log.scope('public-api');
    const profileTask = deps.registerProfileTask ?? registerProfileTaskUi;
    const appliers = new Map<string, Applier>();
    const undoHandlers = new Map<string, (change: ApiJournalChange) => Promise<boolean>>();
    const proxiedTargets = new Set<string>();
    const disposers = new Set<Unsubscribe>();
    const speech = new ArchiveSpeech(app, log);
    let disposed = false;
    let cast: { key: string; world: WorldModelApi | undefined; names: string[] } | null = null;

    const own = (off: Unsubscribe): Unsubscribe => {
        let done = false;
        const remove = () => {
            if (done) return;
            done = true;
            disposers.delete(remove);
            try {
                off();
            } catch (error) {
                log.debug('API remover failed', error);
            }
        };
        disposers.add(remove);
        return remove;
    };

    for (const off of speech.install()) disposers.add(off);

    /* ---------------------------------------------------------------- the world model */

    const world = (): WorldModelApi | undefined => app.modules.api<WorldModelApi>('world');

    const entityOf = (name: string): Entity | undefined => {
        const api = world();
        if (!api || !name.trim()) return undefined;
        try {
            return api.resolve(name, 'character') ?? api.resolve(name) ?? undefined;
        } catch {
            return undefined;
        }
    };

    /** DES-RU case forms of a name (empty without DES-RU 0.8 or for '' ). */
    const desRuForms = (name: string): string[] => {
        try {
            const forms = adaptersOf(app).desru.api()?.nameForms(name);
            return Array.isArray(forms) ? forms.filter((form): form is string => typeof form === 'string') : [];
        } catch {
            return [];
        }
    };

    const refOf = (entity: Entity): ApiEntityRef => {
        const forms = entity.forms.length
            ? entity.forms
            : [entity.name, ...entity.aliases].flatMap((name) => desRuForms(name));
        return {
            id: entity.id,
            name: entity.name,
            aliases: [...entity.aliases],
            forms: uniqueStrings(forms),
        };
    };

    const same = (a: string, b: string): boolean => {
        const left = normalizeName(String(a ?? ''));
        const right = normalizeName(String(b ?? ''));
        if (!left || !right) return false;
        if (left === right) return true;
        const first = entityOf(a);
        const second = entityOf(b);
        if (first && second) return first.id === second.id;
        const known = first ?? second;
        const other = first ? right : left;
        if (known) {
            const names = [known.name, ...known.aliases, ...known.forms].map(normalizeName);
            if (names.includes(other)) return true;
        }
        // Not settled by the world model: DES-RU's case forms of one name may hold the other.
        return (
            desRuForms(String(a)).some((form) => normalizeName(form) === right) ||
            desRuForms(String(b)).some((form) => normalizeName(form) === left)
        );
    };

    /** The cast of the committed reply as the voice cards see it (cached per chat state). */
    const present = (): string[] => {
        const ctx = app.host.ctx();
        const chatId = app.host.chatId();
        if (!chatId) return [];
        const chat = (ctx.chat ?? []) as unknown[];
        const committed = lastCommittedIndex(chat as STChatMessage[]);
        const message = chat[committed];
        const hidden = ((): string[] => {
            try {
                const des = adaptersOf(app).des as { removedCharacters?: () => string[] } | undefined;
                return typeof des?.removedCharacters === 'function' ? des.removedCharacters() : [];
            } catch {
                return [];
            }
        })();
        const ownName = String(ctx.name1 ?? '').trim();
        const key = [
            chatId,
            committed,
            isDict(message) ? String(message.swipe_id ?? 0) : '',
            isDict(message) && typeof message.mes === 'string' ? message.mes.length : 0,
            ownName,
            hidden.join('\u0001'),
        ].join('|');
        const api = world();
        if (cast?.key === key && cast.world === api) return [...cast.names];
        const persona = ((): string => {
            try {
                return (ownName ? api?.resolve(ownName, 'persona')?.name : undefined) ?? ownName;
            } catch {
                return ownName;
            }
        })();
        const names = sceneCast<Entity>(sceneTracker(chat), {
            persona,
            ownName,
            hidden,
            resolve: entityOf,
        }).map((member) => member.name);
        cast = { key, world: api, names };
        return [...names];
    };

    // The archives of the cast are read ahead of the next generation — a tick later: `turn:committed` comes on the
    // send path (P15).
    let warmTimer: ReturnType<typeof setTimeout> | null = null;
    const warm = () => {
        if (warmTimer !== null) return;
        warmTimer = setTimeout(() => {
            warmTimer = null;
            if (disposed) return;
            try {
                speech.warm(present());
            } catch (error) {
                log.debug('archives could not be warmed', error);
            }
        }, 0);
    };
    disposers.add(() => {
        if (warmTimer !== null) clearTimeout(warmTimer);
        warmTimer = null;
    });
    for (const event of ['chat:changed', 'turn:committed', 'reply:ready', 'message:invalidated'] as const) {
        disposers.add(
            app.bus.on(event, () => {
                cast = null;
                warm();
            }),
        );
    }

    /* ---------------------------------------------------------------- turn events */

    const onTurn = (listener: (event: ApiTurnEvent) => void | Promise<void>): Unsubscribe => {
        if (disposed || typeof listener !== 'function') return () => {};
        /** Calls the listener; its promise (if any) settles without throwing. */
        const call = (event: ApiTurnEvent): Promise<void> | undefined => {
            const failed = (error: unknown) => log.warn(`MAESTRO_API ${event.type} listener failed`, error);
            try {
                const result: unknown = listener(event);
                return result instanceof Promise ? result.then(() => undefined, failed) : undefined;
            } catch (error) {
                failed(error);
                return undefined;
            }
        };
        const offs = [
            app.bus.on('chat:changed', ({ chatId }) => call({ type: 'chat:changed', chatId })),
            app.bus.on('reply:ready', ({ messageIndex }) => call({ type: 'reply:ready', messageIndex })),
            app.bus.on('turn:committed', ({ messageIndex }) => call({ type: 'turn:committed', messageIndex })),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) =>
                call({ type: 'message:invalidated', messageIndex, reason }),
            ),
            app.bus.on('generation:before', (info) =>
                within(
                    call({ type: 'generation:before', generation: info.type, dryRun: info.dryRun, quiet: info.quiet }),
                    BEFORE_TIMEOUT_MS,
                    log,
                    'generation:before',
                ),
            ),
            app.bus.on('generation:ended', ({ type, stopped }) =>
                call({ type: 'generation:ended', generation: type, stopped }),
            ),
        ];
        return own(() => {
            for (const off of offs) off();
        });
    };

    /* ---------------------------------------------------------------- LLM */

    const request = async <T>(input: ApiLlmRequest): Promise<ApiLlmResult<T>> => {
        if (disposed) return { ok: false, error: 'maestro-stopped' };
        if (!isDict(input) || !isExternalId(input.task)) return { ok: false, error: 'bad-task' };
        const messages: LlmMessage[] = (Array.isArray(input.messages) ? input.messages : [])
            .filter((message) => isDict(message) && typeof message.content === 'string')
            .map((message) => ({
                role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
                content: message.content,
            }));
        if (!messages.length) return { ok: false, error: 'bad-request' };
        const background = input.background !== false;
        if (background) {
            if (!app.leader.isLeader()) return { ok: false, error: 'not-leader' };
            if (app.cost.backgroundCapReached()) return { ok: false, error: 'cap' };
        }
        const maxTokens = Number.isFinite(input.maxTokens) ? Math.max(1, Math.min(MAX_TOKENS, input.maxTokens)) : 500;
        let result: LlmResult<T>;
        try {
            result = await app.llm.request<T>({
                task: input.task,
                messages,
                maxTokens,
                ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
                ...(input.schema && isDict(input.schema.schema)
                    ? { schema: { name: schemaNameOf(input.task), schema: input.schema.schema } }
                    : {}),
                ...(input.signal ? { signal: input.signal } : {}),
                ...(background ? {} : { interactive: true }),
            });
        } catch (error) {
            log.warn(`${input.task} failed`, error);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        const out: ApiLlmResult<T> = { ok: result.ok };
        if (result.data !== undefined) out.data = result.data;
        if (result.text !== undefined) out.text = result.text;
        if (result.refusal) out.refusal = true;
        const error = apiError(result.error);
        if (error !== undefined) out.error = error;
        if (result.costUsd !== undefined) out.costUsd = result.costUsd;
        if (result.tokens) out.tokens = { prompt: result.tokens.prompt, completion: result.tokens.completion };
        return out;
    };

    const registerTask = (id: string, value: { ru: string; en: string }): Unsubscribe => {
        const words = label(value);
        if (disposed || !isExternalId(id) || !words) {
            log.warn(`task ${String(id)} refused: ids start with "${EXTERNAL_PREFIX}" and need a label`);
            return () => {};
        }
        const key = `core.dramatis.task.${id}`;
        app.i18n.register({ en: { [key]: words.en }, ru: { [key]: words.ru } });
        return own(profileTask(id, key));
    };

    /* ---------------------------------------------------------------- autonomy and the Inbox */

    const registerApplier = (
        kind: string,
        value: { ru: string; en: string },
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): Unsubscribe => {
        const words = label(value);
        if (disposed || !isExternalId(kind) || !words || typeof apply !== 'function') {
            log.warn(`applier ${String(kind)} refused: kinds start with "${EXTERNAL_PREFIX}" and need a label`);
            return () => {};
        }
        // The kind reads in words wherever Maestro shows it (Settings, the Inbox, the journal, «Сделал: …»).
        app.i18n.register({ en: { [`kind.${kind}`]: words.en }, ru: { [`kind.${kind}`]: words.ru } });
        const entry: Applier = {
            apply: async (payload) => {
                await apply(payload);
            },
            ...(typeof stillValid === 'function'
                ? { stillValid: async (payload: unknown) => (await stillValid(payload)) === true }
                : {}),
        };
        appliers.set(kind, entry);
        const off = app.inbox.registerApplier(kind, entry.apply, entry.stillValid);
        return own(() => {
            off();
            if (appliers.get(kind) === entry) appliers.delete(kind);
        });
    };

    const propose = async (input: ApiProposal): Promise<ApiDecision> => {
        if (disposed || !isDict(input) || !isExternalId(input.kind)) {
            log.warn('proposal refused: unknown kind');
            return 'skipped';
        }
        const applier = appliers.get(input.kind);
        if (!applier) {
            log.warn(`proposal ${input.kind} skipped: registerApplier() first`);
            return 'skipped';
        }
        const title = text(input.title) || app.i18n.t(`kind.${input.kind}`);
        const payload = jsonCopy(input.payload);
        const proposal: Proposal = {
            module: API_MODULE,
            kind: input.kind,
            title,
            changes: cleanChanges(input.changes),
            payload,
            apply: (value) => applier.apply(value),
        };
        if (text(input.description)) proposal.description = text(input.description);
        if (text(input.details)) proposal.details = text(input.details);
        if (Number.isInteger(input.sourceMessage) && (input.sourceMessage as number) >= 0) {
            proposal.sourceMessage = input.sourceMessage as number;
        }
        if (typeof input.ttlMs === 'number' && input.ttlMs > 0) proposal.ttlMs = input.ttlMs;
        if (text(input.acceptLabel)) proposal.acceptLabel = text(input.acceptLabel);
        if (text(input.rejectLabel)) proposal.rejectLabel = text(input.rejectLabel);
        const check = applier.stillValid;
        if (check) proposal.stillValid = () => check(payload);
        const fallback = LEVELS.includes(input.fallback) ? input.fallback : 'inbox';
        return app.autonomy.decide(proposal, fallback);
    };

    /* ---------------------------------------------------------------- the journal */

    const record = async (action: {
        kind: string;
        summary: string;
        changes: ApiJournalChange[];
        sourceMessage?: number;
    }): Promise<string> => {
        if (disposed) throw new Error('MAESTRO_API: Maestro stopped');
        if (!isDict(action) || !isExternalId(action.kind)) {
            throw new Error(`MAESTRO_API: journal kinds start with "${EXTERNAL_PREFIX}"`);
        }
        return app.journal.record({
            module: API_MODULE,
            kind: action.kind,
            summary: text(action.summary) || app.i18n.t(`kind.${action.kind}`),
            changes: cleanChanges(action.changes),
            ...(Number.isInteger(action.sourceMessage) && (action.sourceMessage as number) >= 0
                ? { sourceMessage: action.sourceMessage as number }
                : {}),
        });
    };

    const registerUndo = (target: string, handler: (change: ApiJournalChange) => Promise<boolean>): Unsubscribe => {
        if (disposed || !isExternalTarget(target) || typeof handler !== 'function') {
            log.warn(`undo handler for ${String(target)} refused: targets start with "dramatis."`);
            return () => {};
        }
        undoHandlers.set(target, handler);
        if (!proxiedTargets.has(target)) {
            proxiedTargets.add(target);
            // The journal keeps handlers for good: this one asks the neighbour's current handler (none: not undone).
            app.journal.registerUndo(target, async (change) => {
                const current = undoHandlers.get(target);
                if (!current) return false;
                return (await current(change)) === true;
            });
            deps.labels?.register([{ target, labelKey: API_TARGET_LABEL, technical: true }]);
        }
        return own(() => {
            if (undoHandlers.get(target) === handler) undoHandlers.delete(target);
        });
    };

    /* ---------------------------------------------------------------- stage 3 */

    const styleUp = async (name: string, tags: string[]): Promise<boolean> => {
        if (disposed || !text(name) || !Array.isArray(tags) || !tags.length) return false;
        const dossier = app.modules.api<DossierApi>('dossier');
        if (typeof dossier?.styleUpArchive !== 'function') return false;
        try {
            return (
                (await dossier.styleUpArchive(
                    text(name),
                    tags.filter((tag) => typeof tag === 'string'),
                )) === true
            );
        } catch (error) {
            log.warn(`styleUp of ${name} failed`, error);
            return false;
        }
    };

    const setCanonGoals = async (name: string, goals: string[]): Promise<boolean> => {
        const who = text(name);
        if (disposed || !who || !Array.isArray(goals) || !app.host.chatId()) return false;
        const canon = app.modules.api<CanonApi>('canon');
        if (!canon) return false;
        const list = uniqueStrings(goals.map(text).filter(Boolean));
        try {
            const items = await canon.list();
            const item = items.find((candidate) => isCharacterOf(candidate, who, same));
            if (item) {
                const fields = typedFields(item);
                fields.goals = list.join('\n');
                if (!fields.name) fields.name = who;
                await canon.put(
                    {
                        entry: { ...item.entry, content: composeContent({ type: 'character', fields }) },
                        meta: {
                            ...withoutTimes(item.meta),
                            type: 'character',
                            [TYPED_FIELDS_KEY]: fields,
                        } as CanonDraft['meta'],
                    },
                    { uid: item.uid },
                );
                return true;
            }
            if (!list.length) return true;
            const entity = entityOf(who);
            const canonical = entity?.name ?? who;
            const aliases = entity ? entity.aliases : [];
            const russian: string[] = [];
            for (const term of [canonical, ...aliases]) {
                try {
                    russian.push(...(await canon.russianKeys(term)));
                } catch (error) {
                    log.debug('Russian keys are not available', error);
                }
            }
            const fields: Record<string, string> = { name: canonical, goals: list.join('\n') };
            if (aliases.length) fields.aliases = aliases.join(', ');
            await canon.put({
                entry: {
                    comment: canonical,
                    key: uniqueStrings([canonical, ...aliases, ...russian]),
                    keysecondary: [],
                    content: composeContent({ type: 'character', fields }),
                },
                meta: {
                    kind: 'addition',
                    status: 'active',
                    origin: 'entity',
                    type: 'character',
                    [TYPED_FIELDS_KEY]: fields,
                } as unknown as CanonDraft['meta'],
            });
            return true;
        } catch (error) {
            log.warn(`canon goals of ${who} were not written`, error);
            return false;
        }
    };

    /* ---------------------------------------------------------------- the object */

    const api: MaestroApiV1 = {
        version: 1,
        maestroVersion: deps.version ?? String(manifest.version ?? ''),
        llm: {
            request,
            available: (task: string) => !disposed && isExternalId(task) && app.llm.available(task),
            registerTask,
        },
        leader: {
            isLeader: () => app.leader.isLeader(),
            onChange: (listener: (leader: boolean) => void) => {
                if (disposed || typeof listener !== 'function') return () => {};
                return own(
                    app.leader.onChange((value) => {
                        try {
                            listener(value);
                        } catch (error) {
                            log.warn('MAESTRO_API leader listener failed', error);
                        }
                    }),
                );
            },
        },
        propose,
        registerApplier,
        journal: { record, registerUndo },
        notice(message, options) {
            const words = text(message);
            if (disposed || !words) return;
            const action = options?.action;
            app.ui.notice(words, {
                importance: options?.importance ?? 'info',
                ...(action && text(action.label) && typeof action.run === 'function'
                    ? {
                          action: {
                              label: text(action.label),
                              run: () => {
                                  try {
                                      action.run();
                                  } catch (error) {
                                      log.warn('MAESTRO_API notice action failed', error);
                                  }
                              },
                          },
                      }
                    : {}),
            });
        },
        onTurn,
        names: {
            resolve: (name: string) => {
                const entity = typeof name === 'string' ? entityOf(name) : undefined;
                return entity ? refOf(entity) : null;
            },
            same,
        },
        present: () => (disposed ? [] : present()),
        speech: (name: string) => (disposed || typeof name !== 'string' ? null : speech.speech(name)),
        quiet(fn: MaestroQuietFunction, owner: string): Unsubscribe {
            const dramatis = dramatisOf(app);
            if (disposed || !dramatis || !isQuietFunction(fn)) return () => {};
            return own(dramatis.quiet(fn, typeof owner === 'string' ? owner : 'dramatis'));
        },
        styleUp,
        setCanonGoals,
        storyLanguage: () => storyLanguage(app),
    };

    return {
        api,
        speech,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const off of [...disposers]) {
                try {
                    off();
                } catch (error) {
                    log.debug('API disposer failed', error);
                }
            }
            disposers.clear();
            appliers.clear();
            undoHandlers.clear();
            cast = null;
        },
    };
}

/* ------------------------------------------------------------------ canon goals helpers */

function typedFields(item: CanonItem): Record<string, string> {
    const typed = readTypedMeta(item.meta);
    if (typed && typed.type === 'character') return { ...typed.fields };
    const content = typeof item.entry.content === 'string' ? item.entry.content : '';
    return fieldsFromContent('character', content);
}

function withoutTimes(meta: CanonItem['meta']): Omit<CanonItem['meta'], 'createdAt' | 'updatedAt'> {
    const rest: Partial<CanonItem['meta']> = { ...meta };
    delete rest.createdAt;
    delete rest.updatedAt;
    return rest as Omit<CanonItem['meta'], 'createdAt' | 'updatedAt'>;
}

/** A character entry of the chat canon about this person (typed name, title or the composed first line). */
function isCharacterOf(item: CanonItem, name: string, same: (a: string, b: string) => boolean): boolean {
    if (item.meta.status === 'archived') return false;
    const typed = readTypedMeta(item.meta);
    const isCharacter = item.meta.type === 'character' || typed?.type === 'character';
    if (!isCharacter) return false;
    const names = [
        typed?.fields.name,
        typeof item.entry.comment === 'string' ? item.entry.comment : undefined,
        typeof item.entry.content === 'string' ? /^Character:\s*(.+)$/m.exec(item.entry.content)?.[1] : undefined,
    ].filter((value): value is string => typeof value === 'string' && !!value.trim());
    return names.some((value) => same(value, name));
}

/**
 * Publishes MAESTRO_API (version 1) and tells neighbours it is there; the returned function removes it (only when
 * it is still ours) and releases everything registered through it.
 */
export function installMaestroApi(deps: MaestroApiDeps): { handle: MaestroApiHandle; remove: () => void } {
    const handle = createMaestroApi(deps);
    const root = globalThis as Record<string, unknown>;
    root[MAESTRO_API_GLOBAL] = handle.api;
    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent(MAESTRO_API_READY_EVENT, { detail: { version: 1 } }));
        }
    } catch (error) {
        deps.app.log.debug('maestro-api-ready was not dispatched', error);
    }
    return {
        handle,
        remove() {
            if (root[MAESTRO_API_GLOBAL] === handle.api) delete root[MAESTRO_API_GLOBAL];
            handle.dispose();
        },
    };
}
