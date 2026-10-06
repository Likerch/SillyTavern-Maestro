// The assistant's pult tab (M33, plan §7 «Ассистент»; plan-2 §1): the conversation (user and assistant bubbles with
// light Markdown, tool chips, write cards with before → after and «Применить» / «Отклонить»; a pack card lists its
// changes with a tick each and offers «Применить всё» / «Применить выбранные»; a card that can go to another scope has
// the switch «Где действует»), the input (Enter sends, Shift+Enter adds a line) with the chips of what is attached to
// the next message («Обсудить с ассистентом» in the Preset Studio; ✕ removes one), «Стоп» while the loop runs,
// «Очистить» with a confirmation and the cost line. Phones: the tab fills the pult, the input sticks to the bottom, big
// buttons. Every model or tool text goes in as text nodes.
import { tPlural } from '../../core/labels';
import { parseMarkdown } from '../../domain/assistant-markdown';
import type { Block, Inline } from '../../domain/assistant-markdown';
import type { App, PultTab, Unsubscribe } from '../../shared/contracts';
import { banner } from '../../ui/components/card';
import { field, numberInput, select } from '../../ui/components/controls';
import type { SelectOption } from '../../ui/components/controls';
import { diffView } from '../../ui/components/diff';
import { button, clear, el, icon } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { formatUsd } from '../../ui/views/format';
import { contextKey } from './api';
import type { AssistantApi, AssistantContextItem, AssistantMessage, ToolCallItem, ToolCallRecord } from './api';
import { ASSISTANT_KEY, ASSISTANT_LIMITS, ASSISTANT_TAB, ASSISTANT_TASK } from './settings';
import type { AssistantSettings } from './settings';

export { ASSISTANT_TAB };
export const ASSISTANT_TAB_ORDER = 95;
export const ASSISTANT_SECTION_ORDER = 40;
export const EXAMPLE_KEYS = ['m33.example.1', 'm33.example.2', 'm33.example.3', 'm33.example.4'] as const;
/** Longest result preview in a chip. */
const PREVIEW_CHARS = 1500;
/** Distance from the bottom (px) under which new messages keep the view scrolled down. */
const STICKY_BOTTOM_PX = 160;

/** The view uses the service's `awaiting()` when it has one (a card waiting for another tab has no buttons). */
export type AssistantViewApi = AssistantApi & { awaiting?(callId: string): boolean };

const STATUS_ICON: Record<ToolCallRecord['status'], string> = {
    running: 'fa-spinner',
    ok: 'fa-check',
    error: 'fa-triangle-exclamation',
    waiting: 'fa-hourglass-half',
    applied: 'fa-check-double',
    declined: 'fa-ban',
};

