// @vitest-environment happy-dom
// M41 «Персона для персонажа», the work behind the window: what the model reads (the card, the greeting the chat opened
// with, what the card says about {{user}}, the personas, the lore within its budget without Maestro's and BunnyMo's
// books, the comment or its absence), the one retry, and the creation over ST's personas.js double and a NAI Studio
// double — initPersona's arguments, the default avatar upload, the link to the card (the card's other personas stay
// linked), the passport with our outfits, the picture, «Сделать текущей»; without NAI Studio's 'personaKeys' the
// persona is still made and the passport and the picture say why they were skipped.
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaCreator, StPersonas } from '../../../src/features/personaCreator';
import type { CreatePlan } from '../../../src/features/personaCreator';
import { PersonaCollector } from '../../../src/features/personaCreator/collect';
import { readPersonaCreatorSettings } from '../../../src/features/personaCreator/settings';
import type { PersonaCreatorSettings } from '../../../src/features/personaCreator/settings';
import { installFakeNaiPersona, removeFakeNaiPersona } from '../../helpers/nai-persona';
import { OUTFITS, createEnv, personaAnswer } from './helpers';
import type { Env } from './helpers';

type Dict = Record<string, unknown>;

afterEach(() => {
    removeFakeNaiPersona();
    document.body.innerHTML = '';
});

const CARD = { index: 0, avatar: 'vera.png', name: 'Вера' };
const NOW = 1760000000000;
const AVATAR = `${NOW}-Mira.png`;

function creator(env: Env): PersonaCreator {
    const settings = () =>
        readPersonaCreatorSettings(env.settings.module<Partial<PersonaCreatorSettings>>('personaCreator'));
    return new PersonaCreator(env.app, env.app.log, new StPersonas(env.app, env.app.log), settings);
}

async function draftOf(env: Env, service: PersonaCreator) {
    const result = await service.generate(CARD, { comment: 'наёмница с севера' });
    if (!result.ok) throw new Error(result.error);
    return result;
}

function plan(env: Env, draft: Awaited<ReturnType<typeof draftOf>>, options: Partial<CreatePlan['options']> = {}) {
    return {
        card: CARD,
        name: draft.draft.name,
        title: draft.draft.title,
        description: 'Внешность: высокая.\n\nГардероб: Повседневный.',
        outfits: draft.draft.outfits,
        draft: draft.draft,
        language: draft.language,
        options: { passport: true, picture: true, link: true, makeCurrent: false, ...options },
    } satisfies CreatePlan;
}

describe('what the model reads', () => {
    it('reads the card, the greeting of the chat, the {{user}} lines, the personas and the story books', async () => {
        const env = createEnv();
        const collected = await new PersonaCollector(
            env.app,
            env.app.log,
            new StPersonas(env.app, env.app.log),
        ).collect(CARD, 8000);
        expect(collected).not.toBeNull();
        const request = collected!.request;
        expect(request.card.name).toBe('Вера');
        expect(request.card.greeting).toEqual({ index: 1, text: 'Ночью {{user}} стучит в ворота форта.' });
        expect(request.card.creatorNotes).toBe('Играть медленно.');
        expect(request.userLines).toContain('{{user}} — её старый должник.');
        expect(request.currentPersona).toEqual({ name: 'Кай', description: 'Рыжий бард с лютней.' });
        expect(request.existingPersonas).toEqual(['Странник']);
        expect(collected!.language).toBe('ru');
        // Maestro's own book and the BunnyMo pack are never read; the chat book is.
        expect(collected!.books).toEqual(['Гавань', 'Чатовая']);
        expect(request.lore.map((item) => item.title)).toEqual([
            'Прибытие',
            'История гавани',
            'Таверна «Якорь»',
            'Буря',
        ]);
        expect(collected!.lore).toMatchObject({ total: 4, skipped: 0 });
    });

    it('cuts the lore to the budget, the entries about the player first', async () => {
        const env = createEnv();
        const collected = await new PersonaCollector(
            env.app,
            env.app.log,
            new StPersonas(env.app, env.app.log),
        ).collect(CARD, 90);
        expect(collected!.request.lore.map((item) => item.title)).toEqual(['Прибытие']);
        expect(collected!.lore.skipped).toBe(3);
    });

    it('without the Lore Studio reads the linked book; a card that is not the chat one gets no chat book', async () => {
        const env = createEnv({ store: false });
        const personas = new StPersonas(env.app, env.app.log);
        const collected = await new PersonaCollector(env.app, env.app.log, personas).collect(CARD, 8000);
        expect(collected!.books).toEqual(['Гавань']);
        Object.assign(env.mock.context, { characterId: 1 });
        const other = await new PersonaCollector(env.app, env.app.log, personas).collect(CARD, 8000);
        expect(other!.books).toEqual(['Гавань']);
        expect(other!.request.card.greeting).toBeNull();
    });

    it('reads the embedded book of a card without a world book', async () => {
        const env = createEnv({ store: false });
        const character = env.mock.context.characters[0] as unknown as Dict;
        character.data = {
            extensions: {},
            character_book: {
                name: 'Книга Веры',
                entries: [{ id: 0, comment: 'Форт', keys: ['форт'], content: 'Старый форт над гаванью.' }],
            },
        };
        const collected = await new PersonaCollector(
            env.app,
            env.app.log,
            new StPersonas(env.app, env.app.log),
        ).collect(CARD, 8000);
        expect(collected!.books).toEqual(['Книга Веры']);
        expect(collected!.request.lore).toEqual([
            { book: 'Книга Веры', title: 'Форт', text: 'Старый форт над гаванью.' },
        ]);
    });
});

