// What a built-in rule may use besides its definition: the App, the module's settings and the engine's shared state
// (token counts, cut reports). Built-ins get it from the engine; rules registered by later stages bring their own.
import { estimateTokens, isPlainObject } from '../../domain/rules-lore';
import type { App, Logger } from '../../shared/contracts';
import type { CutEntry, EntryCopy, EntryLists, RulesSettings } from './api';

export interface RuleEnv {
    app: App;
    log: Logger;
    t(key: string, params?: Record<string, string | number>): string;
    settings(): RulesSettings;
    /** Enabled and not waiting for the first-run wizard. */
    isActive(id: string): boolean;
    /** Cuts made in the current scan loop (book caps), for M1 and the pult. */
    reportCuts(cuts: CutEntry[]): void;
    tokens: TokenCache;
    /** A host or adapter capability is present now (adapter ones are probed live). */
    capability(id: string): boolean;
    /** The scan in progress is an M1 simulation (no questions, no state for the pult). */
    simulating(): boolean;
    /** Book names seen in the latest real scan. */
    activeBooks(): string[];
}

/** Valid entry copies of every list, in ST's list order (global, character, chat, persona). */
export function entriesOf(lists: EntryLists): EntryCopy[] {
    const result: EntryCopy[] = [];
    for (const list of [lists.globalLore, lists.characterLore, lists.chatLore, lists.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (isPlainObject(entry) && typeof entry.world === 'string' && entry.uid !== undefined) result.push(entry);
        }
    }
    return result;
}

export function contentOf(entry: Record<string, unknown>): string {
    return typeof entry.content === 'string' ? entry.content : '';
}

/**
 * Token counts of entry texts. A scan must not wait for the tokenizer (P15), so the cap uses a cached exact count
 * when one exists and the chars/3.6 estimate otherwise; exact counts are filled in the background after a scan.
 * Keys include ST's entry hash, so an edited entry is counted again.
 */
export class TokenCache {
    private readonly counts = new Map<string, number>();
    private filling = false;

    constructor(
        private readonly count: (text: string) => Promise<number>,
        private readonly log: Logger,
        private readonly maxSize = 5000,
        private readonly batch = 50,
    ) {}

    key(entry: Record<string, unknown>): string {
        return `${String(entry.world)}.${String(entry.uid)}#${String(entry.hash ?? '')}#${contentOf(entry).length}`;
    }

    has(entry: Record<string, unknown>): boolean {
        return this.counts.has(this.key(entry));
    }

    get(entry: Record<string, unknown>): number {
        return this.counts.get(this.key(entry)) ?? estimateTokens(contentOf(entry).length);
    }

    set(entry: Record<string, unknown>, tokens: number): void {
        this.remember(this.key(entry), tokens);
    }

    /** Counts entries without an exact count, one at a time, without blocking the caller. */
    fill(entries: Iterable<Record<string, unknown>>): Promise<void> {
        if (this.filling) return Promise.resolve();
        const todo: { key: string; text: string }[] = [];
        for (const entry of entries) {
            const key = this.key(entry);
            const text = contentOf(entry);
            if (!text || this.counts.has(key) || todo.some((item) => item.key === key)) continue;
            todo.push({ key, text });
            if (todo.length >= this.batch) break;
        }
        if (!todo.length) return Promise.resolve();
        this.filling = true;
        const run = async () => {
            for (const { key, text } of todo) {
                try {
                    const tokens = await this.count(text);
                    if (Number.isFinite(tokens) && tokens >= 0) this.remember(key, tokens);
                } catch (error) {
                    this.log.debug('token count failed', error);
                    return;
                }
            }
        };
        return run().finally(() => {
            this.filling = false;
        });
    }

    private remember(key: string, tokens: number): void {
        if (this.counts.size >= this.maxSize && !this.counts.has(key)) this.counts.clear();
        this.counts.set(key, tokens);
    }
}
