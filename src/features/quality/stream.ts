// What M12 sees of the main generation while it runs:
// - early cutoff (plan M12): ST emits STREAM_TOKEN_RECEIVED with the whole text so far on every chunk (script.js
//   StreamingProcessor.generate); only the new tail is searched for a known junk token, so a chunk costs a few
//   substring checks (P15). A hit stops the generation; the service swipes once the partial reply is rendered;
// - finish reason: the first chat/text-completion generate request after a non-quiet generation:before is the main
//   one (the cost meter attributes it the same way); its response copy (the fetch gate tees streams) is read for
//   `finish_reason` / `stop_reason` ('length' = cut by max_tokens).
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import { findJunkToken, finishReasonFromBody } from './logic';

const GENERATE_URL = /\/api\/backends\/(?:chat|text)-completions\/generate/;

export interface CutoffInfo {
    chatId: string | null;
    /** The message being streamed (the last one). */
    index: number;
    token: string;
}

export class StreamWatch {
    private armed = false;
    private scanned = 0;
    /** Armed by generation:before, consumed by the next generate request. */
    private finishArmed = false;
    private readonly marked = new WeakSet<object>();
    private finish: { reason?: string; done: Promise<void>; at: number } | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly onCutoff: (info: CutoffInfo) => void,
    ) {}

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const event = this.app.host.events.name('STREAM_TOKEN_RECEIVED') ?? 'stream_token_received';
        offs.push(this.app.host.events.on(event, (text) => this.onToken(text)));
        offs.push(
            this.app.host.fetchGate.beforeRequest(GENERATE_URL, (_url, init) => {
                if (!this.finishArmed || !init) return;
                this.finishArmed = false;
                this.marked.add(init);
            }),
        );
        offs.push(
            this.app.host.fetchGate.afterResponse(GENERATE_URL, (_url, response, init) => {
                if (!init || !this.marked.has(init) || !response.ok) return;
                const record: { reason?: string; done: Promise<void>; at: number } = {
                    at: Date.now(),
                    done: Promise.resolve(),
                };
                // text() must start before the first await: the fetch gate cancels copies nobody reads.
                record.done = response
                    .text()
                    .then((body) => {
                        record.reason = finishReasonFromBody(body);
                    })
                    .catch((error: unknown) => this.log.debug('finish reason not readable', error));
                this.finish = record;
            }),
        );
        return offs;
    }

    /** A main generation starts: reset the scan, arm the cutoff when allowed, expect its response. */
    begin(info: GenerationInfo, cutoff: boolean): void {
        if (info.quiet || info.dryRun) return;
        this.scanned = 0;
        this.armed = cutoff;
        this.finishArmed = true;
        this.finish = null;
    }

    end(): void {
        this.armed = false;
        this.finishArmed = false;
    }

    /** Finish reason of the last main generation; waits up to `waitMs` for its body to finish reading. */
    async reason(waitMs: number): Promise<string | undefined> {
        const record = this.finish;
        if (!record) return undefined;
        if (record.reason === undefined) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                record.done,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, waitMs);
                }),
            ]);
            if (timer !== undefined) clearTimeout(timer);
        }
        return record.reason;
    }

    private onToken(raw: unknown): void {
        if (!this.armed) return;
        const text = typeof raw === 'string' ? raw : '';
        if (text.length < this.scanned) this.scanned = 0;
        const token = findJunkToken(text, this.scanned);
        this.scanned = text.length;
        if (!token) return;
        this.armed = false;
        const chat = this.app.host.ctx().chat;
        const info: CutoffInfo = { chatId: this.app.host.chatId(), index: chat.length - 1, token };
        this.log.info(`junk token ${token} in the stream: stopping the generation`);
        try {
            this.onCutoff(info);
        } catch (error) {
            this.log.error('early cutoff failed', error);
        }
    }
}
