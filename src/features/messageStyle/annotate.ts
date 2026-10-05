// Marks a rendered message for the message style rules (M32 «Стиль сообщений»): classes on ST's `<q>` ("…" → dq,
// «…» → gq), spans for dash dialogue, (…), […] and custom rules, spans around swappable quote marks. The same code
// serves the formatter hook (ST's HTML parsed into an inert <template>, then serialised back) and messages already on
// screen (their live DOM). It only splits text nodes and inserts spans — other elements, listeners and neighbours'
// decorations are left alone — and clearAnnotations() takes everything back out. What to mark is decided by the pure
// planner (src/domain/message-style-model.ts).
import type { ScopePlan } from '../../domain/message-style';
import { ANNOTATION_PREFIX } from '../../domain/message-style-css';
import { VisibleTextBuilder, mayAnnotate, planAnnotations } from '../../domain/message-style-model';
import type { VisibleText } from '../../domain/message-style-model';
import type { TextRange } from '../../domain/message-style-match';

const SANITIZED_PREFIX = `custom-${ANNOTATION_PREFIX}`;

function isOurClass(token: string): boolean {
    return token.startsWith(ANNOTATION_PREFIX) || token.startsWith(SANITIZED_PREFIX);
}

/** NAI Studio's inline image hosts and mounted pictures are never story text. */
function skipElement(element: Element): boolean {
    return (
        element.hasAttribute('data-naist-img') ||
        element.hasAttribute('data-naist-mounted') ||
        element.classList.contains('naist-inline')
    );
}

interface Walked {
    model: VisibleText;
    pieces: Text[];
    elements: Element[];
}

function walk(root: Node): Walked {
    const builder = new VisibleTextBuilder();
    const pieces: Text[] = [];
    const elements: Element[] = [];
    const visit = (node: Node): void => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 3) {
                pieces.push(child as Text);
                builder.text((child as Text).data, pieces.length - 1);
            } else if (child.nodeType === 1) {
                const element = child as Element;
                const id = builder.open(element.localName || element.nodeName, { skip: skipElement(element) });
                elements[id] = element;
                visit(element);
                builder.close(id);
            }
        }
    };
    visit(root);
    return { model: builder.build(), pieces, elements };
}

/** Text pieces split at the given offsets: start offset → the text node that begins there. */
class Segments {
    private readonly starts = new Map<number, number[]>();
    private readonly nodes = new Map<number, Map<number, Text>>();

    constructor(
        private readonly model: VisibleText,
        private readonly pieces: Text[],
    ) {}

    /** Requests node boundaries around the visible range. */
    cut(range: TextRange): void {
        const { piece, offset } = this.model;
        this.add(piece[range.start]!, offset[range.start]!);
        this.add(piece[range.end - 1]!, offset[range.end - 1]! + 1);
    }

    split(): void {
        for (const [index, offsets] of this.starts) {
            const node = this.pieces[index]!;
            const length = node.data.length;
            const unique = [...new Set(offsets)].filter((value) => value > 0 && value < length).sort((a, b) => a - b);
            const map = new Map<number, Text>([[0, node]]);
            // From the end: the original node keeps the head, each split returns the tail.
            for (let i = unique.length - 1; i >= 0; i--) map.set(unique[i]!, node.splitText(unique[i]!));
            this.nodes.set(index, map);
            this.starts.set(index, [0, ...unique]);
        }
    }

    /** First and last text node of a visible range (after split()). */
    bounds(range: TextRange): [Text, Text] | null {
        const first = this.nodeAt(range.start);
        const last = this.nodeAt(range.end - 1);
        return first && last ? [first, last] : null;
    }

    private nodeAt(index: number): Text | null {
        const piece = this.model.piece[index]!;
        const offset = this.model.offset[index]!;
        const starts = this.starts.get(piece);
        const map = this.nodes.get(piece);
        if (!starts || !map) return null;
        let start = 0;
        for (const value of starts) if (value <= offset) start = value;
        return map.get(start) ?? null;
    }

    private add(piece: number, offset: number): void {
        if (piece < 0) return;
        const list = this.starts.get(piece) ?? [];
        list.push(offset);
        this.starts.set(piece, list);
    }
}

