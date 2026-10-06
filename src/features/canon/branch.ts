// M6 п. 10 «Ветки» (audit C2): a branch made in ST (`chat_metadata.main_chat` names the parent chat) has no canon of
// its own. When the parent has one, Maestro offers to copy it (autonomy kind 'canon.branchCopy', Inbox by default).
// Stage 2 copies the parent's whole canon; restoring it exactly as of the branch message needs the canon journal of
// stage 4. Offered once per branch (chat pointer), only by the leader tab.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { CANON_BOOK_TARGET, CANON_ID } from './store';
import type { CanonStore } from './store';

export const BRANCH_KIND = 'canon.branchCopy';
const OFFER_POINTER = 'canon.branchOffered';

export interface BranchPayload {
    parentBook: string;
    parentChat: string;
    chatId: string;
}

function isBranchPayload(value: unknown): value is BranchPayload {
    if (!value || typeof value !== 'object') return false;
    const payload = value as Partial<BranchPayload>;
    return (
        typeof payload.parentBook === 'string' &&
        typeof payload.parentChat === 'string' &&
        typeof payload.chatId === 'string' &&
        !!payload.parentBook &&
        !!payload.chatId
    );
}

export class CanonBranches {
    constructor(
        private readonly app: App,
        private readonly store: CanonStore,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        offs.push(
            this.app.inbox.registerApplier(
                BRANCH_KIND,
                async (payload) => {
                    if (isBranchPayload(payload)) await this.apply(payload);
                },
                async (payload) => isBranchPayload(payload) && this.stillValid(payload),
            ),
        );
        const chatChanged = this.app.host.events.name('CHAT_CHANGED');
        if (chatChanged) offs.push(this.app.host.events.on(chatChanged, () => void this.check()));
        // Leadership of a chat is settled a moment after the switch.
        offs.push(this.app.leader.onChange((leader) => leader && void this.check()));
        return offs;
    }

    /** Offers the copy when this chat is a branch without a canon and its parent has one. */
    async check(): Promise<boolean> {
        try {
            const chatId = this.app.host.chatId();
            const parent = this.app.host.ctx().chatMetadata?.main_chat;
            if (!chatId || typeof parent !== 'string' || !parent || parent === chatId) return false;
            if (!this.app.leader.isLeader() || this.app.chat.pointer(OFFER_POINTER)) return false;
            const payload: BranchPayload = { parentBook: this.store.bookName(parent), parentChat: parent, chatId };
            if (!(await this.stillValid(payload))) return false;
            await this.app.chat.setPointer(OFFER_POINTER, payload.parentBook);
            const t = this.app.i18n.t.bind(this.app.i18n);
            await this.app.autonomy.decide<BranchPayload>(
                {
                    module: CANON_ID,
                    kind: BRANCH_KIND,
                    title: t('m6.branch.title'),
                    description: t('m6.branch.description', { parent }),
                    details: t('m6.branch.details', { book: payload.parentBook }),
                    appliedNotice: { text: t('m6.branch.applied', { parent }) },
                    changes: [
                        {
                            target: CANON_BOOK_TARGET,
                            ref: { book: this.store.bookName(chatId) },
                            before: null,
                            after: { copiedFrom: payload.parentBook },
                        },
                    ],
                    payload,
                    apply: (value) => this.apply(value),
                    stillValid: () => this.stillValid(payload),
                },
                'inbox',
            );
            return true;
        } catch (error) {
            this.log.warn('branch canon offer failed', error);
            return false;
        }
    }

    /** The parent canon exists and the branch has none yet. */
    async stillValid(payload: BranchPayload): Promise<boolean> {
        const own = this.store.bookName(payload.chatId);
        const names = this.store.worldNames();
        if (names) return names.includes(payload.parentBook) && !names.includes(own);
        return !!(await this.store.readBook(payload.parentBook)) && !(await this.store.readBook(own));
    }

    async apply(payload: BranchPayload): Promise<void> {
        const copied = await this.store.copyBook(payload.parentBook, payload.chatId);
        if (!copied) throw new Error(this.app.i18n.t('m6.branch.failed'));
    }
}
