// Tiny DOM helpers: Maestro's UI has no framework. Text always goes in as text nodes (never innerHTML), so
// strings from lorebooks, chats and models cannot inject markup.

export type Child = Node | string | number | null | undefined | false;
export type ClassValue = string | (string | null | undefined | false)[];

type Handlers = { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void };

export interface ElProps {
    class?: ClassValue;
    /** Sets textContent (children are appended after it). */
    text?: string;
    title?: string;
    data?: Record<string, string | number>;
    /** Raw attributes: `true` sets an empty attribute, `false`/`null`/`undefined` skip it. */
    attrs?: Record<string, string | number | boolean | null | undefined>;
    on?: Handlers;
}

export function classNames(value: ClassValue | undefined): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0).join(' ');
}

export function append(parent: Node, children: Child | Child[] | undefined): void {
    if (children === undefined) return;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        parent.appendChild(
            typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child,
        );
    }
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: ElProps = {},
    children?: Child | Child[],
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    const className = classNames(props.class);
    if (className) element.className = className;
    if (props.text !== undefined) element.textContent = props.text;
    if (props.title !== undefined) element.setAttribute('title', props.title);
    if (props.data) {
        for (const [key, value] of Object.entries(props.data)) element.dataset[key] = String(value);
    }
    if (props.attrs) {
        for (const [key, value] of Object.entries(props.attrs)) {
            if (value === false || value === null || value === undefined) continue;
            element.setAttribute(key, value === true ? '' : String(value));
        }
    }
    if (props.on) {
        for (const [name, handler] of Object.entries(props.on)) {
            if (handler) element.addEventListener(name, handler as EventListener);
        }
    }
    append(element, children);
    return element;
}

export function clear(node: Element): void {
    while (node.firstChild) node.removeChild(node.firstChild);
}

/** Font Awesome icon (ST ships FA 6). */
export function icon(name: string, extra?: string): HTMLElement {
    const iconClass = name.startsWith('fa-') ? name : `fa-${name}`;
    return el('i', { class: ['fa-solid', iconClass, 'fa-fw', extra], attrs: { 'aria-hidden': 'true' } });
}

let reportButtonError: (error: unknown) => void = (error) => console.error('[Maestro:ui]', error);

/** Where failures of async button handlers go (the UI routes them to its logger and notices). */
export function setButtonErrorHandler(handler: (error: unknown) => void): void {
    reportButtonError = handler;
}

export interface ButtonOptions {
    label?: string;
    icon?: string;
    title?: string;
    kind?: 'default' | 'primary' | 'danger' | 'ghost';
    disabled?: boolean;
    className?: string;
    onClick?: (event: MouseEvent) => void | Promise<void>;
}

/**
 * A ST-styled button. Async handlers disable the button while they run so a double tap on a phone does not
 * accept a card twice.
 */
export function button(options: ButtonOptions): HTMLButtonElement {
    const node = el(
        'button',
        {
            class: [
                'menu_button',
                'maestro-btn',
                options.kind && options.kind !== 'default' ? `maestro-btn-${options.kind}` : null,
                options.className,
            ],
            title: options.title,
            attrs: {
                type: 'button',
                disabled: options.disabled === true,
                'aria-label': options.label ? undefined : options.title,
            },
        },
        [options.icon ? icon(options.icon) : null, options.label ? el('span', { text: options.label }) : null],
    );
    if (options.onClick) {
        const handler = options.onClick;
        node.addEventListener('click', (event) => {
            if (node.disabled) return;
            let result: void | Promise<void>;
            try {
                result = handler(event);
            } catch (error) {
                reportButtonError(error);
                return;
            }
            if (result instanceof Promise) {
                node.disabled = true;
                node.classList.add('maestro-busy');
                void result
                    .catch((error: unknown) => reportButtonError(error))
                    .finally(() => {
                        node.disabled = options.disabled === true;
                        node.classList.remove('maestro-busy');
                    });
            }
        });
    }
    return node;
}

export function prefersReducedMotion(): boolean {
    try {
        return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
        return false;
    }
}
