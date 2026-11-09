// The canon's receivers of agents' proposals (release 1.31): a new chat-lore entry (no duplicates of known names) and
// a chat-only override of a lore entry; both applied through the canon and undone.
import { afterEach, describe, expect, it } from 'vitest';
import { proposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import { CanonAgentReceivers, parseEntryRef } from '../../../src/features/canon/agent-receivers';
import type { CanonDraft, CanonItem } from '../../../src/features/canon/api';
import type { App, JournalChange, UndoHandler } from '../../../src/shared/contracts';
import { RECEIVER_STRINGS } from '../../../src/features/agents/strings-receivers';
import { createTestI18n, createTestLogger } from '../../helpers/core-host';

afterEach(() => resetProposalReceivers());

function setup() {
    const items: CanonItem[] = [];
    const puts: { draft: CanonDraft; uid?: number }[] = [];
    const removed: number[] = [];
    const undo = new Map<string, UndoHandler>();
    let next = 1;
    const canon = {
        list: async (filter: { kind?: string } = {}) =>
            items.filter((item) => !filter.kind || item.meta.kind === filter.kind),
        put: async (draft: CanonDraft, options?: { uid?: number }) => {
            puts.push({ draft, uid: options?.uid });
            const uid = options?.uid ?? next++;
            const existing = items.findIndex((item) => item.uid === uid);
            const item = { uid, entry: draft.entry, meta: { ...draft.meta, createdAt: 1, updatedAt: 1 } } as CanonItem;
            if (existing >= 0) items[existing] = item;
            else items.push(item);
            return uid;
        },
        remove: async (uid: number) => {
            removed.push(uid);
            items.splice(
                items.findIndex((item) => item.uid === uid),
                1,
            );
        },
        russianKeys: async (term: string) => [term, `${term}а`],
    };
    const books: Record<
        string,
        { entries: Record<string, { uid: number; comment: string; content: string; key: string[] }> }
    > = {
        Мир: { entries: { '12': { uid: 12, comment: 'Мира', content: 'Mira is a smuggler.', key: ['Мира'] } } },
    };
    const app = {
        i18n: (() => {
            const i18n = createTestI18n('ru');
            i18n.register(RECEIVER_STRINGS);
            return i18n;
        })(),
        journal: { registerUndo: (target: string, handler: UndoHandler) => void undo.set(target, handler) },
        modules: {
            api: (key: string) =>
                key === 'canon'
                    ? canon
                    : key === 'loreStore'
                      ? { load: async (name: string) => books[name] ?? null }
                      : key === 'world'
                        ? { resolve: (name: string) => (name === 'Вера' ? { id: 'character:вера' } : undefined) }
                        : undefined,
        },
    } as unknown as App;
    const offs = new CanonAgentReceivers(app, createTestLogger()).install();
    return { app, items, puts, removed, undo, offs };
}

describe('canon receivers', () => {
    it('reads entry references', () => {
        expect(parseEntryRef('Мир#12')).toEqual({ world: 'Мир', uid: 12 });
        expect(parseEntryRef('Книга мира # 3')).toEqual({ world: 'Книга мира', uid: 3 });
        expect(parseEntryRef('нет')).toBeNull();
    });

    it('a new entry: none for known names; applied as a canon addition with Russian keys; undone', async () => {
        const { puts, items, removed, undo } = setup();
        const entry = proposalReceiver('canon.agentEntry')!;
        expect(await entry.toProposal({ name: 'Вера', type: 'character', text: 'x' }, { agentName: 'A' })).toBeNull();
        const proposal = await entry.toProposal(
            {
                name: 'Борис',
                englishName: 'Boris',
                type: 'character',
                text: 'Boris keeps the inn.',
                keys: ['трактирщик'],
            },
            { agentName: 'A', messageIndex: 4 },
        );
        expect(proposal?.title).toBe('Новое в лоре: Борис (персонаж)');
        expect(proposal?.sourceMessage).toBe(4);
        await proposal!.apply(proposal!.payload);
        expect(puts[0]?.draft).toMatchObject({
            entry: {
                comment: 'Борис',
                content: 'Boris keeps the inn.',
                key: ['Борис', 'Бориса', 'Boris', 'трактирщик'],
            },
            meta: { kind: 'addition', status: 'active', origin: 'agent', type: 'character', sourceMessage: 4 },
        });
        expect(
            await entry.toProposal({ name: 'борис', type: 'character', text: 'again' }, { agentName: 'A' }),
        ).toBeNull();
        const change = proposal!.changes[0] as JournalChange;
        expect(await undo.get('canon.agentEntry')!(change)).toBe(true);
        expect(removed).toEqual([1]);
        expect(items).toHaveLength(0);
    });

    it('a change of an entry: a chat override with the whole new text; the previous override comes back on undo', async () => {
        const { puts, items, removed, undo } = setup();
        const edit = proposalReceiver('canon.agentEdit')!;
        expect(await edit.toProposal({ entry: 'Нет#1', text: 'x' }, { agentName: 'A' })).toBeNull();
        expect(await edit.toProposal({ entry: 'Мир#12', text: 'Mira is a smuggler.' }, { agentName: 'A' })).toBeNull();
        const first = await edit.toProposal(
            { entry: 'Мир#12', text: 'Mira is a smuggler with a scar.' },
            { agentName: 'A' },
        );
        expect(first?.title).toBe('Обновить запись «Мира»');
        await first!.apply(first!.payload);
        expect(puts[0]?.draft.meta).toMatchObject({
            kind: 'override',
            origin: 'agent',
            base: { world: 'Мир', uid: 12 },
            fields: ['content'],
        });
        const second = await edit.toProposal(
            { entry: 'Мир#12', text: 'Mira, scarred, now captain.' },
            { agentName: 'A' },
        );
        expect((second!.changes[0]!.before as { override: string }).override).toBe('Mira is a smuggler with a scar.');
        await second!.apply(second!.payload);
        expect(await undo.get('canon.agentEdit')!(second!.changes[0]!)).toBe(true);
        expect(items[0]?.entry.content).toBe('Mira is a smuggler with a scar.');
        expect(await undo.get('canon.agentEdit')!(first!.changes[0]!)).toBe(true);
        expect(removed).toHaveLength(1);
    });
});
