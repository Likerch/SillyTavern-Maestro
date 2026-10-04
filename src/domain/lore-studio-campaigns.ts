// DES Lore Library campaigns as the Lore Studio shows them (research/parity-lore.md §9, L-186…L-207). DES owns the
// data (Q32); these helpers only read `extensionSettings.lorebook` and prepare arguments for DES's own API. Pure.
import { isRecord, stringList } from './lore-studio-entries';

/** DES's icon palette (rendering/lorebook.js CAMPAIGN_ICONS). */
export const CAMPAIGN_ICONS = [
    'fa-dragon',
    'fa-hat-wizard',
    'fa-wand-sparkles',
    'fa-shield-halved',
    'fa-skull-crossbones',
    'fa-crown',
    'fa-dungeon',
    'fa-rocket',
    'fa-robot',
    'fa-atom',
    'fa-satellite',
    'fa-meteor',
    'fa-user-astronaut',
    'fa-mountain-sun',
    'fa-tree',
    'fa-water',
    'fa-globe',
    'fa-seedling',
    'fa-ghost',
    'fa-heart',
    'fa-masks-theater',
    'fa-gun',
    'fa-car',
    'fa-city',
    'fa-house',
    'fa-scroll',
    'fa-folder',
    'fa-book',
    'fa-star',
    'fa-fire',
    'fa-bolt',
    'fa-gem',
] as const;

/** DES's colour palette; '' is «default». */
export const CAMPAIGN_COLORS = [
    '#e94560',
    '#e07b39',
    '#f0c040',
    '#2ecc71',
    '#1abc9c',
    '#4a7ba7',
    '#9b59b6',
    '#e84393',
    '#95a5a6',
    '',
] as const;

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** DES writes the colour into `style` unchecked: only hex colours (or '') are passed on and shown. */
export function safeColor(color: unknown): string {
    return typeof color === 'string' && COLOR_RE.test(color) ? color : '';
}

export function safeIcon(icon: unknown): string {
    return typeof icon === 'string' && /^fa-[a-z0-9-]+$/.test(icon) ? icon : 'fa-folder';
}

export interface CampaignView {
    id: string;
    name: string;
    icon: string;
    color: string;
    /** Books of the campaign that exist in ST (stale names hidden, like DES). */
    books: string[];
    /** How many of them are globally active. */
    activeCount: number;
    active: boolean;
    collapsed: boolean;
}

export interface LibraryView {
    campaigns: CampaignView[];
    unfiled: string[];
    activeId: string | null;
    globalBooks: string[];
    autoLinked: string[];
    campaignActivated: string[];
    autoLink: boolean;
    interceptEnabled: boolean;
}

/** The library as DES draws it (L-186, L-187) from `extensionSettings.lorebook`. */
export function libraryView(
    lorebook: unknown,
    worldNames: readonly string[],
    activeBooks: readonly string[],
): LibraryView {
    const lb = isRecord(lorebook) ? lorebook : {};
    const campaigns = isRecord(lb.campaigns) ? lb.campaigns : {};
    const order = stringList(lb.campaignOrder);
    const ids = [
        ...order.filter((id) => isRecord(campaigns[id])),
        ...Object.keys(campaigns).filter((id) => !order.includes(id)),
    ];
    const existing = new Set(worldNames);
    const active = new Set(activeBooks);
    const collapsed = new Set(stringList(lb.collapsedCampaigns));
    const activeId =
        typeof lb.activeCampaignId === 'string' && isRecord(campaigns[lb.activeCampaignId])
            ? lb.activeCampaignId
            : null;
    const filed = new Set<string>();
    const views: CampaignView[] = [];
    for (const id of [...new Set(ids)]) {
        const raw = campaigns[id];
        if (!isRecord(raw)) continue;
        const allBooks = stringList(raw.books);
        for (const book of allBooks) filed.add(book);
        const books = allBooks.filter((book) => existing.has(book));
        views.push({
            id,
            name: typeof raw.name === 'string' ? raw.name : id,
            icon: safeIcon(raw.icon),
            color: safeColor(raw.color),
            books,
            activeCount: books.filter((book) => active.has(book)).length,
            active: id === activeId,
            collapsed: collapsed.has(id),
        });
    }
    return {
        campaigns: views,
        unfiled: worldNames.filter((book) => !filed.has(book)),
        activeId,
        globalBooks: stringList(lb.globalBooks),
        autoLinked: stringList(lb.autoLinked),
        campaignActivated: stringList(lb.campaignActivated),
        autoLink: lb.autoLinkByName !== false,
        interceptEnabled: lb.enabled === true,
    };
}

/** Campaign order after moving one id by `delta` places (full, validated list for `reorderCampaigns`). */
export function moveCampaign(order: readonly string[], id: string, delta: number): string[] {
    const list = [...order];
    const from = list.indexOf(id);
    if (from < 0) return list;
    const to = Math.min(Math.max(0, from + delta), list.length - 1);
    list.splice(from, 1);
    list.splice(to, 0, id);
    return list;
}

/** Campaign of a book, if filed. */
export function campaignOfBook(view: LibraryView, book: string): CampaignView | undefined {
    return view.campaigns.find((campaign) => campaign.books.includes(book));
}

/** Workshop links `NPC → book` (characterInjection[name].lorebook and userCharacters[name].injection.lorebook). */
export function workshopLinks(desSettings: unknown): Record<string, string> {
    const settings = isRecord(desSettings) ? desSettings : {};
    const links: Record<string, string> = {};
    const injection = isRecord(settings.characterInjection) ? settings.characterInjection : {};
    for (const [name, value] of Object.entries(injection)) {
        if (isRecord(value) && typeof value.lorebook === 'string' && value.lorebook) links[name] = value.lorebook;
    }
    const users = isRecord(settings.userCharacters) ? settings.userCharacters : {};
    for (const [name, value] of Object.entries(users)) {
        const own = isRecord(value) && isRecord(value.injection) ? value.injection.lorebook : undefined;
        if (typeof own === 'string' && own) links[name] = own;
    }
    return links;
}
