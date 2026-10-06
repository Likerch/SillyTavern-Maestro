// The Maestro strip under chat messages (plan-2 §5, §6.А): one thin line per message, built from every provider's items
// (Inbox proposals, living canon facts, memory-only lines of Ui.messageBadge: autonomy «Сообщать», M12 «Брак», M25
// rolls…). Collapsed it says what is there in story words («2 предложения · запомнил факт · бросок»; a single item shows
// its own text); a click lists the items with their buttons, an expandable body or a window to open. Display only:
// nothing here touches the message text, the prompt, Qvink memory or swipes.
//
// Where it sits: inside `.mes_block`, right after ST's own blocks (`.mes_bias`, else the last of `.mes_file_wrapper`,
// `.mes_media_wrapper`, `.mes_text`). DES chat bubbles rebuild only the innerHTML of `.mes_text` (DES
// src/systems/rendering/chatBubbles.js applyChatBubbles), so a sibling outside it is neither hidden nor duplicated by
// them; DES appends its own siblings (tracker JSON dropdown, scene header) to the end of `.mes_block`, after the strip.
// ST rebuilds message DOM on edits, swipes, chat changes and lazy loading: the named message is repainted after those
// events (and once more after ST's post-render work), and providers name the messages whose items changed. Repaints
// are batched in a microtask; a message without items costs one items() call per provider and no DOM work, and a strip
// whose items did not change is left alone (its open items stay open).
import { pluralForm } from '../../domain/plural';
import type {
    ChatNoticesLevel,
    Host,
    I18n,
    Logger,
    MessageBadgeSpec,
    MessageStripProvider,
    SettingsService,
    StripAction,
    StripItem,
    Unsubscribe,
} from '../../shared/contracts';
import { clear, el, icon } from '../components/dom';

export type StripKind = StripItem['kind'];

/** Summary order of the kinds (what waits for a decision first). */
export const STRIP_KINDS: readonly StripKind[] = ['proposal', 'question', 'fact', 'change', 'roll', 'info'];
/** Kinds that wait for the user's decision (CoreSettings.chatNotices 'pending'). */
export const PENDING_KINDS: ReadonlySet<StripKind> = new Set<StripKind>(['proposal', 'question']);
const KIND_ICON: Record<StripKind, string> = {
    proposal: 'fa-inbox',
    question: 'fa-circle-question',
    fact: 'fa-seedling',
    change: 'fa-arrow-right-arrow-left',
    roll: 'fa-dice-d20',
    info: 'fa-check',
};

/** ST events whose first argument is the re-rendered message (keys of eventTypes). */
const MESSAGE_EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_UPDATED',
    'MESSAGE_EDITED',
    'MESSAGE_SWIPED',
];
/** ST events after which any message may have been rebuilt or renumbered. */
const CHAT_EVENTS = ['MORE_MESSAGES_LOADED', 'CHAT_CHANGED', 'MESSAGE_DELETED'];
/** ST finishes its own post-render work (and neighbours their decorations) after the event: look once more. */
const SETTLE_MS = 50;
/** Id of the provider behind Ui.messageBadge. */
export const BADGE_PROVIDER = 'maestro.badges';
const BADGE_ORDER = 50;

export interface MessageStripDeps {
    host: Host;
    i18n: I18n;
    settings: SettingsService;
    log: Logger;
    /** Opens a window section (StripItem.open): Ui.openWindow when there are windows, else the pult tab. */
    open(target: NonNullable<StripItem['open']>): void;
    /** A failed button: logged and told to the user. */
    onError?(error: unknown): void;
}

interface Shown {
    key: string;
    item: StripItem;
}

/** A strip in the DOM: what it was built from (the buttons look up the current item at click time). */
interface Painted {
    node: HTMLElement;
    index: number;
    signature: string;
    items: Map<string, StripItem>;
    /** Disposers of rendered bodies, by item key. */
    bodies: Map<string, Unsubscribe | null>;
}

