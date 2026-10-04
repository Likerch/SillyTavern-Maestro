// M31 — character sheets (`!fullsheet` and the other BunnyMo sheet commands). Stage 1.
// - Sheet scenario (M34 п. 7, engine in ../scenarios): the prompt of a sheet generation is replaced by the BunnyMo
//   command instruction, the target's data and a cleaned chat excerpt; only the command entry and the target's
//   archive pass the WI scan; length and temperature are set for this request only.
// - Reply post-processing, also as a safety net without the scenario: the scene continuation and DES tracker JSON
//   after the sheet are cut, the command and the reply are marked `extra.maestro.sheet`.
// - CarrotKernel capture: CK's Baby Bunny looks at replies only in display mode "thinking"
//   (CK index.js CHARACTER_MESSAGE_RENDERED handler); in the other modes Maestro calls CK's global
//   `checkForCompletedSheets(message, id)` (baby-bunny-mode.js:2065). `window.CarrotKernel.checkForCompletedSheets`
//   drops its arguments and does nothing, so it is not used.
// - Folding (P14, audit T6): folded to one line until the next user message; then hidden from the prompt and the WI
//   scan (hideChatMessageRange) and excluded in Qvink, still folded on screen. The last message is never hidden:
//   Regenerate would delete it.
import { adaptersOf } from '../../adapters';
import {
    buildSheetMessages,
    formatCharacterData,
    parseSheetTarget,
    sameCharacter,
    sheetDirective,
} from '../../domain/sheet-context';
import { compareSheetTags, trimSheetReply } from '../../domain/sheet-reply';
import type { SheetTagReport } from '../../domain/sheet-reply';
import type { SheetCommand } from '../../domain/sheets';
import type { GenerationInfo, JournalChange, MaestroModule, Unsubscribe } from '../../shared/contracts';
import type { Scenario, ScenarioContext, ScenarioPlan, ScenariosApi } from '../scenarios/api';
import type { SheetMark, SheetsApi } from './api';
import { SHEET_CSS, SheetDecorator } from './collapse';
import {
    clearSheetMark,
    commandIndexFor,
    currentText,
    setMessageText,
    setSheetMark,
    sheetMark,
    swipeIdOf,
} from './marks';
import { SheetSources } from './sources';
import { SHEET_STRINGS } from './strings';

export interface SheetsSettings {
    /** Response length of a sheet generation (tokens). */
    maxTokens: number;
    temperature: number;
    /** Chat messages given to the model as context. */
    excerptMessages: number;
    /** Fold sheet messages on screen. */
    collapse: boolean;
}

/** Generations the sheet scenario takes over: a new command, its regeneration and swipes. */
const SCENARIO_TYPES: ReadonlySet<string> = new Set(['normal', 'regenerate', 'swipe']);
/** Rendered messages that are not the reply of the generation in progress. */
const FOREIGN_REPLY_TYPES: ReadonlySet<string> = new Set(['first_message', 'extension', 'impersonate', 'quiet']);
/** How far back from the end the commit looks for sheets not hidden yet. */
const COMMIT_LOOKBACK = 50;

export const SHEET_TRIM_KIND = 'sheets.trim';
export const SHEET_HIDE_KIND = 'sheets.hide';
export const SHEET_CAPTURE_KIND = 'sheets.capture';
const TEXT_TARGET = 'sheets.text';
const HIDDEN_TARGET = 'sheets.hidden';

/** The generation is a sheet generation the scenario should take over. */
export function isSheetGeneration(info: GenerationInfo): info is GenerationInfo & { sheetCommand: SheetCommand } {
    return !info.dryRun && !info.quiet && !!info.sheetCommand && SCENARIO_TYPES.has(info.type);
}

interface Pending {
    command: SheetCommand;
    target: string;
}

interface TrimPayload {
    index: number;
    swipeId: number;
    before: string;
    after: string;
    target: string;
}

interface HidePayload {
    ranges: [number, number][];
}

