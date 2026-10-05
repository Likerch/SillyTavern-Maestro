// Light Markdown of the assistant's answers (M33): paragraphs, lists, `code`, fenced code blocks, **bold** and
// *italic*; headings become bold lines. Everything else stays literal text — the view renders the blocks with text
// nodes only, so nothing a model writes can become markup. Pure.

export type Inline =
    | { kind: 'text'; text: string }
    | { kind: 'code'; text: string }
    | { kind: 'bold'; text: string }
    | { kind: 'italic'; text: string };

export type Block =
    /** Lines of one paragraph (rendered with line breaks between them). */
    | { kind: 'paragraph'; lines: Inline[][] }
    | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
    | { kind: 'code'; lang: string; text: string };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Emphasis: **bold**, __bold__, *italic*, and _italic_ only at word edges (so snake_case names like `get_settings`
 * written without backticks stay intact).
 */
const EMPHASIS =
    /\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;

function pushText(out: Inline[], text: string): void {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else out.push({ kind: 'text', text });
}

function emphasis(text: string, out: Inline[]): void {
    let at = 0;
    for (const match of text.matchAll(EMPHASIS)) {
        const index = match.index ?? 0;
        pushText(out, text.slice(at, index));
        const bold = match[1] ?? match[2];
        const italic = match[3] ?? match[4];
        if (bold !== undefined) out.push({ kind: 'bold', text: bold });
        else out.push({ kind: 'italic', text: italic ?? '' });
        at = index + match[0].length;
    }
    pushText(out, text.slice(at));
}

/** Inline spans of one line: code spans first (their content is literal), emphasis in the rest. */
export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let at = 0;
    while (at < text.length) {
        const open = text.indexOf('`', at);
        if (open < 0) break;
        let ticks = 1;
        while (text[open + ticks] === '`') ticks++;
        const fence = '`'.repeat(ticks);
        const close = text.indexOf(fence, open + ticks);
        if (close < 0) break;
        emphasis(text.slice(at, open), out);
        const code = text.slice(open + ticks, close);
        out.push({ kind: 'code', text: ticks > 1 ? code.trim() : code });
        at = close + ticks;
    }
    emphasis(text.slice(at), out);
    return out;
}

type ListBlock = Extract<Block, { kind: 'list' }>;

/** Blocks of an answer (see the file comment). */
export function parseMarkdown(source: string): Block[] {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks: Block[] = [];
    const open: { paragraph: Inline[][] | null; list: ListBlock | null } = { paragraph: null, list: null };

    const flush = () => {
        if (open.paragraph?.length) blocks.push({ kind: 'paragraph', lines: open.paragraph });
        if (open.list?.items.length) blocks.push(open.list);
        open.paragraph = null;
        open.list = null;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const fence = FENCE.exec(line);
        if (fence) {
            flush();
            const marker = fence[1] ?? '```';
            const body: string[] = [];
            index++;
            while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
                body.push(lines[index] ?? '');
                index++;
            }
            blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
            continue;
        }
        if (!line.trim() || RULE.test(line)) {
            flush();
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            flush();
            blocks.push({ kind: 'paragraph', lines: [[{ kind: 'bold', text: heading[1] ?? '' }]] });
            continue;
        }
        const bullet = BULLET.exec(line);
        const ordered = bullet ? null : ORDERED.exec(line);
        if (bullet || ordered) {
            const isOrdered = ordered !== null;
            let list = open.list;
            if (!list || list.ordered !== isOrdered) {
                flush();
                list = { kind: 'list', ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] };
                open.list = list;
            }
            list.items.push(parseInline((bullet ? bullet[1] : ordered?.[2]) ?? ''));
            continue;
        }
        const last = open.list?.items[open.list.items.length - 1];
        if (last && /^\s+\S/.test(line)) {
            // An indented line continues the last item.
            pushText(last, ' ');
            for (const part of parseInline(line.trim())) {
                if (part.kind === 'text') pushText(last, part.text);
                else last.push(part);
            }
            continue;
        }
        if (open.list) flush();
        open.paragraph ??= [];
        open.paragraph.push(parseInline(line.trim()));
    }
    flush();
    return blocks;
}
