// M45 «Мизансцена»: the receiver writes the record of a reply's swipe, the prompt line follows, undo and deletion
// take it back; a swipe has its own record.
import { afterEach, describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { proposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import { StagingService } from '../../../src/features/staging/service';
import { STAGING_STRINGS } from '../../../src/features/staging/strings';
import type { App, GenerationInfo, InjectionSpec, UndoHandler } from '../../../src/shared/contracts';
import { createTestI18n, createTestLogger, settle } from '../../helpers/core-host';

afterEach(() => resetProposalReceivers());

function setup() {
    const log = createTestLogger();
    const chat = [
        { is_user: false, mes: 'Привет.', swipe_id: 0 },
        { is_user: true, mes: 'Я сажусь.', swipe_id: 0 },
        { is_user: false, mes: 'Мира садится рядом.', swipe_id: 0 },
    ] as unknown as STChatMessage[];
    const docs = new Map<string, unknown>();
    const undo = new Map<string, UndoHandler>();
    const injections = new Map<string, InjectionSpec>();
    let producer: ((gen: GenerationInfo) => void) | null = null;
    const i18n = createTestI18n('ru');
    i18n.register(STAGING_STRINGS);
    const journal: unknown[] = [];
    const bus = createBus(log);
    const app = {
        host: { ctx: () => ({ chat }), chatId: () => 'chat-1', isGroupChat: () => false },
        i18n,
        bus,
        chat: {
            get: async (kind: string, defaults: () => object) => structuredClone(docs.get(kind) ?? defaults()),
            put: async (kind: string, data: unknown) => {
                docs.set(kind, structuredClone(data));
                return true;
            },
        },
        journal: {
            registerUndo: (target: string, handler: UndoHandler) => void undo.set(target, handler),
            record: async (action: unknown) => {
                journal.push(action);
                return 'j1';
            },
        },
        ephemeral: {
            addProducer: (_name: string, fn: (gen: GenerationInfo) => void) => {
                producer = fn;
                return () => undefined;
            },
            setInjection: (key: string, spec: InjectionSpec) => void injections.set(key, spec),
        },
    } as unknown as App;
    const service = new StagingService(
        app,
        log,
        () => ({ promptLine: true, depth: 2 }),
        () => 5,
    );
    const offs = service.install();
    return {
        app,
        chat,
        service,
        undo,
        injections,
        journal,
        bus,
        offs,
        produce: () => producer?.({ type: 'normal', dryRun: false, quiet: false }),
    };
}

describe('staging service', () => {
    it('the receiver writes the record of the reply, the prompt line follows; undo takes it back', async () => {
        const { service, undo, injections, produce } = setup();
        await settle(10);
        const receiver = proposalReceiver('staging.set')!;
        expect(receiver.direct).toBe(true);
        const proposal = await receiver.toProposal(
            { characters: [{ name: 'Мира', pose: 'сидит', where: 'у камина' }] },
            { agentName: 'A', messageIndex: 2 },
        );
        expect(proposal?.sourceMessage).toBe(2);
        await proposal!.apply(proposal!.payload);
        expect(service.current()).toEqual([{ name: 'Мира', pose: 'сидит', where: 'у камина' }]);
        produce();
        expect(injections.get('staging')).toMatchObject({
            text: '[Staging now — keep it consistent: Мира: сидит у камина]',
            depth: 2,
            position: 1,
        });
        expect(
            await receiver.toProposal(
                { characters: [{ name: 'Мира', pose: 'сидит' }] },
                { agentName: 'A', messageIndex: 2 },
            ),
        ).toBeNull();
        expect(await undo.get('staging.record')!(proposal!.changes[0]!)).toBe(true);
        expect(service.current()).toEqual([]);
    });

    it("a swipe has its own record; the earlier reply's record holds until then; deletion drops later records", async () => {
        const { service, chat, bus } = setup();
        await settle(10);
        const receiver = proposalReceiver('staging.set')!;
        const first = await receiver.toProposal(
            { characters: [{ name: 'Кай', pose: 'стоит' }] },
            { agentName: 'A', messageIndex: 0 },
        );
        await first!.apply(first!.payload);
        expect(service.current()).toEqual([{ name: 'Кай', pose: 'стоит' }]);
        const second = await receiver.toProposal(
            { characters: [{ name: 'Мира', pose: 'сидит' }] },
            { agentName: 'A', messageIndex: 2 },
        );
        await second!.apply(second!.payload);
        expect(service.current().map((entry) => entry.name)).toEqual(['Кай', 'Мира']);
        chat[2]!.swipe_id = 1;
        expect(service.current()).toEqual([{ name: 'Кай', pose: 'стоит' }]);
        chat[2]!.swipe_id = 0;
        await bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted', removedAt: 1, removed: 2 });
        expect(service.current()).toEqual([{ name: 'Кай', pose: 'стоит' }]);
    });

    it('a hand edit is journaled', async () => {
        const { service, journal } = setup();
        await settle(10);
        await service.setCurrent([{ name: 'Вера', where: 'в дверях' }, { name: '  ' }]);
        expect(service.current()).toEqual([{ name: 'Вера', where: 'в дверях' }]);
        expect(journal).toHaveLength(1);
    });
});
