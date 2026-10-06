// @vitest-environment happy-dom
// M26 in the strip under chat messages (plan-2 §5): provisional facts under their reply with «Верно», «Забыть» and
// «Это ошибка»; a decision of this session stays as a muted line; after a reload only what still waits comes back.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVING_STRIP, livingCanonModule, livingStripProvider } from '../../../src/features/livingCanon';
import type { LivingCanonService } from '../../../src/features/livingCanon';
import type { MessageStripProvider } from '../../../src/shared/contracts';
import { flush, startModule, turn, createLivingTestApp } from './helpers';
import type { LivingTestApp } from './helpers';

const FESTIVAL =
    'Вечером начинался Праздник Фонарей — каждый год жители запускают бумажные фонари над рекой. Элдрин улыбнулся.';

let env: LivingTestApp;
let living: LivingCanonService;
let stop: () => Promise<void>;

beforeEach(async () => {
    env = createLivingTestApp();
    env.world.add('Элдрин');
    const started = await startModule(env, livingCanonModule);
    living = started.living;
    stop = () => started.stop();
});

afterEach(async () => {
    await stop();
});

function provider(): MessageStripProvider {
    const found = env.ui.strips.find((item) => item.id === LIVING_STRIP);
    if (!found) throw new Error('no living canon strip provider');
    return found;
}

describe('M26 in the strip under messages', () => {
    it('registers its provider while the module runs', async () => {
        expect(env.ui.strips.map((item) => item.id)).toEqual([LIVING_STRIP]);
        await stop();
        expect(env.ui.strips).toEqual([]);
        stop = async () => {};
    });

    it('shows a provisional fact under its reply with the three answers, nothing elsewhere', async () => {
        const index = await turn(env, living, FESTIVAL);
        const items = provider().items(index);
        expect(items).toEqual([
            expect.objectContaining({
                kind: 'fact',
                text: 'Remembered: Праздник Фонарей — tradition (provisional)',
                open: { window: '', tab: 'living' },
            }),
        ]);
        expect(items[0]?.actions?.map((action) => [action.label, action.primary === true])).toEqual([
            ['Right', true],
            ['Forget', false],
            ['A mistake', false],
        ]);
        expect(provider().items(index + 1)).toEqual([]);
        const box = document.createElement('div');
        items[0]?.body?.(box);
        expect(box.textContent).toContain('Праздник Фонарей');
        expect(box.textContent).toContain('“Right” makes it confirmed canon');
    });

    it('«Верно» confirms the fact; the line becomes a muted «confirmed» note and the strip is told', async () => {
        const index = await turn(env, living, FESTIVAL);
        const changes: (number[] | undefined)[] = [];
        const off = provider().onChange((indexes) => changes.push(indexes));
        provider().items(index);
        await provider().items(index)[0]!.actions![0]!.run();
        await flush(living);
        expect(living.provisional()).toEqual([]);
        expect(provider().items(index)).toEqual([
            expect.objectContaining({ kind: 'info', text: 'Fact confirmed: Праздник Фонарей — tradition' }),
        ]);
        expect(changes.some((indexes) => indexes?.includes(index))).toBe(true);
        off();
    });

    it('«Забыть» drops it; «Это ошибка» drops it marked as Maestro’s mistake', async () => {
        const first = await turn(env, living, FESTIVAL);
        await provider().items(first)[0]!.actions![1]!.run();
        await flush(living);
        expect(provider().items(first)).toEqual([
            expect.objectContaining({ kind: 'info', text: 'Forgot: Праздник Фонарей — tradition' }),
        ]);
        const dropped = living.records().find((fact) => fact.name === 'Праздник Фонарей')!;
        expect(dropped).toMatchObject({ status: 'dropped', droppedBy: 'user' });
        expect(dropped.wrong).toBeUndefined();
        expect(typeof dropped.droppedAt).toBe('number');

        const second = await turn(env, living, 'В таверне «Ржавый якорь» пахло элем, как всегда.');
        const item = provider().items(second)[0]!;
        expect(item.text).toContain('Ржавый якорь');
        await item.actions![2]!.run();
        await flush(living);
        expect(living.records().find((fact) => fact.name === 'Ржавый якорь')).toMatchObject({
            status: 'dropped',
            droppedBy: 'user',
            wrong: true,
        });
        expect(provider().items(second)[0]?.text).toBe('Marked as my mistake and forgot: Ржавый якорь — place');
        expect(living.stats().droppedByUser).toBe(2);
        expect(env.canon.living()).toEqual([]);
    });

    it('after a reload only what still waits comes back (decisions of an earlier session are not shown)', async () => {
        const first = await turn(env, living, FESTIVAL);
        const second = await turn(env, living, 'В таверне «Ржавый якорь» пахло элем, как всегда.');
        await living.drop(living.provisional().find((fact) => fact.name === 'Праздник Фонарей')!.uid!);
        await flush(living);
        const later = livingStripProvider(env.app, living, Date.now() + 1);
        expect(later.items(first)).toEqual([]);
        expect(later.items(second).map((item) => item.kind)).toEqual(['fact']);
    });
});