export const M33_CSS = `
.maestro-m33 { min-height: 100%; gap: var(--maestro-gap-sm); }
.maestro-m33-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m33-cost { flex: 1; min-width: 0; color: var(--maestro-muted); font-size: 0.85em; }
.maestro-m33-list { display: flex; flex: 1; flex-direction: column; gap: var(--maestro-gap); }
.maestro-m33-msg { display: flex; flex-direction: column; gap: 6px; max-width: min(100%, 780px); }
.maestro-m33-user { align-self: flex-end; align-items: flex-end; }
.maestro-m33-assistant { align-self: flex-start; width: 100%; }
.maestro-m33-bubble { padding: 8px 12px; border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius);
    background: var(--maestro-raised); overflow-wrap: anywhere; }
.maestro-m33-user .maestro-m33-bubble { background: var(--maestro-accent-soft); white-space: pre-wrap; }
.maestro-m33-md p, .maestro-m33-md ul, .maestro-m33-md ol, .maestro-m33-md pre { margin: 0 0 0.55em; }
.maestro-m33-md > :last-child { margin-bottom: 0; }
.maestro-m33-md ul, .maestro-m33-md ol { padding-inline-start: 1.4em; }
.maestro-m33-md code, .maestro-m33-chip-name { font-family: var(--monoFontFamily, monospace); font-size: 0.92em; }
.maestro-m33-md :not(pre) > code { padding: 0 3px; border-radius: 4px; background: var(--maestro-raised-strong); }
.maestro-m33-md pre, .maestro-m33-pre { padding: 8px; border-radius: var(--maestro-radius-sm);
    background: var(--maestro-raised-strong); overflow-x: auto; }
.maestro-m33-md pre { white-space: pre; }
.maestro-m33-pre { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: 0.85em; }
.maestro-m33-notice { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px; color: var(--maestro-muted);
    font-size: 0.9em; border-inline-start: 3px solid var(--maestro-warn); }
.maestro-m33-chip { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    background: var(--maestro-raised); font-size: 0.9em; }
.maestro-m33-chip > summary { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 8px;
    cursor: pointer; list-style: none; }
.maestro-m33-chip > summary::-webkit-details-marker { display: none; }
.maestro-m33-chip-name { opacity: 0.75; }
.maestro-m33-chip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m33-chip[open] .maestro-m33-chip-text { white-space: normal; }
.maestro-m33-chip-ok > summary > i { color: var(--maestro-ok); }
.maestro-m33-chip-error > summary > i { color: var(--maestro-error); }
.maestro-m33-chip-body { display: flex; flex-direction: column; gap: 4px; padding: 4px 8px 8px; }
.maestro-m33-label { color: var(--maestro-muted); font-size: 0.85em; }
.maestro-m33-card { display: flex; flex-direction: column; gap: var(--maestro-gap-sm);
    border-inline-start: 3px solid var(--maestro-accent); }
.maestro-m33-card-applied { border-inline-start-color: var(--maestro-ok); }
.maestro-m33-card-declined { border-inline-start-color: var(--maestro-muted); }
.maestro-m33-card-error { border-inline-start-color: var(--maestro-error); }
.maestro-m33-card-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.maestro-m33-card-state { margin-inline-start: auto; color: var(--maestro-muted); font-size: 0.85em; font-weight: normal; }
.maestro-m33-card-actions { display: flex; flex-wrap: wrap; gap: var(--maestro-gap-sm); }
.maestro-m33-card-scope { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 0.9em; }
.maestro-m33-card-scope select { width: auto; min-width: 12em; margin: 0; }
.maestro-m33-pack-badge { padding: 0 6px; border-radius: var(--maestro-radius-sm); background: var(--maestro-accent-soft);
    font-size: 0.8em; font-weight: normal; }
.maestro-m33-items { display: flex; flex-direction: column; gap: 6px; }
.maestro-m33-item { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm); }
.maestro-m33-item-off { opacity: 0.6; }
.maestro-m33-item-head { display: flex; align-items: center; gap: 6px; }
.maestro-m33-item-head input { margin: 0; }
.maestro-m33-item-summary { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.maestro-m33-item-state { color: var(--maestro-muted); font-size: 0.85em; }
.maestro-m33-item-error .maestro-m33-item-state { color: var(--maestro-error); }
.maestro-m33-item > details > summary { cursor: pointer; color: var(--maestro-muted); font-size: 0.85em; }
.maestro-m33-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m33-context { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 4px 2px 8px;
    border: 1px solid var(--maestro-border); border-radius: 999px; background: var(--maestro-accent-soft); font-size: 0.85em; }
.maestro-m33-context > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m33-context .maestro-btn { min-height: 0; padding: 0 4px; }
.maestro-m33-composer-main { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.maestro-m33-thinking { display: flex; align-items: center; gap: 6px; color: var(--maestro-muted); }
.maestro-m33-empty { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); padding: var(--maestro-gap) 0; }
.maestro-m33-empty-title { font-weight: 600; }
.maestro-m33-examples { display: flex; flex-wrap: wrap; gap: var(--maestro-gap-sm); }
.maestro-m33-example { white-space: normal; text-align: start; }
.maestro-m33-composer { position: sticky; bottom: 0; z-index: 1; display: flex; align-items: flex-end;
    gap: var(--maestro-gap-sm); padding-top: 8px; background: var(--maestro-surface); }
.maestro-m33-input { flex: 1; min-height: 44px; max-height: 40vh; margin: 0; resize: vertical; font: inherit; }
.maestro-m33-composer-actions { display: flex; flex-direction: column; gap: 4px; }
@media screen and (max-width: 1000px) {
    .maestro-m33 { min-height: calc(100dvh - 90px); }
    .maestro-m33-msg { max-width: 100%; }
    .maestro-m33-input { font-size: 16px; }
    .maestro-m33-composer { padding-bottom: env(safe-area-inset-bottom); }
    .maestro-m33-composer .maestro-btn, .maestro-m33-card-actions .maestro-btn {
        min-width: var(--maestro-tap); min-height: var(--maestro-tap); }
    .maestro-m33-card-actions .maestro-btn { flex: 1; }
    .maestro-m33-chip > summary, .maestro-m33-example { min-height: var(--maestro-tap); }
}
`;

