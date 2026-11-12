// Release 1.33 «Обложки глав»: covers kept by chapter uid in the chat document, the chapters without one (with their
// text) for the agent, the receiver drawing through NAI Studio (free only by default) and journaling with undo.
import { afterEach, describe, expect, it } from 'vitest';
import { proposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import { COVER_KIND, COVER_TARGET, ChapterCovers, readCovers } from '../../../src/features/chronicle/covers';
import type { App } from '../../../src/shared/contracts';
import { userImageUrl } from '../../../src/domain/user-images';
import { createTestI18n, createTestLogger } from '../../helpers/core-host';

afterEach(() => resetProposalReceivers());

function setup(options: { paid?: boolean; draw?: { ok: boolean; path?: string; error?: string } } = {}) {
    const docs = new Map<string, unknown>();
    const drawn: Record<string, unknown>[] = [];
    let chatId = 'chat-1';
    const app = {
        host: { chatId: () => chatId },
        i18n: createTestI18n('en'),
        chat: {
            get: async (kind: string, defaults: () => object) => structuredClone(docs.get(kind) ?? defaults()),
            put: async (kind: string, data: unknown) => {
                docs.set(kind, structuredClone(data));
                return true;
            },
        },
        adapters: {
            nai: {
                canDrawPicture: () => true,
                drawPicture: async (input: Record<string, unknown>) => {
                    drawn.push(input);
                    return options.draw ?? { ok: true, path: 'user/images/Mira/Mira_cover.png' };
                },
            },
        },
        modules: { api: (key: string) => (key === 'agents' ? { imagesPaid: () => options.paid === true } : undefined) },
    } as unknown as App;
    const chapters = [
        { uid: 4, title: 'The tavern', from: 2, to: 9, keys: [], secondary: [], chars: 100 },
        { uid: 7, title: 'The road', from: 10, to: 20, keys: [], secondary: [], chars: 100 },
    ];
    const covers = new ChapterCovers(app, createTestLogger(), {
        chapters: async () => chapters,
        chapterText: async (uid) => (uid === 4 ? 'They met at the inn.' : 'They left at dawn.'),
    });
    const off = covers.installReceiver();
    return { covers, docs, drawn, off, switchChat: (id: string) => (chatId = id) };
}

describe('chapter covers', () => {
    it('chapters without a cover for the agent; the receiver draws free only and journals with undo', async () => {
        const { covers, drawn } = setup();
        expect(await covers.agentText(4000)).toBe(
            '[chapter 4] The tavern (messages 2–9)\nThey met at the inn.\n\n[chapter 7] The road (messages 10–20)\nThey left at dawn.',
        );
        const receiver = proposalReceiver(COVER_KIND)!;
        expect(await receiver.available?.({})).toBe(true);
        expect(await receiver.toProposal({ chapter: 99, marker: { prompt: 'x' } }, { agentName: 'A' })).toBeNull();
        const proposal = (await receiver.toProposal(
            { chapter: 4, marker: { prompt: 'an inn at night', caption: 'Meeting' } },
            { agentName: 'A' },
        ))!;
        await proposal.apply(proposal.payload);
        expect(drawn).toEqual([
            { marker: { prompt: 'an inn at night', caption: 'Meeting' }, freeOnly: true, name: 'cover' },
        ]);
        const all = await covers.all();
        expect(all['4']).toMatchObject({ path: 'user/images/Mira/Mira_cover.png', caption: 'Meeting' });
        expect((await covers.uncovered()).map((c) => c.uid)).toEqual([7]);
        expect(proposal.changes).toHaveLength(1);
        expect(proposal.changes[0]!.target).toBe(COVER_TARGET);
        expect(await covers.undo(proposal.changes[0]!)).toBe(true);
        expect(await covers.all()).toEqual({});
    });

    it('a failed drawing sets nothing; another chat is not touched', async () => {
        const { covers, switchChat } = setup({ draw: { ok: false, error: 'free-only-blocked' } });
        const receiver = proposalReceiver(COVER_KIND)!;
        const proposal = (await receiver.toProposal({ chapter: 7, marker: { prompt: 'a road' } }, { agentName: 'A' }))!;
        await expect(proposal.apply(proposal.payload)).rejects.toThrow('m9.cover.failed');
        expect(await covers.all()).toEqual({});
        switchChat('chat-2');
        await expect(proposal.apply(proposal.payload)).rejects.toThrow();
    });

    it('reads its document defensively; paths become URLs', () => {
        expect(readCovers({ covers: { 1: { path: 'a.png', at: 2 }, 2: { path: '' }, 3: 'x' } })).toEqual({
            covers: { 1: { path: 'a.png', at: 2 } },
        });
        expect(readCovers(null)).toEqual({ covers: {} });
        expect(userImageUrl('user\\images\\Мира\\a b.png')).toBe('/user/images/%D0%9C%D0%B8%D1%80%D0%B0/a%20b.png');
    });
});
