// Clean last-message previews in chat lists (M32, part «st»; display only, nothing is saved). ST shows the raw last
// message there: in DES together mode every reply starts with the tracker JSON block, so the start page and «Manage
// chat files» read «```json { "quests": …»; HTML of DES-RU and regexes shows as text (`<font color=…>`). While the
// layer and the part are on, the TEXT of those preview nodes is replaced with a cleaned version (src/domain/
// text-clean.ts cleanPreviewText); the original stays in a data attribute and comes back when the part or the layer
// goes off. A MutationObserver re-applies when ST re-renders a list; message bodies (streaming) are skipped at once.
import { cleanPreviewText } from '../../domain/text-clean';

export interface PreviewTarget {
    selector: string;
    /** The node's `title` holds the same raw text (a tooltip): cleaned too, line breaks kept. */
    title?: boolean;
}

/** Where ST (and the Top Info Bar extension) print a last-message preview. */
export const PREVIEW_TARGETS: readonly PreviewTarget[] = Object.freeze([
    // Start page «Недавние чаты» (public/scripts/templates/welcomePanel.html): `{{mes}}` as text and as title.
    { selector: '.welcomeRecent .recentChat .chatMessage', title: true },
    // «Manage chat files» (script.js displayChats): `.text(chat.preview_message)`, '...' + the last 400 characters.
    { selector: '#select_chat_div .select_chat_block_mes' },
    // Top Info Bar's chat side bar (Extension-TopInfoBar populateSideBar): `textContent = chat.mes`.
    { selector: '#extensionSideBar .sideBarItem .chatMessage' },
]);

/** The original text of a cleaned preview. */
export const PREVIEW_TEXT_ATTR = 'data-maestro-preview-text';
/** The original title of a cleaned preview. */
export const PREVIEW_TITLE_ATTR = 'data-maestro-preview-title';

const SELECTOR = PREVIEW_TARGETS.map((target) => target.selector).join(', ');
/** The preview nodes' own classes: subtrees are searched by these, then checked against the full selectors. */
const LEAVES = [...new Set(PREVIEW_TARGETS.map((target) => target.selector.split(/\s+/).pop()!))].join(', ');
/** Mutations inside chat messages (streaming, swipes, edits) never touch a preview. */
const SKIP = '.mes';
const ELEMENT_NODE = 1;

interface Shown {
    /** What Maestro wrote: anything else in the node means ST re-rendered it. */
    text?: string;
    title?: string;
}

export interface PreviewCleanerDeps {
    doc?: Document;
    /** The cleaner (tests). */
    clean?: (text: string, options?: { keepLines?: boolean }) => string;
    onError?(error: unknown): void;
}

const isElement = (node: Node | null | undefined): node is Element => node?.nodeType === ELEMENT_NODE;
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Preview nodes in a subtree (its ancestors count for the match, as they do in the page). */
function previewsIn(root: ParentNode): Element[] {
    return [...root.querySelectorAll(LEAVES)].filter((node) => node.matches(SELECTOR));
}

export class PreviewCleaner {
    private readonly doc: Document;
    private readonly clean: (text: string, options?: { keepLines?: boolean }) => string;
    private readonly shown = new WeakMap<Element, Shown>();
    private observer: MutationObserver | null = null;
    private running = false;

    constructor(private readonly deps: PreviewCleanerDeps = {}) {
        this.doc = deps.doc ?? document;
        this.clean = deps.clean ?? cleanPreviewText;
    }

    isRunning(): boolean {
        return this.running;
    }

    /** Cleans every preview on the page and keeps cleaning re-rendered ones (idempotent). */
    start(): void {
        if (this.running) return;
        this.running = true;
        const Observer = this.doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        const root = this.doc.body ?? this.doc.documentElement;
        if (Observer && root) {
            this.observer = new Observer((records) => this.guard(() => this.onMutations(records)));
            this.observer.observe(root, { childList: true, subtree: true });
        }
        this.guard(() => this.applyAll());
    }

    /** Stops watching and puts the original texts back (idempotent). */
    stop(): void {
        this.observer?.disconnect();
        this.observer = null;
        if (!this.running) return;
        this.running = false;
        this.guard(() => this.restoreAll());
    }

    /** Sets the state in one call (the layer's sync). */
    sync(on: boolean): void {
        if (on) this.start();
        else this.stop();
    }

    /** Cleans every preview under `root` now. */
    applyAll(root: ParentNode = this.doc): void {
        for (const node of previewsIn(root)) this.apply(node);
    }

    private guard(run: () => void): void {
        try {
            run();
        } catch (error) {
            this.deps.onError?.(error);
        }
    }

    private onMutations(records: readonly MutationRecord[]): void {
        const found = new Set<Element>();
        for (const record of records) {
            if (record.type !== 'childList' || !record.addedNodes.length) continue;
            const target = record.target;
            if (isElement(target)) {
                if (target.closest(SKIP)) continue;
                // ST/jQuery rewrote a preview's text (`.text(…)` replaces its child nodes).
                if (target.matches(SELECTOR)) {
                    found.add(target);
                    continue;
                }
            }
            for (const node of record.addedNodes) {
                if (!isElement(node)) continue;
                if (node.matches(SELECTOR)) found.add(node);
                else if (node.firstElementChild) for (const inner of previewsIn(node)) found.add(inner);
            }
        }
        for (const node of found) if (node.isConnected) this.apply(node);
    }

    private apply(node: Element): void {
        const target = PREVIEW_TARGETS.find((item) => node.matches(item.selector));
        if (!target) return;
        const shown = this.shown.get(node) ?? {};
        const text = node.textContent ?? '';
        if (shown.text === undefined || text !== shown.text) {
            const cleaned = this.clean(text);
            if (cleaned === collapse(text)) {
                // Nothing to clean (or ST put a clean text back): the node is left as ST made it.
                node.removeAttribute(PREVIEW_TEXT_ATTR);
                delete shown.text;
            } else {
                node.setAttribute(PREVIEW_TEXT_ATTR, text);
                shown.text = cleaned;
                node.textContent = cleaned;
            }
        }
        const title = target.title ? node.getAttribute('title') : null;
        if (title !== null && title !== shown.title) {
            const cleaned = this.clean(title, { keepLines: true });
            if (collapse(cleaned) === collapse(title)) {
                node.removeAttribute(PREVIEW_TITLE_ATTR);
                delete shown.title;
            } else {
                node.setAttribute(PREVIEW_TITLE_ATTR, title);
                shown.title = cleaned;
                node.setAttribute('title', cleaned);
            }
        }
        if (shown.text === undefined && shown.title === undefined) this.shown.delete(node);
        else this.shown.set(node, shown);
    }

    private restoreAll(): void {
        for (const node of this.doc.querySelectorAll(`[${PREVIEW_TEXT_ATTR}], [${PREVIEW_TITLE_ATTR}]`)) {
            const shown = this.shown.get(node);
            const text = node.getAttribute(PREVIEW_TEXT_ATTR);
            // A text ST wrote after the cleaning is ST's own: it stays.
            if (text !== null && (shown?.text === undefined || node.textContent === shown.text)) {
                node.textContent = text;
            }
            const title = node.getAttribute(PREVIEW_TITLE_ATTR);
            if (title !== null && (shown?.title === undefined || node.getAttribute('title') === shown.title)) {
                node.setAttribute('title', title);
            }
            node.removeAttribute(PREVIEW_TEXT_ATTR);
            node.removeAttribute(PREVIEW_TITLE_ATTR);
            this.shown.delete(node);
        }
    }
}
