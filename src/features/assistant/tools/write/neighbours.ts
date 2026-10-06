// neighbour_prompt_set (M33 over M36, plan-2 §2 п. 5 and «Области действия» п. 3): the instruction text another
// extension puts into the prompt, changed «везде» (the neighbour's own setting, through its own save path) or as
// Maestro's copy for this character or this chat (put in at generation time only; the neighbour's settings stay as
// they are). Read-only entries (CarrotKernel, Maestro's own injections) and anything of BunnyMo's packs are refused;
// the card shows what goes to the model now and what will go. M36 journals with undo.
import { optBool, optEnum, reqString } from '../../../../domain/assistant-write-args';
import type { App } from '../../../../shared/contracts';
import type { NeighbourPrompt, NeighbourPromptsApi, NeighbourScope } from '../../../neighbourPrompts/api';
import type { ScopeOption, ToolSpec, WritePlan } from '../../api';
import { neighbourPrompts, presetLayer, scopeContext } from '../preset-common';
import { argsOf, failure, listOf, planWith } from './common';
import { MAX_BLOCK_TEXT } from './preset-changes';
import type { Say } from './strings';

type NeighbourTarget = 'global' | NeighbourScope;

const TARGETS: readonly NeighbourTarget[] = ['global', 'character', 'chat'];

/** BunnyMo's packs are never edited (P13); CarrotKernel's inserts are built per scene. */
function forbidden(entry: NeighbourPrompt): boolean {
    return entry.owner === 'ck' || /bunny/i.test(entry.id) || /bunny ?mo/i.test(entry.label);
}

/** The NeighbourPromptError codes in the user's words. */
const ERRORS: Readonly<Record<string, string>> = {
    unknown: 'm33w.err.neighbourUnknownId',
    readOnly: 'm33w.err.neighbourReadOnly',
    absent: 'm33w.err.neighbourAbsent',
    busy: 'm33w.err.neighbourBusy',
    notScopable: 'm33w.err.neighbourNoCopy',
    noScope: 'm33w.err.neighbourNoScope',
};

function translated(say: Say, error: unknown, name: string): Error {
    const code =
        error instanceof Error && error.name === 'NeighbourPromptError'
            ? String((error as { code?: unknown }).code)
            : '';
    const key = ERRORS[code];
    return key ? new Error(say(key, { name })) : error instanceof Error ? error : new Error(String(error));
}

/** The scopes this entry can take now, with their names. */
function targetsOf(say: Say, app: App, entry: NeighbourPrompt): ScopeOption[] {
    const context = scopeContext(presetLayer(app));
    const options: ScopeOption[] = [];
    if (entry.editable) options.push({ value: 'global', label: say('m33w.neighbour.scope.global') });
    if (entry.scopable && (!context || context.character)) {
        const name = context?.character?.name;
        options.push({
            value: 'character',
            label: name ? say('m33w.neighbour.scope.characterNamed', { name }) : say('m33w.neighbour.scope.character'),
        });
    }
    if (entry.scopable && (!context || context.chat)) {
        options.push({ value: 'chat', label: say('m33w.neighbour.scope.chat') });
    }
    return options;
}

export function neighbourPromptSetTool(): ToolSpec {
    return {
        name: 'neighbour_prompt_set',
        kind: 'write',
        description:
            'Changes an instruction text another extension puts into the prompt (ids from neighbour_prompts): scope ' +
            "global changes the extension's own setting everywhere (reset: back to its built-in text); character or " +
            'chat keeps a copy of Maestro for this character or this chat, put in only when a reply is generated ' +
            '(reset removes the copy). Read-only entries and BunnyMo packs cannot be changed.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Entry id, e.g. des.trackerInstructions.' },
                text: { type: 'string', description: 'The whole new text.' },
                reset: {
                    type: 'boolean',
                    description: 'Instead of text: back to the built-in text / remove the copy.',
                },
                scope: {
                    type: 'string',
                    enum: [...TARGETS],
                    description: 'global (the default), character or chat; the user can switch it on the card.',
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
        available: (app) => neighbourPrompts(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say): WritePlan => {
                const app = ctx.app;
                const api = neighbourPrompts(app);
                if (!api) throw failure(say, 'neighbourUnavailable');
                const args = argsOf(raw);
                const id = reqString(args, 'id', { max: 120 });
                const entry = api.get(id);
                if (!entry) {
                    throw failure(say, 'neighbourUnknown', { id, list: listOf(api.list().map((item) => item.id)) });
                }
                const name = entry.label || id;
                if (forbidden(entry)) throw failure(say, 'neighbourForbidden', { name });
                const reset = optBool(args, 'reset') ?? false;
                const text = reset
                    ? null
                    : reqString(args, 'text', { raw: true, max: MAX_BLOCK_TEXT, allowEmpty: true });
                const wanted = optEnum(args, 'scope', TARGETS) ?? 'global';
                const options = targetsOf(say, app, entry);
                if (!options.length) throw failure(say, 'neighbourReadOnlyEntry', { name, note: entry.note ?? '' });
                if (!options.some((option) => option.value === wanted)) {
                    throw failure(say, wanted === 'global' ? 'neighbourNoGlobal' : 'neighbourNoCopyHere', {
                        name,
                        scope: wanted,
                    });
                }
                const now = entry.text;
                let next: string;
                if (text === null) {
                    if (wanted === 'global') next = entry.defaultText ?? entry.globalText;
                    else next = entry.scoped[wanted === 'character' ? 'chat' : 'character'] ?? entry.globalText;
                } else next = text;
                const label = say('m33w.field.text');
                const warnings: string[] = [];
                if (wanted === 'global' && (entry.scoped.chat !== undefined || entry.scoped.character !== undefined)) {
                    warnings.push(say('m33w.neighbour.warn.copyWins'));
                }
                if (!entry.present) warnings.push(say('m33w.neighbour.warn.absent'));
                const after: Record<string, unknown> = { [label]: next };
                if (warnings.length) after[say('m33w.field.warnings')] = warnings;
                const summary = reset
                    ? say('m33w.neighbour.summary.reset', { name })
                    : say('m33w.neighbour.summary.set', { name });
                return {
                    summary,
                    target: say('m33w.target.neighbour', { name }),
                    before: { [label]: now },
                    after,
                    scope: wanted,
                    scopes: options,
                    full: true,
                    async apply(choice) {
                        const live: NeighbourPromptsApi | null = neighbourPrompts(app);
                        if (!live) throw failure(say, 'neighbourUnavailable');
                        const picked = options.find((option) => option.value === choice?.scope)?.value ?? wanted;
                        try {
                            if (picked === 'global') await live.setGlobal(id, text ?? '');
                            else await live.setScoped(id, picked as NeighbourScope, text);
                        } catch (error) {
                            throw translated(say, error, name);
                        }
                        return { result: { id, scope: picked, reset } };
                    },
                };
            }),
    };
}
