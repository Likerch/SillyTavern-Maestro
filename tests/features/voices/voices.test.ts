// M15 «Голоса персонажей»: cards for the present characters (archives, DES tracker, M19), the budget, the ephemeral
// injection for real generations only, CarrotKernel's quiet mode on the assembled prompt and DES-RU's ownership.
import { afterEach, describe, expect, it } from 'vitest';
import { estimateText } from '../../../src/domain/architect-text';
import { unknownFacts } from '../../../src/domain/knowledge-match';
import { VOICES_HEADER } from '../../../src/domain/voices-cards';
import type { KnowledgeApi, KnowledgeFact } from '../../../src/features/knowledge/api';
import { voicesModule } from '../../../src/features/voices';
import type { VoicesApi } from '../../../src/features/voices/api';
import { CK_FUNCTION } from '../../../src/features/voices/service';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { EVENT_TYPES } from '../../helpers/st-mock';
import {
    ARCHIVES,
    FakeArchitect,
    FakeBunnyMoMode,
    FakeDesRuApi,
    changeChat,
    defaultChat,
    generate,
    relation,
    startVoices,
    tick,
    trackerReply,
    userMessage,
} from './helpers';
import type { Msg, VoicesTestApp } from './helpers';

const CK = 'OOC MANDATORY: [CHARACTER CONTEXT - CarrotKernel Tags]\n\nAnna: ELF, KUUDERE, STOIC, BLUNT\n';

let app: VoicesTestApp | null = null;

afterEach(async () => {
    await app?.stop();
    app = null;
});

async function start(options: Parameters<typeof startVoices>[0] = {}): Promise<VoicesTestApp> {
    app = await startVoices(options);
    return app;
}

function card(started: VoicesTestApp, name: string) {
    return started.api.cards().find((item) => item.name === name);
}

function prompt(): Msg[] {
    return [
        { role: 'system', content: 'Main prompt.' },
        { role: 'assistant', content: 'reply' },
        { role: 'system', content: CK.trim() },
        { role: 'user', content: 'Anna, the map?' },
    ];
}