/* ------------------------------------------------------------------ markdown */

function inlineNodes(parts: readonly Inline[]): Child[] {
    return parts.map((part) => {
        switch (part.kind) {
            case 'code':
                return el('code', { text: part.text });
            case 'bold':
                return el('strong', { text: part.text });
            case 'italic':
                return el('em', { text: part.text });
            default:
                return part.text;
        }
    });
}

function blockNode(block: Block): HTMLElement {
    if (block.kind === 'code') {
        return el('pre', { data: block.lang ? { lang: block.lang } : undefined }, [el('code', { text: block.text })]);
    }
    if (block.kind === 'list') {
        return el(
            block.ordered ? 'ol' : 'ul',
            { attrs: block.ordered && block.start !== 1 ? { start: block.start } : undefined },
            block.items.map((item) => el('li', {}, inlineNodes(item))),
        );
    }
    return el(
        'p',
        {},
        block.lines.flatMap((line, index) => [index ? el('br') : null, ...inlineNodes(line)]),
    );
}

/** An answer as DOM: light Markdown, everything as text nodes (no HTML from the model ever becomes markup). */
export function renderMarkdown(text: string): HTMLElement {
    return el('div', { class: 'maestro-m33-md' }, parseMarkdown(text).map(blockNode));
}

/* ------------------------------------------------------------------ helpers */

function pretty(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2) ?? '';
    } catch {
        return String(value);
    }
}

