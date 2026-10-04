// Building blocks of the sheet scenario prompt (M31 п. 1-2): the sheet target from the command message,
// WI decorators, a cleaned chat excerpt, character matching across the card, CK archives and DES, and the final
// message list. Pure: the feature gathers the inputs from SillyTavern and the adapters.
import { archiveTags, entryKeys, isBunnyMoCoreEntry, isCharacterArchive } from './bunnymo';
import type { BunnyMoEntryLike } from './bunnymo';
import type { PromptMessage } from './scenario-params';
import { SHEET_COMMANDS } from './sheets';
import type { SheetCommand } from './sheets';
import { cleanForAnalysis, isImagePost } from './text-clean';

const COMMAND_TARGET_RE = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])!(${SHEET_COMMANDS.join('|')})(?![\\p{L}\\p{N}])([^\\n]*)`,
    'iu',
);
/** Leading words that introduce the name ("!fullsheet for Vera", "!fullsheet на Веру"). */
const TARGET_LEAD_RE = /^(?:for|on|about|of|на|для|про|о|об)\s+/iu;
const WRAP_CHARS = `"'«»“”„()[]{}<>*_\``;
const MAX_TARGET_LENGTH = 60;

/**
 * The character a sheet command asks for: the text after the command up to the end of the line or a sentence
 * mark, without quotes and lead words. Null when the command has no argument.
 */
export function parseSheetTarget(text: string | null | undefined, command?: SheetCommand): string | null {
    const match = COMMAND_TARGET_RE.exec(String(text ?? ''));
    if (!match) return null;
    if (command && match[1]?.toLowerCase() !== command) return null;
    let target = (match[2] ?? '').split(/[,.!?;:\n]/)[0] ?? '';
    target = target.trim().replace(TARGET_LEAD_RE, '');
    let start = 0;
    let end = target.length;
    while (start < end && WRAP_CHARS.includes(target[start]!)) start++;
    while (end > start && WRAP_CHARS.includes(target[end - 1]!)) end--;
    target = target.slice(start, end).trim().replace(/\s+/g, ' ');
    if (!target || target.length > MAX_TARGET_LENGTH) return null;
    return target;
}

/**
 * Entry content without World Info decorators (`@@activate`, `@@dont_activate`, …): ST strips the leading `@@`
 * lines before sending (world-info.js parseDecorators); `@@@` escapes a literal `@@` line.
 */
export function stripDecorators(content: string | null | undefined): string {
    const text = String(content ?? '');
    if (!text.startsWith('@@')) return text;
    const lines = text.split('\n');
    let index = 0;
    while (index < lines.length && lines[index]!.startsWith('@@')) index++;
    return lines.slice(index).join('\n');
}

