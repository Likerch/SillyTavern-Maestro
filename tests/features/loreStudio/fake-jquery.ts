// A tiny jQuery stand-in for the takeover tests: namespaced .on/.off over native listeners (so handler order and
// stopImmediatePropagation behave like jQuery's), .trigger, .val and $._data(el, 'events').
type Handler = (this: Element, event: Event) => unknown;

interface Binding {
    type: string;
    namespace: string;
    handler: Handler;
    listener: EventListener;
}

const registry = new WeakMap<Element, Binding[]>();

function bindings(element: Element): Binding[] {
    let list = registry.get(element);
    if (!list) {
        list = [];
        registry.set(element, list);
    }
    return list;
}

export interface FakeJQueryHandle {
    on(events: string, handler: Handler): FakeJQueryHandle;
    off(events: string, handler?: Handler): FakeJQueryHandle;
    trigger(event: string): FakeJQueryHandle;
    val(value: string | number): FakeJQueryHandle;
}

export interface FakeJQuery {
    (target: Element | string): FakeJQueryHandle;
    _data(element: Element, key: string): unknown;
}

export function installFakeJQuery(): FakeJQuery {
    const $ = ((target: Element | string) => {
        const elements = typeof target === 'string' ? [...document.querySelectorAll(target)] : [target];
        const api: FakeJQueryHandle = {
            on(events: string, handler: Handler) {
                for (const element of elements) {
                    for (const spec of events.split(' ')) {
                        const [type = '', ...namespaces] = spec.split('.');
                        const listener: EventListener = (event) => void handler.call(element, event);
                        element.addEventListener(type, listener);
                        bindings(element).push({ type, namespace: namespaces.sort().join('.'), handler, listener });
                    }
                }
                return api;
            },
            off(events: string, handler?: Handler) {
                for (const element of elements) {
                    for (const spec of events.split(' ')) {
                        const [type = '', ...namespaces] = spec.split('.');
                        const list = bindings(element);
                        for (const binding of [...list]) {
                            if (type && binding.type !== type) continue;
                            if (
                                namespaces.length &&
                                !namespaces.every((name) => binding.namespace.split('.').includes(name))
                            )
                                continue;
                            if (handler && binding.handler !== handler) continue;
                            element.removeEventListener(binding.type, binding.listener);
                            list.splice(list.indexOf(binding), 1);
                        }
                    }
                }
                return api;
            },
            trigger(event: string) {
                for (const element of elements) element.dispatchEvent(new Event(event, { bubbles: true }));
                return api;
            },
            val(value: string | number) {
                for (const element of elements) (element as HTMLSelectElement).value = String(value);
                return api;
            },
        };
        return api;
    }) as FakeJQuery;
    $._data = (element: Element, key: string) =>
        key === 'events'
            ? {
                  click: bindings(element)
                      .filter((binding) => binding.type === 'click')
                      .map((binding) => ({ handler: binding.handler, namespace: binding.namespace })),
              }
            : undefined;
    (globalThis as { jQuery?: unknown }).jQuery = $;
    return $;
}

export function removeFakeJQuery(): void {
    delete (globalThis as { jQuery?: unknown }).jQuery;
}

/** The classic WI drawer markup of ST 1.19 (index.html 4671-4676) plus the editor select. */
export function buildWiDrawer(books: string[] = []): {
    toggle: HTMLElement;
    icon: HTMLElement;
    drawer: HTMLElement;
    editor: HTMLSelectElement;
} {
    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="WI-SP-button" class="drawer">
            <div class="drawer-toggle drawer-header"><div id="WIDrawerIcon" class="drawer-icon closedIcon"></div></div>
            <div id="WorldInfo" class="drawer-content closedDrawer"></div>
        </div>
        <select id="world_editor_select"><option value="">--- Pick ---</option></select>`,
    );
    const editor = document.getElementById('world_editor_select') as HTMLSelectElement;
    books.forEach((book, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.text = book;
        editor.append(option);
    });
    return {
        toggle: document.querySelector('#WI-SP-button .drawer-toggle') as HTMLElement,
        icon: document.getElementById('WIDrawerIcon') as HTMLElement,
        drawer: document.getElementById('WorldInfo') as HTMLElement,
        editor,
    };
}
