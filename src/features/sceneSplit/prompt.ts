// Old `<offscreen>` blocks do not pile up in the prompt (M43 «Сцена и вокруг»). Inside Maestro's generate interceptor
// the assistant entries of ST's coreChat are replaced with copies (never mutating the shared `extra`, plan §10.1): the
// `keepRecent` newest replies keep their block as one bracket line `[Elsewhere, not in the scene: …]`, older ones and
// the reply being continued lose it (domain/scene-split.ts rewritePromptEntries).
//
// ST 1.19 runs its prompt regexes before the interceptors (script.js Generate: coreChat map with `isPrompt: true`), so
// with DES's «Clean HTML (From Outgoing Prompt)» the tags are already gone and the block's words are glued to the scene.
// The entry is matched back to its stored message (send date, name, author: domain/rules-qvink.ts liveIndexOf), ST's
// regex engine is run over the stored text with and without the block at the entry's depth, and the result replaces
// the old one inside the entry (reasoning before it and attachments after it stay). Results are cached per message and
// regex set, so a turn costs only the replies that are new.
import { fnv1a32 } from '../../domain/hash';
import { liveIndexOf, promptChatIndexes } from '../../domain/rules-qvink';
import { hasOffscreen, rewritePromptEntries } from '../../domain/scene-split';
import type { PromptEntryInput } from '../../domain/scene-split';
import type { App, GenerationInfo, Logger } from '../../shared/contracts';

/** ST's regex placement of model replies (extensions/regex/engine.js regex_placement.AI_OUTPUT). */
const AI_OUTPUT = 2;
const CACHE_MAX = 600;

type Dict = Record<string, unknown>;
type RegexFn = (text: string, placement: number, options: Dict) => string;

interface Engine {
    regex: RegexFn | null;
    /** The regex scripts as a signature, and whether any of them depends on the depth. */
    scripts: (() => unknown[]) | null;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolsSupported(ctx: STContext): boolean {
    try {
        return typeof ctx.isToolCallingSupported === 'function' && ctx.isToolCallingSupported() === true;
    } catch {
        return false;
    }
}

function hasDepth(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value);
}

export class PromptCleaner {
    private engine: Promise<Engine> | null = null;
    private readonly cache = new Map<string, string>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly keep: () => number,
    ) {}

    /** A new chat: cached texts belong to the old one. */
    reset(): void {
        this.cache.clear();
    }

    private loadEngine(): Promise<Engine> {
        if (!this.engine) {
            this.engine = (async (): Promise<Engine> => {
                if (!this.app.host.caps.has('st.regex')) return { regex: null, scripts: null };
                try {
                    const module = await this.app.host.modules.regexEngine();
                    const regex =
                        typeof module.getRegexedString === 'function' ? (module.getRegexedString as RegexFn) : null;
                    const list = module.getRegexScripts;
                    const scripts =
                        typeof list === 'function'
                            ? () => {
                                  const result: unknown = (list as (options: Dict) => unknown)({ allowedOnly: true });
                                  return Array.isArray(result) ? result : [];
                              }
                            : null;
                    return { regex, scripts };
                } catch (error) {
                    this.log.debug('scene split: no regex engine', error);
                    return { regex: null, scripts: null };
                }
            })();
        }
        return this.engine;
    }

    /** Runs inside Maestro's interceptor: rewrites the assistant entries whose stored reply has a block. */
    async clean(chat: STChatMessage[], info: GenerationInfo): Promise<number> {
        if (info.dryRun || !chat.length) return 0;
        const ctx = this.app.host.ctx();
        const live = (ctx.chat ?? []) as STChatMessage[];
        const mapping = promptChatIndexes(live, toolsSupported(ctx));
        const lives = chat.map((entry): STChatMessage | null => {
            if (!entry || entry.is_user || entry.is_system) return null;
            const index = liveIndexOf(entry, live, mapping);
            const message = index >= 0 ? live[index] : undefined;
            return message && !message.is_user && typeof message.mes === 'string' ? message : null;
        });
        if (!lives.some((message) => message !== null && hasOffscreen(message.mes))) return 0;

        const continued = info.type === 'continue';
        // The depth ST gave each entry (script.js: coreChat.length - index - (continue ? 2 : 1)); `index` is the entry's
        // place in coreChat before any interceptor removed entries, so the last entry tells the original length.
        const last = chat[chat.length - 1] as Dict | undefined;
        const length = typeof last?.index === 'number' ? last.index + 1 : chat.length;
        const depthOf = (entry: Dict, position: number): number =>
            length - (typeof entry.index === 'number' ? entry.index : position) - (continued ? 2 : 1);

        const engine = await this.loadEngine();
        const regex = engine.regex ? this.cachedRegex(engine) : null;
        const entries: PromptEntryInput[] = chat.map((entry, position) => ({
            mes: typeof entry?.mes === 'string' ? entry.mes : '',
            live: lives[position]?.mes ?? null,
            depth: depthOf(entry as unknown as Dict, position),
        }));
        const results = rewritePromptEntries(entries, { keep: this.keep(), continued, regex });
        let changed = 0;
        results.forEach((text, position) => {
            if (text === undefined) return;
            const entry = chat[position]!;
            // A copy: the shared `extra` (and its symbol keys) is carried over untouched.
            chat[position] = { ...entry, mes: text };
            changed++;
        });
        if (changed) this.log.debug(`scene split: ${changed} replies with offscreen blocks rewritten in the prompt`);
        return changed;
    }

    /** ST's prompt regexes of a model reply, cached by text and regex set (and depth when a script uses it). */
    private cachedRegex(engine: Engine): (text: string, depth: number) => string {
        const run = engine.regex!;
        let signature = 'none';
        let byDepth = true;
        try {
            const scripts = engine.scripts?.() ?? null;
            if (scripts) {
                signature = String(
                    fnv1a32(
                        JSON.stringify(
                            scripts.map((script) =>
                                isDict(script)
                                    ? [
                                          script.id,
                                          script.findRegex,
                                          script.replaceString,
                                          script.trimStrings,
                                          script.placement,
                                          script.disabled,
                                          script.promptOnly,
                                          script.markdownOnly,
                                          script.substituteRegex,
                                          script.minDepth,
                                          script.maxDepth,
                                      ]
                                    : null,
                            ),
                        ),
                    ),
                );
                byDepth = scripts.some(
                    (script) => isDict(script) && (hasDepth(script.minDepth) || hasDepth(script.maxDepth)),
                );
            }
        } catch (error) {
            this.log.debug('scene split: regex scripts not readable', error);
        }
        return (text: string, depth: number): string => {
            const key = `${signature}|${byDepth ? depth : '*'}|${text.length}|${fnv1a32(text)}`;
            const known = this.cache.get(key);
            if (known !== undefined) return known;
            let out: string;
            try {
                const result: unknown = run(text, AI_OUTPUT, { isPrompt: true, depth });
                out = typeof result === 'string' ? result : text;
            } catch {
                out = text;
            }
            if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, out);
            return out;
        };
    }
}
