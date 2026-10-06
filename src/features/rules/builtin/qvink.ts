// Qvink rules of stage 1 (plan M22 table, §10.1, §10.14; audit T12; research/qvink-nai-studio.md §A):
// - gap guard: prompt entries Qvink dropped ("Remove Messages") but has not summarised come back as copies, and a
//   background task asks Qvink to summarise them;
// - NAI picture posts get Qvink's "exclude" mark so their image prompts are not summarised.
import { adaptersOf } from '../../../adapters';
import { tPlural } from '../../../core/labels';
import { estimateTokens, isPlainObject } from '../../../domain/rules-lore';
import {
    QVINK_MEMORY_KEY,
    contiguousRanges,
    hasQvinkMemory,
    liveIndexOf,
    promptChatIndexes,
    qvinkWouldSummarize,
    rangeArgument,
} from '../../../domain/rules-qvink';
import { isImagePost } from '../../../domain/text-clean';
import type { GenerationInfo, JournalChange, Unsubscribe } from '../../../shared/contracts';
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';

export const GAP_RULE_ID = 'qvink.gapGuard';
export const IMAGE_POSTS_RULE_ID = 'qvink.excludeImagePosts';
/** Background task: `/qm-summarize` for the messages the gap guard returned. */
export const QVINK_SUMMARIZE_TASK = 'rules.qvinkSummarize';
export const QVINK_EXCLUDE_KIND = 'rules.qvinkExclude';
export const QVINK_EXCLUDE_TARGET = 'm22.qvinkExclude';
/** ST `IGNORE_SYMBOL` (constants.js): set by Qvink's interceptor on prompt entries it drops. */
export const IGNORE_SYMBOL = Symbol.for('ignore');

type Dict = Record<string, unknown>;

interface ExcludePayload {
    index: number;
    sendDate: string;
}

function isExcludePayload(value: unknown): value is ExcludePayload {
    return isPlainObject(value) && typeof value.index === 'number' && typeof value.sendDate === 'string';
}

function slashCommandExists(name: string, ctx: STContext): boolean {
    const commands = (ctx as Partial<STContext>).SlashCommandParser?.commands;
    return isPlainObject(commands) && name in commands;
}

/** Runs an STscript line quietly; a failed command throws. */
async function runSlash(env: RuleEnv, command: string): Promise<void> {
    const result = await env.app.host.ctx().executeSlashCommandsWithOptions(command, {
        handleParserErrors: false,
        handleExecutionErrors: false,
        source: 'maestro',
    });
    if (isPlainObject(result) && result.isError === true) {
        throw new Error(typeof result.errorMessage === 'string' ? result.errorMessage : command);
    }
}

function toolsSupported(ctx: STContext): boolean {
    try {
        return typeof ctx.isToolCallingSupported === 'function' && ctx.isToolCallingSupported() === true;
    } catch {
        return false;
    }
}

/** Estimate only: ST's synchronous counter may block on a server tokenizer, and this runs on the send path (P15). */
function tokenCount(text: string): number {
    return estimateTokens(text.length);
}

function sameMessage(ctx: STContext, index: number, sendDate: string): boolean {
    const message = ctx.chat[index];
    return !!message && String(message.send_date ?? '') === sendDate;
}

/* ------------------------------------------------------------------ gap guard */

export function gapGuardRule(env: RuleEnv): RuleDefinition {
    /** Last index list queued per chat: the same gaps are not queued again on every generation. */
    const queued = new Map<string, string>();
    return {
        id: GAP_RULE_ID,
        titleKey: 'm22.rule.qvink.gapGuard.title',
        descriptionKey: 'm22.rule.qvink.gapGuard.description',
        owner: 'maestro',
        stage: 1,
        kind: 'prompt',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['qvink.present', 'qvink.removeMessages'],
        start(): Unsubscribe {
            return env.app.turn.onIntercept((chat, info) => {
                guardGaps(env, chat, info, queued);
            });
        },
    };
}