interface CapturePayload {
    index: number;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastUserIndex(chat: readonly STChatMessage[]): number {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) return i;
    return -1;
}

/** Ascending contiguous ranges of indexes. */
export function toRanges(indexes: Iterable<number>): [number, number][] {
    const sorted = [...new Set(indexes)].filter((i) => i >= 0).sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    for (const index of sorted) {
        const last = ranges.at(-1);
        if (last && index === last[1] + 1) last[1] = index;
        else ranges.push([index, index]);
    }
    return ranges;
}

function rangeText([start, end]: [number, number]): string {
    return start === end ? String(start) : `${start}-${end}`;
}

function number(value: unknown, fallback: number, min: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

export const sheetsModule: MaestroModule<SheetsSettings> = {
    id: 'M31',
    key: 'sheets',
    stage: 1,
    titleKey: 'm31.title',
    enabledByDefault: true,
    defaults: () => ({ maxTokens: 6000, temperature: 0.7, excerptMessages: 12, collapse: true }),
    i18n: SHEET_STRINGS,

    init({ app, settings, log, own }) {
        const ctx = () => app.host.ctx();
        const adapters = adaptersOf(app);
        const sources = new SheetSources(app, log);
        const decorator = new SheetDecorator({
            i18n: app.i18n,
            chat: () => ctx().chat,
            enabled: () => settings.collapse !== false,
        });
        own(app.ui.style('maestro-sheets', SHEET_CSS));
        own(() => decorator.dispose());

        /** Raw replies as received (tag-loss check), per message object, for this page session. */
        const rawReplies = new WeakMap<STChatMessage, string>();
        let pending: Pending | null = null;
        let disposed = false;
        own(() => {
            disposed = true;
            pending = null;
        });

        // chats.js is preloaded so hideChatMessageRange can run synchronously inside MESSAGE_SENT, before ST
        // builds the next prompt (the interceptor below is the safety net).
        let chats: Record<string, unknown> | null = null;
        app.host.modules.chats().then(
            (namespace) => {
                chats = namespace;
            },
            (error: unknown) => log.debug('chats.js not available', error),
        );
        const hideRange = (): ((start: number, end: number, unhide: boolean) => Promise<void>) | null => {
            const fn = chats?.hideChatMessageRange;
            if (typeof fn !== 'function' || !app.host.caps.has('st.chats.hide')) return null;
            return fn as (start: number, end: number, unhide: boolean) => Promise<void>;
        };

        const rerender = (index: number, message: STChatMessage): void => {
            try {
                ctx().updateMessageBlock?.(index, message);
            } catch (error) {
                log.warn('could not re-render the sheet message', error);
            }
        };
        const save = async (): Promise<void> => {
            try {
                await ctx().saveChat();
            } catch (error) {
                log.warn('could not save the chat', error);
            }
        };

        /* ------------------------------------------------------------ Qvink */

        const qvinkExclude = async (ranges: [number, number][], exclude: boolean): Promise<boolean> => {
            const qvink = adapters.qvink;
            if (!ranges.length || !qvink.present() || !qvink.chatEnabled()) return false;
            const context = ctx();
            if (!context.SlashCommandParser?.commands?.['qm-toggle-exclude']) return false;
            try {
                for (const range of ranges) {
                    await context.executeSlashCommandsWithOptions(
                        `/qm-toggle-exclude ${rangeText(range)} exclude=${exclude}`,
                        { handleParserErrors: false, handleExecutionErrors: false },
                    );
                }
                return true;
            } catch (error) {
                log.warn('Qvink exclusion failed', error);
                return false;
            }
        };

        /* ------------------------------------------------------------ trim */

        const applyTrim = async (payload: TrimPayload): Promise<void> => {
            const message = ctx().chat[payload.index];
            if (!message) return;
            setMessageText(message, payload.after);
            rerender(payload.index, message);
            await save();
        };
        const trimStillValid = (payload: TrimPayload): boolean => {
            const message = ctx().chat[payload.index];
            return !!message && swipeIdOf(message) === payload.swipeId && currentText(message) === payload.before;
        };

        const proposeTrim = async (payload: TrimPayload): Promise<void> => {
            const change: JournalChange = {
                target: TEXT_TARGET,
                ref: { index: payload.index, swipeId: payload.swipeId },
                before: payload.before,
                after: payload.after,
            };
            await app.autonomy.decide<TrimPayload>(
                {
                    module: 'sheets',
                    kind: SHEET_TRIM_KIND,
                    title: app.i18n.t('m31.trim.title', { name: payload.target }),
                    changes: [change],
                    payload,
                    sourceMessage: payload.index,
                    apply: applyTrim,
                    stillValid: async () => trimStillValid(payload),
                },
                'auto',
            );
        };

        /* ------------------------------------------------------------ CK capture */

        const runCapture = (payload: CapturePayload): void => {
            const capture = (globalThis as unknown as Dict).checkForCompletedSheets;
            const message = ctx().chat[payload.index];
            if (typeof capture !== 'function' || !message) return;
            // Not awaited: Baby Bunny resolves only when its popup closes.
            Promise.resolve((capture as (m: STChatMessage, id: number) => unknown)(message, payload.index)).catch(
                (error: unknown) => log.warn('Baby Bunny capture failed', error),
            );
        };

        const proposeCapture = async (index: number, target: string): Promise<void> => {
            const ck = adapters.ck;
            if (!ck.present() || !ck.enabled()) return;
            const ckSettings = ck.settings();
            // Baby Bunny off: the user does not want captures. "thinking": CK captures by itself.
            if (ckSettings?.babyBunnyMode !== true || ckSettings.displayMode === 'thinking') return;
            if (typeof (globalThis as unknown as Dict).checkForCompletedSheets !== 'function') return;
            await app.autonomy.decide<CapturePayload>(
                {
                    module: 'sheets',
                    kind: SHEET_CAPTURE_KIND,
                    title: app.i18n.t('m31.capture.title', { name: target }),
                    changes: [],
                    payload: { index },
                    sourceMessage: index,
                    apply: async (payload) => runCapture(payload),
                },
                'auto',
            );
        };

        /* ------------------------------------------------------------ reply */

        const handleReply = async (index: number): Promise<void> => {
            const job = pending;
            const chat = ctx().chat;
            const message = chat[index];
            if (!job || disposed || !message || message.is_user || message.is_system) return;
            pending = null;
            sources.end();

            const before = currentText(message);
            rawReplies.set(message, before);
            const trim = trimSheetReply(before);
            if (!trim.isSheet) {
                log.info(`!${job.command} reply does not look like a sheet; left as is`);
                if (sheetMark(message)) {
                    clearSheetMark(message);
                    await save();
                    decorator.schedule();
                }
                // It was excluded in Qvink on arrival as a presumed sheet: an ordinary reply is summarised as usual.
                await qvinkExclude([[index, index]], false);
                return;
            }
            if (trim.changed) {
                await proposeTrim({
                    index,
                    swipeId: swipeIdOf(message),
                    before,
                    after: trim.text,
                    target: job.target,
                });
            }
            const mark: Omit<SheetMark, 'part'> = { command: job.command, target: job.target };
            setSheetMark(message, { ...mark, part: 'reply' });
            const commandIndex = commandIndexFor(chat, index);
            const command = chat[commandIndex];
            if (command) setSheetMark(command, { ...mark, part: 'command' });
            await save();
            decorator.schedule();
            // Normally done on MESSAGE_RECEIVED already; idempotent.
            await qvinkExclude([[index, index]], true);
            await proposeCapture(index, job.target);
        };

        /* ------------------------------------------------------------ commit: hide */

        const applyHide = async (payload: HidePayload): Promise<void> => {
            const chat = ctx().chat;
            const last = chat.length - 1;
            const ranges = payload.ranges.filter(([, end]) => end < last);
            const hide = hideRange();
            if (!ranges.length) return;
            // Every range is started before any is awaited: is_system is set synchronously inside the call.
            const pendingSaves = hide ? ranges.map(([start, end]) => hide(start, end, false)) : [];
            for (const [start, end] of ranges) {
                for (let i = start; i <= end; i++) {
                    const message = chat[i];
                    const mark = sheetMark(message);
                    if (message && mark) setSheetMark(message, { ...mark, committed: true });
                }
            }
            decorator.schedule();
            await Promise.all(pendingSaves);
            if (!hide) await save();
            await qvinkExclude(ranges, true);
        };

        const commit = (): void => {
            const chat = ctx().chat;
            const last = chat.length - 1;
            const indexes: number[] = [];
            let target = '';
            for (let i = last - 1; i >= Math.max(0, last - COMMIT_LOOKBACK); i--) {
                const mark = sheetMark(chat[i]);
                if (mark?.part !== 'reply' || mark.committed) continue;
                indexes.push(i);
                target ||= mark.target;
                const commandIndex = commandIndexFor(chat, i);
                if (sheetMark(chat[commandIndex])?.part === 'command') indexes.push(commandIndex);
            }
            if (!indexes.length) return;
            const ranges = toRanges(indexes);
            const payload: HidePayload = { ranges };
            // No stillValid: with level "auto" apply() then starts synchronously, inside ST's MESSAGE_SENT.
            void app.autonomy.decide<HidePayload>(
                {
                    module: 'sheets',
                    kind: SHEET_HIDE_KIND,
                    title: app.i18n.t('m31.hide.title', { name: target }),
                    changes: ranges.map(([start, end]) => ({
                        target: HIDDEN_TARGET,
                        ref: { start, end },
                        before: false,
                        after: true,
                    })),
                    payload,
                    sourceMessage: ranges.at(-1)?.[1],
                    apply: applyHide,
                },
                'auto',
            );
        };

        /** A hidden sheet that became the last message again (the messages after it were deleted) is shown again. */
        const unhideTrailing = async (): Promise<void> => {
            const chat = ctx().chat;
            const indexes: number[] = [];
            for (let i = chat.length - 1; i >= 0; i--) {
                const message = chat[i];
                const mark = sheetMark(message);
                if (!message || !mark?.committed || !message.is_system) break;
                indexes.push(i);
            }
            if (!indexes.length) return;
            const hide = hideRange();
            for (const index of indexes) {
                const message = chat[index]!;
                const mark = sheetMark(message);
                if (mark) setSheetMark(message, { ...mark, committed: false });
            }
            const ranges = toRanges(indexes);
            if (hide) await Promise.all(ranges.map(([start, end]) => hide(start, end, true)));
            else await save();
            await qvinkExclude(ranges, false);
            decorator.schedule();
        };

        /* ------------------------------------------------------------ scenario */

        const build = async (scenarioContext: ScenarioContext): Promise<ScenarioPlan | null> => {
            const job = pending;
            if (!job) return null;
            const chat = scenarioContext.chat;
            const commandIndex = lastUserIndex(chat);
            const instruction = await sources.instruction(job.command);
            if (!instruction) {
                log.info(`no BunnyMo entry for !${job.command}; the sheet goes out with the regular prompt`);
                return null;
            }
            const archives = await sources.archives(job.target);
            const messages = buildSheetMessages({
                instruction,
                directive: sheetDirective(job.command, job.target),
                characterData: formatCharacterData(sources.characterData(job.target, commandIndex, archives)),
                excerpt: sources.excerpt(commandIndex, Math.floor(number(settings.excerptMessages, 12, 0))),
                command: chat[commandIndex]?.mes ?? `!${job.command}`,
            });
            return {
                messages,
                params: {
                    max_tokens: Math.floor(number(settings.maxTokens, 6000, 1)),
                    temperature: number(settings.temperature, 0.7, 0),
                },
            };
        };

        /**
         * Sets up the pending sheet for a generation; idempotent per GenerationInfo object, because the engine's
         * match() and our own `generation:before` handler both call it, in whichever order the bus runs them.
         */
        let preparedFor: GenerationInfo | null = null;
        const prepare = (info: GenerationInfo): void => {
            if (preparedFor === info) return;
            preparedFor = info;
            const chat = ctx().chat;
            const lastMark = sheetMark(chat.at(-1));
            if (app.host.isGroupChat()) {
                // Maestro does not support group chats (plan Q11): ST handles sheets there as before.
                pending = null;
                sources.end();
            } else if (isSheetGeneration(info)) {
                const command = chat[lastUserIndex(chat)];
                const target = parseSheetTarget(command?.mes, info.sheetCommand) || ctx().name2 || '';
                pending = { command: info.sheetCommand, target };
                sources.begin(info.sheetCommand, target);
            } else if (info.type === 'continue' && lastMark?.part === 'reply') {
                // Continuing a sheet: no scenario (the partial sheet is in ST's prompt), but trim the result.
                pending = { command: lastMark.command, target: lastMark.target };
                sources.end();
            } else {
                pending = null;
                sources.end();
            }
        };

        const scenario: Scenario = {
            id: 'sheets',
            match: (info) => {
                if (!isSheetGeneration(info)) return false;
                prepare(info);
                return pending !== null;
            },
            build,
            onReply: (index) => handleReply(index),
            keepEntry: (entry) => sources.keepEntry(entry),
        };

        let registered: { api: ScenariosApi; off: Unsubscribe } | null = null;
        /** The engine may start after this module or restart: (re-)register lazily. */
        const ensureRegistered = (): void => {
            const api = app.modules.api<ScenariosApi>('scenarios');
            if (registered?.api === api) return;
            registered?.off();
            registered = api ? { api, off: api.register(scenario) } : null;
        };
        ensureRegistered();
        own(() => {
            registered?.off();
            registered = null;
        });

        /* ------------------------------------------------------------ wiring */

        own(
            app.bus.on('generation:before', async (info) => {
                if (info.dryRun || info.quiet) return;
                ensureRegistered();
                prepare(info);
                // Before the WI scan (turn.ts awaits this event inside the interceptor): decides the lore filter.
                if (pending && isSheetGeneration(info)) await sources.preload();
            }),
        );
        own(
            app.bus.on('reply:ready', async ({ messageIndex, type }) => {
                // The scenario's onReply normally handles it; this is the path without the engine.
                if (!pending || FOREIGN_REPLY_TYPES.has(type)) return;
                await handleReply(messageIndex);
            }),
        );
        own(app.bus.on('turn:committed', () => commit()));
        own(
            app.bus.on('message:invalidated', async ({ reason }) => {
                if (reason === 'deleted') await unhideTrailing();
            }),
        );
        own(
            app.bus.on('chat:changed', async () => {
                pending = null;
                preparedFor = null;
                sources.end();
                decorator.schedule();
                await unhideTrailing();
            }),
        );

        // Sheets never reach a non-sheet prompt, even before (or without) hideChatMessageRange.
        own(
            app.turn.onIntercept((coreChat) => {
                const lastUser = lastUserIndex(coreChat);
                let removed = 0;
                for (let i = lastUser - 1; i >= 0; i--) {
                    if (!sheetMark(coreChat[i])) continue;
                    coreChat.splice(i, 1);
                    removed++;
                }
                if (removed) log.debug(`${removed} sheet messages left out of the prompt`);
            }),
        );

        const onSt = (key: string, handler: (...args: unknown[]) => unknown): void => {
            const name = app.host.events.name(key);
            if (name) own(app.host.events.on(name, handler));
        };
        // Exclude the sheet in Qvink before its auto-summary (Qvink summarises on CHARACTER_MESSAGE_RENDERED,
        // which ST emits right after MESSAGE_RECEIVED and awaits our listener first).
        onSt('MESSAGE_RECEIVED', async (messageId, type) => {
            if (!pending || FOREIGN_REPLY_TYPES.has(String(type ?? ''))) return;
            const index = Number(messageId);
            const message = ctx().chat[index];
            if (!Number.isInteger(index) || !message || message.is_user) return;
            await qvinkExclude([[index, index]], true);
        });
        for (const key of [
            'CHAT_CHANGED',
            'MORE_MESSAGES_LOADED',
            'MESSAGE_DELETED',
            'MESSAGE_SWIPED',
            'MESSAGE_UPDATED',
            'MESSAGE_EDITED',
            'CHARACTER_MESSAGE_RENDERED',
            'USER_MESSAGE_RENDERED',
        ]) {
            onSt(key, () => decorator.schedule());
        }
        own(app.settings.onChange(() => decorator.schedule()));
        decorator.schedule();

        /* ------------------------------------------------------------ autonomy, journal, inbox */

        own(
            app.inbox.registerApplier(
                SHEET_TRIM_KIND,
                (payload) => applyTrim(payload as TrimPayload),
                async (payload) => trimStillValid(payload as TrimPayload),
            ),
        );
        own(app.inbox.registerApplier(SHEET_HIDE_KIND, (payload) => applyHide(payload as HidePayload)));
        own(app.inbox.registerApplier(SHEET_CAPTURE_KIND, async (payload) => runCapture(payload as CapturePayload)));
        app.journal.registerUndo(TEXT_TARGET, async (change) => {
            const ref = isDict(change.ref) ? change.ref : {};
            const index = Number(ref.index);
            const message = ctx().chat[index];
            if (!message || swipeIdOf(message) !== Number(ref.swipeId) || currentText(message) !== change.after) {
                return false;
            }
            setMessageText(message, String(change.before ?? ''));
            rerender(index, message);
            await save();
            return true;
        });
        app.journal.registerUndo(HIDDEN_TARGET, async (change) => {
            const ref = isDict(change.ref) ? change.ref : {};
            const start = Number(ref.start);
            const end = Number(ref.end);
            if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
            const hide = hideRange();
            if (hide) await hide(start, end, true);
            await qvinkExclude([[start, end]], false);
            decorator.schedule();
            return true;
        });

        /* ------------------------------------------------------------ API */

        const lastSheetReply = (): number => {
            const chat = ctx().chat;
            for (let i = chat.length - 1; i >= 0; i--) if (sheetMark(chat[i])?.part === 'reply') return i;
            return -1;
        };

        const checkTags = async (index: number): Promise<SheetTagReport | null> => {
            const message = ctx().chat[index];
            const mark = sheetMark(message);
            if (!message || mark?.part !== 'reply') return null;
            const raw = rawReplies.get(message) ?? currentText(message);
            const archives = await sources.archives(mark.target);
            return compareSheetTags(raw, archives.join('\n\n'));
        };

        const api: SheetsApi = {
            isSheetMessage: (index) => sheetMark(ctx().chat[index]) !== null,
            sheetsFor: (name) =>
                ctx().chat.flatMap((message, index) => {
                    const mark = sheetMark(message);
                    return mark?.part === 'reply' && sameCharacter(mark.target, name)
                        ? [{ index, command: mark.command }]
                        : [];
                }),
            checkTags,
        };
        app.modules.expose('sheets', api);

        own(
            app.ui.addSlashCommand({
                name: 'maestro-sheet-tags',
                helpKey: 'm31.cmd.tags.help',
                args: [{ name: 'index', descriptionKey: 'm31.cmd.tags.index', optional: true }],
                callback: async (_args, value) => {
                    const requested = Number.parseInt(String(value ?? '').trim(), 10);
                    const index = Number.isInteger(requested) ? requested : lastSheetReply();
                    const report = index >= 0 ? await checkTags(index) : null;
                    return report ? JSON.stringify(report, null, 2) : app.i18n.t('m31.cmd.tags.none');
                },
            }),
        );
    },
};