describe('cards', () => {
    it('builds a card for every present character from the archive, the tracker and the quests', async () => {
        const started = await start();
        expect(started.api.cards().map((item) => item.name)).toEqual(['Anna', 'Corvin', 'Stranger']);
        const anna = card(started, 'Anna');
        expect(anna?.speech).toBe(
            'blunt, soft spoken, formal; formal speech with an archaic register; often trails off mid-sentence when ' +
                'nervous; a faint northern lilt; Calls Kai "little fox"',
        );
        expect(anna?.mbti).toBe('INFP-H (healthy; now: guarded, tired)');
        expect(anna?.attitude).toBe('Friend');
        expect(anna?.goals).toBe('find the map; quest: Escape Velmora with Anna');
        expect(anna?.entityId).toBe('character:anna');
        expect(anna?.text.startsWith('[Voice: Anna] Speech: blunt, soft spoken, formal; ')).toBe(true);
        expect(anna?.text).toContain(' | MBTI: INFP-H (healthy; now: guarded, tired) | Toward Kai: Friend | Goals: ');
        expect(anna?.tokens).toBe(estimateText(anna?.text ?? ''));

        expect(card(started, 'Corvin')?.text).toBe(
            '[Voice: Corvin] Speech: commanding | MBTI: ENTJ-U (unhealthy; now: cold) | Toward Kai: Enemy',
        );
        expect(card(started, 'Stranger')?.text).toBe('[Voice: Stranger] Now: nervous');
        expect(started.loads).toEqual([ARCHIVES, ARCHIVES]);
    });

    it('takes no archive by the bare name: a namesake’s archive of another story stays out (plan-2 §9)', async () => {
        // The world model keeps Anna's same-name archive out of this chat until the user says it is her.
        const started = await start({
            world: [{ name: 'Kai', kind: 'persona' }, { name: 'Anna' }, { name: 'Corvin', archive: `${ARCHIVES}#2` }],
        });
        await tick();
        expect(card(started, 'Anna')?.text).toBe(
            '[Voice: Anna] Now: guarded, tired | Toward Kai: Friend | Goals: find the map; quest: Escape Velmora with Anna',
        );
        expect(started.loads).toEqual([ARCHIVES]);
    });

    it('leaves out absent characters, the persona and characters hidden in DES', async () => {
        const started = await start({
            before(test) {
                (test.env.app.adapters.des as unknown as { removedCharacters: () => string[] }).removedCharacters =
                    () => ['corvin'];
            },
        });
        const names = started.api.cards().map((item) => item.name);
        expect(names).toEqual(['Anna', 'Stranger']);
        expect(names).not.toContain('Bob');
        expect(names).not.toContain('Kai');
    });

    it('has no cards without a chat or a DES tracker', async () => {
        const started = await start({ chat: [userMessage('Hi.'), userMessage('Hello?')] });
        expect(started.api.cards()).toEqual([]);
        expect(started.api.ckSilenced()).toBe(false);
        await changeChat(started, undefined);
        expect(started.api.cards()).toEqual([]);
    });

    it('reads archives through M35 when it runs', async () => {
        const mode = new FakeBunnyMoMode({
            [`${ARCHIVES}#1`]: {
                book: ARCHIVES,
                uid: 1,
                name: 'Anna',
                tags: [{ key: 'LING', value: 'POETIC' }],
                mbti: { type: 'ISFJ', variant: 'U' },
                linguistics: 'Speaks in rhymes.',
                sections: [],
            },
        });
        const started = await start({ before: (test) => test.env.modules.expose('bunnymoMode', mode) });
        expect(mode.reads).toEqual([`${ARCHIVES}#1`, `${ARCHIVES}#2`]);
        expect(started.loads).toEqual([]);
        expect(card(started, 'Anna')?.speech).toBe('poetic; rhymes');
        expect(card(started, 'Anna')?.mbti).toBe('ISFJ-U (unhealthy; now: guarded, tired)');
        expect(card(started, 'Corvin')?.speech).toBe('');
    });

    it('takes the attitude from M19 when the tracker has none, and shows the status a change replaced', async () => {
        const chat = defaultChat();
        chat[1] = trackerReply([
            { name: 'Anna', details: { demeanor: 'calm' } },
            { name: 'Corvin', relationship: 'Ally' },
        ]);
        const started = await start({
            chat,
            relations: [relation('Anna', 'Kai', [[1, 'Trusted']]), relation('Corvin', 'Kai', [[0, 'Enemy']])],
        });
        expect(card(started, 'Anna')?.attitude).toBe('Trusted');
        expect(card(started, 'Corvin')?.attitude).toBe('Ally (was Enemy)');

        started.relations.set([
            relation('Anna', 'Kai', [
                [0, 'Neutral'],
                [1, 'Trusted'],
            ]),
        ]);
        expect(card(started, 'Anna')?.attitude).toBe('Trusted (was Neutral)');
    });

    it('adds attitudes between present characters, which the user can turn off', async () => {
        const started = await start({
            relations: [
                relation('Anna', 'Corvin', [[1, 'Distrust']]),
                relation('Corvin', 'Anna', [[1, 'Contempt']]),
                relation('Anna', 'Bob', [[1, 'Fond']]),
            ],
        });
        expect(started.service.injection().bonds).toEqual([
            '[Bond] Anna → Corvin: Distrust',
            '[Bond] Corvin → Anna: Contempt',
        ]);
        expect(started.service.injection().text).toContain('\n[Bond] Anna → Corvin: Distrust');

        started.service.settings().npcAttitudes = false;
        started.env.settings.notify('m15.npcAttitudes');
        expect(started.service.injection().bonds).toEqual([]);
        started.service.settings().goals = false;
        expect(card(started, 'Anna')?.goals).toBeUndefined();
    });

    it('reads a saved archive book again', async () => {
        const started = await start();
        let changes = 0;
        started.api.onChange(() => changes++);
        started.books[ARCHIVES]!.entries['2']!.content =
            '<BunnymoTags><Name:Corvin>, <MBTI:ENTJ-H>, <LING:WARM></BunnymoTags>';
        await started.env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_UPDATED!, 'Other book');
        await started.env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_UPDATED!, ARCHIVES);
        expect(card(started, 'Corvin')?.speech).toBe('commanding');
        await new Promise((resolve) => setTimeout(resolve, 260));
        await tick();
        expect(card(started, 'Corvin')?.speech).toBe('warm');
        expect(card(started, 'Corvin')?.mbti).toBe('ENTJ-H (healthy; now: cold)');
        expect(changes).toBeGreaterThan(0);
    });

    it('warms the archives of a new reply before the user answers it', async () => {
        const started = await start({
            world: [
                { name: 'Kai', kind: 'persona' },
                { name: 'Anna', archive: `${ARCHIVES}#1` },
            ],
        });
        started.env.mock.chat.push(trackerReply([{ name: 'Anna' }, { name: 'Kai' }]));
        started.world.set([
            { name: 'Kai', kind: 'persona' },
            { name: 'Anna', archive: `${ARCHIVES}#1` },
            { name: 'Corvin', archive: `${ARCHIVES}#2` },
        ]);
        started.env.mock.chat.push(trackerReply([{ name: 'Corvin' }]));
        const loadsBefore = started.loads.length;
        await started.env.app.bus.emit('reply:ready', {
            messageIndex: started.env.mock.chat.length - 1,
            type: 'normal',
        });
        await started.env.app.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        await tick();
        expect(started.loads.length).toBe(loadsBefore + 1);
    });

    it('respects the architect’s voices budget over its own cap; goals go first', async () => {
        const started = await start();
        const full = started.service.injection();
        expect(full.budgetSource).toBe('cap');
        expect(full.budget).toBe(600);
        expect(full.trimmed).toEqual([]);

        const architect = new FakeArchitect(full.tokens - 5);
        started.env.modules.expose('architect', architect);
        started.env.settings.notify('m20.budgets');
        const tight = started.service.injection();
        expect(tight.budgetSource).toBe('architect');
        expect(tight.trimmed[0]).toBe('goals');
        expect(tight.tokens).toBeLessThanOrEqual(tight.budget);
        expect(tight.text).not.toContain('Goals:');

        architect.voices = 0;
        expect(started.service.injection().budgetSource).toBe('cap');
        started.service.settings().cap = 20;
        const capped = started.service.injection();
        expect(capped.budget).toBe(100);
        expect(capped.tokens).toBeLessThanOrEqual(100);
        expect(capped.trimmed).toContain('speech');
    });
});

