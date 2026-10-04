// DES Lore Library campaigns inside the Lore Studio (research/parity-lore.md §9.2–§9.4, §9.7): the tree in DES's
// order with icon, colour and active marker, create / rename / delete / reorder / collapse, the active campaign
// switch (blocked while DES switches), books filed per campaign and «Unfiled», DES's 🌐 flag, global activation,
// the auto-link setting and the Workshop's book links (read-only). DES stays the owner: every change is a call
// into DES's own modules (des-lore.ts).
import { CAMPAIGN_COLORS, CAMPAIGN_ICONS } from '../../domain/lore-studio-campaigns';
import type { CampaignView, LibraryView } from '../../domain/lore-studio-campaigns';
import { emptyState } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';

export interface CampaignsModel {
    /** null when DES can be used; otherwise why not. */
    unavailable: 'absent' | 'loading' | null;
    view: LibraryView;
    switching: boolean;
    workshop: Record<string, string>;
    /** Globally active books (ST). */
    active: string[];
}

export interface CampaignsActions {
    create(): Promise<void>;
    rename(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    setIcon(id: string, icon: string): Promise<void>;
    setColor(id: string, color: string): Promise<void>;
    move(id: string, delta: number): Promise<void>;
    activate(id: string | null): Promise<void>;
    toggleCollapsed(id: string): Promise<void>;
    moveBook(book: string, toId: string | null): Promise<void>;
    toggleDesGlobal(book: string): Promise<void>;
    setActive(book: string, on: boolean): Promise<void>;
    setAutoLink(on: boolean): Promise<void>;
    openBook(book: string): void;
}

export function renderCampaignsPanel(app: App, model: CampaignsModel, actions: CampaignsActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    if (model.unavailable) {
        return el('div', { class: 'maestro-m23-campaigns' }, [
            emptyState(t(model.unavailable === 'absent' ? 'm23.des.absent' : 'm23.des.loading'), 'fa-folder-tree'),
        ]);
    }
    const { view } = model;
    const active = view.campaigns.find((campaign) => campaign.active) ?? null;
    const root = el('div', { class: 'maestro-m23-campaigns' });
    root.append(
        el('div', { class: 'maestro-m23-campaigns-head' }, [
            el('p', { class: 'maestro-muted', text: t('m23.des.intro') }),
            el('div', {
                class: 'maestro-m23-active-campaign',
                text: active ? t('m23.des.activeIs', { name: active.name }) : t('m23.des.noActive'),
            }),
            el('div', { class: 'maestro-row' }, [
                button({ icon: 'fa-folder-plus', label: t('m23.des.create'), onClick: () => actions.create() }),
                active
                    ? button({
                          icon: 'fa-circle-stop',
                          label: t('m23.des.deactivate'),
                          disabled: model.switching,
                          onClick: () => actions.activate(null),
                      })
                    : null,
            ]),
            toggle({
                label: t('m23.des.autoLink'),
                checked: view.autoLink,
                onChange: (on) => actions.setAutoLink(on),
            }),
            el('div', { class: 'maestro-field-hint', text: t('m23.des.autoLinkHint') }),
            el('div', {
                class: 'maestro-field-hint',
                text: view.interceptEnabled ? t('m23.des.interceptOn') : t('m23.des.interceptOff'),
            }),
            model.switching ? el('div', { class: 'maestro-warn-text', text: t('m23.des.switching') }) : null,
        ]),
    );

    const targets = [
        { value: '', label: t('m23.des.unfiled') },
        ...view.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name })),
    ];

    const bookRow = (book: string, campaignId: string | null): HTMLElement => {
        const move = el('select', {
            class: 'text_pole maestro-m23-move-book',
            attrs: { 'aria-label': t('m23.des.moveBook', { book }) },
        });
        for (const target of targets) move.append(el('option', { text: target.label, attrs: { value: target.value } }));
        move.value = campaignId ?? '';
        move.addEventListener('change', () => {
            void actions.moveBook(book, move.value || null);
        });
        const isActive = model.active.includes(book);
        const isDesGlobal = view.globalBooks.includes(book);
        const autoLinked = view.autoLinked.includes(book);
        const activeBox = el('input', {
            attrs: { type: 'checkbox', 'aria-label': t('m23.books.globalToggle', { book }) },
        });
        activeBox.checked = isActive;
        activeBox.addEventListener('change', () => {
            void actions.setActive(book, activeBox.checked);
        });
        return el('div', { class: 'maestro-m23-campaign-book', data: { book } }, [
            el('label', { class: 'maestro-m23-global', title: t('m23.books.globalHint') }, [
                activeBox,
                icon('fa-power-off'),
            ]),
            el('button', {
                class: 'maestro-m23-book-link',
                text: book,
                attrs: { type: 'button' },
                title: t('m23.des.openBook'),
                on: { click: () => actions.openBook(book) },
            }),
            autoLinked ? el('span', { class: 'maestro-m23-badge', text: t('m23.des.autoLinked') }) : null,
            button({
                icon: 'fa-earth-americas',
                kind: isDesGlobal ? 'primary' : 'ghost',
                title: isDesGlobal ? t('m23.des.globalOn') : t('m23.des.globalOff'),
                onClick: () => actions.toggleDesGlobal(book),
            }),
            move,
        ]);
    };

    const campaignCard = (campaign: CampaignView, index: number): HTMLElement => {
        const card = el('div', {
            class: ['maestro-m23-campaign', campaign.active ? 'maestro-on' : null],
            data: { campaign: campaign.id },
        });
        if (campaign.color) card.style.setProperty('--maestro-m23-campaign-color', campaign.color);
        const picker = el('details', { class: 'maestro-m23-icon-picker' }, [
            el('summary', { title: t('m23.des.icon') }, [icon(campaign.icon)]),
            el(
                'div',
                { class: 'maestro-m23-icon-grid' },
                CAMPAIGN_ICONS.map((name) =>
                    button({
                        icon: name,
                        kind: name === campaign.icon ? 'primary' : 'ghost',
                        title: name.replace('fa-', ''),
                        onClick: () => actions.setIcon(campaign.id, name),
                    }),
                ),
            ),
            el(
                'div',
                { class: 'maestro-m23-color-row' },
                CAMPAIGN_COLORS.map((color) => {
                    const swatch = button({
                        icon: color ? undefined : 'fa-xmark',
                        title: color || t('m23.des.defaultColor'),
                        kind: color === campaign.color ? 'primary' : 'ghost',
                        className: 'maestro-m23-swatch',
                        onClick: () => actions.setColor(campaign.id, color),
                    });
                    if (color) swatch.style.setProperty('--maestro-m23-swatch', color);
                    return swatch;
                }),
            ),
        ]);
        card.append(
            el('div', { class: 'maestro-m23-campaign-head' }, [
                picker,
                el('button', {
                    class: 'maestro-m23-campaign-name',
                    text: campaign.name,
                    attrs: { type: 'button', 'aria-expanded': campaign.collapsed ? 'false' : 'true' },
                    on: { click: () => void actions.toggleCollapsed(campaign.id) },
                }),
                campaign.active
                    ? el('span', { class: 'maestro-m23-badge maestro-m23-badge-active', text: t('m23.des.active') })
                    : null,
                el('span', {
                    class: 'maestro-m23-count',
                    title: t('m23.des.countHint'),
                    text: `${campaign.activeCount}/${campaign.books.length}`,
                }),
                button({
                    icon: campaign.active ? 'fa-circle-check' : 'fa-play',
                    title: campaign.active ? t('m23.des.deactivate') : t('m23.des.activate'),
                    disabled: model.switching,
                    kind: campaign.active ? 'primary' : 'default',
                    onClick: () => actions.activate(campaign.active ? null : campaign.id),
                }),
                button({
                    icon: 'fa-pen',
                    kind: 'ghost',
                    title: t('m23.des.rename'),
                    onClick: () => actions.rename(campaign.id),
                }),
                button({
                    icon: 'fa-arrow-up',
                    kind: 'ghost',
                    title: t('m23.des.up'),
                    disabled: index === 0,
                    onClick: () => actions.move(campaign.id, -1),
                }),
                button({
                    icon: 'fa-arrow-down',
                    kind: 'ghost',
                    title: t('m23.des.down'),
                    disabled: index === view.campaigns.length - 1,
                    onClick: () => actions.move(campaign.id, 1),
                }),
                button({
                    icon: 'fa-trash-can',
                    kind: 'ghost',
                    title: t('m23.des.delete'),
                    disabled: model.switching,
                    onClick: () => actions.remove(campaign.id),
                }),
            ]),
        );
        if (!campaign.collapsed) {
            const books = el('div', { class: 'maestro-m23-campaign-books' });
            if (!campaign.books.length)
                books.append(el('div', { class: 'maestro-muted', text: t('m23.des.emptyCampaign') }));
            for (const book of campaign.books) books.append(bookRow(book, campaign.id));
            card.append(books);
        }
        return card;
    };

    const list = el('div', { class: 'maestro-m23-campaign-list' });
    view.campaigns.forEach((campaign, index) => list.append(campaignCard(campaign, index)));
    if (!view.campaigns.length) list.append(el('div', { class: 'maestro-muted', text: t('m23.des.noCampaigns') }));
    root.append(list);

    const unfiled = el('details', { class: 'maestro-m23-unfiled' }, [
        el('summary', { text: t('m23.des.unfiledCount', { count: view.unfiled.length }) }),
        ...view.unfiled.map((book) => bookRow(book, null)),
    ]);
    root.append(unfiled);

    const workshop = Object.entries(model.workshop);
    if (workshop.length) {
        root.append(
            el('details', { class: 'maestro-m23-workshop' }, [
                el('summary', { text: t('m23.des.workshop', { count: workshop.length }) }),
                el('p', { class: 'maestro-muted', text: t('m23.des.workshopHint') }),
                ...workshop.map(([npc, book]) =>
                    el('div', { class: 'maestro-m23-workshop-row', text: `${npc} → ${book}` }),
                ),
            ]),
        );
    }
    return root;
}
