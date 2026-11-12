// Release 1.33: pictures by agents through NAI Studio 0.16. The illustrator runs only while NAI Studio gives it the
// reply (its mode, «…when the main model wrote none» for a reply without a marker) and its marker goes to NAI Studio in
// the main model's form, free only by default; Maestro is NAI Studio's illustrator exactly while such an agent is on;
// the portraitist writes a passport into the chat (journaled, undone) and asks DES's portrait; a face is shown to it
// once; the card's avatar is never applied by itself.
import { afterEach, describe, expect, it } from 'vitest';
import { proposalReceiver } from '../../../src/core/proposal-receivers';
import {
    CARD_AVATAR_KIND,
    ILLUSTRATE_KIND,
    ILLUSTRATOR_ID,
    PORTRAIT_KIND,
    facesWithoutPassport,
    portraitlessText,
    resetShownFaces,
    unseenFaces,
} from '../../../src/features/agents/image-receivers';
import type { LlmRequest } from '../../../src/shared/contracts';
import { settle } from '../../helpers/core-host';
import { msg, withAgents } from './harness';
import type { Harness } from './harness';

type Writer = 'main' | 'illustrator' | 'fallback';

function fakeNai() {
    const state = {
        writer: { setting: 'illustrator' as Writer, effective: 'illustrator' as Writer },
        markers: [] as unknown[],
        passports: [] as { kind: string; name: string; aliases: string[]; id: string }[],
        registered: [] as string[],
        requests: [] as Record<string, unknown>[],
        saved: [] as { id: string; scope: string }[],
        cleared: [] as string[],
        portraits: [] as string[],
        avatars: [] as Record<string, unknown>[],
    };
    const nai = {
        api: () => ({
            generatePassport: () => null,
            savePassport: async (p: { id: string }, scope: string) => void state.saved.push({ id: p.id, scope }),
            clearChatOverride: async (id: string) => void state.cleared.push(id),
        }),
        canIllustrate: () => true,
        markerWriter: () => state.writer,
        registerIllustrator: (id: string) => {
            state.registered.push(id);
            return () => state.registered.splice(state.registered.indexOf(id), 1);
        },
        markerRules: async () => '<images>THE RULES</images>',
        messageMarkers: () => state.markers,
        requestImage: async (request: Record<string, unknown>) => {
            state.requests.push(request);
            return { ok: true, imageId: 'img1' };
        },
        chatPassports: () => state.passports,
        generatePassport: async (input: { name: string }) => ({
            id: `p-${input.name}`,
            kind: 'character',
            name: input.name,
            aliases: [],
            tags: '',
            slots: {},
            outfits: [],
            activeOutfit: '',
            states: [],
            negative: '',
        }),
        canRequestDesPortrait: () => true,
        requestDesPortrait: async (name: string) => {
            state.portraits.push(name);
            return true;
        },
        canCardAvatar: () => true,
        passportsOf: () => [],
        generateCardAvatar: async (input: Record<string, unknown>) => {
            state.avatars.push(input);
            return { ok: true, backup: 'user/images/avatar-backups/Mira.png' };
        },
    };
    const des = { trackerFor: () => ({ characters: [{ name: 'Кай' }, { name: 'Мира' }, { name: 'Я' }] }) };
    return { state, adapters: { nai, des } };
}

const ILLUSTRATOR = {
    id: 'u-illustrator-aaaaa',
    name: 'Иллюстратор',
    sources: [{ id: 'markerRules' }, { id: 'reply' }],
    trigger: { phase: 'post' as const },
    result: { type: 'proposals' as const, options: { receivers: [ILLUSTRATE_KIND], max: 3 } },
};

async function reply(h: Harness, text: string): Promise<number> {
    h.chat.push(msg('Дальше.', true), msg(text, false));
    const index = h.chat.length - 1;
    await h.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
    await settle(40);
    return index;
}

afterEach(() => resetShownFaces());

