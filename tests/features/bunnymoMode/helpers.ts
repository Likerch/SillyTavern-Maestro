// Test app for M35 «Режим BunnyMo»: the canon test app (ST mock with an in-memory World Info, real settings, i18n,
// chat store; recording journal, UI and adapters) plus the BunnyMo/CK/DES-RU adapter surface this module reads, the
// fixture books, and a P13 guard: serialised BunnyMo books must never change.
import { BUNNYMO_MODE_STRINGS } from '../../../src/features/bunnymoMode/strings';
import type { SlashCommandSpec } from '../../../src/shared/contracts';
import { createCanonTestApp, listsFrom } from '../canon/helpers';
import type { CanonTestApp, Lists } from '../canon/helpers';
import {
    ARCHIVES,
    BSM,
    CORE,
    COT,
    DERE,
    MBTI_V1,
    MBTI_V2,
    SPECIES,
    SPECIES_A,
    archiveEntries,
    bsmEntries,
    coreEntries,
    cotEntries,
    dereEntries,
    mbtiV1,
    mbtiV2,
    speciesEntries,
    speciesSplitEntries,
} from './fixtures';
import type { Dict } from './fixtures';

export { listsFrom, settle, startModule } from '../canon/helpers';

/** Every BunnyMo book of the fixtures (core first). */
export const BUNNY_BOOKS = [CORE, MBTI_V2, MBTI_V1, DERE, SPECIES, SPECIES_A, BSM, COT];
export const PACK_BOOKS = BUNNY_BOOKS.slice(1);

export interface BunnyEnv extends CanonTestApp {
    /** What the BunnyMo adapter reports (classification of the active books). */
    bunny: { core: string[]; packs: string[]; archives: string[] };
    ck: { repos: string[]; tagLibraries: string[]; settings: Dict; rescans: string[][] };
    desru: { present: boolean; bunnymo: boolean };
    commands: SlashCommandSpec[];
}

export function createBunnyEnv(): BunnyEnv {
    const env = createCanonTestApp();
    env.app.i18n.register(BUNNYMO_MODE_STRINGS);
    env.settings.registerModule('bunnymoMode', () => ({}), true);
    const bunny = { core: [] as string[], packs: [] as string[], archives: [] as string[] };
    const ck = { repos: [] as string[], tagLibraries: [] as string[], settings: {} as Dict, rescans: [] as string[][] };
    const desru = { present: false, bunnymo: false };
    const adapters = env.app.adapters as unknown as Record<string, Dict>;
    adapters.bunnymo = {
        ...adapters.bunnymo,
        books: () => ({ core: [...bunny.core], packs: [...bunny.packs], archives: [...bunny.archives] }),
        activeBooks: async () => [...env.neighbours.active],
    };
    adapters.ck = {
        ...adapters.ck,
        repoBooks: () => [...ck.repos],
        tagLibraries: () => [...ck.tagLibraries],
        settings: () => ck.settings,
        kernel: () => ({ scanSelectedLorebooks: (names: string[]) => void ck.rescans.push([...names]) }),
    };
    adapters.desru = {
        ...adapters.desru,
        present: () => desru.present,
        moduleEnabled: (module: string) => module === 'bunnymo' && desru.bunnymo,
    };
    const commands: SlashCommandSpec[] = [];
    env.ui.addSlashCommand = (command) => {
        commands.push(command);
        return () => {
            const index = commands.indexOf(command);
            if (index >= 0) commands.splice(index, 1);
        };
    };
    return Object.assign(env, { bunny, ck, desru, commands });
}

/** Puts every fixture book into the fake World Info. */
export function loadFixtures(env: BunnyEnv): void {
    env.world.book(CORE, coreEntries());
    env.world.book(MBTI_V2, mbtiV2());
    env.world.book(MBTI_V1, mbtiV1());
    env.world.book(DERE, dereEntries());
    env.world.book(SPECIES, speciesEntries());
    env.world.book(SPECIES_A, speciesSplitEntries());
    env.world.book(BSM, bsmEntries());
    env.world.book(COT, cotEntries());
    env.world.book(ARCHIVES, archiveEntries());
    env.world.book('World', [{ uid: 1, key: ['castle'], comment: 'Castle', content: 'A castle.', disable: false }]);
}

/** Serialised BunnyMo books (P13: must stay identical through every operation). */
export function bunnySnapshot(env: BunnyEnv): string {
    return JSON.stringify(BUNNY_BOOKS.map((book) => [book, env.world.books.get(book) ?? null]));
}

/** Saves of BunnyMo books (must stay empty). */
export function bunnySaves(env: BunnyEnv): string[] {
    return env.world.saves.map((save) => save.name).filter((name) => BUNNY_BOOKS.includes(name));
}

/** Scan lists with every fixture book active (global), the archives as the character book. */
export function allLists(env: BunnyEnv): Lists {
    return listsFrom(env.world, { globalLore: [...BUNNY_BOOKS, 'World'], characterLore: [ARCHIVES] });
}

/** A File like the browser's (Node 20+ has File). */
export function file(name: string, data: unknown): File {
    return new File([typeof data === 'string' ? data : JSON.stringify(data)], name, { type: 'application/json' });
}