describe('injection', () => {
    it('goes into every real generation in chat at depth 1 as system, never scanned', async () => {
        const started = await start();
        await generate(started, prompt());
        const slot = started.prompts().maestro_voices;
        expect(slot).toEqual({
            value: started.service.injection().text,
            position: 1,
            depth: 1,
            scan: false,
            role: 0,
        });
        expect(slot?.value.startsWith(`${VOICES_HEADER}\n[Voice: Anna]`)).toBe(true);
        await generate(started, prompt(), { info: { type: 'impersonate' } });
        expect(started.prompts().maestro_voices?.value).toBe(slot?.value);
    });

    it('stays out of quiet generations, dry runs and sheet commands', async () => {
        const started = await start();
        for (const info of [{ quiet: true, type: 'quiet' }, { dryRun: true }, { sheetCommand: '!fullsheet' }]) {
            await generate(started, prompt());
            expect(started.prompts().maestro_voices?.value).not.toBe('');
            await generate(started, prompt(), { info });
            expect(started.prompts().maestro_voices?.value ?? '').toBe('');
        }
    });

    it('is assembled at turn:committed: the producer only takes the cached cards', async () => {
        const started = await start();
        started.env.mock.chat = [
            ...defaultChat(),
            trackerReply([{ name: 'Corvin', relationship: 'Rival' }]),
            userMessage('And you?'),
        ];
        await started.env.app.bus.emit('turn:committed', { messageIndex: 3 });
        expect(started.api.cards().map((item) => item.name)).toEqual(['Corvin']);
        const resolves = started.world.calls.resolve;
        await generate(started, prompt());
        expect(started.world.calls.resolve).toBe(resolves);
        expect(started.prompts().maestro_voices?.value).toContain('[Voice: Corvin]');
        expect(started.prompts().maestro_voices?.value).toContain('Toward Kai: Rival');
    });

    it('follows edits and swipes of the committed reply', async () => {
        const started = await start();
        started.env.mock.chat[1] = trackerReply([{ name: 'Corvin' }], undefined, 'edited reply');
        await started.env.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'edited' });
        expect(started.api.cards().map((item) => item.name)).toEqual(['Corvin']);
    });
});