/**
 * Runs inside Maestro's interceptor (after Qvink's). Walks the prompt entries from the newest, takes those Qvink
 * flagged as ignored whose live message has no memory yet and that Qvink would summarise (its own exclusion rules,
 * picture posts never), at most `gapGuardLimit`, and replaces each in the array with a shallow copy whose `extra` is
 * a copy with the flag false: the shared `extra` and every other symbol key stay intact. Returns the live indexes.
 */
export function guardGaps(
    env: RuleEnv,
    chat: STChatMessage[],
    info: GenerationInfo,
    queued: Map<string, string> = new Map(),
): number[] {
    if (info.quiet || info.dryRun) return [];
    const qvink = adaptersOf(env.app).qvink;
    if (!qvink.present() || !qvink.chatEnabled() || !qvink.removesMessages()) return [];
    const limit = Math.max(0, Math.floor(env.settings().gapGuardLimit));
    if (!limit) return [];
    const ctx = env.app.host.ctx();
    const live = ctx.chat;
    const settings = qvink.settings() ?? {};
    const mapping = promptChatIndexes(live, toolsSupported(ctx));
    const picked: { position: number; index: number }[] = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i--) {
        const entry = chat[i];
        const extra = entry?.extra as (Dict & Record<symbol, unknown>) | undefined;
        if (!entry || !extra || extra[IGNORE_SYMBOL] !== true) continue;
        const index = liveIndexOf(entry, live, mapping);
        const message = index >= 0 ? live[index] : undefined;
        if (!message || hasQvinkMemory(message) || isImagePost(message)) continue;
        if (!qvinkWouldSummarize(message, settings, { groupId: ctx.groupId, tokenCount })) continue;
        picked.push({ position: i, index });
    }
    for (const { position } of picked) {
        const entry = chat[position] as STChatMessage;
        // Never structuredClone (drops symbol keys) and never write to the shared extra (plan §10.1).
        const extra = { ...entry.extra, [IGNORE_SYMBOL]: false } as STChatMessage['extra'];
        chat[position] = { ...entry, extra };
    }
    const indexes = picked.map((item) => item.index).sort((a, b) => a - b);
    if (indexes.length) queueSummaries(env, indexes, queued);
    return indexes;
}

function queueSummaries(env: RuleEnv, indexes: number[], queued: Map<string, string>): void {
    const chatId = env.app.host.chatId();
    if (!chatId) return;
    const signature = indexes.join(',');
    if (queued.get(chatId) === signature) return;
    queued.set(chatId, signature);
    const live = env.app.host.ctx().chat;
    const dates = indexes.map((index) => String(live[index]?.send_date ?? ''));
    env.app.tasks
        .enqueue({
            kind: QVINK_SUMMARIZE_TASK,
            dedupeKey: `${QVINK_SUMMARIZE_TASK}:${chatId}`,
            chatId,
            payload: { indexes, dates },
        })
        .catch((error: unknown) => env.log.warn('could not queue Qvink summaries', error));
}

/**
 * Task runner: re-checks every message (same send date, still without memory, still eligible) and runs
 * `/qm-summarize` per contiguous run. A range would make Qvink summarise every message in it, including the ones
 * its rules exclude (user messages by default), so runs are split at those.
 */
export async function runQvinkSummaries(env: RuleEnv, payload: Record<string, unknown>): Promise<number[]> {
    if (!env.isActive(GAP_RULE_ID)) return [];
    const qvink = adaptersOf(env.app).qvink;
    const ctx = env.app.host.ctx();
    if (!qvink.present() || !slashCommandExists('qm-summarize', ctx)) return [];
    const indexes = Array.isArray(payload.indexes)
        ? payload.indexes.filter((x): x is number => Number.isInteger(x))
        : [];
    const dates = Array.isArray(payload.dates) ? payload.dates : [];
    const settings = qvink.settings() ?? {};
    const valid = indexes.filter((index, position) => {
        const message = ctx.chat[index];
        if (!message) return false;
        const date = dates[position];
        if (typeof date === 'string' && date && String(message.send_date ?? '') !== date) return false;
        if (hasQvinkMemory(message) || isImagePost(message)) return false;
        return qvinkWouldSummarize(message, settings, { groupId: ctx.groupId, tokenCount });
    });
    for (const range of contiguousRanges(valid)) {
        await runSlash(env, `/qm-summarize ${rangeArgument(range)}`);
    }
    return valid;
}