/** Open state of a message's strip, kept across rebuilds while the chat stays. */
interface OpenState {
    expanded: boolean;
    bodies: Set<string>;
}

interface BadgeEntry extends MessageBadgeSpec {
    index: number;
    /** The same index in another chat is another message. */
    chatId: string | null;
}

/** Items the user's choice lets through (none, only what waits for a decision, or all). */
export function filterStripItems<T extends { kind: StripKind }>(
    items: readonly T[],
    level: ChatNoticesLevel | undefined,
): T[] {
    if (level === 'none') return [];
    if (level === 'pending') return items.filter((item) => PENDING_KINDS.has(item.kind));
    return [...items];
}

/** The collapsed line: the single item's own text (and icon), else counts per kind in story words. */
export function stripSummary(
    i18n: I18n,
    items: readonly StripItem[],
): { kind: StripKind; text: string; icon?: string }[] {
    const [only] = items;
    if (items.length === 1 && only)
        return [{ kind: only.kind, text: only.text, ...(only.icon ? { icon: only.icon } : {}) }];
    const counts = new Map<StripKind, number>();
    for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    return STRIP_KINDS.filter((kind) => counts.has(kind)).map((kind) => {
        const count = counts.get(kind) ?? 0;
        const text =
            count === 1
                ? i18n.t(`ui.strip.single.${kind}`)
                : i18n.t(`ui.strip.count.${kind}.${pluralForm(count, i18n.locale())}`, { count });
        return { kind, text };
    });
}

function signatureOf(index: number, locale: string, shown: readonly Shown[]): string {
    return JSON.stringify([
        index,
        locale,
        shown.map(({ key, item }) => [
            key,
            item.kind,
            item.text,
            item.icon ?? '',
            item.tone ?? '',
            (item.actions ?? []).map((action) => [action.label, action.primary === true]),
            typeof item.body === 'function',
            item.open ? [item.open.window, item.open.tab ?? ''] : null,
        ]),
    ]);
}

/** A lone line with no buttons, body or window has nothing to expand: it stays a plain line. */
function plainLine(shown: readonly Shown[]): boolean {
    const [only] = shown;
    return shown.length === 1 && !!only && !only.item.actions?.length && !only.item.body && !only.item.open;
}