describe('CarrotKernel quiet mode', () => {
    it('takes CK’s insert out of the prompt of a generation with cards, leaving CK’s slot alone', async () => {
        const started = await start();
        const messages = await generate(started, prompt(), { ck: CK });
        expect(messages.map((item) => item.content)).toEqual(['Main prompt.', 'reply', 'Anna, the map?']);
        expect(started.prompts()['script_inject_carrot-consistency']?.value).toBe(CK);
        const quiet = started.service.quiet();
        expect(quiet.ck?.outcome).toBe('removed');
        expect(quiet.ck?.tokens).toBeGreaterThan(0);
        expect(started.api.ckSilenced()).toBe(true);
    });

    it('leaves the insert when no cards went out: no cast, quiet generations, dry runs', async () => {
        const started = await start({
            chat: [userMessage('Hi.'), trackerReply([{ name: 'Kai' }]), userMessage('Hm.')],
        });
        expect(started.api.cards()).toEqual([]);
        expect((await generate(started, prompt(), { ck: CK })).length).toBe(4);
        expect(started.service.quiet().ck).toBeNull();

        await app?.stop();
        const other = await start();
        expect((await generate(other, prompt(), { ck: CK, info: { quiet: true, type: 'quiet' } })).length).toBe(4);
        expect((await generate(other, prompt(), { ck: CK, dryRun: true })).length).toBe(4);
        expect(other.service.quiet().ck).toBeNull();
        expect((await generate(other, prompt(), { ck: CK })).length).toBe(3);
        const removed = other.service.quiet().ck;
        expect(removed?.outcome).toBe('removed');
        // After the generation ended, a stray PROMPT_READY (another extension's request) is left alone.
        await other.env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        const late = prompt();
        await other.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, { chat: late, dryRun: false });
        expect(late).toHaveLength(4);
        expect(other.service.quiet().ck).toEqual(removed);
    });

    it('reports when CK sent nothing and when its text is not in the prompt', async () => {
        const started = await start();
        await generate(started, prompt());
        expect(started.service.quiet().ck?.outcome).toBe('absent');
        expect(started.api.ckSilenced()).toBe(true);

        await generate(started, [{ role: 'user', content: 'nothing here' }], { ck: CK });
        expect(started.service.quiet().ck?.outcome).toBe('notFound');
        expect(started.api.ckSilenced()).toBe(false);
    });

    it('tells DES-RU on start, keeps its other owned functions, and gives the function back on stop', async () => {
        const desru = new FakeDesRuApi();
        desru.owned = new Set(['bunnymo.scanTags']);
        const started = await start({ desru });
        expect(desru.maestroOwned()).toEqual([CK_FUNCTION, 'bunnymo.scanTags']);
        expect(started.service.quiet().desru).toBe('told');
        const calls = desru.calls.length;
        await generate(started, prompt());
        expect(desru.calls.length).toBe(calls);

        await started.stop();
        expect(desru.maestroOwned()).toEqual(['bunnymo.scanTags']);
    });

    it('tells a DES-RU that appeared later before the next generation, and reports one that refuses', async () => {
        const started = await start({ desru: null });
        expect(started.service.quiet().desru).toBe('absent');
        expect(started.api.ckSilenced()).toBe(true);
        const desru = new FakeDesRuApi();
        started.desru.api = desru;
        await generate(started, prompt());
        expect(desru.maestroOwned()).toEqual([CK_FUNCTION]);

        desru.setMaestroOwned = () => {
            throw new Error('refused');
        };
        desru.owned.clear();
        await changeChat(started, 'chat-2');
        expect(started.service.quiet().desru).toBe('notTold');
        expect(started.api.ckSilenced()).toBe(false);
    });
});

