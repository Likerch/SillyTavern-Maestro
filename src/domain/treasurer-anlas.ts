// NAI Studio's Anlas records in chat messages (M21 п.2) and the turn a message belongs to. Field names follow
// NAI Studio's source (SillyTavern-NAI-Studio/src):
// - picture post: `extra.nai_studio { model, seed, mode, transport, cost }` — cost of the whole batch
//   (features/generation/output.ts postToChat); its `extra.media[]` repeat that cost on every item;
// - media attachment: `extra.media[].nai_studio { seed, model, prompt, transport, cost, correlationId?, tool? }`
//   (output.ts toAttachments) — cost of the batch, the same on every item of the batch; appendToMessage adds
//   later batches (image overswipe, paintbrush, tools) to an existing message without re-rendering it;
// - inline image: `extra.nai_images[] { id, swipes[] { meta { cost, createdAt, … } }, marker? }` (domain/inline.ts)
//   — every swipe of one generation carries a copy of the same meta (batch cost, same createdAt);
//   inactive reply swipes keep theirs in `swipe_info[].extra`.
// The core meter counts posts and media present at reply:ready (src/core/cost.ts onReplyReady); inline images and
// media added later are what the treasurer adds itself.
import { isImagePost } from './text-clean';
import { positive } from './treasurer-spend';

export interface NaiRecord {
    /** Stable within a chat: `post|<send_date>`, `media|c|<correlationId>`, `media|u|<url>`, `inline|<id>|<createdAt>`. */
    key: string;
    kind: 'post' | 'media' | 'inline';
    anlas: number;
    /** Creation time (inline images only). */
    at?: number;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extrasOf(message: Record<string, unknown>): Record<string, unknown>[] {
    const list: Record<string, unknown>[] = [];
    if (isDict(message['extra'])) list.push(message['extra']);
    const infos = message['swipe_info'];
    if (Array.isArray(infos)) {
        for (const info of infos) {
            if (isDict(info) && isDict(info['extra']) && !list.includes(info['extra'])) list.push(info['extra']);
        }
    }
    return list;
}

function mediaBatchKey(item: Record<string, unknown>, meta: Record<string, unknown>): string | null {
    if (typeof meta['correlationId'] === 'string' && meta['correlationId']) return `media|c|${meta['correlationId']}`;
    if (typeof item['url'] === 'string' && item['url']) return `media|u|${item['url']}`;
    return null;
}

function recordsOfExtra(extra: Record<string, unknown>, sendDate: string, out: Map<string, NaiRecord>): void {
    const put = (record: NaiRecord) => {
        if (!out.has(record.key)) out.set(record.key, record);
    };
    const media = Array.isArray(extra['media']) ? extra['media'].filter(isDict) : [];
    const post = isDict(extra['nai_studio']) ? extra['nai_studio'] : undefined;
    const postCost = post ? positive(post['cost']) : 0;
    let covered: string | null = null;
    if (postCost > 0) {
        put({ key: `post|${sendDate}`, kind: 'post', anlas: postCost });
        // The post's own batch is the first media item's (its items repeat the post cost).
        const first = media[0];
        const meta = first && isDict(first['nai_studio']) ? first['nai_studio'] : undefined;
        covered = first && meta ? mediaBatchKey(first, meta) : null;
    }
    for (const item of media) {
        const meta = isDict(item['nai_studio']) ? item['nai_studio'] : undefined;
        const cost = meta ? positive(meta['cost']) : 0;
        if (!meta || cost <= 0) continue;
        const key = mediaBatchKey(item, meta);
        if (key && key !== covered) put({ key, kind: 'media', anlas: cost });
    }
    const inline = Array.isArray(extra['nai_images']) ? extra['nai_images'].filter(isDict) : [];
    for (const entry of inline) {
        if (typeof entry['id'] !== 'string' || !Array.isArray(entry['swipes'])) continue;
        entry['swipes'].forEach((swipe: unknown, index: number) => {
            const meta = isDict(swipe) && isDict(swipe['meta']) ? swipe['meta'] : undefined;
            const cost = meta ? positive(meta['cost']) : 0;
            if (!meta || cost <= 0) return;
            const created = typeof meta['createdAt'] === 'string' ? meta['createdAt'] : '';
            const at = created ? Date.parse(created) : Number.NaN;
            const record: NaiRecord = {
                key: `inline|${String(entry['id'])}|${created || `#${index}`}`,
                kind: 'inline',
                anlas: cost,
            };
            if (Number.isFinite(at)) record.at = at;
            put(record);
        });
    }
}

/** Every NAI Studio cost record of a message (active swipe and stored swipes), one per batch. */
export function naiRecords(message: unknown): NaiRecord[] {
    if (!isDict(message)) return [];
    const out = new Map<string, NaiRecord>();
    const sendDate = typeof message['send_date'] === 'string' ? message['send_date'] : '';
    for (const extra of extrasOf(message)) recordsOfExtra(extra, sendDate, out);
    return [...out.values()];
}

/**
 * What triggered a look at a message: the chat was opened or re-scanned ('scan', 'sweep'), a reply was rendered
 * ('reply'), or NAI Studio reported a picture (its imageReady kinds: 'message', 'swipe', 'tool', 'inline', 'marker').
 */
export type AnlasTrigger = 'scan' | 'sweep' | 'reply' | 'message' | 'swipe' | 'tool' | 'inline' | 'marker';

export interface AnlasContext {
    trigger: AnlasTrigger;
    /** The message is the user's (NAI Studio posts as the user when told so: no reply:ready, the core misses it). */
    isUser: boolean;
    /** Records the treasurer already counted (persisted per chat). */
    counted: ReadonlySet<string>;
    /** Records present when the chat was opened or the message rendered (the core's or history). */
    baseline: ReadonlySet<string>;
    /** Inline images created before this are history. */
    countFrom: number;
}

/** Records the treasurer must add now (the core meter does not count them). */
export function newAnlas(records: readonly NaiRecord[], context: AnlasContext): NaiRecord[] {
    const result: NaiRecord[] = [];
    for (const record of records) {
        if (context.counted.has(record.key)) continue;
        if (record.kind === 'inline') {
            // Never counted by the core; the creation time tells new pictures from history.
            if (record.at !== undefined && record.at >= context.countFrom) result.push(record);
            continue;
        }
        if (context.baseline.has(record.key)) continue;
        if (context.trigger === 'swipe' || context.trigger === 'tool') result.push(record);
        else if (context.trigger === 'message' && context.isUser) result.push(record);
    }
    return result;
}

/** An assistant reply that opens a turn: not the user's, not a system note, not a NAI Studio picture post. */
export function isReply(message: unknown): boolean {
    if (!isDict(message)) return false;
    return message['is_user'] !== true && message['is_system'] !== true && !isImagePost(message);
}

/** The turn a message belongs to: the nearest reply at or before it; -1 when there is none. */
export function turnOfMessage(chat: readonly unknown[], index: number): number {
    for (let i = Math.min(index, chat.length - 1); i >= 0; i--) {
        if (isReply(chat[i])) return i;
    }
    return -1;
}

/** The latest reply of a chat (-1 if none). */
export function lastReply(chat: readonly unknown[]): number {
    return turnOfMessage(chat, chat.length - 1);
}
