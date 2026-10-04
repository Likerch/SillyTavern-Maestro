import { describe, expect, it } from 'vitest';
import {
    CAMPAIGN_COLORS,
    CAMPAIGN_ICONS,
    campaignOfBook,
    libraryView,
    moveCampaign,
    safeColor,
    safeIcon,
    workshopLinks,
} from '../../src/domain/lore-studio-campaigns';

describe('DES campaigns view', () => {
    it('only passes hex colours and icon classes', () => {
        expect(CAMPAIGN_ICONS).toHaveLength(32);
        expect(CAMPAIGN_COLORS).toContain('');
        expect(safeColor('#e94560')).toBe('#e94560');
        expect(safeColor('#abc')).toBe('#abc');
        expect(safeColor('red;background:url(x)')).toBe('');
        expect(safeColor(3)).toBe('');
        expect(safeIcon('fa-dragon')).toBe('fa-dragon');
        expect(safeIcon('fa-x" onclick')).toBe('fa-folder');
        expect(safeIcon(undefined)).toBe('fa-folder');
    });

    it('builds the library as DES draws it', () => {
        const lorebook = {
            enabled: true,
            campaigns: {
                b: { id: 'b', name: 'Second', icon: 'fa-gem', color: '#2ecc71', books: ['World', 'Gone'] },
                a: { id: 'a', name: 'First', books: ['Lore'] },
                c: { id: 'c', books: 'bad' },
                broken: 'junk',
            },
            campaignOrder: ['a', 'b', 'missing'],
            collapsedCampaigns: ['b'],
            activeCampaignId: 'b',
            globalBooks: ['World'],
            autoLinked: ['Anna'],
            campaignActivated: ['World'],
            autoLinkByName: false,
        };
        const view = libraryView(lorebook, ['World', 'Lore', 'Anna', 'Free'], ['World', 'Anna']);
        expect(view.campaigns.map((campaign) => campaign.id)).toEqual(['a', 'b', 'c']);
        const second = view.campaigns[1]!;
        expect(second).toMatchObject({
            name: 'Second',
            icon: 'fa-gem',
            color: '#2ecc71',
            books: ['World'],
            activeCount: 1,
            active: true,
            collapsed: true,
        });
        expect(view.campaigns[0]?.icon).toBe('fa-folder');
        expect(view.campaigns[2]?.name).toBe('c');
        expect(view.unfiled).toEqual(['Anna', 'Free']);
        expect(view.activeId).toBe('b');
        expect(view.autoLink).toBe(false);
        expect(view.interceptEnabled).toBe(true);
        expect(view.globalBooks).toEqual(['World']);
        expect(view.autoLinked).toEqual(['Anna']);
        expect(view.campaignActivated).toEqual(['World']);
        expect(campaignOfBook(view, 'Lore')?.id).toBe('a');
        expect(campaignOfBook(view, 'Free')).toBeUndefined();
    });

    it('handles a missing lorebook object', () => {
        const view = libraryView(undefined, ['A'], []);
        expect(view).toMatchObject({
            campaigns: [],
            unfiled: ['A'],
            activeId: null,
            autoLink: true,
            interceptEnabled: false,
        });
        expect(libraryView({ activeCampaignId: 'x', campaigns: {} }, [], []).activeId).toBeNull();
    });

    it('reorders campaigns', () => {
        expect(moveCampaign(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
        expect(moveCampaign(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
        expect(moveCampaign(['a', 'b', 'c'], 'a', 5)).toEqual(['b', 'c', 'a']);
        expect(moveCampaign(['a'], 'z', 1)).toEqual(['a']);
    });

    it('reads Workshop book links', () => {
        expect(
            workshopLinks({
                characterInjection: { Anna: { lorebook: 'Anna lore' }, Bob: { lorebook: '' }, Eve: 'junk' },
                userCharacters: { Me: { injection: { lorebook: 'My lore' } }, You: { injection: {} } },
            }),
        ).toEqual({ Anna: 'Anna lore', Me: 'My lore' });
        expect(workshopLinks(null)).toEqual({});
    });
});