describe('module', () => {
    it('is off by default and releases everything it registered', async () => {
        expect(voicesModule).toMatchObject({ id: 'M15', key: 'voices', stage: 8, enabledByDefault: false });
        const started = await start();
        await started.stop();
        const { env } = started;
        const disposers: Unsubscribe[] = [];
        const desru = new FakeDesRuApi();
        started.desru.api = desru;
        await voicesModule.init({
            app: env.app,
            settings: env.settings.module('voices'),
            log: env.log,
            own: (dispose) => disposers.push(dispose as Unsubscribe),
        });
        const api = env.modules.api<VoicesApi>('voices');
        expect(api?.cards().length).toBe(3);
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['voices', 'm15.tab', 56]]);
        expect(env.ui.styles.has('maestro-m15')).toBe(true);
        expect(desru.maestroOwned()).toEqual([CK_FUNCTION]);

        for (const dispose of disposers.splice(0).reverse()) await dispose();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.has('maestro-m15')).toBe(false);
        expect(desru.maestroOwned()).toEqual([]);
        await generate(started, prompt(), { ck: CK });
        expect(started.prompts().maestro_voices?.value ?? '').toBe('');
        expect(api?.cards()).toEqual([]);
    });
});

/* ------------------------------------------------------------------ stage 9: M18 */

class FakeKnowledge implements KnowledgeApi {
    readonly calls: string[] = [];
    private readonly listeners = new Set<() => void>();
    constructor(public list: KnowledgeFact[]) {}
    set(list: KnowledgeFact[]): void {
        this.list = list;
        for (const listener of [...this.listeners]) listener();
    }
    facts(): KnowledgeFact[] {
        return this.list;
    }
    unknownFor(character: string, recentText: string): KnowledgeFact[] {
        this.calls.push(character);
        return unknownFacts(this.list, character, recentText);
    }
    async markKnown(): Promise<void> {}
    async addSecret(): Promise<string> {
        return 'id';
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

function knowledgeFact(id: string, text: string, topics: string[], knownBy: string[], secret = false): KnowledgeFact {
    return { id, text, topics, knownBy, secret, sourceMessage: 1, at: 1 };
}

describe('what a present character does not know (M18)', () => {
    const facts = () => [
        knowledgeFact('map', 'Quest begun: Find the map', ['the map'], ['Anna', 'Kai']),
        knowledgeFact('gold', 'Bob stole the gold', ['gold'], ['Kai']),
    ];

    it('adds «Unaware of» only when the topic came up and the character does not know it', async () => {
        const knowledge = new FakeKnowledge(facts());
        const started = await start({ before: (test) => test.env.modules.expose('knowledge', knowledge) });
        expect(card(started, 'Corvin')?.unknown).toBe('Quest begun: Find the map');
        expect(card(started, 'Corvin')?.text).toBe(
            '[Voice: Corvin] Speech: commanding | MBTI: ENTJ-U (unhealthy; now: cold) | Toward Kai: Enemy | ' +
                'Unaware of: Quest begun: Find the map',
        );
        expect(card(started, 'Stranger')?.text).toBe(
            '[Voice: Stranger] Now: nervous | Unaware of: Quest begun: Find the map',
        );
        expect(card(started, 'Anna')?.unknown).toBeUndefined();
        expect(card(started, 'Anna')?.text).not.toContain('Unaware of');

        // A secret noted after the commit: the cards are rebuilt in the background, the producer only takes them.
        knowledge.set([...facts(), knowledgeFact('spy', 'Anna is a spy', ['Anna'], ['Anna'], true)]);
        await tick();
        expect(card(started, 'Corvin')?.unknown).toBe('Anna is a spy; Quest begun: Find the map');
        const calls = knowledge.calls.length;
        await generate(started, prompt());
        expect(knowledge.calls.length).toBe(calls);
        expect(started.prompts().maestro_voices?.value).toContain('| Unaware of: Anna is a spy; Quest begun: Find');
    });

    it('follows the user’s answer: when the topic is gone, so is the line', async () => {
        const knowledge = new FakeKnowledge(facts());
        const started = await start({ before: (test) => test.env.modules.expose('knowledge', knowledge) });
        expect(card(started, 'Corvin')?.unknown).toBe('Quest begun: Find the map');
        started.env.mock.chat[2] = userMessage('Corvin, leave us.');
        await started.env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        expect(card(started, 'Corvin')?.unknown).toBeUndefined();
    });

    it('leaves the cards as they were without M18', async () => {
        const started = await start();
        expect(started.api.cards().some((item) => item.unknown !== undefined || item.text.includes('Unaware'))).toBe(
            false,
        );
    });
});
