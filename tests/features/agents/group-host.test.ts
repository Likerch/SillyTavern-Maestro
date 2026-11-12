// Release 1.34 «Ведущий группы»: only in a group with the reply order «Вручную»; the player's message runs the host
// agent; the member it names answers through ST's own path (Generate with force_chid); muted members and other chats
// are refused; the members source lists who may speak.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import {
    GROUP_MEMBERS_SOURCE,
    MANUAL_ACTIVATION,
    SPEAKER_KIND,
    currentGroup,
    installGroupHost,
} from '../../../src/features/agents/group-host';
import type { App } from '../../../src/shared/contracts';
import { createTestLogger } from '../../helpers/core-host';

afterEach(() => resetProposalReceivers());

function setup(strategy = MANUAL_ACTIVATION) {
    const handlers = new Map<string, () => void>();
    const generate = vi.fn(async () => undefined);
    const ctx = {
        groupId: 'g1',
        groups: [
            {
                id: 'g1',
                name: 'Гавань',
                members: ['mira.png', 'kai.png', 'vera.png'],
                disabled_members: ['vera.png'],
                activation_strategy: strategy,
            },
        ],
        characters: [
            { avatar: 'kai.png', name: 'Кай', description: 'Smuggler.' },
            { avatar: 'mira.png', name: 'Мира', data: { description: 'Captain of the harbour guard.' } },
            { avatar: 'vera.png', name: 'Вера', description: 'Healer.' },
        ],
        chat: [{ is_user: true, mes: 'Мира, что скажешь?' }],
        generate,
    };
    const app = {
        host: {
            ctx: () => ctx,
            events: {
                on: (name: string, handler: () => void) => {
                    handlers.set(name, handler);
                    return () => handlers.delete(name);
                },
            },
        },
        leader: { isLeader: () => true },
        i18n: { t: (key: string, params?: Record<string, string>) => `${key}${params?.name ? `:${params.name}` : ''}` },
    } as unknown as App;
    const runs: [string, number][] = [];
    const hosts = [{ id: 'u-host-aaaaa' }];
    installGroupHost(app, createTestLogger(), {
        hosts: () => hosts,
        run: async (id, index) => void runs.push([id, index]),
    });
    return { app, ctx, generate, handlers, runs, hosts };
}

describe('group host', () => {
    it('the group, its enabled members and the source', async () => {
        const { app } = setup();
        expect(currentGroup(app)).toEqual({
            id: 'g1',
            name: 'Гавань',
            manual: true,
            members: [
                { name: 'Мира', chid: 1, description: 'Captain of the harbour guard.' },
                { name: 'Кай', chid: 0, description: 'Smuggler.' },
            ],
        });
        expect(await GROUP_MEMBERS_SOURCE.render({ app, agentId: 'a', state: {} as never }, 2000)).toBe(
            '- Мира: Captain of the harbour guard.\n- Кай: Smuggler.',
        );
    });

    it('the player’s message runs the host; the named member answers through ST', async () => {
        const { handlers, runs, generate } = setup();
        handlers.get('MESSAGE_SENT')!();
        await Promise.resolve();
        expect(runs).toEqual([['u-host-aaaaa', 0]]);
        const receiver = proposalReceiver(SPEAKER_KIND)!;
        expect(await receiver.available?.({})).toBe(true);
        expect(await receiver.toProposal({ name: 'Вера' }, { agentName: 'A' })).toBeNull();
        const proposal = (await receiver.toProposal({ name: 'мира' }, { agentName: 'A' }))!;
        expect(proposal.title).toBe('m44.group.speaks:Мира');
        await proposal.apply(proposal.payload);
        expect(generate).toHaveBeenCalledWith('normal', { force_chid: 1 });
    });

    it('other reply orders are left to SillyTavern; another chat refuses a stored card', async () => {
        const { handlers, runs, ctx } = setup(0);
        handlers.get('MESSAGE_SENT')!();
        await Promise.resolve();
        expect(runs).toEqual([]);
        expect(await proposalReceiver(SPEAKER_KIND)!.available?.({})).toBe(false);
        ctx.groupId = 'g2';
        await expect(proposalReceiver(SPEAKER_KIND)!.apply({ name: 'Мира', groupId: 'g1' })).rejects.toThrow(
            'm44.group.otherChat',
        );
    });
});
