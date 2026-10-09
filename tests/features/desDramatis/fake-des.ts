// A happy-dom fake of DES 2.6's modal UI (template.html, characterSheet.js, characterWorkshop.js, portraitBar.js) for
// M39: the lazily appended template with the character sheet and the Workshop, openCharacterSheet's one synchronous
// pass (attributes, `.rpg-cs-sections` emptied and rebuilt with the tabs, the Notes Mode toggle and the contents,
// `display: flex`), DES's document-delegated tab switching, the Workshop's opening (data-mode, the title, the theme,
// activatePane('identity'), `.is-open`) and its nav, the portrait card menu that keeps the card's name in jQuery data
// and moves into body on its first use, and a minimal jQuery for that data.

type Dict = Record<string, unknown>;

export interface FakeDesUi {
    /** The portrait bar with the menu (before the first right-click the menu lives here). */
    bar: HTMLElement;
    menu: HTMLElement;
    /** Appended by the first DES modal (null before). */
    sheet: HTMLElement | null;
    workshop: HTMLElement | null;
    /** DES's lazy template goes into body (ensureSettingsUI). */
    appendTemplate(): void;
    /** characterSheet.js openCharacterSheet. */
    openSheet(name: string): void;
    /** The Notes Mode toggle: DES rebuilds the open sheet. */
    toggleNotes(): void;
    closeSheet(): void;
    /** characterWorkshop.js openCharacterWorkshop. */
    openWorkshop(name: string, mode?: 'npc' | 'user'): void;
    closeWorkshop(): void;
    card(name: string, user?: boolean): HTMLElement;
    rightClick(card: HTMLElement): void;
    /** The tab of the sheet that is active, and the contents shown. */
    activeTab(): string | null;
    shownContents(): string[];
    activePane(): string | null;
    remove(): void;
}

const store = new WeakMap<object, Dict>();

/** The jQuery calls DES and Maestro make here: data(), hide(), off(). */
function fakeJquery(target: unknown) {
    const node =
        typeof target === 'string' ? document.querySelector(target) : ((target as Element | Document | null) ?? null);
    return {
        data(key: string, value?: unknown) {
            if (!node) return undefined;
            const data = store.get(node) ?? {};
            store.set(node, data);
            if (value === undefined) return data[key];
            data[key] = value;
            return this;
        },
        hide() {
            if (node instanceof HTMLElement) node.style.display = 'none';
            return this;
        },
        off() {
            return this;
        },
    };
}

