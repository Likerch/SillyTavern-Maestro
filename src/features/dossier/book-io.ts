// Lorebook reads and writes of the dossier (ARCHITECTURE «Lorebook writes»): a fresh copy is loaded, changed and
// saved at once with saveWorldInfo(name, data, true); then ST's editor is reloaded and DES's Lore Library cache reset.
// A new book is announced to ST's book list (updateWorldInfoList). Null when this SillyTavern cannot load or save.
import { adaptersOf } from '../../adapters';
import { isBookData } from '../../domain/doctor-fixes';
import type { BookData, BookIo } from '../../domain/doctor-fixes';
import type { App, Logger } from '../../shared/contracts';

export interface DossierBookIo extends BookIo {
    /** Saves a new book (empty entries unless given) and refreshes ST's book list. */
    create(book: string, data?: BookData): Promise<void>;
}

export function bookIo(app: App, log: Logger): DossierBookIo | null {
    const ctx = app.host.ctx();
    if (typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') return null;
    const save = async (book: string, data: BookData): Promise<void> => {
        const current = app.host.ctx();
        await current.saveWorldInfo?.(book, data, true);
        try {
            current.reloadWorldInfoEditor?.(book);
        } catch (error) {
            log.debug('lorebook editor reload failed', error);
        }
        try {
            adaptersOf(app).des.invalidateLoreCache(book);
        } catch (error) {
            log.debug('DES Lore Library cache reset failed', error);
        }
    };
    return {
        load: async (book) => {
            const data: unknown = await app.host.ctx().loadWorldInfo?.(book);
            return isBookData(data) ? data : null;
        },
        save,
        create: async (book, data = { entries: {} }) => {
            await save(book, data);
            try {
                await app.host.ctx().updateWorldInfoList?.();
            } catch (error) {
                log.warn('lorebook list was not refreshed', error);
            }
        },
    };
}
