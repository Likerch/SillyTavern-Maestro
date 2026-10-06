// Cards, sections, empty states, badges and status lamps.
import { el, icon } from './dom';
import type { Child } from './dom';

export type Level = 'info' | 'ok' | 'warn' | 'error' | 'muted';

export interface CardOptions {
    title?: string;
    subtitle?: Child | Child[];
    level?: Level;
    body?: Child | Child[];
    actions?: Child | Child[];
    className?: string;
}

export function card(options: CardOptions): HTMLElement {
    return el(
        'div',
        { class: ['maestro-card', options.level ? `maestro-level-${options.level}` : null, options.className] },
        [
            options.title || options.subtitle
                ? el('div', { class: 'maestro-card-head' }, [
                      options.title ? el('div', { class: 'maestro-card-title', text: options.title }) : null,
                      options.subtitle ? el('div', { class: 'maestro-card-subtitle' }, options.subtitle) : null,
                  ])
                : null,
            options.body !== undefined ? el('div', { class: 'maestro-card-body' }, options.body) : null,
            options.actions !== undefined ? el('div', { class: 'maestro-card-actions' }, options.actions) : null,
        ],
    );
}

/** A titled block inside a tab, with optional header actions. */
export function section(title: string, children: Child | Child[], actions?: Child | Child[]): HTMLElement {
    return el('section', { class: 'maestro-section' }, [
        el('div', { class: 'maestro-section-head' }, [
            el('h4', { class: 'maestro-section-title', text: title }),
            actions !== undefined ? el('div', { class: 'maestro-section-actions' }, actions) : null,
        ]),
        el('div', { class: 'maestro-section-body' }, children),
    ]);
}

/**
 * Marks a module's own settings inside its tab (plan-2 §10 п.4): in a window they stay hidden until the gear in the
 * window header shows them.
 */
export const MODULE_SETTINGS_CLASS = 'maestro-module-settings';

export function moduleSettings<T extends HTMLElement>(node: T): T {
    node.classList.add(MODULE_SETTINGS_CLASS);
    return node;
}

/** A section with a module's own settings (shown in a window by its gear). */
export function moduleSettingsSection(
    title: string,
    children: Child | Child[],
    actions?: Child | Child[],
): HTMLElement {
    return moduleSettings(section(title, children, actions));
}

export function emptyState(text: string, iconName = 'fa-circle-check'): HTMLElement {
    return el('div', { class: 'maestro-empty' }, [icon(iconName), el('span', { text })]);
}

export function badge(value: string | number, level: Level = 'info'): HTMLElement {
    return el('span', { class: ['maestro-badge-pill', `maestro-level-${level}`], text: String(value) });
}

/** A coloured dot with an accessible label. */
export function lamp(state: 'ok' | 'warn' | 'error' | 'off', label: string): HTMLElement {
    return el('span', {
        class: ['maestro-lamp', `maestro-lamp-${state}`],
        title: label,
        attrs: { role: 'img', 'aria-label': label },
    });
}

/** Inline banner (group chat, Text Completion, stale card…). */
export function banner(text: string, level: Level = 'warn', iconName = 'fa-triangle-exclamation'): HTMLElement {
    return el('div', { class: ['maestro-banner', `maestro-level-${level}`], attrs: { role: 'status' } }, [
        icon(iconName),
        el('span', { text }),
    ]);
}