export function installFakeDes(): FakeDesUi {
    const globals = globalThis as unknown as Dict;
    globals.jQuery = fakeJquery;
    const bar = document.createElement('div');
    bar.id = 'dooms-portrait-bar-wrapper';
    bar.innerHTML = `
        <div class="dooms-pb-scroll"></div>
        <div id="dooms-pb-context-menu" class="dooms-pb-context-menu" style="display:none;">
            <div class="dooms-pb-ctx-item" data-action="open-workshop">Open in Workshop</div>
            <div class="dooms-pb-ctx-divider"></div>
            <div class="dooms-pb-ctx-item" data-action="character-sheet">Character Sheet</div>
            <div class="dooms-pb-ctx-item" data-action="regenerate-portrait">Regenerate Portrait</div>
        </div>`;
    document.body.appendChild(bar);
    const menu = bar.querySelector<HTMLElement>('#dooms-pb-context-menu')!;
    const listeners: [EventTarget, string, EventListener][] = [];
    const listen = (target: EventTarget, type: string, handler: EventListener) => {
        target.addEventListener(type, handler);
        listeners.push([target, type, handler]);
    };
    let notes = false;

    const fake: FakeDesUi = {
        bar,
        menu,
        sheet: null,
        workshop: null,
        appendTemplate() {
            if (fake.sheet) return;
            const holder = document.createElement('div');
            holder.innerHTML = `
                <div id="rpg-character-sheet-popup" class="rpg-settings-popup" style="display: none;">
                    <div class="rpg-settings-popup-content rpg-cs-content">
                        <div class="rpg-cs-hero"><img class="rpg-cs-hero-art"><div class="rpg-cs-hero-name"></div></div>
                        <div class="rpg-cs-right"><div class="rpg-cs-sections"></div></div>
                    </div>
                </div>
                <div id="character-workshop-popup" class="rpg-settings-popup">
                    <section class="rpg-settings-popup-content">
                        <header><h3><span id="cw-char-title"></span></h3></header>
                        <main class="cw-editor">
                            <nav class="workshop-nav cw-tabs">
                                <button type="button" class="active" data-pane="identity">&#128481; <span class="cw-tab-label">Identity</span></button>
                                <button type="button" data-pane="appearance">&#127912; <span class="cw-tab-label">Appearance</span></button>
                            </nav>
                            <div class="workshop-pane-host">
                                <section class="rpg-editor-pane active" data-pane="identity">Identity</section>
                                <section class="rpg-editor-pane" data-pane="appearance">Appearance</section>
                            </div>
                        </main>
                    </section>
                </div>`;
            // `$('body').append(templateHtml)`: the template's top-level nodes become children of body.
            document.body.append(...holder.children);
            fake.sheet = document.getElementById('rpg-character-sheet-popup');
            fake.workshop = document.getElementById('character-workshop-popup');
            // DES's activatePane over the nav (characterWorkshop.js bindStaticListeners).
            listen(fake.workshop!, 'click', (event) => {
                const button = (event.target as Element).closest<HTMLElement>('.workshop-nav button');
                if (button?.dataset.pane) activate(button.dataset.pane);
            });
        },
        openSheet(name) {
            fake.appendTemplate();
            const popup = fake.sheet!;
            popup.querySelector('.rpg-cs-hero-name')!.textContent = name;
            popup.setAttribute('data-cs-character', name);
            const sections = popup.querySelector<HTMLElement>('.rpg-cs-sections')!;
            sections.replaceChildren();
            const tabs = document.createElement('div');
            tabs.className = 'rpg-cs-tabs';
            tabs.innerHTML = `
                <div class="rpg-cs-tab active" data-tab="sheet"><i class="fa-solid fa-scroll"></i> ${notes ? 'Notes' : 'Sheet'}</div>
                <div class="rpg-cs-tab" data-tab="stats"><i class="fa-solid fa-chart-bar"></i> Stats</div>
                <label class="rpg-cs-mode-toggle"><input type="checkbox" id="rpg-cs-notes-toggle"> Notes Mode</label>`;
            sections.appendChild(tabs);
            const sheet = document.createElement('div');
            sheet.className = 'rpg-cs-tab-content';
            sheet.dataset.tab = 'sheet';
            sheet.innerHTML = '<div class="rpg-cs-empty"><p>No character sheet data.</p></div>';
            sections.appendChild(sheet);
            const stats = document.createElement('div');
            stats.className = 'rpg-cs-tab-content';
            stats.dataset.tab = 'stats';
            stats.style.display = 'none';
            sections.appendChild(stats);
            popup.style.display = 'flex';
        },
        toggleNotes() {
            notes = !notes;
            const name = fake.sheet?.getAttribute('data-cs-character');
            if (name) fake.openSheet(name);
        },
        closeSheet() {
            if (fake.sheet) fake.sheet.style.display = 'none';
        },
        openWorkshop(name, mode = 'npc') {
            fake.appendTemplate();
            const popup = fake.workshop!;
            popup.setAttribute('data-mode', mode);
            popup.querySelector('#cw-char-title')!.textContent = name;
            activate('identity');
            popup.setAttribute('data-theme', 'default');
            popup.classList.add('is-open');
        },
        closeWorkshop() {
            fake.workshop?.classList.remove('is-open');
        },
        card(name, user = false) {
            const card = document.createElement('div');
            card.className = 'dooms-portrait-card';
            card.setAttribute('data-char', name);
            if (user) card.setAttribute('data-user', '1');
            bar.querySelector('.dooms-pb-scroll')!.appendChild(card);
            return card;
        },
        rightClick(card) {
            card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        },
        activeTab() {
            return fake.sheet?.querySelector<HTMLElement>('.rpg-cs-tab.active')?.dataset.tab ?? null;
        },
        shownContents() {
            return [...(fake.sheet?.querySelectorAll<HTMLElement>('.rpg-cs-tab-content') ?? [])]
                .filter((node) => node.style.display !== 'none')
                .map((node) => node.dataset.tab ?? '');
        },
        activePane() {
            return fake.workshop?.querySelector<HTMLElement>('.rpg-editor-pane.active')?.dataset.pane ?? null;
        },
        remove() {
            for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
            delete globals.jQuery;
            document.body.replaceChildren();
        },
    };

    function activate(pane: string): void {
        const popup = fake.workshop;
        if (!popup) return;
        popup.querySelectorAll<HTMLElement>('.workshop-nav button').forEach((button) => {
            button.classList.toggle('active', button.dataset.pane === pane);
        });
        popup.querySelectorAll<HTMLElement>('.rpg-editor-pane').forEach((node) => {
            node.classList.toggle('active', node.dataset.pane === pane);
        });
    }

    // characterSheet.js initCharacterSheet: tab switching, delegated on the document.
    listen(document, 'click', (event) => {
        const tab = (event.target as Element).closest<HTMLElement>('.rpg-cs-tab');
        const modal = tab?.closest('#rpg-character-sheet-popup');
        if (!tab || !modal) return;
        modal.querySelectorAll('.rpg-cs-tab').forEach((node) => node.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll<HTMLElement>('.rpg-cs-tab-content').forEach((node) => (node.style.display = 'none'));
        const content = modal.querySelector<HTMLElement>(`.rpg-cs-tab-content[data-tab="${tab.dataset.tab}"]`);
        if (content) content.style.display = '';
    });
    // portraitBar.js: the card menu (delegated, bubbling) and its items.
    listen(document, 'contextmenu', (event) => {
        const card = (event.target as Element).closest<HTMLElement>('.dooms-portrait-card');
        if (!card) return;
        event.preventDefault();
        const $menu = fakeJquery(menu);
        $menu.data('character', card.getAttribute('data-char'));
        $menu.data('isUser', card.getAttribute('data-user') === '1');
        if (menu.parentElement !== document.body) document.body.appendChild(menu);
        menu.style.display = 'block';
    });
    listen(document, 'click', (event) => {
        const item = (event.target as Element).closest<HTMLElement>('.dooms-pb-ctx-item');
        if (!item) return;
        menu.style.display = 'none';
        if (item.dataset.action === 'character-sheet') {
            const name = fakeJquery(menu).data('character');
            if (typeof name === 'string') fake.openSheet(name);
        }
    });
    return fake;
}
