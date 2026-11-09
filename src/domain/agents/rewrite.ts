// A reply rewrite that never touches the service blocks (plan §3.5 «Правка ответа», §4.7): the agent gets the story
// text without the DES tracker JSON, the mechanics block, the `<offscreen>` block, NAI Studio's markers and images and
// CarrotKernel's dumps; the code puts them back where they were — leading blocks first, trailing ones last, inline
// ones after the same words as before (or, when the agent rewrote those words, at the nearest paragraph break of the
// same place in the text). A rewrite cut by the length limit, or much shorter than the reply without saying why, is
// refused: the original stays.
import { blockRanges } from '../mechanics-block';
import { findOffscreen } from '../scene-split';
import { stripDesTrackerJson } from '../text-clean';

export interface Protected {
    /** The reply without its service blocks: what the agent sees and rewrites. */
    text: string;
    /** The blocks with the text before them in `text` (offset) — to put them back. */
    blocks: { block: string; offset: number; where: 'lead' | 'inline' | 'tail'; before: string }[];
}

interface Range {
    start: number;
    end: number;
}

const NAI_PLACEHOLDER_RE = /\[nai:img:[^\]\s]{1,80}\]/g;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const CK_DUMP_RE = /<BunnyMoTags>[\s\S]*?<\/BunnyMoTags>/g;
/** A fenced block anywhere in a reply (a continued reply carries the tracker of its second part in the middle). */
const FENCED_RE = /```(?:json|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*(?:\r?\n)?/gi;
const TRACKER_KEY_RE = /"(?:quests|infoBox|infobox|characterThoughts|characters)"\s*:/;

/** Fenced DES tracker blocks anywhere in a text (not only the leading one). */
export function trackerRanges(text: string): Range[] {
    const ranges: Range[] = [];
    if (!text.includes('```')) return ranges;
    for (const match of text.matchAll(FENCED_RE)) {
        if (!TRACKER_KEY_RE.test(match[1] ?? '')) continue;
        const start = match.index ?? 0;
        ranges.push({ start, end: start + match[0].length });
    }
    return ranges;
}

/** The text without any fenced DES tracker block (what an agent reads of older replies). */
export function stripTrackerBlocks(text: string): string {
    const ranges = trackerRanges(text);
    if (!ranges.length) return text;
    let out = '';
    let cursor = 0;
    for (const range of ranges) {
        out += text.slice(cursor, range.start);
        cursor = range.end;
    }
    return (out + text.slice(cursor)).replace(/\n{3,}/g, '\n\n').trim();
}

/** Ranges of every service block, merged and sorted. */
export function serviceRanges(text: string): Range[] {
    const ranges: Range[] = [];
    const stripped = stripDesTrackerJson(text);
    if (stripped !== text) ranges.push({ start: 0, end: text.length - stripped.length });
    for (const range of trackerRanges(text)) ranges.push(range);
    for (const range of blockRanges(text)) ranges.push(range);
    for (const block of findOffscreen(text)) ranges.push({ start: block.start, end: block.end });
    for (const re of [NAI_PLACEHOLDER_RE, IMG_TAG_RE, CK_DUMP_RE]) {
        for (const match of text.matchAll(re)) {
            const start = match.index ?? 0;
            ranges.push({ start, end: start + match[0].length });
        }
    }
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Range[] = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

/** Cuts the service blocks out of a reply. */
export function protect(reply: string): Protected {
    const ranges = serviceRanges(reply);
    let text = '';
    let cursor = 0;
    const raw: { block: string; offset: number }[] = [];
    for (const range of ranges) {
        text += reply.slice(cursor, range.start);
        raw.push({ block: reply.slice(range.start, range.end), offset: text.length });
        cursor = range.end;
    }
    text += reply.slice(cursor);
    const blocks = raw.map(({ block, offset }) => {
        const before = text.slice(0, offset);
        const where: 'lead' | 'inline' | 'tail' = !before.trim()
            ? 'lead'
            : !text.slice(offset).trim()
              ? 'tail'
              : 'inline';
        return { block, offset, where, before };
    });
    return { text, blocks };
}

function paragraphBreakNear(text: string, target: number): number {
    const breaks: number[] = [];
    for (const match of text.matchAll(/\n+/g)) breaks.push((match.index ?? 0) + match[0].length);
    if (!breaks.length) return Math.max(0, Math.min(text.length, target));
    return breaks.reduce((best, at) => (Math.abs(at - target) < Math.abs(best - target) ? at : best), breaks[0] ?? 0);
}

/** Where an inline block goes in the new text: after the same words, else at the nearest break of the same place. */
function anchorIn(newText: string, before: string, ratio: number): number {
    const tail = before.replace(/\s+$/, '');
    const whitespace = before.slice(tail.length);
    for (const size of [40, 20, 12]) {
        if (tail.length < size && size !== 12) continue;
        const anchor = tail.slice(-size);
        if (anchor.trim().length < 6) continue;
        const at = newText.lastIndexOf(anchor);
        if (at >= 0 && newText.indexOf(anchor) === at) {
            const end = at + anchor.length;
            const gap = /^\s*/.exec(newText.slice(end))?.[0] ?? '';
            return end + Math.min(gap.length, whitespace.length);
        }
    }
    return paragraphBreakNear(newText, Math.round(ratio * newText.length));
}

/** Puts the service blocks back into the agent's text. */
export function restore(protectedReply: Protected, newText: string): string {
    const lead = protectedReply.blocks.filter((item) => item.where === 'lead').map((item) => item.block);
    const tail = protectedReply.blocks.filter((item) => item.where === 'tail').map((item) => item.block);
    const inline = protectedReply.blocks.filter((item) => item.where === 'inline');
    const total = Math.max(1, protectedReply.text.length);
    const placed = inline
        .map((item) => ({ block: item.block, at: anchorIn(newText, item.before, item.offset / total) }))
        .sort((a, b) => b.at - a.at);
    let body = newText;
    for (const item of placed) body = body.slice(0, item.at) + item.block + body.slice(item.at);
    // The lead blocks kept their own whitespace after them (the tracker's cut includes it); the tail ones the text's.
    const head = lead.join('');
    const end = tail.join('');
    if (!end) return head + body;
    const trimmed = body.replace(/\s+$/, '');
    const originalGap = /\s*$/.exec(protectedReply.text)?.[0] ?? '';
    return head + trimmed + (originalGap || '\n\n') + end;
}

export type RewriteCheck = { ok: true } | { ok: false; reason: 'length' | 'shrunk' | 'same' };

/**
 * Whether a rewrite may be applied: not cut by the length limit, not shorter than half of the text unless the agent
 * listed what it removed, and not the same text.
 */
export function checkRewrite(
    before: string,
    after: string,
    changes: readonly string[],
    truncated: boolean,
): RewriteCheck {
    if (truncated) return { ok: false, reason: 'length' };
    const a = before.trim();
    const b = after.trim();
    if (a === b) return { ok: false, reason: 'same' };
    if (b.length < a.length * 0.5 && changes.length === 0) return { ok: false, reason: 'shrunk' };
    return { ok: true };
}
