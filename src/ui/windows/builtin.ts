// Maestro's own windows (plan-2 §10): each gathers the pult tabs of one plan §7 group as its sections. The «Maestro»
// window keeps the overview, journal, general settings, the look and the neighbours' dock, and takes every tab no
// other window claims; the studio launchers live there too (the studios themselves are windows of their modules).
import type { MaestroWindowSpec } from '../../shared/contracts';
import { MORE_GROUP, TOP_GROUP } from '../views/pult-groups';
import { MAESTRO_WINDOW } from './sections';

/** Window ids of the studios (registered by their modules; hidden from the window list, offered as launchers). */
export const STUDIO_WINDOWS: readonly string[] = ['loreStudio', 'presetStudio'];

export const BUILTIN_WINDOWS: readonly MaestroWindowSpec[] = [
    {
        id: 'assistant',
        titleKey: 'ui.window.assistant',
        icon: 'fa-comments',
        order: 10,
        groups: ['assistant'],
        defaultDock: 'right',
        defaultWidth: 520,
    },
    { id: 'inbox', titleKey: 'ui.window.inbox', icon: 'fa-inbox', order: 20, groups: ['inbox'] },
    { id: 'characters', titleKey: 'ui.window.characters', icon: 'fa-address-card', order: 30, groups: ['dossier'] },
    { id: 'mechanics', titleKey: 'ui.window.mechanics', icon: 'fa-dice-d20', order: 40, groups: ['mechanics'] },
    { id: 'world', titleKey: 'ui.window.world', icon: 'fa-earth-europe', order: 50, groups: ['world'] },
    { id: 'canon', titleKey: 'ui.window.canon', icon: 'fa-scroll', order: 60, groups: ['canon'] },
    { id: 'turn', titleKey: 'ui.window.turn', icon: 'fa-clapperboard', order: 70, groups: ['turn'] },
    { id: 'health', titleKey: 'ui.window.health', icon: 'fa-heart-pulse', order: 80, groups: ['health'] },
    {
        id: MAESTRO_WINDOW,
        titleKey: 'ui.window.maestro',
        icon: 'fa-wand-magic-sparkles',
        order: 90,
        // The studios' launcher tabs (pult ids 'loreStudio', 'presetStudio') would otherwise join «Канон» by group.
        tabs: ['overview', 'loreStudio', 'presetStudio'],
        groups: [TOP_GROUP, 'journal', 'extensions', MORE_GROUP, 'settings'],
        defaultDock: 'right',
        defaultWidth: 560,
    },
];