function cut(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** «Блок «Main Prompt» из «Marinara»» / «Пресет «Marinara»». */
export function contextText(app: App, item: AssistantContextItem): string {
    return item.kind === 'presetBlock'
        ? app.i18n.t('m33.context.block', { name: item.label || item.identifier || '', preset: item.preset })
        : app.i18n.t('m33.context.preset', { name: item.preset });
}

/** A call is a write when it reached the card stage (plan made) or carries a write status. */
function isWriteRecord(record: ToolCallRecord): boolean {
    return (
        record.target !== undefined ||
        record.status === 'waiting' ||
        record.status === 'applied' ||
        record.status === 'declined'
    );
}

/** Spend of the conversation and of the last user message (from it to the end). */
export function costOf(messages: readonly AssistantMessage[]): { total: number; last: number } {
    let total = 0;
    let last = 0;
    for (const message of messages) {
        if (message.role === 'user') last = 0;
        const cost = typeof message.costUsd === 'number' ? message.costUsd : 0;
        total += cost;
        last += cost;
    }
    return { total, last };
}

/* ------------------------------------------------------------------ tab */

export function assistantTab(app: App, api: AssistantViewApi): PultTab {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    // Kept across renders: the draft, which chips are open, and the choices made on waiting cards (pack ticks, scope).
    let draft = '';
    const openChips = new Set<string>();
    const choices = new Map<string, { cleared: Set<string>; scope?: string }>();
    const choiceOf = (id: string) => {
        let choice = choices.get(id);
        if (!choice) {
            choice = { cleared: new Set() };
            choices.set(id, choice);
        }
        return choice;
    };

    return {
        id: ASSISTANT_TAB,
        titleKey: 'm33.tab',
        icon: 'fa-comments',
        order: ASSISTANT_TAB_ORDER,
        group: 'assistant',
        render(container): Unsubscribe {
            const bar = el('div', { class: 'maestro-m33-bar' });
            const banners = el('div', { class: 'maestro-m33-banners' });
            const list = el('div', {
                class: 'maestro-m33-list',
                attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': t('m33.tab') },
            });
            const input = el('textarea', {
                class: 'text_pole maestro-m33-input',
                attrs: { rows: 2, placeholder: t('m33.input.placeholder'), 'aria-label': t('m33.input.label') },
            });
            input.value = draft;
            let stickToBottom = true;

            const submit = (text?: string): void => {
                const value = (text ?? input.value).trim();
                if (!value || api.busy()) return;
                if (text === undefined) {
                    input.value = '';
                    draft = '';
                }
                stickToBottom = true;
                void api.send(value).catch((error: unknown) => app.log.error('assistant send failed', error));
            };

            input.addEventListener('input', () => {
                draft = input.value;
            });
            input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
                event.preventDefault();
                submit();
            });

            const sendButton = button({
                label: t('m33.send'),
                icon: 'fa-paper-plane',
                kind: 'primary',
                className: 'maestro-m33-send',
                onClick: () => submit(),
            });
            const stopButton = button({
                label: t('m33.stop'),
                icon: 'fa-stop',
                kind: 'danger',
                className: 'maestro-m33-stop',
                onClick: () => api.stop(),
            });
            const attached = el('div', {
                class: 'maestro-m33-chips maestro-m33-attached',
                attrs: { 'aria-label': t('m33.context.label') },
            });
            const composer = el('div', { class: 'maestro-m33-composer' }, [
                el('div', { class: 'maestro-m33-composer-main' }, [attached, input]),
                el('div', { class: 'maestro-m33-composer-actions' }, [sendButton, stopButton]),
            ]);

            const contextChip = (item: AssistantContextItem, removable: boolean): HTMLElement =>
                el('span', { class: 'maestro-m33-context', data: { context: contextKey(item) } }, [
                    icon(item.kind === 'presetBlock' ? 'fa-cube' : 'fa-sliders'),
                    el('span', { text: contextText(app, item), title: contextText(app, item) }),
                    removable
                        ? button({
                              icon: 'fa-xmark',
                              kind: 'ghost',
                              title: t('m33.context.remove'),
                              className: 'maestro-m33-context-remove',
                              onClick: () => api.detach?.(contextKey(item)),
                          })
                        : null,
                ]);

            const drawAttached = () => {
                clear(attached);
                const items = api.attachments?.() ?? [];
                attached.hidden = !items.length;
                for (const item of items) attached.append(contextChip(item, true));
            };

            const chip = (record: ToolCallRecord): HTMLElement => {
                const node = el('details', {
                    class: ['maestro-m33-chip', `maestro-m33-chip-${record.status}`],
                    data: { call: record.id },
                });
                if (openChips.has(record.id)) node.setAttribute('open', '');
                node.addEventListener('toggle', () => {
                    if (node.hasAttribute('open')) openChips.add(record.id);
                    else openChips.delete(record.id);
                });
                const text = record.error ?? record.summary ?? t(`m33.status.${record.status}`);
                node.append(
                    el('summary', { title: t(`m33.status.${record.status}`) }, [
                        icon(STATUS_ICON[record.status], record.status === 'running' ? 'fa-spin' : undefined),
                        el('code', { class: 'maestro-m33-chip-name', text: record.name }),
                        el('span', { class: 'maestro-m33-chip-text', text }),
                    ]),
                    el('div', { class: 'maestro-m33-chip-body' }, [
                        el('div', { class: 'maestro-m33-label', text: t('m33.chip.args') }),
                        el('pre', { class: 'maestro-m33-pre', text: pretty(record.args) }),
                        record.result !== undefined
                            ? el('div', { class: 'maestro-m33-label', text: t('m33.chip.result') })
                            : null,
                        record.result !== undefined
                            ? el('pre', { class: 'maestro-m33-pre', text: cut(record.result, PREVIEW_CHARS) })
                            : null,
                        record.untrusted ? el('div', { class: 'maestro-hint', text: t('m33.chip.untrusted') }) : null,
                    ]),
                );
                return node;
            };

            /** The scope line: a switch while the card waits (two or more scopes), else the scope in words. */
            const scopeRow = (record: ToolCallRecord, live: boolean): HTMLElement | null => {
                const options = record.scopes ?? [];
                if (!options.length) return null;
                const current = (live ? choices.get(record.id)?.scope : undefined) ?? record.scope ?? options[0]!.value;
                const label = options.find((option) => option.value === current)?.label ?? current;
                if (!live || options.length < 2) {
                    return el('div', { class: 'maestro-m33-card-scope' }, [
                        icon('fa-location-crosshairs'),
                        el('span', { text: `${t('m33.card.scope')}: ${label}` }),
                    ]);
                }
                return el('label', { class: 'maestro-m33-card-scope' }, [
                    icon('fa-location-crosshairs'),
                    el('span', { text: t('m33.card.scope') }),
                    select({
                        value: current,
                        label: t('m33.card.scope'),
                        options: options.map((option) => ({ value: option.value, label: option.label })),
                        onChange: (value) => {
                            choiceOf(record.id).scope = value;
                        },
                    }),
                ]);
            };

            const itemState = (item: ToolCallItem): string => {
                if (item.status === 'error') return t('m33.card.item.error', { error: item.error ?? '' });
                return item.status ? t(`m33.card.item.${item.status}`) : '';
            };

            /** The changes of a pack: a tick each while it waits, their fate afterwards. */
            const itemsList = (record: ToolCallRecord, live: boolean, refresh: () => void): HTMLElement | null => {
                const items = record.items ?? [];
                if (!items.length) return null;
                const cleared = live ? choiceOf(record.id).cleared : new Set<string>();
                return el(
                    'div',
                    { class: 'maestro-m33-items' },
                    items.map((item) => {
                        const off = live ? cleared.has(item.id) : item.status === 'skipped';
                        const head: Child[] = [];
                        if (live) {
                            const tick = el('input', {
                                class: 'maestro-m33-item-tick',
                                attrs: { type: 'checkbox', 'aria-label': t('m33.card.item.keep') },
                                data: { item: item.id },
                            });
                            tick.checked = !off;
                            tick.addEventListener('change', () => {
                                if (tick.checked) cleared.delete(item.id);
                                else cleared.add(item.id);
                                refresh();
                            });
                            head.push(tick);
                        } else if (item.status) {
                            head.push(
                                icon(
                                    item.status === 'applied'
                                        ? 'fa-check'
                                        : item.status === 'error'
                                          ? 'fa-triangle-exclamation'
                                          : 'fa-minus',
                                ),
                            );
                        }
                        head.push(el('span', { class: 'maestro-m33-item-summary', text: item.summary }));
                        const state = live ? '' : itemState(item);
                        if (state) head.push(el('span', { class: 'maestro-m33-item-state', text: state }));
                        const hasValues = item.before !== undefined || item.after !== undefined;
                        const diff = hasValues
                            ? el('details', {}, [
                                  el('summary', { text: item.target ?? t('m33.card.item.diff') }),
                                  diffView(item.before, item.after, t),
                              ])
                            : null;
                        if (diff && items.length <= 3) diff.setAttribute('open', '');
                        return el(
                            'div',
                            {
                                class: [
                                    'maestro-m33-item',
                                    off ? 'maestro-m33-item-off' : null,
                                    item.status ? `maestro-m33-item-${item.status}` : null,
                                ],
                                data: { item: item.id },
                            },
                            [el('div', { class: 'maestro-m33-item-head' }, head), diff],
                        );
                    }),
                );
            };

            const card = (record: ToolCallRecord): HTMLElement => {
                let footer: Child;
                const items = record.items ?? [];
                const live = record.status === 'waiting' && !(api.awaiting && !api.awaiting(record.id));
                let refreshButtons = () => {};
                if (record.status === 'waiting') {
                    if (!live) {
                        footer = el('div', { class: 'maestro-hint', text: t('m33.card.otherTab') });
                    } else if (items.length) {
                        const choice = choiceOf(record.id);
                        const kept = () => items.filter((item) => !choice.cleared.has(item.id)).map((item) => item.id);
                        const all = button({
                            label: t('m33.card.applyAll'),
                            icon: 'fa-check-double',
                            kind: 'primary',
                            className: 'maestro-m33-apply',
                            onClick: () =>
                                api.confirm(record.id, true, {
                                    selected: items.map((item) => item.id),
                                    scope: choice.scope ?? record.scope,
                                }),
                        });
                        const some = button({
                            label: t('m33.card.applySelected'),
                            icon: 'fa-check',
                            className: 'maestro-m33-apply-selected',
                            onClick: () =>
                                api.confirm(record.id, true, { selected: kept(), scope: choice.scope ?? record.scope }),
                        });
                        refreshButtons = () => {
                            const count = kept().length;
                            some.disabled = count === 0 || count === items.length;
                            for (const node of cardNode.querySelectorAll<HTMLElement>('.maestro-m33-item')) {
                                node.classList.toggle(
                                    'maestro-m33-item-off',
                                    choice.cleared.has(node.dataset['item'] ?? ''),
                                );
                            }
                        };
                        footer = el('div', { class: 'maestro-m33-card-actions' }, [
                            all,
                            some,
                            button({
                                label: t('m33.card.decline'),
                                icon: 'fa-xmark',
                                className: 'maestro-m33-decline',
                                onClick: () => api.confirm(record.id, false),
                            }),
                        ]);
                    } else {
                        footer = el('div', { class: 'maestro-m33-card-actions' }, [
                            button({
                                label: t('m33.card.apply'),
                                icon: 'fa-check',
                                kind: 'primary',
                                className: 'maestro-m33-apply',
                                onClick: () => {
                                    const scope = choices.get(record.id)?.scope;
                                    return scope === undefined
                                        ? api.confirm(record.id, true)
                                        : api.confirm(record.id, true, { scope });
                                },
                            }),
                            button({
                                label: t('m33.card.decline'),
                                icon: 'fa-xmark',
                                className: 'maestro-m33-decline',
                                onClick: () => api.confirm(record.id, false),
                            }),
                        ]);
                    }
                } else if (record.status === 'applied' && items.length) {
                    const applied = items.filter((item) => item.status === 'applied').length;
                    footer = el('div', {
                        class: 'maestro-hint',
                        text:
                            applied === items.length
                                ? t('m33.card.applied')
                                : t('m33.card.appliedPart', { applied, total: items.length }),
                    });
                } else if (record.status === 'applied') {
                    footer = el('div', { class: 'maestro-hint', text: t('m33.card.applied') });
                } else if (record.status === 'declined') {
                    footer = el('div', { class: 'maestro-hint', text: t('m33.card.declined') });
                } else if (record.status === 'error') {
                    footer = el('div', {
                        class: 'maestro-hint maestro-warn-text',
                        text: t('m33.card.failed', { error: record.error ?? '' }),
                    });
                } else {
                    footer = null;
                }
                const hasValues = record.before !== undefined || record.after !== undefined;
                const cardNode = el(
                    'div',
                    {
                        class: [
                            'maestro-card',
                            'maestro-m33-card',
                            `maestro-m33-card-${record.status}`,
                            items.length ? 'maestro-m33-pack' : null,
                        ],
                        data: { call: record.id },
                    },
                    [
                        el('div', { class: 'maestro-m33-card-head' }, [
                            icon(
                                record.status === 'running'
                                    ? 'fa-spinner'
                                    : items.length
                                      ? 'fa-layer-group'
                                      : 'fa-pen-to-square',
                            ),
                            el('span', { class: 'maestro-m33-card-target', text: record.target ?? record.name }),
                            items.length
                                ? el('span', {
                                      class: 'maestro-m33-pack-badge',
                                      text: tPlural(app.i18n, 'm33.card.pack', items.length),
                                  })
                                : null,
                            el('span', {
                                class: 'maestro-m33-card-state',
                                text: t(`m33.status.${record.status}`),
                            }),
                        ]),
                        record.summary ? el('div', { class: 'maestro-m33-card-summary', text: record.summary }) : null,
                        scopeRow(record, live),
                        hasValues ? diffView(record.before, record.after, t) : null,
                        itemsList(record, live, () => refreshButtons()),
                        footer,
                    ],
                );
                refreshButtons();
                return cardNode;
            };

            const messageNode = (message: AssistantMessage): HTMLElement => {
                if (message.role === 'notice') {
                    return el(
                        'div',
                        { class: 'maestro-m33-notice', attrs: { role: 'status' }, data: { id: message.id } },
                        [icon('fa-circle-info'), el('span', { text: message.text })],
                    );
                }
                if (message.role === 'user') {
                    const context = message.context ?? [];
                    return el('div', { class: 'maestro-m33-msg maestro-m33-user', data: { id: message.id } }, [
                        context.length
                            ? el(
                                  'div',
                                  { class: 'maestro-m33-chips' },
                                  context.map((item) => contextChip(item, false)),
                              )
                            : null,
                        el('div', {
                            class: 'maestro-m33-bubble',
                            text: message.text,
                            attrs: { 'aria-label': t('m33.you') },
                        }),
                    ]);
                }
                const calls = message.toolCalls ?? [];
                return el('div', { class: 'maestro-m33-msg maestro-m33-assistant', data: { id: message.id } }, [
                    message.text.trim()
                        ? el('div', { class: 'maestro-m33-bubble', attrs: { 'aria-label': t('m33.assistant') } }, [
                              renderMarkdown(message.text),
                          ])
                        : null,
                    ...calls.map((record) => (isWriteRecord(record) ? card(record) : chip(record))),
                ]);
            };

            const emptyView = (): HTMLElement =>
                el('div', { class: 'maestro-m33-empty' }, [
                    el('div', { class: 'maestro-m33-empty-title', text: t('m33.empty.title') }),
                    el('div', { class: 'maestro-hint', text: t('m33.empty.hint') }),
                    el(
                        'div',
                        { class: 'maestro-m33-examples' },
                        EXAMPLE_KEYS.map((key) =>
                            button({
                                label: t(key),
                                icon: 'fa-comment-dots',
                                className: 'maestro-m33-example',
                                onClick: () => submit(t(key)),
                            }),
                        ),
                    ),
                ]);

            const drawBar = (messages: AssistantMessage[]) => {
                clear(bar);
                const cost = costOf(messages);
                bar.append(
                    el('div', {
                        class: 'maestro-m33-cost',
                        text:
                            cost.total > 0
                                ? t('m33.cost', {
                                      total: formatUsd(cost.total, app.i18n),
                                      last: formatUsd(cost.last, app.i18n),
                                  })
                                : '',
                    }),
                    button({
                        label: t('m33.clear'),
                        icon: 'fa-broom',
                        kind: 'ghost',
                        className: 'maestro-m33-clear',
                        disabled: !messages.length,
                        onClick: async () => {
                            if (await app.ui.confirm(t('m33.clear.title'), t('m33.clear.body'))) await api.clear();
                        },
                    }),
                );
            };

            const drawBanners = () => {
                clear(banners);
                if (!app.llm.available(ASSISTANT_TASK)) {
                    banners.append(
                        el('div', { class: 'maestro-m33-banner' }, [
                            banner(t('m33.noProfile.banner'), 'warn', 'fa-plug-circle-xmark'),
                            button({
                                label: t('m33.noProfile.open'),
                                icon: 'fa-gear',
                                kind: 'ghost',
                                onClick: () => app.ui.openPult('settings'),
                            }),
                        ]),
                    );
                }
                if (!app.host.chatId()) banners.append(banner(t('m33.noChat'), 'info', 'fa-circle-info'));
            };

            const nearBottom = () =>
                container.scrollHeight - container.scrollTop - container.clientHeight < STICKY_BOTTOM_PX;

            const draw = () => {
                const keepBottom = stickToBottom || nearBottom();
                const messages = api.conversation();
                const busy = api.busy();
                drawBar(messages);
                drawBanners();
                clear(list);
                if (!messages.length && !busy) list.append(emptyView());
                for (const message of messages) list.append(messageNode(message));
                const waitingIds = new Set(
                    messages.flatMap((message) =>
                        (message.toolCalls ?? []).filter((call) => call.status === 'waiting').map((call) => call.id),
                    ),
                );
                // Choices of answered cards are no longer needed.
                for (const id of [...choices.keys()]) if (!waitingIds.has(id)) choices.delete(id);
                const waiting = waitingIds.size > 0;
                drawAttached();
                if (busy && !waiting)
                    list.append(
                        el('div', { class: 'maestro-m33-thinking', attrs: { role: 'status' } }, [
                            icon('fa-spinner', 'fa-spin'),
                            el('span', { text: t('m33.busy') }),
                        ]),
                    );
                sendButton.disabled = busy;
                sendButton.hidden = busy;
                stopButton.hidden = !busy;
                if (keepBottom) container.scrollTop = container.scrollHeight;
                stickToBottom = false;
            };

            container.append(el('div', { class: 'maestro-view maestro-m33' }, [bar, banners, list, composer]));
            draw();
            const off = api.onChange(draw);
            return () => {
                off();
            };
        },
    };
}

