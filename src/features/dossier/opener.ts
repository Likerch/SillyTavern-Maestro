// «Открыть» on a dossier section: the owner's own editor for the source. Lorebook entries open in the Lore Studio
// (its open(book, uid) when the studio exposes one, else `/maestro-lore <book>`, else ST's World Info editor); chat
// messages are scrolled to (`/chat-jump` loads older messages first); places open the places tab. NAI Studio's API
// has no way to open a passport, so passport sections only name the place to edit them (NAI Studio → passports).
// Sources without an editor get no button.
import type { App, Logger } from '../../shared/contracts';
import type { EntitySource } from '../world/api';
import type { DossierSection } from './api';

/** What the Lore Studio exposes under 'loreStudio'. */
interface LoreStudioOpener {
    open?(book?: string, uid?: number): void;
}

const PLACES_TAB = 'places';

function bookOf(source: EntitySource | undefined): string | null {
    return source?.world && ['lore.entry', 'canon.entry', 'ck.archive', 'persona'].includes(source.kind)
        ? source.world
        : null;
}

export class DossierOpener {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** The section can be opened somewhere. */
    canOpen(section: Pick<DossierSection, 'source' | 'messageIndex'>): boolean {
        const source = section.source;
        if (section.messageIndex !== undefined || source?.messageIndex !== undefined) return true;
        if (bookOf(source)) return true;
        return source?.kind === 'place';
    }

    async open(section: Pick<DossierSection, 'source' | 'messageIndex'>): Promise<void> {
        const source = section.source;
        const book = bookOf(source);
        if (book) {
            await this.openEntry(book, typeof source?.uid === 'number' ? source.uid : undefined);
            return;
        }
        const message = section.messageIndex ?? source?.messageIndex;
        if (message !== undefined) {
            await this.jump(message);
            return;
        }
        if (source?.kind === 'place') this.app.ui.openPult(PLACES_TAB);
    }

    private async openEntry(book: string, uid?: number): Promise<void> {
        const studio = this.app.modules.api<LoreStudioOpener>('loreStudio');
        if (typeof studio?.open === 'function') {
            this.app.ui.closePult?.();
            studio.open(book, uid);
            return;
        }
        const ctx = this.app.host.ctx();
        if (this.app.modules.api('loreStore') && typeof ctx.executeSlashCommandsWithOptions === 'function') {
            this.app.ui.closePult?.();
            await ctx.executeSlashCommandsWithOptions(`/maestro-lore ${book}`, { handleExecutionErrors: true });
            return;
        }
        try {
            const module = await this.app.host.modules.worldInfo();
            const open = module.openWorldInfoEditor;
            if (typeof open === 'function') {
                this.app.ui.closePult?.();
                (open as (name: string) => void)(book);
            }
        } catch (error) {
            this.log.debug('cannot open the lorebook editor', error);
        }
    }

    private async jump(index: number): Promise<void> {
        this.app.ui.closePult?.();
        const ctx = this.app.host.ctx();
        if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return;
        try {
            await ctx.executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true });
        } catch (error) {
            this.log.debug('chat-jump failed', error);
        }
    }
}
