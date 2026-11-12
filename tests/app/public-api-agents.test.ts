// Release 1.34: MAESTRO_API.agents and .context. A neighbour's job becomes a built-in agent of the «Агенты» window (its
// words in both languages, its switch and settings; through Maestro's client the user's instruction goes into its
// requests, on its own channel it asks for it and reports runs); its proposal receivers and its sources of context;
// own agents and sets for authors. Ids carry a neighbour's prefix.
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentsFacade, isAgentNeighbourId } from '../../src/app/public-api-agents';
import { builtInAgent, resetBuiltInAgents } from '../../src/core/builtin-agents';
import { proposalReceiver, resetProposalReceivers } from '../../src/core/proposal-receivers';
import type { LlmRequest } from '../../src/shared/contracts';
import { createTestLogger } from '../helpers/core-host';
import { harness, msg } from '../features/agents/harness';
import type { Harness } from '../features/agents/harness';

const SYSTEM = 'You read the turn of a character.';

afterEach(() => {
    resetBuiltInAgents();
    resetProposalReceivers();
});

function facade(h: Harness) {
    return createAgentsFacade({
        app: h.app,
        log: createTestLogger(),
        disposed: () => false,
        own: (off) => off,
    });
}

async function withOverride(id: string, override: Record<string, unknown>): Promise<Harness> {
    return harness({
        seed: new Map<string, unknown>([
            [
                'maestro-agents.json',
                {
                    schema: 1,
                    agents: [],
                    sets: [],
                    global: { set: 'as-1-27', overrides: {} },
                    hintShown: true,
                    builtins: { [id]: override },
                },
            ],
        ]),
    });
}

describe('neighbours’ built-in agents', () => {
    it('only with a neighbour prefix; words, switch and settings of the neighbour; the remover takes it out', async () => {
        const h = await harness();
        const { agents } = facade(h);
        expect(isAgentNeighbourId('localizer.expand')).toBe(true);
        expect(isAgentNeighbourId('maestro.revision')).toBe(false);
        expect(() =>
            agents.registerBuiltIn({
                id: 'quality.judge',
                title: { ru: 'x', en: 'x' },
                when: { ru: 'x', en: 'x' },
                defaultInstructions: [SYSTEM],
            }),
        ).toThrow('prefix');
        expect(() =>
            agents.registerBuiltIn({
                id: 'dramatis.turn',
                title: { ru: 'x', en: 'x' },
                when: { ru: 'x', en: 'x' },
                defaultInstructions: [],
            }),
        ).toThrow('defaultInstructions');
        let on = true;
        let every = 3;
        const off = agents.registerBuiltIn({
            id: 'dramatis.turn',
            title: { ru: 'Ход персонажа', en: 'Character turn' },
            when: { ru: 'после ответа', en: 'after a reply' },
            icon: 'fa-masks-theater',
            defaultInstructions: () => [SYSTEM],
            defaults: { maxTokens: 900, temperature: 0.3 },
            enabled: () => on,
            setEnabled: (value) => void (on = value),
            knobs: [
                {
                    id: 'every',
                    label: { ru: 'Каждые', en: 'Every' },
                    kind: 'number',
                    get: () => every,
                    set: (v) => void (every = Number(v)),
                },
            ],
        });
        const spec = builtInAgent('dramatis.turn')!;
        expect(spec).toMatchObject({
            neighbour: 'dramatis',
            module: 'dramatis',
            group: 'neighbours',
            channel: 'maestro',
        });
        expect(spec.defaults).toEqual({ maxTokens: 900, temperature: 0.3 });
        expect(h.app.i18n.t('m44.bi.dramatis.turn.title')).toBe('Ход персонажа');
        expect(h.app.i18n.t('m44.bi.dramatis.turn.knob.every')).toBe('Каждые');
        await spec.toggle!.set(false);
        expect(on).toBe(false);
        expect(spec.toggle!.get()).toBe(false);
        await spec.knobs![0]!.set!(5);
        expect(spec.knobs![0]!.get!()).toBe(5);
        off();
        expect(builtInAgent('dramatis.turn')).toBeUndefined();
    });

    it("Maestro's channel: the user's addition goes into the neighbour's request", async () => {
        const h = await withOverride('dramatis.turn', { mode: 'addition', addition: 'Keep villains cruel.' });
        facade(h).agents.registerBuiltIn({
            id: 'dramatis.turn',
            title: { ru: 'Ход', en: 'Turn' },
            when: { ru: 'после ответа', en: 'after a reply' },
            defaultInstructions: [SYSTEM],
        });
        const request: LlmRequest = {
            task: 'dramatis.turn',
            maxTokens: 500,
            messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: 'The turn.' },
            ],
        };
        const changed = h.interceptors.map((i) => i.before).reduce((req, before) => before?.(req) ?? req, request);
        expect(changed.messages[0]!.content).toContain('Keep villains cruel.');
    });

    it('its own channel: the instruction to use and the reported runs; unknown ids get the default', async () => {
        const h = await withOverride('localizer.expand', {
            mode: 'full',
            full: 'Write three entries.',
            temperature: 0.2,
        });
        const { agents } = facade(h);
        expect(agents.instruction('localizer.expand', 'Default.')).toEqual({ text: 'Default.' });
        agents.registerBuiltIn({
            id: 'localizer.expand',
            title: { ru: 'Расширить мир', en: 'Expand the world' },
            when: { ru: 'по кнопке', en: 'by a button' },
            defaultInstructions: ['Default.'],
            channel: 'own',
            interactive: true,
        });
        expect(builtInAgent('localizer.expand')?.channel).toBe('own');
        expect(agents.instruction('localizer.expand', 'Default.')).toEqual({
            text: 'Write three entries.',
            temperature: 0.2,
        });
        const seen: unknown[] = [];
        agents.onResult((run) => seen.push(run));
        agents.report('localizer.expand', { ok: true, ms: 1200, raw: '[]', costUsd: 0.01 });
        agents.report('dramatis.unknown', { ok: true, ms: 1 });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            agentId: 'localizer.expand',
            agentName: 'Расширить мир',
            ok: true,
            builtin: true,
        });
    });
});