/** Lower case, ё → е, `_` and punctuation → spaces, words split. */
export function nameWords(name: string | null | undefined): string[] {
    return String(name ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter(Boolean);
}

function commonPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

/** Same word, allowing a short inflected ending ("Вера" / "Веру" / "Веры", "Мартин" / "Мартина"). */
function sameWord(a: string, b: string): boolean {
    if (a === b) return true;
    const longest = Math.max(a.length, b.length);
    const shortest = Math.min(a.length, b.length);
    if (shortest < 3 || longest - shortest > 2) return false;
    return commonPrefix(a, b) >= Math.max(3, longest - 2);
}

/** True when both names point to one character: every word of the shorter name is in the longer one. */
export function sameCharacter(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = nameWords(a);
    const right = nameWords(b);
    if (!left.length || !right.length) return false;
    const [short, long] = left.length <= right.length ? [left, right] : [right, left];
    return short.every((word) => long.some((other) => sameWord(word, other)));
}

/** The sheet command an entry answers (BunnyMo core #2-#7), by its keys. */
export function sheetCommandOfEntry(entry: BunnyMoEntryLike | null | undefined): SheetCommand | null {
    if (!entry || !isBunnyMoCoreEntry(entry)) return null;
    for (const key of entryKeys(entry)) {
        const command = key.toLowerCase().replace(/^!/, '');
        if (key.trim().startsWith('!') && (SHEET_COMMANDS as readonly string[]).includes(command)) {
            return command as SheetCommand;
        }
    }
    return null;
}

const ARCHIVE_COMMENT_RE = /^(.+?)\s+Character Archive\b/i;

/** Character name of an archive entry: `<Name:…>`, else Baby Bunny's comment "<Name> Character Archive …". */
export function archiveName(entry: BunnyMoEntryLike | null | undefined): string | null {
    const name = archiveTags(entry).name;
    if (name) return name.replace(/_/g, ' ').trim();
    const comment = typeof entry?.comment === 'string' ? entry.comment : '';
    return ARCHIVE_COMMENT_RE.exec(comment)?.[1]?.trim() || null;
}

/** A character archive (CK repo / BunnyMo example) of this character: by its name or by its keys. */
export function isArchiveOf(entry: BunnyMoEntryLike | null | undefined, target: string): boolean {
    if (!entry || !isCharacterArchive(entry)) return false;
    if (sameCharacter(archiveName(entry), target)) return true;
    return entryKeys(entry).some((key) => !key.startsWith('/') && sameCharacter(key, target));
}

/* ------------------------------------------------------------------ chat excerpt */

const FENCED_JSON_RE = /```[ \t]*json[^\n]*\n[\s\S]*?```/gi;
const DETAILS_RE = /<details\b[\s\S]*?<\/details>/gi;
const TAG_BLOCK_RE = /<bunnymotags>[\s\S]*?<\/bunnymotags>/gi;

/**
 * Message text for an excerpt: text-clean's story text (no DES tracker, CK dumps, NAI images, HTML; picture posts
 * give '') and, on top of it, no JSON blocks anywhere, no folded `<details>` (thoughts, trackers) and no
 * `<BunnymoTags>` blocks. BunnyMo `<KEY:VALUE>` tags typed in the chat stay.
 */
export function cleanExcerptText(message: unknown): string {
    if (typeof message !== 'string' && isImagePost(message)) return '';
    const raw =
        typeof message === 'string'
            ? message
            : message && typeof message === 'object' && typeof (message as { mes?: unknown }).mes === 'string'
              ? (message as { mes: string }).mes
              : '';
    const text = raw.replace(FENCED_JSON_RE, '\n').replace(DETAILS_RE, '\n').replace(TAG_BLOCK_RE, '\n');
    return cleanForAnalysis(text)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface ExcerptLine {
    name: string;
    text: string;
}

/** "Name: text" lines, oldest first, each message capped. */
export function formatExcerpt(lines: readonly ExcerptLine[], maxPerMessage = 1500): string {
    return lines
        .map(({ name, text }) => {
            const body = text.length > maxPerMessage ? `${text.slice(0, maxPerMessage).trimEnd()}…` : text;
            return name ? `${name}: ${body}` : body;
        })
        .join('\n\n');
}

/* ------------------------------------------------------------------ character data and messages */

export interface SheetCharacterData {
    target: string;
    /** Card fields of the target (description, personality), already with macros substituted. */
    card?: { description?: string; personality?: string; scenario?: string } | null;
    /** Persona description when the sheet is for the user's persona. */
    persona?: string | null;
    /** Contents of the target's archive entries. */
    archives?: readonly string[];
    /** DES tracker facts of the target from the latest reply that has them. */
    tracker?: { details?: Record<string, string>; relationship?: string; thoughts?: string } | null;
}

const MAX_FIELD = 8000;

function field(label: string, value: string | null | undefined): string | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const capped = text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD).trimEnd()}…` : text;
    return `${label}:\n${capped}`;
}

/** The character data message (English labels: it is read by the model, not shown to the user). */
export function formatCharacterData(data: SheetCharacterData): string {
    const parts: string[] = [`[Character data for the sheet: ${data.target}]`];
    const add = (part: string | null) => {
        if (part) parts.push(part);
    };
    add(field('Character card — description', data.card?.description));
    add(field('Character card — personality', data.card?.personality));
    add(field('Character card — scenario', data.card?.scenario));
    add(field('Persona description', data.persona));
    for (const archive of data.archives ?? []) add(field('Existing archive entry (CarrotKernel)', archive));
    const tracker = data.tracker;
    if (tracker) {
        const lines = Object.entries(tracker.details ?? {})
            .filter(([, value]) => value.trim())
            .map(([key, value]) => `- ${key}: ${value.trim()}`);
        if (tracker.relationship) lines.push(`- relationship: ${tracker.relationship}`);
        if (tracker.thoughts) lines.push(`- current thoughts: ${tracker.thoughts}`);
        if (lines.length) parts.push(`Current scene tracker (DES):\n${lines.join('\n')}`);
    }
    if (parts.length === 1) parts.push('No stored data for this character: rely on the chat excerpt.');
    return parts.join('\n\n');
}

/** Maestro's own rules for the sheet generation, appended to the BunnyMo command instruction. */
export function sheetDirective(command: SheetCommand, target: string): string {
    return [
        `[Maestro — sheet mode: !${command}]`,
        `Output ONLY the !${command} sheet for ${target}, in the format above.`,
        'Do not continue the story or the scene: no narration, no dialogue, no actions after the sheet.',
        'Do not output tracker JSON, code blocks, image prompts or any commentary before or after the sheet.',
        'Write the descriptive text in the language of the roleplay (as in the chat excerpt); keep the tags in English,',
        'exactly as the format requires, with no parentheses inside tags. End the reply right after the sheet.',
    ].join('\n');
}

export interface SheetPromptInput {
    /** BunnyMo command entry text (decorators stripped, macros substituted). */
    instruction: string;
    directive: string;
    characterData: string;
    /** Formatted excerpt ('' when the chat has nothing usable). */
    excerpt: string;
    /** The user's command message as typed. */
    command: string;
}

/** The message list that replaces ST's prompt for a sheet generation. */
export function buildSheetMessages(input: SheetPromptInput): PromptMessage[] {
    const messages: PromptMessage[] = [
        { role: 'system', content: `${input.instruction.trim()}\n\n${input.directive}` },
        { role: 'system', content: input.characterData },
    ];
    if (input.excerpt.trim()) {
        messages.push({ role: 'user', content: `[Recent roleplay, oldest first]\n\n${input.excerpt}` });
    }
    messages.push({ role: 'user', content: input.command.trim() });
    return messages;
}
