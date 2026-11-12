// «Ведущий группы» (plan §3.20, release 1.34): in a group chat ST picks who speaks by turn or at random; the agent picks
// by the scene. It works with the group's reply order «Вручную» (ST's MANUAL activation: the player's message gets no
// automatic reply): after the player's message Maestro runs every agent on that proposes `group.speaker`, and the member
// it names answers — ST's own «speak» path, Generate('normal', { force_chid }). Other orders are left to ST (the agent
// stays silent and the agents window says why). Agents otherwise do not run in group chats.
import { registerProposalReceiver } from '../../core/proposal-receivers';
import type { App, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { ContextSource } from './sources';

export const SPEAKER_KIND = 'group.speaker';
/** ST's group_activation_strategy.MANUAL (public/scripts/group-chats.js, 1.19). */
export const MANUAL_ACTIVATION = 2;

const fold = (text: string) => text.trim().toLowerCase().replace(/ё/g, 'е');

interface GroupInfo {
    id: string;
    name: string;
    manual: boolean;
    members: { name: string; chid: number; description: string }[];
}

/** The open group with its enabled members (null outside a group chat). */
export function currentGroup(app: App): GroupInfo | null {
    try {
        const ctx = app.host.ctx() as unknown as {
            groupId?: string | null;
            groups?: {
                id: string;
                name: string;
                members: string[];
                disabled_members?: string[];
                activation_strategy?: number;
            }[];
            characters?: { avatar?: string; name?: string; description?: string; data?: { description?: string } }[];
        };
        if (!ctx.groupId) return null;
        const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
        if (!group) return null;
        const disabled = new Set(group.disabled_members ?? []);
        const characters = ctx.characters ?? [];
        const members = group.members
            .filter((avatar) => !disabled.has(avatar))
            .map((avatar) => {
                const chid = characters.findIndex((character) => character.avatar === avatar);
                const character = characters[chid];
                const description = String(character?.data?.description ?? character?.description ?? '');
                return { name: String(character?.name ?? ''), chid, description };
            })
            .filter((member) => member.chid >= 0 && member.name);
        return {
            id: group.id,
            name: group.name,
            manual: Number(group.activation_strategy ?? 0) === MANUAL_ACTIVATION,
            members,
        };
    } catch {
        return null;
    }
}

/** The source «Участники группы»: who may speak, a line about each. */
export const GROUP_MEMBERS_SOURCE: ContextSource = {
    id: 'groupMembers',
    labelKey: 'm44.src.groupMembers',
    title: 'Members of the group who may speak next',
    budget: 2000,
    stable: true,
    render: (ctx, budget) => {
        const group = currentGroup(ctx.app);
        if (!group) return '';
        const per = Math.max(80, Math.floor(budget / Math.max(1, group.members.length)) - 40);
        return group.members
            .map((member) => `- ${member.name}: ${member.description.replace(/\s+/g, ' ').slice(0, per)}`)
            .join('\n')
            .slice(0, budget);
    },
};

export interface GroupHostDeps {
    /** Own agents that are on now and propose `group.speaker`. */
    hosts(): { id: string }[];
    /** Runs one (its proposals are applied: the member answers). */
    run(id: string, index: number): Promise<void>;
}

/** The receiver: the member to answer next; applied at once (ST generates the reply). */
export function installGroupHost(app: App, log: Logger, deps: GroupHostDeps): Unsubscribe[] {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const speak = async (raw: unknown): Promise<void> => {
        const payload = raw as { name: string; groupId: string };
        const group = currentGroup(app);
        if (!group || group.id !== payload.groupId) throw new Error(t('m44.group.otherChat'));
        const member = group.members.find((item) => fold(item.name) === fold(payload.name));
        if (!member) throw new Error(t('m44.group.noMember', { name: payload.name }));
        const generate = app.host.ctx().generate;
        if (typeof generate !== 'function') throw new Error(t('m44.group.noGenerate'));
        // Not awaited: the reply streams on; the agent's run is done.
        void Promise.resolve(generate('normal', { force_chid: member.chid })).catch((error: unknown) =>
            log.warn('group host: the member did not answer', error),
        );
    };
    let busy = false;
    const onSent = async () => {
        const group = currentGroup(app);
        if (!group?.manual || busy || !app.leader.isLeader()) return;
        const hosts = deps.hosts();
        const host = hosts[0];
        if (!host) return;
        busy = true;
        try {
            const index = (app.host.ctx().chat?.length ?? 1) - 1;
            await deps.run(host.id, index);
        } catch (error) {
            log.warn('group host failed', error);
        } finally {
            busy = false;
        }
    };
    return [
        registerProposalReceiver({
            kind: SPEAKER_KIND,
            module: 'agents',
            labelKey: 'm44.recv.group.speaker',
            describe:
                'who of the group members (listed in the sources) should answer the player now, by the scene: who was addressed, who has a reason to react, who has been silent too long. name: exactly as listed. One item.',
            schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            defaultAutonomy: 'auto',
            direct: true,
            available: () => currentGroup(app)?.manual === true,
            toProposal: (data): Proposal | null => {
                const group = currentGroup(app);
                const name = typeof data.name === 'string' ? data.name.trim() : '';
                if (!group || !name) return null;
                const member = group.members.find((item) => fold(item.name) === fold(name));
                if (!member) return null;
                return {
                    module: 'agents',
                    kind: SPEAKER_KIND,
                    title: t('m44.group.speaks', { name: member.name }),
                    // The reply is the record: nothing to undo but the message itself.
                    changes: [],
                    payload: { name: member.name, groupId: group.id },
                    apply: speak,
                };
            },
            apply: speak,
        }),
        app.host.events.on('MESSAGE_SENT', () => void onSent()),
    ];
}