describe('receivers and sources of neighbours', () => {
    it('a receiver with a prefix takes agents’ items; its proposal applies through the neighbour', async () => {
        const h = await harness();
        const { agents } = facade(h);
        expect(() =>
            agents.registerReceiver({
                kind: 'profile',
                label: { ru: 'x', en: 'x' },
                describe: 'x',
                schema: {},
                toProposal: () => null,
                apply: async () => {},
            }),
        ).toThrow('prefix');
        const applied: unknown[] = [];
        agents.registerReceiver({
            kind: 'dramatis.profile',
            label: { ru: 'Профиль Dramatis', en: 'Dramatis profile' },
            describe: 'fills empty fields of a profile',
            schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            defaultAutonomy: 'inbox',
            toProposal: (data) => ({ title: `Профиль: ${String(data.name)}`, payload: data }),
            apply: async (payload) => void applied.push(payload),
        });
        const receiver = proposalReceiver('dramatis.profile')!;
        expect(receiver.module).toBe('dramatis');
        expect(h.app.i18n.t('kind.dramatis.profile')).toBe('Профиль Dramatis');
        const proposal = (await receiver.toProposal({ name: 'Кай' }, { agentName: 'A' }))!;
        expect(proposal).toMatchObject({ module: 'dramatis', kind: 'dramatis.profile', title: 'Профиль: Кай' });
        await proposal.apply(proposal.payload);
        expect(applied).toEqual([{ name: 'Кай' }]);
        expect(h.appliers).toContain('dramatis.profile');
    });

    it('a source of a neighbour is offered to agents and rendered into their requests', async () => {
        const h = await harness();
        const { agents, context } = facade(h);
        context.register({
            id: 'dramatis.cast',
            title: 'Cast: motives of those present',
            label: { ru: 'Каст Dramatis', en: 'Dramatis cast' },
            budget: 500,
            render: ({ budget }) => `Кай wants the map.`.slice(0, budget),
        });
        const id = await agents.save({
            name: 'Читатель',
            instruction: 'Note what Кай wants.',
            sources: [{ id: 'dramatis.cast' }],
            trigger: { phase: 'manual' },
            result: { type: 'note', options: { show: 'strip' } },
        });
        expect(id).toBeTruthy();
        h.answers.push((request: LlmRequest) => {
            expect(request.messages.map((m) => m.content).join('\n')).toContain('Кай wants the map.');
            return { ok: true, data: { note: 'ok' }, text: 'ok' };
        });
        h.chat.push(msg('Кай молчит.', false));
        const run = await agents.run(id!);
        expect(run?.ok).toBe(true);
        expect(h.llm).toHaveBeenCalledTimes(1);
    });
});

describe('own agents and sets for authors', () => {
    it('save, list, get, switch in a scope; sets saved and applied; invalid ones refused', async () => {
        const h = await harness();
        const { agents } = facade(h);
        expect(await agents.save({ instruction: 'no name' })).toBeNull();
        const id = (await agents.save({
            name: 'Сюжетная линия',
            instruction: 'Keep the plotline.',
            trigger: { phase: 'prefetch' },
            result: { type: 'inject', options: {} },
        }))!;
        expect(agents.get(id)).toMatchObject({ name: 'Сюжетная линия' });
        expect(agents.list().find((a) => a.id === id)).toMatchObject({ builtin: false, phase: 'prefetch', on: false });
        expect(await agents.setEnabled(id, true, 'chat')).toBe(true);
        expect(agents.list().find((a) => a.id === id)?.on).toBe(true);
        expect(await agents.setEnabled('nobody', true)).toBe(false);
        expect(await agents.saveSet({ id: 'set-1', name: 'Моя история', agents: { [id]: { on: true } } })).toBe(true);
        expect(await agents.saveSet({ id: 'x', name: 'Bad', builtin: true, agents: {} })).toBe(false);
        expect(agents.sets().map((set) => set.id)).toContain('set-1');
        expect(await agents.applySet('set-1', 'global')).toBe(true);
        expect(await agents.applySet('missing')).toBe(false);
    });
});