/** Index of a message node, or null. */
function messageIndexOf(node: Element): number | null {
    const value = Number(node.getAttribute('mesid'));
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function childWith(parent: Element, className: string): Element | null {
    for (const child of parent.children) if (child.classList.contains(className)) return child;
    return null;
}

/** Index from an event argument (ST passes numbers, sometimes numeric strings). */
function indexArg(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return undefined;
}

export class MessageStrip {
    private readonly providers = new Map<string, { provider: MessageStripProvider; off: Unsubscribe }>();
    private readonly painted = new Map<HTMLElement, Painted>();
    private readonly states = new Map<string, OpenState>();
    private readonly badges = new Map<string, BadgeEntry>();
    private readonly badgeListeners = new Set<(indexes?: number[]) => void>();
    private readonly unsubscribers: Unsubscribe[] = [];
    private readonly pending = new Set<number>();
    private readonly settleTimers = new Set<ReturnType<typeof setTimeout>>();
    private pendingAll = false;
    /** Messages whose strip must be rebuilt even if its items look the same (after a button ran). */
    private readonly forced = new Set<number>();
    private scheduled = false;
    private listening = false;
    private disposed = false;

    constructor(private readonly deps: MessageStripDeps) {
        this.addProvider({
            id: BADGE_PROVIDER,
            order: BADGE_ORDER,
            items: (index) => this.badgeItems(index),
            onChange: (listener) => {
                this.badgeListeners.add(listener);
                return () => this.badgeListeners.delete(listener);
            },
        });
    }

    /* ---------------------------------------------------------------- public */

    addProvider(provider: MessageStripProvider): Unsubscribe {
        if (this.disposed) return () => {};
        this.providers.get(provider.id)?.off();
        let off: Unsubscribe = () => {};
        try {
            off = provider.onChange((indexes) => this.schedule(indexes));
        } catch (error) {
            this.deps.log.warn(`strip provider "${provider.id}" cannot be observed`, error);
        }
        const entry = { provider, off };
        this.providers.set(provider.id, entry);
        // The built-in badge provider waits for its first line: no listeners and no work while nothing can show.
        if (provider.id !== BADGE_PROVIDER) {
            this.listen();
            this.schedule();
        }
        return () => {
            if (this.providers.get(provider.id) !== entry) return;
            entry.off();
            this.providers.delete(provider.id);
            this.schedule();
        };
    }

    /** Ui.messageBadge: a memory-only line (same id on the same message replaces it). */
    badge(index: number, spec: MessageBadgeSpec): Unsubscribe {
        if (this.disposed) return () => {};
        const key = `${index}:${spec.id}`;
        const entry: BadgeEntry = { ...spec, index, chatId: this.chatId() };
        this.badges.set(key, entry);
        this.listen();
        this.emitBadges([index]);
        return () => {
            if (this.badges.get(key) !== entry) return;
            this.badges.delete(key);
            this.emitBadges([index]);
        };
    }

    /** Repaints the given messages (none: every rendered message) in the next microtask. */
    schedule(indexes?: readonly number[]): void {
        if (this.disposed) return;
        if (!indexes) this.pendingAll = true;
        else for (const index of indexes) if (Number.isInteger(index) && index >= 0) this.pending.add(index);
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => this.flush());
    }

    /** Rebuilds every strip now (language change). */
    repaintAll(): void {
        for (const record of this.painted.values()) record.signature = '';
        this.schedule();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const timer of this.settleTimers) clearTimeout(timer);
        this.settleTimers.clear();
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        for (const { off } of this.providers.values()) off();
        this.providers.clear();
        for (const record of [...this.painted.values()]) this.remove(record);
        for (const node of document.querySelectorAll('.maestro-strip')) node.remove();
        this.badges.clear();
        this.badgeListeners.clear();
        this.states.clear();
    }

    /* ---------------------------------------------------------------- events */

    private listen(): void {
        if (this.listening) return;
        this.listening = true;
        for (const event of MESSAGE_EVENTS) {
            this.on(event, (...args: unknown[]) => {
                const index = indexArg(args[0]);
                this.scheduleSettled(index === undefined ? undefined : [index]);
            });
        }
        for (const event of CHAT_EVENTS) {
            this.on(event, () => {
                if (event === 'CHAT_CHANGED') this.states.clear();
                this.scheduleSettled();
            });
        }
        this.unsubscribers.push(
            this.deps.settings.onChange((path) => {
                if (path === 'core.chatNotices') this.schedule();
            }),
        );
    }

    private on(event: string, handler: (...args: unknown[]) => unknown): void {
        try {
            this.unsubscribers.push(this.deps.host.events.on(event, handler));
        } catch (error) {
            this.deps.log.debug(`strip: no event ${event}`, error);
        }
    }

    /** Now, and once more after ST's post-render work. */
    private scheduleSettled(indexes?: number[]): void {
        this.schedule(indexes);
        const timer = setTimeout(() => {
            this.settleTimers.delete(timer);
            this.schedule(indexes);
        }, SETTLE_MS);
        this.settleTimers.add(timer);
    }

    /* ---------------------------------------------------------------- painting */

    private flush(): void {
        this.scheduled = false;
        if (this.disposed) return;
        const all = this.pendingAll;
        const indexes = [...this.pending];
        this.pendingAll = false;
        this.pending.clear();
        this.sweep();
        if (all) {
            for (const message of document.querySelectorAll<HTMLElement>('#chat .mes[mesid]')) this.paint(message);
        } else {
            for (const index of indexes) {
                const message = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"]`);
                if (message) this.paint(message);
            }
        }
        this.forced.clear();
    }

    /** Forgets strips ST removed together with their messages. */
    private sweep(): void {
        for (const record of [...this.painted.values()]) if (!record.node.isConnected) this.remove(record);
    }

    private chatId(): string | null {
        try {
            return this.deps.host.chatId();
        } catch {
            return null;
        }
    }

    private stateOf(index: number): OpenState {
        const key = `${this.chatId() ?? ''}#${index}`;
        let state = this.states.get(key);
        if (!state) {
            state = { expanded: false, bodies: new Set() };
            this.states.set(key, state);
        }
        return state;
    }

    private collect(index: number): Shown[] {
        const level = this.deps.settings.core().chatNotices;
        if (level === 'none') return [];
        const providers = [...this.providers.values()]
            .map((entry) => entry.provider)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const shown: Shown[] = [];
        for (const provider of providers) {
            let items: StripItem[];
            try {
                items = provider.items(index) ?? [];
            } catch (error) {
                this.deps.log.debug(`strip provider "${provider.id}" failed`, error);
                continue;
            }
            for (const item of filterStripItems(items, level)) {
                if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
                shown.push({ key: `${provider.id}:${item.id}`, item });
            }
        }
        return shown;
    }

    private paint(message: HTMLElement): void {
        const index = messageIndexOf(message);
        if (index === null) return;
        const existing = [...message.querySelectorAll<HTMLElement>('.maestro-strip')];
        const shown = this.collect(index);
        if (!shown.length) {
            for (const node of existing) this.removeNode(node);
            return;
        }
        const [current, ...extra] = existing;
        for (const node of extra) this.removeNode(node);
        const signature = signatureOf(index, this.deps.i18n.locale(), shown);
        const record = current ? this.painted.get(current) : undefined;
        if (current && record && record.signature === signature && !this.forced.has(index)) {
            record.items = new Map(shown.map(({ key, item }) => [key, item]));
            this.place(message, current);
            return;
        }
        const next = this.build(index, shown, signature);
        if (current) {
            this.removeRecord(current);
            current.replaceWith(next.node);
        }
        this.place(message, next.node);
        this.painted.set(next.node, next);
        this.renderOpenBodies(next);
    }

    /** Puts the strip right after ST's own blocks of the message (see the header). */
    private place(message: HTMLElement, node: HTMLElement): void {
        const block = childWith(message, 'mes_block') ?? message.querySelector('.mes_block') ?? message;
        let anchor: Element | null = null;
        for (const name of ['mes_bias', 'mes_file_wrapper', 'mes_media_wrapper', 'mes_text']) {
            anchor = childWith(block, name);
            if (anchor) break;
        }
        if (anchor) {
            if (anchor.nextElementSibling !== node) anchor.after(node);
        } else if (node.parentElement !== block) {
            block.appendChild(node);
        }
    }

    private build(index: number, shown: readonly Shown[], signature: string): Painted {
        const { i18n } = this.deps;
        const state = this.stateOf(index);
        const record: Painted = {
            node: el('div'),
            index,
            signature,
            items: new Map(shown.map(({ key, item }) => [key, item])),
            bodies: new Map(),
        };
        for (const key of [...state.bodies]) if (!record.items.has(key)) state.bodies.delete(key);
        const summary = stripSummary(
            i18n,
            shown.map(({ item }) => item),
        );
        const summaryText = summary.map((part) => part.text).join(' · ');
        const plain = plainLine(shown);
        const line = el(
            plain ? 'div' : 'button',
            {
                class: ['maestro-strip-line', plain ? 'maestro-strip-plain' : null],
                title: summaryText,
                attrs: plain ? {} : { type: 'button', 'aria-expanded': String(state.expanded) },
            },
            [
                icon('fa-wand-magic-sparkles', 'maestro-strip-logo'),
                el(
                    'span',
                    { class: 'maestro-strip-summary' },
                    summary.map((part, at) =>
                        el('span', { class: ['maestro-strip-chip', `maestro-strip-kind-${part.kind}`] }, [
                            at > 0
                                ? el('span', {
                                      class: 'maestro-strip-dot',
                                      text: '·',
                                      attrs: { 'aria-hidden': 'true' },
                                  })
                                : null,
                            icon(part.icon ?? KIND_ICON[part.kind] ?? 'fa-circle', 'maestro-strip-chip-icon'),
                            el('span', { class: 'maestro-strip-chip-text', text: part.text }),
                        ]),
                    ),
                ),
                plain ? null : icon('fa-chevron-down', 'maestro-strip-caret'),
            ],
        );
        const list = el(
            'div',
            { class: 'maestro-strip-items', attrs: { hidden: plain || !state.expanded } },
            plain ? [] : shown.map(({ key, item }) => this.row(record, key, item, state)),
        );
        const node = el(
            'div',
            {
                class: ['maestro-strip', state.expanded ? 'maestro-strip-open' : null],
                data: { maestroStrip: index },
                attrs: { role: 'group', 'aria-label': i18n.t('ui.strip.label') },
            },
            [line, list],
        );
        // ST and neighbours listen to clicks on messages (selection, swipes on phones): the strip keeps its own.
        node.addEventListener('click', (event) => event.stopPropagation());
        if (!plain)
            line.addEventListener('click', () => {
                state.expanded = !state.expanded;
                node.classList.toggle('maestro-strip-open', state.expanded);
                line.setAttribute('aria-expanded', String(state.expanded));
                list.hidden = !state.expanded;
                if (state.expanded) this.renderOpenBodies(record);
            });
        record.node = node;
        return record;
    }

    private row(record: Painted, key: string, item: StripItem, state: OpenState): HTMLElement {
        const { i18n } = this.deps;
        const actions = (item.actions ?? []).map((action, at) => {
            const node = el('button', {
                class: ['maestro-strip-action', action.primary ? 'maestro-strip-primary' : null],
                text: action.label,
                attrs: { type: 'button' },
            });
            node.addEventListener('click', () => void this.runAction(record, key, at, node));
            return node;
        });
        const bodyBox = item.body
            ? el('div', { class: 'maestro-strip-body', attrs: { hidden: !state.bodies.has(key) } })
            : null;
        let toggle: HTMLButtonElement | null = null;
        if (bodyBox) {
            const open = state.bodies.has(key);
            const button = el(
                'button',
                {
                    class: 'maestro-strip-toggle',
                    title: i18n.t('ui.strip.more'),
                    attrs: { type: 'button', 'aria-expanded': String(open), 'aria-label': i18n.t('ui.strip.more') },
                },
                [icon('fa-chevron-down')],
            );
            button.addEventListener('click', () => {
                const opened = !state.bodies.has(key);
                if (opened) state.bodies.add(key);
                else state.bodies.delete(key);
                button.setAttribute('aria-expanded', String(opened));
                bodyBox.hidden = !opened;
                if (opened) this.renderBody(record, key, bodyBox);
                else this.disposeBody(record, key, bodyBox);
            });
            toggle = button;
        }
        let opener: HTMLButtonElement | null = null;
        if (item.open) {
            opener = el(
                'button',
                {
                    class: 'maestro-strip-action maestro-strip-open-window',
                    title: i18n.t('ui.strip.open'),
                    attrs: { type: 'button', 'aria-label': i18n.t('ui.strip.open') },
                },
                [icon('fa-up-right-from-square')],
            );
            opener.addEventListener('click', () => {
                const target = record.items.get(key)?.open;
                if (!target) return;
                try {
                    this.deps.open(target);
                } catch (error) {
                    this.fail(error);
                }
            });
        }
        return el(
            'div',
            {
                class: [
                    'maestro-strip-item',
                    `maestro-strip-kind-${item.kind}`,
                    item.tone && item.tone !== 'normal' ? `maestro-strip-tone-${item.tone}` : null,
                ],
                data: { maestroItem: key },
            },
            [
                el('div', { class: 'maestro-strip-item-row' }, [
                    icon(item.icon ?? KIND_ICON[item.kind] ?? 'fa-circle', 'maestro-strip-item-icon'),
                    el('span', { class: 'maestro-strip-item-text', text: item.text }),
                    actions.length || toggle || opener
                        ? el('span', { class: 'maestro-strip-actions' }, [...actions, opener, toggle])
                        : null,
                ]),
                bodyBox,
            ],
        );
    }

    private async runAction(record: Painted, key: string, at: number, node: HTMLButtonElement): Promise<void> {
        const item = record.items.get(key);
        const action: StripAction | undefined = item?.actions?.[at];
        if (!item || !action || node.disabled) return;
        node.disabled = true;
        try {
            await action.run();
        } catch (error) {
            this.fail(error);
        } finally {
            node.disabled = false;
        }
        // What the button changed may show in the body (an editor, a new value): open it and rebuild the strip.
        if (item.body) {
            const state = this.stateOf(record.index);
            state.expanded = true;
            state.bodies.add(key);
        }
        this.forced.add(record.index);
        this.schedule([record.index]);
    }

    private renderOpenBodies(record: Painted): void {
        const state = this.stateOf(record.index);
        if (!state.expanded) return;
        for (const key of state.bodies) {
            const box = [...record.node.querySelectorAll<HTMLElement>('.maestro-strip-item')]
                .find((node) => node.dataset.maestroItem === key)
                ?.querySelector<HTMLElement>('.maestro-strip-body');
            if (box && !record.bodies.has(key)) this.renderBody(record, key, box);
        }
    }

    private renderBody(record: Painted, key: string, box: HTMLElement): void {
        this.disposeBody(record, key, box);
        const item = record.items.get(key);
        if (!item?.body) return;
        try {
            const off = item.body(box);
            record.bodies.set(key, typeof off === 'function' ? off : null);
        } catch (error) {
            this.deps.log.error(`strip body "${key}" failed`, error);
            clear(box);
            box.appendChild(el('div', { class: 'maestro-muted', text: this.deps.i18n.t('ui.pult.renderFailed') }));
            record.bodies.set(key, null);
        }
    }

    private disposeBody(record: Painted, key: string, box?: HTMLElement): void {
        if (record.bodies.has(key)) {
            const off = record.bodies.get(key);
            record.bodies.delete(key);
            try {
                off?.();
            } catch (error) {
                this.deps.log.debug('strip body cleanup failed', error);
            }
        }
        if (box) clear(box);
    }

    private removeRecord(node: HTMLElement): void {
        const record = this.painted.get(node);
        if (!record) return;
        this.painted.delete(node);
        for (const key of [...record.bodies.keys()]) this.disposeBody(record, key);
    }

    private remove(record: Painted): void {
        this.removeRecord(record.node);
        record.node.remove();
    }

    private removeNode(node: HTMLElement): void {
        this.removeRecord(node);
        node.remove();
    }

    private fail(error: unknown): void {
        this.deps.log.error('strip action failed', error);
        try {
            this.deps.onError?.(error);
        } catch {
            // the error handler itself failed: logged above
        }
    }

    /* ---------------------------------------------------------------- Ui.messageBadge */

    private emitBadges(indexes: number[]): void {
        for (const listener of [...this.badgeListeners]) listener(indexes);
    }

    private badgeItems(index: number): StripItem[] {
        const chatId = this.chatId();
        const items: StripItem[] = [];
        for (const entry of this.badges.values()) {
            if (entry.index !== index || entry.chatId !== chatId) continue;
            const actions: StripAction[] = [
                ...(entry.action ? [{ label: entry.action.label, run: entry.action.run, primary: true }] : []),
                ...(entry.actions ?? []),
            ];
            const item: StripItem = {
                id: entry.id,
                kind: entry.kind ?? (actions.length ? 'proposal' : 'info'),
                text: entry.text,
            };
            if (actions.length) item.actions = actions;
            if (entry.icon) item.icon = entry.icon;
            if (entry.tone) item.tone = entry.tone;
            items.push(item);
        }
        return items;
    }
}