/* ------------------------------------------------------------------ settings section */

/** The module's block in the pult's Settings: the profile (CoreSettings.profiles.assistant) and the limits. */
export function renderAssistantSettings(container: HTMLElement, app: App, settings: AssistantSettings): void {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const commit = (path: string) => {
        app.settings.save();
        app.settings.notify(path);
    };
    let profiles: { id: string; name: string }[] | null = null;
    try {
        const service = app.host.ctx().ConnectionManagerRequestService;
        profiles = typeof service?.getSupportedProfiles === 'function' ? service.getSupportedProfiles() : null;
    } catch (error) {
        app.log.debug('connection profiles unavailable', error);
    }
    const rows: Child[] = [];
    if (!profiles) {
        rows.push(banner(t('m33.settings.noCm'), 'warn', 'fa-plug-circle-xmark'));
    } else {
        const current = app.settings.core().profiles[ASSISTANT_TASK] ?? '';
        const options: SelectOption<string>[] = [
            { value: '', label: t('m33.settings.profileInherit') },
            ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
        ];
        if (current && !profiles.some((profile) => profile.id === current))
            options.push({ value: current, label: t('m33.settings.profileMissing', { id: current }) });
        rows.push(
            field(
                t('m33.settings.profile'),
                select({
                    value: current,
                    label: t('m33.settings.profile'),
                    options,
                    onChange: (value) => {
                        const stored = app.settings.core().profiles;
                        if (value) stored[ASSISTANT_TASK] = value;
                        else delete stored[ASSISTANT_TASK];
                        commit(`core.profiles.${ASSISTANT_TASK}`);
                    },
                }),
                t('m33.settings.profileHint'),
            ),
        );
    }
    const numbers: { key: keyof AssistantSettings; label: string; hint?: string; step: number }[] = [
        { key: 'maxTokens', label: 'm33.settings.maxTokens', step: 100 },
        { key: 'historyTokens', label: 'm33.settings.historyTokens', hint: 'm33.settings.historyHint', step: 500 },
        { key: 'writesPerHour', label: 'm33.settings.writesPerHour', hint: 'm33.settings.writesHint', step: 1 },
        { key: 'resultChars', label: 'm33.settings.resultChars', step: 1000 },
    ];
    for (const item of numbers) {
        const [min, max] = ASSISTANT_LIMITS[item.key];
        rows.push(
            field(
                t(item.label),
                numberInput({
                    value: settings[item.key],
                    min,
                    max,
                    step: item.step,
                    label: t(item.label),
                    onChange: (value) => {
                        settings[item.key] = Math.round(value);
                        commit(`modules.${ASSISTANT_KEY}.${item.key}`);
                    },
                }),
                item.hint ? t(item.hint) : undefined,
            ),
        );
    }
    container.append(el('div', { class: 'maestro-view maestro-m33-settings' }, rows));
}
