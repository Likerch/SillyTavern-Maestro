// Write tools over the Mechanics module (M25 through M33): a mechanic from a template or a definition (an existing
// one is changed in place: attributes and checks merged by id), validated with the constructor's own checks before
// the card; and the per-chat switch. Saving journals itself (the mechanics' definitions store); the per-chat switch
// does not, so the assistant journals it with an undo.
import { exactlyOne, optEnum, optObject, reqBool, reqObject, reqString } from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import {
    checkMechanic,
    mechanicView,
    mergeMechanic,
    SCOPE_CHOICES,
    scopeOf,
    withMechanicId,
} from '../../../../domain/assistant-write-mechanic';
import type { ScopeChoice } from '../../../../domain/assistant-write-mechanic';
import type { DefIssue, MechanicScope, ScopeContext } from '../../../../domain/mechanics-defs';
import type { App, JournalChange } from '../../../../shared/contracts';
import type { MechanicDef, MechanicsApi } from '../../../mechanics/api';
import type { ToolSpec } from '../../api';
import { argsOf, failure, journal, listOf, planWith, UNDO_TARGETS } from './common';
import type { Say } from './strings';

const MECHANICS_KEY = 'mechanics';

function mechanicsOf(app: App): MechanicsApi | undefined {
    return app.modules.api<MechanicsApi>(MECHANICS_KEY);
}

/** Where the chat is (the mechanics' own rule: the character(s) of the chat and the chat id). */
function scopeContext(app: App): ScopeContext {
    const ctx = app.host.ctx();
    const avatars: string[] = [];
    if (ctx.groupId) {
        const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
        for (const member of group?.members ?? []) if (typeof member === 'string' && member) avatars.push(member);
    } else if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const avatar = ctx.characters?.[Number(ctx.characterId)]?.avatar;
        if (typeof avatar === 'string' && avatar) avatars.push(avatar);
    }
    return { avatars, chatId: app.host.chatId() };
}

/** A new definition's default scope, as the constructor does: this character, else this chat, else everywhere. */
function defaultScope(context: ScopeContext): MechanicScope {
    return scopeOf('card', context) ?? scopeOf('chat', context) ?? { kind: 'global' };
}

function issueText(app: App, issue: DefIssue): string {
    const key = `m25.def.issue.${issue.code}`;
    const text = app.i18n.t(key, issue.params);
    return text && text !== key ? text : `${issue.path}: ${issue.code}`;
}

/* ------------------------------------------------------------------ mechanic_save */

export function mechanicSaveTool(): ToolSpec {
    return {
        name: 'mechanic_save',
        kind: 'write',
        description:
            'Creates or changes a mechanic (stats, magic, reputation, money, skills…) of the Mechanics module. ' +
            'Either `template` (a template id, with optional `overrides`) or `definition` (a MechanicDef JSON: id, ' +
            'name, summary, rules (English, for the model), attributes [{id, name, promptName, kind ' +
            'number|scale|list|text, min, max, initial, levels, options, multi, tracking, events}], holders {kind ' +
            'persona|characters|named|world|factions, names}, checks [{id, name, promptName, dice like ' +
            '"1d20+mod(@attr)", difficulty, triggers}], tracking desStats|block|background|manual). With the id of ' +
            'an existing mechanic only the given fields change: attributes and checks are merged by id, ' +
            '{id, remove: true} removes one. Validated before the user confirms; current ones: mechanics_state.',
        parameters: {
            type: 'object',
            properties: {
                template: { type: 'string', description: 'Template id to start from.' },
                overrides: { type: 'object', description: 'Fields laid over the template (same rules as an update).' },
                definition: { type: 'object', description: 'A full new definition, or changes of an existing one.' },
                scope: {
                    type: 'string',
                    enum: [...SCOPE_CHOICES],
                    description: 'Where it works: this character (default for new ones), this chat, or everywhere.',
                },
            },
            additionalProperties: false,
        },
        available: (app) => mechanicsOf(app) !== undefined,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const app = ctx.app;
                const api = mechanicsOf(app);
                if (!api) throw failure(say, 'mechanicUnavailable');
                const args = argsOf(raw);
                const source = exactlyOne(args, 'definition', 'template');
                const overrides = optObject(args, 'overrides') ?? {};
                const choice = optEnum(args, 'scope', SCOPE_CHOICES);
                const context = scopeContext(app);
                let draft: Dict;
                let existing: MechanicDef | null = null;
                if (source === 'b') {
                    const template = reqString(args, 'template', { max: 80 });
                    const made = api.fromTemplate(template);
                    if (!made) {
                        throw failure(say, 'mechanicTemplate', {
                            template,
                            list: listOf(api.templates().map((item) => item.id)),
                        });
                    }
                    draft = mergeMechanic(made as unknown as Dict, overrides);
                } else {
                    const definition = mergeMechanic(reqObject(args, 'definition'), overrides);
                    const id = typeof definition.id === 'string' ? definition.id.trim() : '';
                    existing = id ? api.get(id) : null;
                    if (existing) {
                        draft = mergeMechanic(existing as unknown as Dict, definition);
                    } else {
                        draft = withMechanicId(
                            definition,
                            api.list().map((def) => def.id),
                        );
                        if (draft.scope === undefined) draft.scope = defaultScope(context);
                    }
                }
                if (choice) draft.scope = scopeFor(say, choice, context);
                const checked = checkMechanic(draft);
                if (!checked) throw failure(say, 'mechanicNotDef');
                if (checked.errors.length) {
                    const issues = checked.errors.slice(0, 5).map((issue) => issueText(app, issue));
                    throw failure(say, 'mechanicInvalid', { issues: issues.join('; ') });
                }
                const def = checked.def;
                const after: Dict = mechanicView(def);
                if (checked.warnings.length) after.warnings = checked.warnings.map((issue) => issueText(app, issue));
                return {
                    summary: existing
                        ? say('m33w.mechanic.summary.update', { name: def.name })
                        : say('m33w.mechanic.summary.create', {
                              name: def.name,
                              attributes: def.attributes.length,
                              checks: def.checks.length,
                              scope: say(`m33w.mechanic.scope.${def.scope.kind}`),
                          }),
                    target: say('m33w.target.mechanic', { name: def.name }),
                    before: existing ? mechanicView(existing) : null,
                    after,
                    async apply() {
                        const live = mechanicsOf(app);
                        if (!live) throw failure(say, 'mechanicUnavailable');
                        // The definitions store validates again, writes its book entry and journals with undo.
                        const saved = await live.save(def);
                        return { result: { id: saved.id, name: saved.name, book: saved.book, uid: saved.uid } };
                    },
                };
            }),
    };
}

