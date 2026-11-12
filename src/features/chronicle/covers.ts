// Chapter covers (plan §3.19 «Обложки глав», release 1.33): the agent «Обложки глав» writes a picture for a chapter of
// the chronicle that has none — the same marker object as the illustrator's — and NAI Studio 0.16 draws it into no
// message (`drawPicture`, saved into /user/images). The cover is kept in the chat document 'chronicle-covers' by the
// chapter's uid; «Летопись» shows it on the chapter. The receiver `chronicle.cover` journals each cover with undo (the
// file stays in /user/images). Free only unless the agents may spend Anlas.
import { adaptersOf } from '../../adapters';
import { registerProposalReceiver } from '../../core/proposal-receivers';
import { userImageUrl } from '../../domain/user-images';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { AgentsApi } from '../agents/api';
import type { Chapter } from './api';
import { CHRONICLE_KEY } from './settings';

export const COVERS_DOC = 'chronicle-covers';
export const COVER_KIND = 'chronicle.cover';
export const COVER_TARGET = 'm9.cover';

export interface ChapterCover {
    /** /user/images path of the picture. */
    path: string;
    caption?: string;
    at: number;
}

export interface CoversDoc {
    covers: Record<string, ChapterCover>;
}

const isDict = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function readCovers(raw: unknown): CoversDoc {
    const covers: Record<string, ChapterCover> = {};
    if (isDict(raw) && isDict(raw.covers)) {
        for (const [uid, value] of Object.entries(raw.covers)) {
            if (!isDict(value) || typeof value.path !== 'string' || !value.path) continue;
            const cover: ChapterCover = { path: value.path, at: typeof value.at === 'number' ? value.at : 0 };
            if (typeof value.caption === 'string' && value.caption) cover.caption = value.caption;
            covers[uid] = cover;
        }
    }
    return { covers };
}

/** A /user/images path as a URL the page can show. */
export const coverUrl = userImageUrl;

export interface CoverDeps {
    chapters(): Promise<Chapter[]>;
    /** The chapter's text in the canon ('' when unknown). */
    chapterText(uid: number): Promise<string>;
}