/* ------------------------------------------------------------------ picture posts */

export function imagePostsRule(env: RuleEnv): RuleDefinition {
    return {
        id: IMAGE_POSTS_RULE_ID,
        titleKey: 'm22.rule.qvink.excludeImagePosts.title',
        descriptionKey: 'm22.rule.qvink.excludeImagePosts.description',
        owner: 'maestro',
        stage: 1,
        kind: 'neighbour',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['qvink.present'],
        start(): Unsubscribe {
            const offs: Unsubscribe[] = [];
            // Normal order: NAI's marker finaliser and DES go first (plan §10.2). A user-authored picture post
            // comes as MESSAGE_SENT. The handler is awaited by ST, so Qvink sees the mark before it renders.
            for (const key of ['MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
                const name = env.app.host.events.name(key);
                if (name) offs.push(env.app.host.events.on(name, (id) => excludeImagePost(env, id)));
            }
            return () => {
                for (const off of offs) off();
            };
        },
    };
}

/** Marks a picture post "exclude" in Qvink (`/qm-toggle-exclude exclude=true <index>`) through autonomy. */
export async function excludeImagePost(env: RuleEnv, messageId: unknown): Promise<boolean> {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return false;
    const ctx = env.app.host.ctx();
    const message = ctx.chat[index];
    if (!message || !isImagePost(message)) return false;
    const record = isPlainObject(message.extra?.[QVINK_MEMORY_KEY]) ? (message.extra[QVINK_MEMORY_KEY] as Dict) : {};
    // The user's own "remember" wins; an existing mark needs nothing.
    if (record.exclude === true || record.remember === true) return false;
    if (!adaptersOf(env.app).qvink.present() || !slashCommandExists('qm-toggle-exclude', ctx)) return false;
    const payload: ExcludePayload = { index, sendDate: String(message.send_date ?? '') };
    const decision = await env.app.autonomy.decide<ExcludePayload>(
        {
            module: 'M22',
            kind: QVINK_EXCLUDE_KIND,
            title: env.t('m22.qvinkExclude.title', { index }),
            description: env.t('m22.qvinkExclude.description'),
            // Several picture posts in one turn: «Убрал из пересказов Qvink 3 картинки».
            appliedNotice: {
                text: env.t('m22.qvinkExclude.done', { index }),
                group: QVINK_EXCLUDE_KIND,
                groupText: (count) => tPlural(env.app.i18n, 'm22.qvinkExclude.doneMany', count),
            },
            changes: [{ target: QVINK_EXCLUDE_TARGET, ref: { ...payload }, before: false, after: true }],
            payload,
            stillValid: async () => sameMessage(env.app.host.ctx(), payload.index, payload.sendDate),
            apply: (value) => setExcluded(env, value, true),
        },
        'auto',
    );
    return decision === 'applied';
}

async function setExcluded(env: RuleEnv, payload: ExcludePayload, exclude: boolean): Promise<void> {
    // Named arguments go before the unnamed one in STscript.
    await runSlash(env, `/qm-toggle-exclude exclude=${exclude ? 'true' : 'false'} ${payload.index}`);
}

/** Undo handler, Inbox applier and the summarise task; the module owns the returned disposers. */
export function registerQvinkHandlers(env: RuleEnv): Unsubscribe[] {
    env.app.journal.registerUndo(QVINK_EXCLUDE_TARGET, async (change: JournalChange) => {
        const ref = change.ref;
        if (!isExcludePayload(ref) || !sameMessage(env.app.host.ctx(), ref.index, ref.sendDate)) return false;
        await setExcluded(env, ref, false);
        return true;
    });
    return [
        env.app.inbox.registerApplier(
            QVINK_EXCLUDE_KIND,
            async (payload) => {
                if (isExcludePayload(payload)) await setExcluded(env, payload, true);
            },
            async (payload) =>
                isExcludePayload(payload) && sameMessage(env.app.host.ctx(), payload.index, payload.sendDate),
        ),
        env.app.tasks.register(QVINK_SUMMARIZE_TASK, async (payload) => {
            await runQvinkSummaries(env, payload);
        }),
    ];
}
