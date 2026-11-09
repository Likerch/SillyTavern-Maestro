// Receivers of agents' proposals (plan §3.5 «Предложения», §4.7, release 1.31): a module that keeps a store (the chat
// canon, the calendar, Dramatis profiles…) registers here what an agent may propose to it — the item's form for the
// model, how an item becomes a Proposal for autonomy / the Inbox, and how a stored payload is applied (Inbox cards
// outlive the page). M44 «Агенты» routes the items of an agent's answer here. Registered in init() with own().
import type { AutonomyLevel, Proposal, Unsubscribe } from '../shared/contracts';

export interface ProposalReceiver {
    /** Autonomy kind of its proposals ('agents.canon.entry'): needs the label `kind.<kind>`. */
    kind: string;
    module: string;
    /** i18n key of what it changes («Запись в книгу чата»), for the editor and the capabilities list. */
    labelKey: string;
    /** For the model (English): what one item means and how to fill its fields. */
    describe: string;
    /** JSON schema of one item's `data`. */
    schema: Record<string, unknown>;
    defaultAutonomy: AutonomyLevel;
    /** Never applied by itself (a card): autonomy refuses 'auto'. */
    neverAuto?: boolean;
    /** An item as a proposal (null: nothing to do — a duplicate, an unknown name). */
    toProposal(
        data: Record<string, unknown>,
        context: { agentName: string; messageIndex?: number },
    ): Promise<Proposal | null> | Proposal | null;
    /** Applies a stored payload (an Inbox card accepted later). */
    apply(payload: unknown): Promise<void>;
}

const receivers = new Map<string, ProposalReceiver>();
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.error('[Maestro] proposal receivers listener failed', error);
        }
    }
}

export function registerProposalReceiver(receiver: ProposalReceiver): Unsubscribe {
    receivers.set(receiver.kind, receiver);
    changed();
    return () => {
        if (receivers.get(receiver.kind) !== receiver) return;
        receivers.delete(receiver.kind);
        changed();
    };
}

export function proposalReceivers(): ProposalReceiver[] {
    return [...receivers.values()];
}

export function proposalReceiver(kind: string): ProposalReceiver | undefined {
    return receivers.get(kind);
}

export function onProposalReceiversChange(listener: () => void): Unsubscribe {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test helper. */
export function resetProposalReceivers(): void {
    receivers.clear();
    changed();
}