describe('the model', () => {
    it('sends the comment, or says there is none; interactive, under its own task', async () => {
        const env = createEnv();
        const service = creator(env);
        const result = await service.generate(CARD, { comment: 'наёмница с севера, давно знает Веру' });
        expect(result.ok).toBe(true);
        const request = env.llm.requests[0]!;
        expect(request.task).toBe('persona.create');
        expect(request.interactive).toBe(true);
        expect(request.schema?.name).toBe('maestro_persona_create');
        const user = request.messages[1]!.content;
        expect(user).toContain('<player_comment>\nнаёмница с севера, давно знает Веру\n</player_comment>');
        expect(user).toContain('[Гавань · Прибытие]');
        expect(user).not.toContain('Служебная запись Maestro');
        expect(user).not.toContain('BunnyMoTags');

        await service.generate(CARD, { comment: '   ', avoid: ['Мира'] });
        const second = env.llm.requests[1]!.messages[1]!.content;
        expect(second).toContain('The player left no comment');
        expect(second).not.toContain('<player_comment>');
        expect(second).toContain('Earlier attempts were: Мира.');
    });

    it('asks once more when the answer breaks the rules, then gives up with a plain reason', async () => {
        const env = createEnv();
        env.llm.answers = [
            { ok: true, data: personaAnswer({ outfits: OUTFITS.slice(0, 3) }) },
            { ok: true, data: personaAnswer() },
        ];
        const phases: string[] = [];
        const result = await creator(env).generate(CARD, { comment: '', phase: (label) => phases.push(label) });
        expect(result.ok).toBe(true);
        expect(env.llm.requests).toHaveLength(2);
        expect(env.llm.requests[1]!.messages[1]!.content).toContain('it had 3 usable outfits');
        expect(phases).toEqual([
            'Читаю карточку и лор…',
            'Придумываю персону…',
            'Ответ не подошёл, спрашиваю ещё раз…',
        ]);

        const bad = createEnv();
        bad.llm.answers = [{ ok: true, data: personaAnswer({ outfits: OUTFITS.slice(0, 4) }) }];
        expect(await creator(bad).generate(CARD, { comment: '' })).toEqual({
            ok: false,
            error: 'Модель дала нарядов: 4 вместо 5–6',
        });
    });

    it('reports no profile, a refusal, a failed request and a stop', async () => {
        const env = createEnv();
        env.llm.available = false;
        expect(await creator(env).generate(CARD, { comment: '' })).toMatchObject({
            ok: false,
            error: expect.stringContaining('Нет профиля'),
        });
        env.llm.available = true;
        env.llm.answers = [{ ok: false, refusal: true }];
        expect(await creator(env).generate(CARD, { comment: '' })).toEqual({ ok: false, error: 'Модель отказалась' });
        env.llm.answers = [{ ok: false, error: 'timeout' }];
        expect(await creator(env).generate(CARD, { comment: '' })).toEqual({
            ok: false,
            error: 'Модель не ответила: timeout',
        });
        const controller = new AbortController();
        controller.abort();
        expect(await creator(env).generate(CARD, { comment: '', signal: controller.signal })).toMatchObject({
            ok: false,
            cancelled: true,
        });
    });
});

