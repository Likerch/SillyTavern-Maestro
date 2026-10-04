// What M35 reads from SillyTavern and the neighbours to tell book roles apart: lorebook names and contents (context
// loadWorldInfo / getWorldInfoNames), card bindings of every character (`data.extensions.world` and world-info.js
// `world_info.charLore`), the chat book, persona books, the global selection, CarrotKernel repos and the DES roster.
// Read-only.
import { adaptersOf } from '../../adapters';
import { emptyRoleContext } from '../../domain/roles-detect';
import type { RoleContext } from '../../domain/roles-detect';
import type { App, Logger } from '../../shared/contracts';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

/** Every lorebook ST knows (a copy), or null when this ST has no getWorldInfoNames. */
export function worldNames(app: App): string[] | null {
    const names = app.host.ctx().getWorldInfoNames?.();
    return Array.isArray(names) ? strings(names) : null;
}

/** A deep copy of a book from ST's cache (loadWorldInfo clones on get); null when it is missing or unreadable. */
export async function loadBook(app: App, book: string, log: Logger): Promise<Dict | null> {
    const load = app.host.ctx().loadWorldInfo;
    if (typeof load !== 'function') return null;
    try {
        const data = await load(book);
        return isDict(data) && isDict(data.entries) ? data : null;
    } catch (error) {
        log.debug(`lorebook ${book} did not load`, error);
        return null;
    }
}

async function worldInfoModule(app: App, log: Logger): Promise<Dict | null> {
    try {
        return await app.host.modules.worldInfo();
    } catch (error) {
        log.debug('world-info.js is not available', error);
        return null;
    }
}

/** Bindings and neighbour state for detectRole(). Missing pieces are left empty, never thrown. */
export async function readRoleContext(app: App, log: Logger): Promise<RoleContext> {
    const context = emptyRoleContext();
    const ctx = app.host.ctx();
    const module = await worldInfoModule(app, log);
    const settings = module && isDict(module.world_info) ? module.world_info : null;

    const cardBooks = new Set<string>();
    for (const character of ctx.characters ?? []) {
        const primary = character?.data?.extensions?.world;
        if (typeof primary === 'string' && primary) cardBooks.add(primary);
    }
    for (const lore of Array.isArray(settings?.charLore) ? settings.charLore : []) {
        if (isDict(lore)) for (const book of strings(lore.extraBooks)) cardBooks.add(book);
    }
    context.cardBooks = cardBooks;

    const chatBook = ctx.chatMetadata?.world_info;
    context.chatBook = typeof chatBook === 'string' && chatBook ? chatBook : null;

    const personaBooks = new Set<string>();
    const power = isDict(ctx.powerUserSettings) ? ctx.powerUserSettings : {};
    if (typeof power.persona_description_lorebook === 'string' && power.persona_description_lorebook) {
        personaBooks.add(power.persona_description_lorebook);
    }
    if (isDict(power.persona_descriptions)) {
        for (const persona of Object.values(power.persona_descriptions)) {
            if (isDict(persona) && typeof persona.lorebook === 'string' && persona.lorebook) {
                personaBooks.add(persona.lorebook);
            }
        }
    }
    context.personaBooks = personaBooks;
    context.globalBooks = new Set(strings(module?.selected_world_info));

    const adapters = adaptersOf(app);
    try {
        context.ckRepos = new Set(adapters.ck.repoBooks());
    } catch (error) {
        log.debug('CarrotKernel repos are not available', error);
    }
    try {
        const names = [...adapters.des.knownCharacters(), ...Object.keys(adapters.des.aliases())];
        context.npcNames = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
    } catch (error) {
        log.debug('DES roster is not available', error);
    }
    return context;
}

/** Books ST scans in this chat (BunnyMo adapter's list: global, chat, persona, character books). */
export async function activeBooks(app: App, log: Logger): Promise<string[]> {
    try {
        return await adaptersOf(app).bunnymo.activeBooks();
    } catch (error) {
        log.debug('active books are not available', error);
        const ctx = app.host.ctx();
        const chatBook = ctx.chatMetadata?.world_info;
        return typeof chatBook === 'string' && chatBook ? [chatBook] : [];
    }
}
