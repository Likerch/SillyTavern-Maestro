// M16 with Dramatis (release 1.17): a character's brief gets what Dramatis's engine says of them off screen — goals,
// what they attempted, the outcome of its roll — and the contradiction check sees it too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { answer, createOffscreenEnv, event, seedMira, seedScene, trackerMessage, userMessage } from './helpers';
import type { OffscreenEnv, TrackerParts } from './helpers';

let env: OffscreenEnv;
let dramatis: InstalledDramatis;

const TAVERN: TrackerParts = { location: 'Таверна', present: ['Лиза'] };

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
    seedScene(env);
    seedMira(env);
    env.mock.chat.push(
        trackerMessage('Мира на рынке.', { present: ['Лиза', 'Mira'], location: 'Рынок' }),
        userMessage('Пойдём.'),
    );
    for (let i = 0; i < 6; i++) env.mock.chat.push(trackerMessage(`Таверна ${i}`, TAVERN), userMessage(`Ход ${i}`));
    env.mock.chat.push(trackerMessage('Черновик ответа', TAVERN));
    dramatis = installDramatis(env.app);
});

afterEach(async () => {
    await env.stop();
    dramatis.remove();
    vi.useRealTimers();
});

const userPrompt = () => env.llm.requests[0]?.messages[1]?.content ?? '';

describe('M16 with Dramatis', () => {
    it('adds the engine’s lines to the brief and to what the event must not contradict', async () => {
        dramatis.api.briefs = {
            Mira: 'Goal: pay off the guild before the moon\nTried: sold the amulet to a captain\nOutcome: success (rolled 14 vs 12)',
        };
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(userPrompt()).toContain(
            'Their own plans (from the personality engine; the event follows them): Goal: pay off the guild before the moon; Tried: sold the amulet to a captain; Outcome: success (rolled 14 vs 12)',
        );
        const against = env.contradictions.checks[0]!.input.against;
        expect(against.filter((item) => item.label === 'dramatis: Mira').map((item) => item.text)).toEqual([
            'Goal: pay off the guild before the moon',
            'Tried: sold the amulet to a captain',
            'Outcome: success (rolled 14 vs 12)',
        ]);
    });

    it('says nothing of the engine without Dramatis or without lines for the character', async () => {
        env.llm.script = [answer(event()), answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(userPrompt()).not.toContain('personality engine');
        dramatis.api.briefs = { Mira: 'Goal: hide' };
        dramatis.remove();
        await service.execute('manual', ['Mira']);
        expect(env.llm.requests[1]?.messages[1]?.content ?? '').not.toContain('personality engine');
    });
});