describe('creation', () => {
    it('makes the persona, uploads the default avatar, links it, saves the passport with our outfits and draws it', async () => {
        const env = createEnv();
        const nai = installFakeNaiPersona();
        const service = creator(env);
        const draft = await draftOf(env, service);
        const steps: string[] = [];
        const outcome = await service.create(plan(env, draft), {
            now: NOW,
            onStep: (list) => steps.push(list.map((step) => `${step.id}:${step.status}`).join(' ')),
        });

        expect(outcome).toMatchObject({
            ok: true,
            avatarId: AVATAR,
            name: 'Мира',
            picture: true,
            current: false,
            outfits: 6,
        });
        expect(outcome.steps.map((step) => [step.id, step.status])).toEqual([
            ['persona', 'done'],
            ['avatar', 'done'],
            ['link', 'done'],
            ['passport', 'done'],
            ['picture', 'done'],
            ['current', 'skipped'],
        ]);
        expect(outcome.steps.find((step) => step.id === 'passport')?.detail).toBe('6 нарядов');
        expect(steps[0]).toBe(
            'persona:running avatar:pending link:pending passport:pending picture:pending current:pending',
        );

        // initPersona as ST's own «Create» calls it.
        expect(env.personas.initPersona).toHaveBeenCalledWith(
            AVATAR,
            'Мира',
            'Внешность: высокая.\n\nГардероб: Повседневный.',
            'наёмница с севера',
        );
        // ST's default avatar under the new file name.
        const upload = env.mock.requests.find((request) => request.url === '/api/avatars/upload')!;
        expect(env.mock.requests.some((request) => request.url === 'img/user-default.png')).toBe(true);
        expect(upload.init?.method).toBe('POST');
        const form = upload.init?.body as FormData;
        expect(form.get('overwrite_name')).toBe(AVATAR);
        expect(form.get('avatar')).toBeInstanceOf(File);
        expect((upload.init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
        // The link: the new persona's own connection; the card's other persona stays linked.
        const descriptors = env.power.persona_descriptions as Record<string, Dict>;
        expect(descriptors[AVATAR]!.connections).toEqual([{ type: 'character', id: 'vera.png' }]);
        expect(descriptors['old.png']!.connections).toEqual([{ type: 'character', id: 'vera.png' }]);
        expect(env.mock.saveSettingsCalls).toBeGreaterThan(0);
        expect(env.personas.updatePersonaConnectionsAvatarList).toHaveBeenCalled();
        expect(env.personas.getUserAvatars).toHaveBeenCalledWith(true, AVATAR);
        expect(env.personas.setUserAvatar).not.toHaveBeenCalled();

        // The passport: the persona prompt, our outfits instead of the generator's, the everyday one on.
        expect(nai.generated).toHaveLength(1);
        expect(nai.generated[0]).toMatchObject({ name: 'Мира', kind: 'character', persona: true, language: 'ru' });
        expect(nai.generated[0]!.description).toContain('adult woman, tall, slim');
        expect(nai.generated[0]!.description).toContain('- Дорожный: hooded cloak, travel boots');
        expect(nai.saved).toHaveLength(1);
        const saved = nai.saved[0]!;
        expect(saved.scope).toBe('card');
        expect(saved.target).toEqual({ personaKey: AVATAR });
        expect(saved.passport.outfits).toEqual(
            OUTFITS.map((outfit) => ({ name: outfit.name, tags: outfit.tags, looks: [outfit.wording] })),
        );
        expect(saved.passport.activeOutfit).toBe('Повседневный');
        expect(saved.passport.slots.hair).toBe('blonde hair, braid');
        // The picture, drawn from that passport for that persona.
        expect(nai.avatars).toHaveLength(1);
        expect(nai.avatars[0]!.personaKey).toBe(AVATAR);
        expect(nai.avatars[0]!.passport?.outfits).toHaveLength(6);
    });

    it('makes it the current persona only when asked, and leaves out what was not chosen', async () => {
        const env = createEnv();
        installFakeNaiPersona();
        const service = creator(env);
        const draft = await draftOf(env, service);
        const outcome = await service.create(plan(env, draft, { link: false, passport: false, makeCurrent: true }), {
            now: NOW,
        });
        expect(env.personas.setUserAvatar).toHaveBeenCalledWith(AVATAR, { toastPersonaNameChange: false });
        expect(outcome.current).toBe(true);
        expect(outcome.steps.map((step) => [step.id, step.status, step.detail ?? ''])).toEqual([
            ['persona', 'done', ''],
            ['avatar', 'done', ''],
            ['link', 'skipped', 'не выбрано'],
            ['passport', 'skipped', 'не выбрано'],
            ['picture', 'skipped', 'нет паспорта, по которому рисовать'],
            ['current', 'done', ''],
        ]);
        expect((env.power.persona_descriptions as Record<string, Dict>)[AVATAR]!.connections).toBeUndefined();
    });

    it('without NAI Studio’s persona keys still makes the persona and says why the passport and picture were skipped', async () => {
        const env = createEnv();
        const nai = installFakeNaiPersona({ personaKeys: false });
        const service = creator(env);
        expect(service.naiSupport()).toBe('old');
        const outcome = await service.create(plan(env, await draftOf(env, service)), { now: NOW });
        expect(outcome.ok).toBe(true);
        expect(outcome.steps.filter((step) => step.status === 'skipped').map((step) => [step.id, step.detail])).toEqual(
            [
                ['passport', 'нужна свежая NAI Studio'],
                ['picture', 'нужна свежая NAI Studio'],
                ['current', 'не выбрано'],
            ],
        );
        expect(nai.generated).toEqual([]);
        expect(nai.saved).toEqual([]);
        expect(env.personas.initPersona).toHaveBeenCalled();

        removeFakeNaiPersona();
        const bare = createEnv();
        const without = creator(bare);
        expect(without.naiSupport()).toBe('absent');
        const result = await without.create(plan(bare, await draftOf(bare, without)), { now: NOW });
        expect(result.steps.find((step) => step.id === 'passport')?.detail).toBe(
            'NAI Studio не установлен или выключен',
        );
    });

    it('tells why NAI Studio made no passport, and skips the picture', async () => {
        const env = createEnv();
        installFakeNaiPersona({ generate: () => null });
        const service = creator(env);
        const outcome = await service.create(plan(env, await draftOf(env, service)), { now: NOW });
        expect(outcome.steps.find((step) => step.id === 'passport')).toEqual({
            id: 'passport',
            status: 'failed',
            detail: 'NAI Studio не сделал паспорт: не хватает Anlas',
        });
        expect(outcome.steps.find((step) => step.id === 'picture')).toEqual({
            id: 'picture',
            status: 'skipped',
            detail: 'нет паспорта, по которому рисовать',
        });
    });

    it('reports a picture NAI Studio did not draw and an avatar that did not upload', async () => {
        const env = createEnv();
        installFakeNaiPersona({ avatar: () => ({ ok: false, error: 'только бесплатно' }) });
        const fetch = globalThis.fetch;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
            String(input) === '/api/avatars/upload' ? new Response('no', { status: 500 }) : fetch(input, init);
        const service = creator(env);
        const outcome = await service.create(plan(env, await draftOf(env, service)), { now: NOW });
        expect(outcome.steps.find((step) => step.id === 'avatar')?.status).toBe('failed');
        expect(outcome.steps.find((step) => step.id === 'picture')).toEqual({
            id: 'picture',
            status: 'failed',
            detail: 'NAI Studio не нарисовал: только бесплатно',
        });
        expect(outcome.picture).toBe(false);
    });

    it('creates nothing when SillyTavern refuses the persona', async () => {
        const env = createEnv();
        env.personas.initPersona.mockRejectedValueOnce(new Error('settings are locked'));
        const service = creator(env);
        const outcome = await service.create(plan(env, await draftOf(env, service)), { now: NOW });
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBe('SillyTavern не создал персону: settings are locked');
        expect(outcome.steps.slice(1).every((step) => step.status === 'skipped')).toBe(true);
        expect(env.mock.requests.some((request) => request.url === '/api/avatars/upload')).toBe(false);
    });

    it('stops before the passport when the job was stopped', async () => {
        const env = createEnv();
        const nai = installFakeNaiPersona();
        const service = creator(env);
        const draft = await draftOf(env, service);
        const controller = new AbortController();
        controller.abort();
        const outcome = await service.create(plan(env, draft), { now: NOW, signal: controller.signal });
        expect(outcome.ok).toBe(true);
        expect(outcome.steps.slice(3).map((step) => [step.id, step.status, step.detail])).toEqual([
            ['passport', 'skipped', 'остановлено'],
            ['picture', 'skipped', 'остановлено'],
            ['current', 'skipped', 'остановлено'],
        ]);
        expect(nai.generated).toEqual([]);
    });
});
