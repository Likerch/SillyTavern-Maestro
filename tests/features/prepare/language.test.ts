// @vitest-environment happy-dom
// «Язык истории» in «Подготовить к игре» (M37): the stand's card is Russian and the interface Russian, so «Авто» reads
// it as a Russian story — the request asks for Russian names and player-facing texts, the outfits reach the wardrobe as
// Russian statements, the secret is stored in Russian with its English copy, passports are generated for Russian. An
// explicit English setting keeps today's behaviour (whatever script the names have). A Russian plan meets what an older
// preparation made under English names without duplicating it; a saved analysis of another language is read again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREPARE_SCHEMA } from '../../../src/domain/prepare-extract';
import type { AnyPrepareItem } from '../../../src/domain/prepare-plan';
import { savedLanguageFits } from '../../../src/features/prepare/service';
import { analyse, createPrepareEnv, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

let env: PrepareEnv;
let started: Started;

beforeEach(() => {
    env = createPrepareEnv();
    started = startPrepare(env);
});

afterEach(() => {
    started.stop();
});

function userText(index = 0): string {
    return env.llm.requests[index]?.messages.find((message) => message.role === 'user')?.content ?? '';
}

function scene(greeting: number) {
    return started.service.plan()!.items.find((item) => item.id === `scene:${greeting}`) as Extract<
        AnyPrepareItem,
        { kind: 'scene' }
    >;
}

describe('prepare: «Язык истории»', () => {
    it('auto in a new Russian chat: Russian names and player texts in one request, the plan remembers it', async () => {
        const { service } = started;
        await analyse(service);
        const request = env.llm.requests[0]!;
        expect(userText().startsWith('Story language: Russian')).toBe(true);
        expect(request.messages[0]!.content).toContain('Ophelia → Офелия');
        expect(request.schema?.schema).not.toBe(PREPARE_SCHEMA);
        const plan = service.plan()!;
        expect(plan.language).toBe('ru');
        expect(scene(0).data.outfits.every((row) => /[а-яё]/i.test(row.wearing))).toBe(true);
        expect(plan.items.find((item) => item.id === 'direction')?.data).toMatchObject({ genre: 'Детектив' });

        const summary = await service.apply('all', { passports: false });
        expect(summary.failed).toEqual([]);
        // The shown start's outfits go to the wardrobe as Russian statements (no passports made now).
        expect(env.wardrobe.intakes.length).toBeGreaterThan(0);
        expect(env.wardrobe.intakes.every((intake) => / носит: /.test(String(intake.value)))).toBe(true);
        // The secret: Russian for «Кто что знает», the English statement beside it.
        expect(env.knowledge.facts()[0]).toMatchObject({
            text: expect.stringMatching(/^[А-ЯЁ]/),
            english: expect.stringContaining('missing cargo'),
        });
    });

    it("an explicit English setting keeps today's request and texts, passports for English", async () => {
        env.settings.core().storyLanguage = 'en';
        const { service } = started;
        await analyse(service);
        const request = env.llm.requests[0]!;
        expect(userText()).not.toContain('Story language');
        expect(request.messages[0]!.content).not.toContain('Ophelia → Офелия');
        expect(request.schema?.schema).toBe(PREPARE_SCHEMA);
        expect(service.plan()!.language).toBe('en');
        expect(scene(1).data.outfits).toEqual([{ name: 'Вера', wearing: 'a quilted watch jacket' }]);

        await service.apply('all');
        // The names are Cyrillic (a Russian card), yet the passports follow the setting.
        expect(env.nai.generated.length).toBeGreaterThan(0);
        expect(env.nai.generated.every((input) => input.language === 'en')).toBe(true);
        const fact = env.knowledge.facts()[0]!;
        expect(fact.text).toContain('missing cargo');
        expect(fact.english).toBeUndefined();
    });

    it('does not duplicate what an older preparation made under English names', async () => {
        // An earlier (English) preparation of this chat: a canon entry, a place and a passport under English names.
        env.canon.seed(
            { comment: 'Elizabet', key: ['Elizabet'], content: 'Character: Elizabet' },
            { type: 'character' },
        );
        await env.places.create('Silver Harbor');
        env.nai.chat.push({
            id: 'old-elizabet',
            kind: 'character',
            name: 'Elizabet',
            aliases: [],
            tags: '',
            slots: { base: '1girl' },
            outfits: [],
            activeOutfit: '',
            states: [],
            negative: '',
        } as never);
        const { service } = started;
        await analyse(service);
        const items = new Map(service.plan()!.items.map((item) => [item.id, item]));
        const elizabeth = items.get('character:elizabet')!;
        expect(elizabeth.data).toMatchObject({ name: 'Элизабет', english: 'Elizabet' });
        expect(elizabeth.exists?.where).toBe('canon');
        expect(elizabeth.links).toMatchObject({ passportId: 'old-elizabet' });
        expect(items.get('place:silver harbor')?.exists).toMatchObject({ where: 'places', label: 'Silver Harbor' });

        const canonBefore = (await env.canon.list()).length;
        await service.apply('all');
        const canon = await env.canon.list();
        expect(canon.filter((item) => /^Elizabet$/.test(String(item.entry.comment)))).toHaveLength(1);
        expect(canon.length).toBeGreaterThan(canonBefore);
        expect(env.places.list().filter((place) => /Silver Harbor|Серебряная Гавань/.test(place.name))).toHaveLength(1);
        expect(env.nai.generated.some((input) => input.name === 'Elizabet')).toBe(false);
    });

    it('finds a place made under its English name after the analysis (no link yet): no second place', async () => {
        const { service } = started;
        await analyse(service);
        expect(service.plan()!.items.find((item) => item.id === 'place:silver harbor')?.links).toBeUndefined();
        await env.places.create('Silver Harbor');
        await service.apply([{ id: 'place:silver harbor' }]);
        expect(env.places.list().map((place) => place.name)).toEqual(['Silver Harbor']);
    });
});

describe('prepare: a saved analysis and «Язык истории»', () => {
    const named = (name: string): AnyPrepareItem =>
        ({
            id: `character:${name.toLowerCase()}`,
            kind: 'character',
            data: { name, english: name, forms: [] },
            russian: '',
            sources: [],
            scope: 'character',
        }) as unknown as AnyPrepareItem;

    it('is reused only for the language it was read for', () => {
        expect(savedLanguageFits({ language: 'ru', analysis: [] }, 'ru')).toBe(true);
        expect(savedLanguageFits({ language: 'en', analysis: [] }, 'ru')).toBe(false);
        expect(savedLanguageFits({ language: 'ru', analysis: [] }, 'en')).toBe(false);
    });

    it('an older file (no language) fits an English story, and a Russian one only with Russian names', () => {
        const english = { analysis: [named('Ophelia')] };
        const russian = {
            analysis: [named('Офелия'), { ...named('x'), kind: 'secret', data: { text: 'A' } } as never],
        };
        expect(savedLanguageFits(english, 'en')).toBe(true);
        expect(savedLanguageFits(english, 'ru')).toBe(false);
        expect(savedLanguageFits(russian, 'ru')).toBe(true);
    });

    it('reads everything again when the saved analysis was read for another language', async () => {
        const { service } = started;
        env.settings.core().storyLanguage = 'en';
        await analyse(service);
        await service.apply([{ id: 'character:elizabet', scope: 'character' }]);
        const saved = (await service.readSaved(env.mock.context.characters[0]!.avatar as string))!;
        expect(saved.language).toBe('en');
        env.settings.core().storyLanguage = 'ru';
        const estimate = await service.estimate({ reuse: true });
        // Nothing changed in the card, yet every source is read again (the names must be Russian now).
        expect(estimate.reuse).toBe(false);
        expect(estimate.labels.length).toBeGreaterThan(0);
        env.settings.core().storyLanguage = 'en';
        const same = await service.estimate({ reuse: true });
        expect(same.reuse).toBe(true);
        expect(same.labels).toEqual([]);
    });
});
