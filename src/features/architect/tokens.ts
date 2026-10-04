// Token counts for M20's budgets. The send path never waits for the tokenizer (P15): a count is the cached exact
// number when one exists and the chars/3.6 estimate otherwise; exact counts are filled in the background after the
// generation (one at a time). Lore entries are keyed by world, uid, ST's entry hash and length (an edited entry is
// counted again), texts by length and a quick hash.
import { quickHash } from '../../domain/architect-cache';
import { estimateText } from '../../domain/architect-text';
import type { Logger } from '../../shared/contracts';

type Dict = Record<string, unknown>;

function contentOf(entry: Dict): string {
    return typeof entry.content === 'string' ? entry.content : '';
}

export class TokenMeter {
    private readonly exact = new Map<string, number>();
    private readonly wanted = new Map<string, string>();
    private filling = false;

    constructor(
        private readonly count: (text: string) => Promise<number>,
        private readonly log: Logger,
        private readonly maxSize = 4000,
        private readonly batch = 40,
    ) {}

    private textKey(text: string): string {
        return `t${text.length}:${quickHash(text)}`;
    }

    private entryKey(entry: Dict): string {
        return `e${String(entry.world)}.${String(entry.uid)}#${String(entry.hash ?? '')}#${contentOf(entry).length}`;
    }

    /** Tokens of a text (cached exact or estimate). */
    text(text: string): number {
        if (!text) return 0;
        return this.exact.get(this.textKey(text)) ?? estimateText(text);
    }

    /** Tokens of a lore entry's content (cached exact or estimate). */
    entry(entry: Dict): number {
        const content = contentOf(entry);
        if (!content) return 0;
        return this.exact.get(this.entryKey(entry)) ?? estimateText(content);
    }

    /** Remembers texts / entries to count exactly later (no work now). */
    want(items: Iterable<string | Dict>): void {
        for (const item of items) {
            if (this.wanted.size >= this.batch * 4) return;
            const text = typeof item === 'string' ? item : contentOf(item);
            if (!text) continue;
            const key = typeof item === 'string' ? this.textKey(text) : this.entryKey(item);
            if (!this.exact.has(key)) this.wanted.set(key, text);
        }
    }

    /** Counts up to one batch of wanted items in the background; resolves when done. */
    fill(): Promise<void> {
        if (this.filling || !this.wanted.size) return Promise.resolve();
        const todo = [...this.wanted].slice(0, this.batch);
        for (const [key] of todo) this.wanted.delete(key);
        this.filling = true;
        const run = async () => {
            for (const [key, text] of todo) {
                try {
                    const tokens = Number(await this.count(text));
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
        if (this.exact.size >= this.maxSize && !this.exact.has(key)) this.exact.clear();
        this.exact.set(key, tokens);
    }
}