export class ChapterCovers {
    private cache: { chatId: string; doc: CoversDoc } | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly deps: CoverDeps,
    ) {}

    async all(): Promise<Record<string, ChapterCover>> {
        const chatId = this.app.host.chatId();
        if (!chatId) return {};
        if (this.cache?.chatId !== chatId) {
            const doc = readCovers(await this.app.chat.get(COVERS_DOC, () => ({ covers: {} })));
            this.cache = { chatId, doc };
        }
        return { ...this.cache.doc.covers };
    }

    async set(uid: number, cover: ChapterCover | null): Promise<boolean> {
        const chatId = this.app.host.chatId();
        if (!chatId) return false;
        const doc = readCovers(await this.app.chat.get(COVERS_DOC, () => ({ covers: {} })));
        if (cover) doc.covers[String(uid)] = cover;
        else delete doc.covers[String(uid)];
        const ok = await this.app.chat.put(COVERS_DOC, doc);
        if (ok && this.app.host.chatId() === chatId) this.cache = { chatId, doc };
        this.emit();
        return ok;
    }

    /** Chapters without a cover, oldest first. */
    async uncovered(): Promise<Chapter[]> {
        const covers = await this.all();
        return (await this.deps.chapters()).filter((chapter) => !covers[String(chapter.uid)]);
    }

    /** For the agent: the chapters without a cover with their text. */
    async agentText(budget: number): Promise<string> {
        const parts: string[] = [];
        let used = 0;
        for (const chapter of await this.uncovered()) {
            const text = (await this.deps.chapterText(chapter.uid)).trim();
            const part = `[chapter ${chapter.uid}] ${chapter.title} (messages ${chapter.from}–${chapter.to})\n${text}`;
            if (used + part.length > budget && parts.length) break;
            parts.push(part.slice(0, Math.max(0, budget - used)));
            used += part.length;
        }
        return parts.join('\n\n');
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    chatChanged(): void {
        this.cache = null;
        this.emit();
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.warn('chapter covers listener failed', error);
            }
        }
    }

    /** Undo of a cover (journal target m9.cover): gone when it is still the one set. */
    async undo(change: JournalChange): Promise<boolean> {
        const uid = typeof change.ref.uid === 'number' ? change.ref.uid : NaN;
        const chatId = typeof change.ref.chatId === 'string' ? change.ref.chatId : '';
        const after = isDict(change.after) ? change.after : null;
        if (!Number.isFinite(uid) || chatId !== this.app.host.chatId()) return false;
        const current = (await this.all())[String(uid)];
        if (!current || (after && current.path !== after.path)) return false;
        const before = isDict(change.before) && typeof change.before.path === 'string' ? change.before : null;
        return this.set(uid, before ? (before as unknown as ChapterCover) : null);
    }

    installReceiver(): Unsubscribe {
        const t = (key: string, params?: Record<string, string | number>) => this.app.i18n.t(key, params);
        const freeOnly = () => this.app.modules.api<AgentsApi>('agents')?.imagesPaid?.() !== true;
        interface Payload {
            uid: number;
            title: string;
            chatId: string;
            marker: Record<string, unknown>;
            freeOnly: boolean;
        }
        const draw = async (raw: unknown, changes?: JournalChange[]): Promise<void> => {
            const payload = raw as Payload;
            if (this.app.host.chatId() !== payload.chatId) throw new Error(t('m9.cover.otherChat'));
            const result = await adaptersOf(this.app).nai.drawPicture({
                marker: payload.marker,
                freeOnly: payload.freeOnly,
                name: 'cover',
            });
            if (!result.ok || !result.path) throw new Error(t('m9.cover.failed', { error: result.error ?? '' }));
            if (this.app.host.chatId() !== payload.chatId) throw new Error(t('m9.cover.otherChat'));
            const before = (await this.all())[String(payload.uid)] ?? null;
            const cover: ChapterCover = { path: result.path, at: Date.now() };
            const caption = typeof payload.marker.caption === 'string' ? payload.marker.caption.trim() : '';
            if (caption) cover.caption = caption;
            await this.set(payload.uid, cover);
            changes?.push({
                target: COVER_TARGET,
                ref: { uid: payload.uid, chatId: payload.chatId, title: payload.title },
                before,
                after: cover,
            });
        };
        return registerProposalReceiver({
            kind: COVER_KIND,
            module: CHRONICLE_KEY,
            labelKey: 'm44.recv.chronicle.cover',
            describe:
                'a cover picture for one chapter of the chronicle that has none (the chapters are in the sources, each with its number). chapter: that number; marker: the picture as the image rules describe a marker — the object of data-nai (prompt: the scene that best stands for the chapter as a whole, chars with name / look / action / pos, ratio, caption: the chapter in a few words). One item per chapter, at most two.',
            schema: {
                type: 'object',
                properties: { chapter: { type: 'number' }, marker: { type: 'object' } },
                required: ['chapter', 'marker'],
            },
            defaultAutonomy: 'auto',
            direct: true,
            available: async () => adaptersOf(this.app).nai.canDrawPicture() && (await this.uncovered()).length > 0,
            toProposal: async (data, context): Promise<Proposal | null> => {
                const uid = typeof data.chapter === 'number' ? data.chapter : Number(data.chapter);
                const marker = isDict(data.marker) ? structuredClone(data.marker) : null;
                const chatId = this.app.host.chatId();
                if (!Number.isFinite(uid) || !marker || typeof marker.prompt !== 'string' || !chatId) return null;
                const chapter = (await this.uncovered()).find((item) => item.uid === uid);
                if (!chapter) return null;
                const changes: JournalChange[] = [];
                const payload: Payload = { uid, title: chapter.title, chatId, marker, freeOnly: freeOnly() };
                const proposal: Proposal = {
                    module: CHRONICLE_KEY,
                    kind: COVER_KIND,
                    title: t('m9.cover.title', { title: chapter.title }),
                    changes,
                    payload,
                    apply: (value) => draw(value, changes),
                };
                if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
                return proposal;
            },
            apply: (raw) => draw(raw),
        });
    }
}