describe('the illustrator', () => {
    it('runs only while NAI Studio gives it the reply; its marker goes in the main model’s form, free only', async () => {
        const fake = fakeNai();
        const h = await withAgents([ILLUSTRATOR], { adapters: fake.adapters });
        expect(fake.state.registered).toEqual([ILLUSTRATOR_ID]);

        fake.state.writer = { setting: 'illustrator', effective: 'main' };
        await reply(h, 'Свечи гаснут. Кай молчит.');
        expect(h.llm).not.toHaveBeenCalled();

        fake.state.writer = { setting: 'illustrator', effective: 'illustrator' };
        h.answers.push((request: LlmRequest) => {
            expect(request.messages.map((m) => m.content).join('\n')).toContain('<images>THE RULES</images>');
            return {
                ok: true,
                data: {
                    proposals: [
                        {
                            kind: ILLUSTRATE_KIND,
                            why: '',
                            data: { marker: { prompt: 'candles go out', caption: 'Тьма' }, after: 'Свечи гаснут.' },
                        },
                        { kind: ILLUSTRATE_KIND, why: '', data: { marker: { caption: 'без сцены' } } },
                    ],
                },
            };
        });
        const index = await reply(h, 'Свечи гаснут. Мира встаёт.');
        expect(fake.state.requests).toEqual([
            {
                messageIndex: index,
                swipeId: 0,
                marker: { prompt: 'candles go out', caption: 'Тьма' },
                after: 'Свечи гаснут.',
                freeOnly: true,
            },
        ]);
        // Nothing of its own to journal: the picture is NAI Studio's.
        expect(h.journal.records.filter((r) => r.kind === ILLUSTRATE_KIND)).toEqual([]);
    });

    it('«…when the main model wrote none»: only for a reply without a marker', async () => {
        const fake = fakeNai();
        const h = await withAgents([ILLUSTRATOR], { adapters: fake.adapters });
        fake.state.writer = { setting: 'fallback', effective: 'fallback' };
        fake.state.markers = [{ imageId: 'm1', marker: { prompt: 'x' }, status: 'done' }];
        await reply(h, 'Мира смеётся.');
        expect(h.llm).not.toHaveBeenCalled();
        fake.state.markers = [];
        h.answers.push(() => ({ ok: true, data: { proposals: [] } }));
        await reply(h, 'Мира плачет.');
        expect(h.llm).toHaveBeenCalledTimes(1);
    });

    it('may spend Anlas when the agents’ setting says so', async () => {
        const fake = fakeNai();
        const h = await withAgents([ILLUSTRATOR], { adapters: fake.adapters });
        h.app.settings.module<{ imagesPaid?: boolean }>('agents').imagesPaid = true;
        expect(h.api.imagesPaid?.()).toBe(true);
        const proposal = await proposalReceiver(ILLUSTRATE_KIND)!.toProposal(
            { marker: { prompt: 'x' } },
            { agentName: 'A', messageIndex: 2 },
        );
        expect(proposal?.payload).toMatchObject({ freeOnly: false });
    });

    it('Maestro is not NAI Studio’s illustrator without such an agent', async () => {
        const fake = fakeNai();
        await withAgents([{ id: 'u-other-aaaaa', name: 'Другой', trigger: { phase: 'manual' } }], {
            adapters: fake.adapters,
        });
        expect(fake.state.registered).toEqual([]);
    });
});

describe('the portraitist', () => {
    it('a passport into the chat (journaled with undo) and a DES portrait; none for a known face', async () => {
        const fake = fakeNai();
        const h = await withAgents([], { adapters: fake.adapters });
        const receiver = proposalReceiver(PORTRAIT_KIND)!;
        expect(await receiver.available?.({})).toBe(true);
        fake.state.passports = [{ kind: 'character', name: 'Вера', aliases: ['Верочка'], id: 'v' }];
        expect(await receiver.toProposal({ name: 'верочка', look: 'tall' }, { agentName: 'A' })).toBeNull();

        const proposal = (await receiver.toProposal({ name: 'Кай', look: 'tall, scar' }, { agentName: 'A' }))!;
        await proposal.apply(proposal.payload);
        expect(fake.state.saved).toEqual([{ id: 'p-Кай', scope: 'chat' }]);
        expect(fake.state.portraits).toEqual(['Кай']);
        expect(proposal.changes).toEqual([
            {
                target: 'nai.chatPassport',
                ref: { id: 'p-Кай', chatId: 'chat-1', name: 'Кай' },
                before: null,
                after: 'Кай',
            },
        ]);
        await h.journal.record({ module: 'agents', kind: PORTRAIT_KIND, summary: 's', changes: proposal.changes });
        expect(await h.journal.undo(h.journal.records[0]!.id)).toBe(true);
        expect(fake.state.cleared).toEqual(['p-Кай']);
    });

    it('shows each face without a passport once: not the player, not the card', async () => {
        const fake = fakeNai();
        const h = await withAgents([], { adapters: fake.adapters });
        expect(facesWithoutPassport(h.app)).toEqual(['Кай']);
        expect(unseenFaces(h.app)).toEqual(['Кай']);
        expect(portraitlessText(h.app)).toBe('- Кай');
        expect(unseenFaces(h.app)).toEqual([]);
        expect(await proposalReceiver(PORTRAIT_KIND)!.available?.({})).toBe(false);
    });
});

describe("the card's avatar", () => {
    it('never by itself; the current card; NAI Studio keeps the old picture', async () => {
        const fake = fakeNai();
        await withAgents([], { adapters: fake.adapters });
        const receiver = proposalReceiver(CARD_AVATAR_KIND)!;
        expect(receiver.neverAuto).toBe(true);
        expect(receiver.defaultAutonomy).toBe('ask');
        const proposal = (await receiver.toProposal({ look: 'older now' }, { agentName: 'A' }))!;
        expect(proposal.title).toContain('Мира');
        await proposal.apply(proposal.payload);
        // The card has an image passport? None here: NAI Studio writes one from the look and draws from it.
        expect(fake.state.avatars).toHaveLength(1);
        expect(fake.state.avatars[0]).toMatchObject({ avatar: 'Mira.png', passport: { name: 'Мира' } });
    });
});