/**
 * Wraps the sibling nodes from `first` to `last` in a span. Nodes that are the first/last child of a span made in
 * this pass are lifted to that span, so outer wraps go around inner ones.
 */
function wrap(first: Node, last: Node, cls: string, created: Set<Node>): boolean {
    let from = first;
    let to = last;
    while (from.parentNode && created.has(from.parentNode) && from.parentNode.firstChild === from)
        from = from.parentNode;
    while (to.parentNode && created.has(to.parentNode) && to.parentNode.lastChild === to) to = to.parentNode;
    const parent = from.parentNode;
    if (!parent || parent !== to.parentNode) return false;
    const doc = parent.ownerDocument ?? (parent as Document);
    const span = doc.createElement('span');
    span.className = `${ANNOTATION_PREFIX}${cls}`;
    parent.insertBefore(span, from);
    let node: Node | null = from;
    while (node) {
        const next: Node | null = node.nextSibling;
        span.appendChild(node);
        if (node === to) break;
        node = next;
    }
    created.add(span);
    return true;
}

/** Marks a message (a `.mes_text` or a parsed fragment) for the plan; returns how many marks were made. */
export function annotateNode(root: Node, plan: ScopePlan): number {
    const { model, pieces, elements } = walk(root);
    const annotations = planAnnotations(model, plan);
    if (!annotations.length) return 0;

    const segments = new Segments(model, pieces);
    const marks: TextRange[] = [];
    const spans: { range: TextRange; cls: string }[] = [];
    for (const item of annotations) {
        marks.push(...item.marks);
        if (item.type !== 'span') continue;
        if (item.whole) spans.push({ range: { start: item.start, end: item.end }, cls: item.cls });
        else for (const piece of item.pieces) spans.push({ range: piece, cls: item.cls });
    }
    for (const range of [...marks, ...spans.map((item) => item.range)]) segments.cut(range);
    segments.split();

    const created = new Set<Node>();
    let count = 0;
    // Inner wraps first (marks), then the spans around them.
    for (const range of marks) {
        const bounds = segments.bounds(range);
        if (bounds && wrap(bounds[0], bounds[1], 'mark', created)) count++;
    }
    for (const item of spans) {
        const bounds = segments.bounds(item.range);
        if (bounds && wrap(bounds[0], bounds[1], item.cls, created)) count++;
    }
    for (const item of annotations) {
        if (item.type !== 'quote') continue;
        const element = elements[item.element];
        if (!element) continue;
        element.classList.add(`${ANNOTATION_PREFIX}${item.cls}`);
        count++;
    }
    return count;
}

/** Takes Maestro's marks out of a message again (spans unwrapped, classes removed, text nodes merged). */
export function clearAnnotations(root: ParentNode): number {
    let count = 0;
    const parents = new Set<Node>();
    for (const span of Array.from(root.querySelectorAll('span'))) {
        if (!Array.from(span.classList).some(isOurClass)) continue;
        const parent = span.parentNode;
        if (!parent) continue;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parents.add(parent);
        count++;
    }
    for (const quote of Array.from(root.querySelectorAll('q'))) {
        const ours = Array.from(quote.classList).filter(isOurClass);
        if (!ours.length) continue;
        quote.classList.remove(...ours);
        if (!quote.classList.length) quote.removeAttribute('class');
        count++;
    }
    for (const parent of parents) parent.normalize();
    return count;
}

/** Whether a message holds any of Maestro's marks. */
export function hasAnnotations(root: ParentNode): boolean {
    return root.querySelector(`[class*="${ANNOTATION_PREFIX}"]`) !== null;
}

/**
 * The formatter hook's work: ST's HTML for one message, marked for the plan. The HTML is parsed into an inert
 * <template> (nothing loads or runs) and serialised back only when something was marked.
 */
export function annotateHtml(html: string, plan: ScopePlan, doc: Document): string {
    if (!mayAnnotate(html, plan)) return html;
    const template = doc.createElement('template');
    template.innerHTML = html;
    return annotateNode(template.content, plan) ? template.innerHTML : html;
}