function scopeFor(say: Say, choice: ScopeChoice, context: ScopeContext): MechanicScope {
    const scope = scopeOf(choice, context);
    if (!scope) throw failure(say, 'mechanicScope', { scope: choice });
    return scope;
}

/* ------------------------------------------------------------------ mechanic_toggle_chat */

function isOn(api: MechanicsApi, id: string): boolean {
    return api.active().some((def) => def.id === id);
}

export function mechanicToggleChatTool(): ToolSpec {
    return {
        name: 'mechanic_toggle_chat',
        kind: 'write',
        description:
            'Switches one mechanic on or off in the current chat only (its definition is not changed); ids from ' +
            'mechanics_state.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Mechanic id (or its exact name).' },
                on: { type: 'boolean', description: 'true: on in this chat, false: off in this chat.' },
            },
            required: ['id', 'on'],
            additionalProperties: false,
        },
        available: (app) => mechanicsOf(app) !== undefined,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const app = ctx.app;
                const api = mechanicsOf(app);
                if (!api) throw failure(say, 'mechanicUnavailable');
                const args = argsOf(raw);
                const wanted = reqString(args, 'id', { max: 120 });
                const on = reqBool(args, 'on');
                const chatId = app.host.chatId();
                if (!chatId) throw failure(say, 'mechanicNoChat');
                const list = api.list();
                const def =
                    list.find((item) => item.id === wanted) ??
                    list.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
                if (!def) {
                    throw failure(say, 'mechanicUnknown', { id: wanted, list: listOf(list.map((item) => item.id)) });
                }
                const was = isOn(api, def.id);
                const state = (value: boolean) => say(value ? 'm33w.stateF.on' : 'm33w.stateF.off');
                if (was === on) throw failure(say, 'mechanicAlready', { name: def.name, state: state(on) });
                return {
                    summary: say(on ? 'm33w.mechanic.summary.chatOn' : 'm33w.mechanic.summary.chatOff', {
                        name: def.name,
                    }),
                    target: say('m33w.target.mechanicChat'),
                    before: say(was ? 'm33w.on' : 'm33w.off'),
                    after: say(on ? 'm33w.on' : 'm33w.off'),
                    async apply() {
                        const live = mechanicsOf(app);
                        if (!live) throw failure(say, 'mechanicUnavailable');
                        const previous = isOn(live, def.id);
                        await live.setEnabledInChat(def.id, on);
                        if (previous !== on) {
                            await journal(app, {
                                kind: 'assistant.mechanicChat',
                                summary: say(on ? 'm33w.mechanic.journal.chatOn' : 'm33w.mechanic.journal.chatOff', {
                                    name: def.name,
                                }),
                                change: {
                                    target: UNDO_TARGETS.mechanicChat,
                                    ref: { chatId, id: def.id },
                                    before: previous,
                                    after: on,
                                },
                            });
                        }
                        return { result: { id: def.id, on } };
                    },
                };
            }),
    };
}

/** Journal undo of mechanic_toggle_chat: the previous state in that chat, if nobody switched it since. */
export async function undoMechanicChat(app: App, change: JournalChange): Promise<boolean> {
    const { chatId, id } = change.ref;
    const api = mechanicsOf(app);
    if (!api || typeof id !== 'string' || typeof chatId !== 'string' || app.host.chatId() !== chatId) return false;
    if (!api.list().some((def) => def.id === id)) return false;
    if (isOn(api, id) !== (change.after === true)) return false;
    await api.setEnabledInChat(id, change.before === true);
    return true;
}
