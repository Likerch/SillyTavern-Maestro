// Service junk in a reply (M12 check 6): leaked chat-template tokens, program code, document-level HTML, tool-call
// blocks and prompt echoes. Found with offsets in the raw stored text, so the clean fix removes exactly the junk
// and keeps every other byte (DES tracker JSON, NAI markers, `<details>`, `<font>`, BunnyMo tags, custom tags of
// other extensions and reasoning blocks that presets hide with regexes are NOT junk).
// Pure: no DOM, no SillyTavern.
import { fenceBlocks, isTrackerBody } from './quality-text';

export type JunkRule = 'token' | 'code' | 'html' | 'tool' | 'echo' | 'fence-text';

export interface JunkHit {
    start: number;
    end: number;
    rule: JunkRule;
    confidence: number;
    /** Safe to delete automatically (the clean fix); otherwise only reported. */
    removable: boolean;
    text: string;
}

interface SpanRule {
    rule: JunkRule;
    re: RegExp;
    confidence: number;
}

// prettier-ignore
const SPAN_RULES: readonly SpanRule[] = [
    // DeepSeek fullwidth-bar tokens: <｜begin▁of▁sentence｜>, <｜end▁of▁sentence｜>, <｜User｜>, <｜Assistant｜>, …
    { rule: 'token', confidence: 0.95, re: /<｜[^｜\n]{1,64}｜>/g },
    // Llama 3 header with its role, ChatML start with its role, then any other <|name|> token.
    { rule: 'token', confidence: 0.95, re: /<\|start_header_id\|>[^<\n]{0,20}<\|end_header_id\|>(?:\r?\n){0,2}/g },
    { rule: 'token', confidence: 0.95, re: /<\|im_start\|>(?:system|user|assistant)?[ \t]*(?:\r?\n)?/g },
    { rule: 'token', confidence: 0.95, re: /<\|[A-Za-z][A-Za-z0-9_]{0,40}\|>/g },
    // Gemma and Llama 2 / Mistral templates.
    { rule: 'token', confidence: 0.9, re: /<start_of_turn>(?:user|model)?[ \t]*(?:\r?\n)?|<(?:end_of_turn|bos|eos|pad|unk|eot)>/g },
    { rule: 'token', confidence: 0.9, re: /\[\/?INST\]|<<\/?SYS>>/g },
    // Document-level HTML a story never needs (removed with content where the content is code or metadata).
    { rule: 'html', confidence: 0.85, re: /<(script|iframe|noscript|object|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi },
    { rule: 'html', confidence: 0.85, re: /<!DOCTYPE[^>]*>|<\/?(?:html|body)\b[^>]*>|<(?:meta|link|base|embed)\b[^>]*>/gi },
    // Function-calling leaks.
    { rule: 'tool', confidence: 0.85, re: /<(tool_calls?|function_calls?|function_results?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi },
    // Prompt echoes: system notes, instruct headers, ST separators, prompt-structure tags (Marinara's among them).
    { rule: 'echo', confidence: 0.85, re: /\[\s*system\s+note\s*:[^\]\n]*\]?/gi },
    { rule: 'echo', confidence: 0.8, re: /^[ \t]*#{2,4}[ \t]*(?:instructions?|response|input|system(?:\s+prompt)?|user|assistant|human)[ \t]*:?[ \t]*\r?$/gim },
    { rule: 'echo', confidence: 0.8, re: /^[ \t]*\[(?:start\s+a\s+new\s+chat|example\s+chat|chat\s+history|end\s+of\s+(?:chat\s+)?history|continue(?:\s+the\s+(?:story|roleplay|chat|scene))?|write\s+(?:the\s+|your\s+)?next\s+reply)[^\]\n]{0,80}\][ \t]*\r?$/gim },
    { rule: 'echo', confidence: 0.8, re: /^[ \t]*<START>[ \t]*\r?$/gm },
    { rule: 'echo', confidence: 0.8, re: /<\/?(?:instructions?|task|output_format|past_events|system_note|system|guidelines|chat_history|user_input|response_format)\s*>/gi },
];

/** `<s>` opens a strikethrough; a bare `</s>` without one is the Llama 2 EOS token. */
const S_OPEN_RE = /<s(?:\s[^>]*)?>/i;
const S_CLOSE_RE = /<\/s>/g;
const S_LEADING_RE = /^\s*<s>/;

/** Info strings of fenced blocks that are program code. */
const CODE_LANGS: ReadonlySet<string> = new Set([
    'python',
    'py',
    'js',
    'javascript',
    'ts',
    'typescript',
    'java',
    'c',
    'cpp',
    'c++',
    'csharp',
    'cs',
    'go',
    'rust',
    'rs',
    'php',
    'ruby',
    'rb',
    'bash',
    'sh',
    'shell',
    'zsh',
    'powershell',
    'ps1',
    'sql',
    'html',
    'css',
    'xml',
    'kotlin',
    'swift',
    'lua',
    'perl',
    'r',
    'scala',
    'dart',
    'haskell',
    'asm',
    'jsx',
    'tsx',
    'vue',
    'latex',
    'tex',
]);

/** A line that reads as program code. */
const CODE_LINE_RE =
    /^\s*(?:(?:def|class|import|from|return|function|const|let|var|public|private|protected|static|void|package|using|namespace|fn|func|elif|except|try|catch|finally|print|println|echo|SELECT|INSERT|UPDATE|CREATE)\b|#include\b|#define\b|\/\/|\/\*|\}\s*$|console\.log)|[;{]\s*$|\)\s*:\s*$|\s(?:=>|===?|!==?|\+=|-=|&&|\|\|)\s|^\s*[A-Za-z_][\w.]*\s*=\s*[^=]|^\s*[A-Za-z_][\w.]*\([^)]*\)\s*;?\s*$/;

const CYRILLIC_WORD_RE = /\p{Script=Cyrillic}{3,}/gu;

/** Share of non-empty lines that read as code, and their count. */
export function codeLines(text: string): { code: number; total: number } {
    let code = 0;
    let total = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        total++;
        // Russian prose («Она сказала: …;») is never code, whatever its punctuation.
        const russianWords = line.match(CYRILLIC_WORD_RE)?.length ?? 0;
        if (russianWords < 2 && CODE_LINE_RE.test(line)) code++;
    }
    return { code, total };
}

/** Structured data (JSON, a list of `key: value` lines): another extension's tracker, not junk. */
function isDataBody(body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed) return true;
    // JSON (an unclosed object of a cut reply included).
    if (/^[{[]/.test(trimmed)) return true;
    const lines = trimmed.split('\n').filter((line) => line.trim());
    return lines.every((line) => /^\s*(?:[-*•]\s*)?["']?[\p{L}\p{N} _-]{1,40}["']?\s*:\s*\S?/u.test(line));
}

function isCodeBody(body: string): boolean {
    const { code, total } = codeLines(body);
    return code >= 2 && code / Math.max(1, total) >= 0.4;
}

function fenceHits(text: string): JunkHit[] {
    const hits: JunkHit[] = [];
    for (const block of fenceBlocks(text)) {
        if (isTrackerBody(block.body)) continue;
        const raw = text.slice(block.start, block.end);
        const code = CODE_LANGS.has(block.info);
        if (!code && isDataBody(block.body)) continue;
        if (code || isCodeBody(block.body)) {
            hits.push({
                start: block.start,
                end: block.end,
                rule: 'code',
                confidence: 0.9,
                removable: true,
                text: raw,
            });
        } else if (block.closed) {
            // Prose or a letter in a fence: odd, but it may be a preset's own block. Reported, never removed.
            hits.push({
                start: block.start,
                end: block.end,
                rule: 'fence-text',
                confidence: 0.5,
                removable: false,
                text: raw,
            });
        }
    }
    return hits;
}

/** Every junk piece of a reply, in text order. */
export function findJunk(text: string): JunkHit[] {
    const source = String(text ?? '');
    const hits: JunkHit[] = [];
    for (const { rule, re, confidence } of SPAN_RULES) {
        for (const match of source.matchAll(re)) {
            const start = match.index;
            hits.push({ start, end: start + match[0].length, rule, confidence, removable: true, text: match[0] });
        }
    }
    if (!S_OPEN_RE.test(source)) {
        for (const match of source.matchAll(S_CLOSE_RE)) {
            const start = match.index;
            hits.push({ start, end: start + 4, rule: 'token', confidence: 0.85, removable: true, text: match[0] });
        }
    } else if (S_LEADING_RE.test(source) && !source.includes('</s>')) {
        const start = source.indexOf('<s>');
        hits.push({ start, end: start + 3, rule: 'token', confidence: 0.85, removable: true, text: '<s>' });
    }
    hits.push(...fenceHits(source));
    return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

function lineStart(text: string, index: number): boolean {
    return index === 0 || text[index - 1] === '\n';
}

function lineBreakAt(text: string, index: number): number {
    if (text.startsWith('\r\n', index)) return 2;
    return text[index] === '\n' ? 1 : 0;
}

/**
 * The text without the spans. A span that fills whole lines takes its line break with it; a span at the very
 * start takes the whitespace after it. Every other byte stays.
 */
export function removeSpans(text: string, spans: readonly { start: number; end: number }[]): string {
    const merged: { start: number; end: number }[] = [];
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
        const last = merged[merged.length - 1];
        if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else merged.push({ start: span.start, end: span.end });
    }
    let out = '';
    let cursor = 0;
    for (const span of merged) {
        let start = Math.max(span.start, cursor);
        let end = Math.max(span.end, start);
        if (end <= cursor) continue;
        if (start === 0 && cursor === 0) {
            while (end < text.length && /\s/.test(text[end] ?? '')) end++;
        } else if (lineStart(text, start)) {
            const breakLength = lineBreakAt(text, end);
            if (breakLength) end += breakLength;
            else if (end === text.length && start > 0) {
                // The last line: drop the line break before it instead.
                start -= text[start - 2] === '\r' ? 2 : 1;
                start = Math.max(start, cursor);
            }
        }
        out += text.slice(cursor, start);
        cursor = end;
    }
    return out + text.slice(cursor);
}

/** The reply without its removable junk, and the hits. */
export function cleanJunk(text: string): { cleaned: string; hits: JunkHit[] } {
    const source = String(text ?? '');
    const hits = findJunk(source);
    const removable = hits.filter((hit) => hit.removable);
    return { cleaned: removable.length ? removeSpans(source, removable) : source, hits };
}
