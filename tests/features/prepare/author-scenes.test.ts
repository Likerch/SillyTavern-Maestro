// @vitest-environment happy-dom
// «Подготовить к игре» with the starting scenes the card's author set down (Officina, release 1.24): the stand's card
// gets `data.extensions.officina.scenes` for two of its three greetings. The analysis is told them for the greetings of
// each part, and the plan's scenes of those greetings take their place, time and cast; the third greeting is read as
// before.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrepareItem } from '../../../src/domain/prepare-plan';
import { analyse, createPrepareEnv, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

type Dict = Record<string, unknown>;

let env: PrepareEnv;
let started: Started;

beforeEach(() => {
    env = createPrepareEnv();
    started = startPrepare(env);
});

afterEach(() => {
    started.stop();
});

function setScenes(scenes: unknown[]): void {
    const data = (env.mock.context.characters[0] as unknown as Dict).data as Dict;
    const extensions = (data.extensions as Dict | undefined) ?? {};
    data.extensions = { ...extensions, officina: { scenes } };
}

function scenesOfPlan(): PrepareItem<'scene'>[] {
    return started.service.plan()!.items.filter((item): item is PrepareItem<'scene'> => item.kind === 'scene');
}

describe('prepare: the author’s starting scenes', () => {
    it('are given to the analysis and win over what it read for their greetings', async () => {
        setScenes([
            {
                place: 'Таверна у моста',
                time: 'полночь',
                present: ['Мартин', 'Вера'],
                mood: 'тревожно',
                hook: 'Мартин прячет письмо.',
            },
            null,
            { place: 'Архив картографов', time: 'глубокая ночь' },
        ]);
        await analyse(started.service);
        const scenes = scenesOfPlan();
        expect(scenes.map((item) => [item.id, item.data.place, item.data.time])).toEqual([
            ['scene:0', 'Таверна у моста', 'полночь'],
            ['scene:1', 'Серебряная Гавань', 'рассвет'],
            ['scene:2', 'Архив картографов', 'глубокая ночь'],
        ]);
        expect(scenes[0]!.data.present).toEqual(['Мартин', 'Вера']);
        // What the analysis read and the author did not say stays.
        expect(scenes[0]!.data.firstScene).toBe('dialogue');
        // The requests named the author's scenes of their greetings only.
        const texts = env.llm.requests.map((request) => request.messages.map((message) => message.content).join('\n'));
        const told = texts.filter((content) => content.includes('<author_scenes>'));
        expect(told.length).toBeGreaterThan(0);
        expect(told.some((content) => content.includes('greeting 0 — place: Таверна у моста; time: полночь'))).toBe(
            true,
        );
        expect(texts.every((content) => !content.includes('greeting 1 —'))).toBe(true);
    });

    it('change nothing for a card without them', async () => {
        await analyse(started.service);
        expect(scenesOfPlan().map((item) => item.data.place)).toEqual([
            'Солёный якорь',
            'Серебряная Гавань',
            'Архив гильдии картографов',
        ]);
        expect(
            env.llm.requests.every((request) => !request.messages.some((m) => m.content.includes('author_scenes'))),
        ).toBe(true);
    });
});
