// «Что надето сейчас» (release 1.11, plan-2 §4): every committed turn the clothing of each character of the scene (the
// DES clothing field, else the appearance text) is reconciled with the passport; undressing, characters without a
// passport, the persona, the prompt line, portraits, the DES clothing field and the hand actions of the tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NaiPassport } from '../../../src/adapters/nai';
import {
    DES_FIELD_UNDO_TARGET,
    PERSONA_TASK,
    WARDROBE_INJECTION,
    WEARING_HEADER,
} from '../../../src/features/wardrobe';
import type { LorePassportsApi } from '../../../src/features/lorePassports/api';
import { createWardrobeEnv, fakeWorld, passport } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const anna = (): NaiPassport => env.nai.getPassport('p-anna')!;
const lastJournal = () => env.journal.records[env.journal.records.length - 1]!;
const wearing = (name: string) => env.service().current(name)[0];
const dressed = (appearance: string, extra: Record<string, string> = {}) => ({
    characters: [{ name: 'Anna', details: { appearance, ...extra } }],
});

describe('every committed turn (English UI)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv();
    });

    it('reads the clothing out of the appearance text and makes a new outfit after two turns', async () => {
        await env.start();
        await env.turn(dressed('Long silver hair, green eyes, in a dark blue silk dress and leather boots'));
        expect(env.nai.calls).toEqual([]);
        expect(wearing('Anna')).toMatchObject({
            passportId: 'p-anna',
            wording: 'in a dark blue silk dress and leather boots',
            outfit: null,
            source: 'appearance',
            present: true,
        });
        const index = await env.turn(dressed('Silver hair; in a dark blue silk dress and leather boots'));
        expect(anna().activeOutfit).toBe('blue silk dress');
        // An appearance text is no look of the outfit (it would match other clothes with the same hair).
        expect(anna().outfits.at(-1)).toEqual({ name: 'blue silk dress', tags: 'dark blue silk dress, leather boots' });
        expect(lastJournal()).toMatchObject({ kind: 'wardrobe.outfit', sourceMessage: index });
        expect(wearing('Anna')).toMatchObject({ outfit: 'blue silk dress', since: index - 2 });
        await env.turn(dressed('in a dark blue silk dress and leather boots'));
        expect(env.nai.of('savePassport')).toHaveLength(1);
        expect(env.nai.of('setOutfit')).toHaveLength(0);
    });

    it('puts a known outfit on at once and goes back to the own clothes', async () => {
        await env.start();
        await env.turn(dressed('Elf, in a white ball gown with long gloves'));
        expect(anna().activeOutfit).toBe('ballgown');
        expect(env.nai.of('setOutfit')).toEqual([['p-anna', 'ballgown', 'chat']]);
        expect(lastJournal().summary).toBe('Anna changed clothes: «ballgown»');
        await env.turn(dressed('wearing blue jeans and a grey hoodie'));
        expect(anna().activeOutfit).toBe('');
        expect(wearing('Anna')).toMatchObject({ outfit: '' });
        expect(lastJournal().summary).toBe('Anna is in their own clothes again');
    });

    it('takes the clothing field first and keeps its wording as a look', async () => {
        await env.start();
        await env.turn(dressed('Silver hair, in a cloak', { outfit: 'Red evening dress, gold earrings' }));
        await env.turn(dressed('Silver hair, in a cloak', { outfit: 'Red evening dress, gold earrings' }));
        expect(anna().outfits.at(-1)).toEqual({
            name: 'red evening dress',
            tags: 'red evening dress, gold earrings',
            looks: ['Red evening dress, gold earrings'],
        });
        expect(wearing('Anna')).toMatchObject({ source: 'field', wording: 'Red evening dress, gold earrings' });
    });

    it('follows undressing: built-in outfits at once, the own clothes while a new outfit waits', async () => {
        await env.start();
        await env.turn(dressed('Naked, hair loose'));
        expect(anna().outfits.at(-1)).toEqual({ name: 'No clothes', tags: 'nude' });
        expect(anna().activeOutfit).toBe('No clothes');
        expect(lastJournal().summary).toBe('Anna has no clothes on');
        await env.turn(dressed('wrapped in a towel'));
        expect(anna().activeOutfit).toBe('In a towel');
        expect(anna().outfits.find((outfit) => outfit.name === 'In a towel')!.tags).toBe('naked towel, towel');
        await env.turn(dressed('Naked'));
        expect(anna().activeOutfit).toBe('No clothes');
        expect(anna().outfits.filter((outfit) => outfit.name === 'No clothes')).toHaveLength(1);
        // Dressing again in something new: the own clothes meanwhile, the outfit on the second turn.
        await env.turn(dressed('in a green velvet coat'));
        expect(anna().activeOutfit).toBe('');
        expect(wearing('Anna')).toMatchObject({ outfit: null });
        await env.turn(dressed('in a green velvet coat'));
        expect(anna().activeOutfit).toBe('green velvet coat');
        // Topless is not an outfit of its own: the record says it, the clothes still match.
        await env.turn(dressed('topless, in a green velvet coat'));
        expect(wearing('Anna')).toMatchObject({ undress: 'partial' });
    });

    it('heals a turn that was missed', async () => {
        await env.start();
        await env.turn(dressed('in a dark blue silk dress'));
        env.autonomy.levels.set('wardrobe.outfit', 'off');
        await env.turn(dressed('in a dark blue silk dress'));
        expect(env.nai.calls).toEqual([]);
        env.autonomy.levels.delete('wardrobe.outfit');
        await env.turn(dressed('in a dark blue silk dress'));
        expect(anna().activeOutfit).toBe('blue silk dress');
        // Without NAI Studio the record is kept by name; the passport catches up when it is back.
        env.naiPresent.value = false;
        await env.turn(dressed('in a white ball gown'));
        await env.turn(dressed('in a white ball gown'));
        env.naiPresent.value = true;
        await env.turn(dressed('in a white ball gown'));
        expect(anna().activeOutfit).toBe('ballgown');
    });

    it('does not stall when messages were deleted while it was not looking', async () => {
        await env.start();
        for (let i = 0; i < 4; i++) await env.turn(dressed('in a white ball gown'));
        expect(anna().activeOutfit).toBe('ballgown');
        // The chat file was cut back without Maestro seeing it (another tab, Maestro off): the stored mark now
        // points past the end of the chat and must not make the next turns look processed.
        await env.switchTo('chat-1', []);
        await env.turn(dressed('wearing blue jeans and a grey hoodie'));
        expect(anna().activeOutfit).toBe('');
        expect(wearing('Anna')).toMatchObject({ outfit: '' });
    });

    it('leaves the user’s own choice alone while the clothing stays, and learns a choice made in Maestro', async () => {
        const service = await env.start();
        await env.turn(dressed('in a dark blue silk dress'));
        await env.turn(dressed('in a dark blue silk dress'));
        await env.nai.setOutfit('p-anna', 'ballgown');
        const calls = env.nai.calls.length;
        await env.turn(dressed('in a dark blue silk dress'));
        expect(env.nai.calls).toHaveLength(calls);
        expect(anna().activeOutfit).toBe('ballgown');
        // «Надеть другое»: this clothing is that outfit from now on.
        await service.wearOther('p-anna', '');
        expect(anna().activeOutfit).toBe('');
        expect(wearing('Anna')).toMatchObject({ outfit: '' });
        const after = env.nai.calls.length;
        await env.turn(dressed('in a dark blue silk dress'));
        expect(env.nai.calls).toHaveLength(after);
        await expect(service.wearOther('nobody', '')).rejects.toThrow('no look for pictures');
    });

    it('updates the record at the Inbox level and proposes once while the clothing stays', async () => {
        env.autonomy.levels.set('wardrobe.outfit', 'inbox');
        await env.start();
        await env.turn(dressed('in a dark blue silk dress'));
        await env.turn(dressed('in a dark blue silk dress'));
        await env.turn(dressed('in a dark blue silk dress'));
        const proposals = env.autonomy.proposals.filter((proposal) => proposal.kind === 'wardrobe.outfit');
        expect(proposals).toHaveLength(1);
        expect(wearing('Anna')).toMatchObject({ queued: 'blue silk dress', wording: 'in a dark blue silk dress' });
        expect(env.nai.calls).toEqual([]);
        await env.inbox.appliers.get('wardrobe.outfit')!(JSON.parse(JSON.stringify(proposals[0]!.payload)));
        expect(anna().activeOutfit).toBe('blue silk dress');
        expect(wearing('Anna')!.queued).toBeUndefined();
    });

    it('takes back what a deleted reply changed', async () => {
        await env.start();
        await env.turn(dressed('in a dark blue silk dress'));
        const index = await env.turn(dressed('in a dark blue silk dress'));
        expect(anna().activeOutfit).toBe('blue silk dress');
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(50);
        expect(anna().outfits.map((outfit) => outfit.name)).toEqual(['ballgown']);
        expect(wearing('Anna')).toMatchObject({ turns: 1, seen: index - 2 });
        const later = await env.turn(dressed('in a dark blue silk dress'));
        expect(anna().activeOutfit).toBe('blue silk dress');
        expect(later).toBeGreaterThan(index);
    });

    it('marks who left the scene and keeps characters without a passport in Maestro only', async () => {
        await env.start();
        await env.turn({
            characters: [
                { name: 'Anna', details: { appearance: 'in a white ball gown' } },
                { name: 'Незнакомка', details: { appearance: 'в сером плаще' } },
            ],
        });
        expect(wearing('Незнакомка')).toMatchObject({ passportId: '', wording: 'в сером плаще', present: true });
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'in a white ball gown' } }] });
        await env.turn({ characters: [{ name: 'Незнакомка', details: { appearance: 'в сером плаще' } }] });
        expect(wearing('Незнакомка')).toMatchObject({ turns: 2, present: true });
        expect(wearing('Anna')).toMatchObject({ present: false });
        expect(
            env
                .service()
                .current()
                .map((item) => item.name),
        ).toEqual(['Незнакомка', 'Anna']);
    });

    it('copies a lore passport into the chat on the first outfit, undo removes it', async () => {
        const lore: Partial<LorePassportsApi> = {
            forScene: () => [
                {
                    world: 'Book',
                    uid: 3,
                    name: 'Vera',
                    passport: { kind: 'character', name: 'Vera', slots: { hair: 'red hair' }, outfits: [] },
                },
            ],
            get: async () => null,
        };
        env.modules.expose('lorePassports', lore);
        await env.start();
        await env.turn({ characters: [{ name: 'Vera', details: { appearance: 'red hair, in a grey cloak' } }] });
        expect(env.nai.calls).toEqual([]);
        await env.turn({ characters: [{ name: 'Vera', details: { appearance: 'red hair, in a grey cloak' } }] });
        const copy =
            env.nai.chatOwn.find((item) => item.name === 'Vera') && env.nai.getPassport(env.nai.chatOwn.at(-1)!.id);
        expect(copy).toMatchObject({ kind: 'character', name: 'Vera', activeOutfit: 'grey cloak' });
        expect(copy!.id).toMatch(/^maestro-vera-/);
        expect(env.journal.records.map((record) => record.summary)).toEqual([
            'Vera: a look of their own in this chat',
            'Vera changed clothes: «grey cloak»',
        ]);
        expect(wearing('Vera')).toMatchObject({ passportId: copy!.id, outfit: 'grey cloak' });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.nai.of('clearChatOverride')).toEqual([[copy!.id]]);
        expect(wearing('Vera')).toMatchObject({ passportId: '', key: 'name:vera' });
    });

    it('does not bring back a passport excluded in this chat through the lore', async () => {
        env.nai.chatOwn.push(passport('p-vera', 'Vera'));
        (env.nai as unknown as { isPassportExcluded: (id: string) => boolean }).isPassportExcluded = (id) =>
            id === 'p-vera';
        const getPassport = env.nai.getPassport.bind(env.nai);
        env.nai.getPassport = (id) => (id === 'p-vera' ? null : getPassport(id));
        const passports = env.nai.passports.bind(env.nai);
        env.nai.passports = (scope) => {
            const all = passports(scope);
            return (scope as { includeExcluded?: boolean } | undefined)?.includeExcluded
                ? all
                : all.filter((item) => item.id !== 'p-vera');
        };
        env.modules.expose('lorePassports', {
            forScene: () => [{ world: 'B', uid: 1, name: 'Vera', passport: { kind: 'character', name: 'Vera' } }],
            get: async () => null,
        });
        await env.start();
        await env.turn({ characters: [{ name: 'Vera', details: { appearance: 'in a grey cloak' } }] });
        await env.turn({ characters: [{ name: 'Vera', details: { appearance: 'in a grey cloak' } }] });
        expect(env.nai.calls).toEqual([]);
        expect(wearing('Vera')).toMatchObject({ passportId: '' });
    });
});

describe('Russian UI', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv('ru');
    });

    it('names new outfits and undressing in Russian', async () => {
        await env.start();
        await env.turn(dressed('Высокая, серебристые волосы, в тёмно-синем шёлковом платье и кожаных сапогах'));
        await env.turn(dressed('в тёмно-синем шёлковом платье, кожаные сапоги'));
        expect(anna().activeOutfit).toBe('Шёлковое платье');
        expect(lastJournal().summary).toBe('Anna переоделась: «Шёлковое платье»');
        await env.turn(dressed('Обнажена, волосы распущены'));
        expect(anna().activeOutfit).toBe('Без одежды');
        expect(lastJournal().summary).toBe('Anna без одежды');
        await env.turn(dressed('в одном нижнем белье'));
        expect(anna().activeOutfit).toBe('Нижнее бельё');
    });

    it('carries the own clothes’ wording of the clothing field on the slot stand-in', async () => {
        await env.start();
        await env.turn(dressed('эльфийка', { Одежда: 'Белое бальное платье, длинные перчатки' }));
        await env.turn(dressed('эльфийка', { Одежда: 'Синие джинсы, серая толстовка, кроссовки' }));
        expect(anna().activeOutfit).toBe('');
        expect(anna().outfits.find((outfit) => outfit.name === 'Своя одежда')).toEqual({
            name: 'Своя одежда',
            tags: 'blue jeans, grey hoodie, sneakers',
            looks: ['Синие джинсы, серая толстовка, кроссовки'],
        });
        // The stand-in is the own clothes, not an outfit of the library.
        expect(
            env
                .service()
                .outfits('Anna')
                .map((outfit) => outfit.name),
        ).toEqual(['ballgown']);
        const writes = env.nai.calls.length;
        await env.turn(dressed('эльфийка', { Одежда: 'Синие джинсы, серая толстовка, кроссовки' }));
        expect(env.nai.calls).toHaveLength(writes);
    });

    it('«Это новый наряд» makes the outfit at once', async () => {
        const service = await env.start();
        await env.turn(dressed('в белом бальном платье'));
        expect(anna().activeOutfit).toBe('ballgown');
        const name = await service.markNew('p-anna');
        expect(name).toBe('Бальное платье');
        expect(anna().activeOutfit).toBe('Бальное платье');
        expect(lastJournal()).toMatchObject({ kind: 'wardrobe.wear' });
        expect(wearing('Anna')).toMatchObject({ outfit: 'Бальное платье' });
        const writes = env.nai.calls.length;
        await env.turn(dressed('в белом бальном платье'));
        expect(env.nai.calls).toHaveLength(writes);
        await expect(service.markNew('nobody')).rejects.toThrow('нет внешности для картинок');
    });
});

describe('the persona', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv('ru');
    });

    it('takes what the user writes by hand into the persona passport', async () => {
        const service = await env.start();
        expect(await service.setPersonaWearing('Серый дорожный плащ и сапоги')).toBe(true);
        const alex = env.nai.getPassport('p-alex')!;
        expect(alex.activeOutfit).toBe('Дорожный плащ');
        expect(env.nai.of('savePassport').at(-1)![2]).toEqual({ persona: true });
        expect(lastJournal()).toMatchObject({ kind: 'wardrobe.wear' });
        expect(service.current().at(-1)).toMatchObject({
            key: 'persona',
            persona: true,
            source: 'user',
            name: 'Алекс',
        });
        expect(await service.setPersonaWearing('  ')).toBe(false);
        expect(env.portraits).toEqual([]);
    });

    it('asks the background model when the chat speaks of clothes, at most every N turns', async () => {
        // The check every N turns is the fallback while «Переодевание по сообщениям» is off.
        env.slices.wardrobe = { personaEvery: 2, triggers: false };
        env.llm.answer = () => ({ ok: true, data: { wearing: 'кожаная куртка' } });
        const service = await env.start();
        env.mock.chat.push({ ...env.mock.chat[0]!, mes: 'Алекс накинул кожаную куртку.', is_user: true } as never);
        await env.turn({ text: 'Они вышли на улицу.' });
        expect(env.tasks.queued).toEqual([]);
        await env.turn({ text: 'Дождь усилился.' });
        expect(env.tasks.queued.map((task) => task.kind)).toEqual([PERSONA_TASK]);
        expect(String(env.tasks.queued[0]!.payload.excerpt)).toContain('куртку');
        await env.tasks.runLatest(PERSONA_TASK);
        await env.tick(50);
        expect(env.llm.requests[0]).toMatchObject({ task: PERSONA_TASK, schema: { name: 'wardrobe_persona' } });
        expect(service.current().at(-1)).toMatchObject({ persona: true, wording: 'кожаная куртка', source: 'model' });
        expect(env.nai.getPassport('p-alex')!.activeOutfit).toBe('Кожаная куртка');
        // No clothes since the last look: no request.
        await env.turn({ text: 'Тишина.' });
        await env.turn({ text: 'Тишина.' });
        expect(env.tasks.queued).toHaveLength(1);
    });

    it('does not ask in economy mode, without a profile or when switched off', async () => {
        env.slices.wardrobe = { personaEvery: 1, triggers: false };
        await env.start();
        env.core.mode = 'economy';
        await env.turn({ text: 'Она надела платье.' });
        env.core.mode = 'balanced';
        env.llm.availableValue = false;
        await env.turn({ text: 'Она надела платье.' });
        env.llm.availableValue = true;
        env.slices.wardrobe!.persona = false;
        await env.turn({ text: 'Она надела платье.' });
        expect(env.tasks.queued).toEqual([]);
        env.slices.wardrobe!.persona = true;
        await env.turn({ text: 'Она надела платье.' });
        expect(env.tasks.queued).toHaveLength(1);
        env.llm.answer = () => ({ ok: false, error: 'no' });
        await env.tasks.runLatest(PERSONA_TASK);
        expect(
            env
                .service()
                .current()
                .some((item) => item.persona),
        ).toBe(false);
    });
});

describe('the prompt line and portraits', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv('ru');
    });

    it('tells the model who wears what: the scene of the last committed reply and the persona', async () => {
        const service = await env.start();
        await env.turn({
            characters: [
                { name: 'Anna', details: { appearance: 'эльфийка, в белом бальном платье' } },
                { name: 'Boris', details: { appearance: 'в кольчуге' }, offScene: true },
                { name: 'Незнакомка', details: { appearance: 'рыжая, глаза зелёные' } },
            ],
        });
        await service.setPersonaWearing('серый плащ');
        const injected = await env.ephemeral.generate();
        expect(injected.get(WARDROBE_INJECTION)).toEqual({
            text: `${WEARING_HEADER} Anna: в белом бальном платье; Алекс: серый плащ`,
            position: 1,
            depth: 1,
            role: 0,
            scan: false,
        });
        expect((await env.ephemeral.generate({ quiet: true })).size).toBe(0);
        expect((await env.ephemeral.generate({ dryRun: true })).size).toBe(0);
        env.slices.wardrobe!.promptDepth = 3;
        expect((await env.ephemeral.generate()).get(WARDROBE_INJECTION)?.depth).toBe(3);
        env.slices.wardrobe!.promptLine = false;
        expect((await env.ephemeral.generate()).size).toBe(0);
        await env.stop();
        expect(env.ephemeral.producers.size).toBe(0);
    });

    it('asks NAI Studio to redraw the DES portrait once when the outfit changes', async () => {
        await env.start();
        await env.turn(dressed('в белом бальном платье'));
        expect(env.portraits).toEqual(['Anna']);
        await env.turn(dressed('в белом бальном платье'));
        expect(env.portraits).toEqual(['Anna']);
        env.slices.wardrobe!.redrawPortrait = false;
        await env.turn(dressed('в синих джинсах и серой толстовке'));
        expect(anna().activeOutfit).toBe('');
        expect(env.portraits).toEqual(['Anna']);
    });
});

describe('the DES clothing field', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv('ru');
    });

    const offer = () => env.ui.checks.find((check) => check.id === 'm27.desField')!;

    it('is offered by a health check and a notice once, added with consent and undone through the journal', async () => {
        await env.start();
        expect(env.ui.notices.filter((notice) => notice.options?.action)).toHaveLength(1);
        const check = await offer().run();
        expect(check).toMatchObject({
            status: 'warn',
            message: 'DES не спрашивает про одежду: наряды угадываются по описанию внешности.',
        });
        await check.fix!();
        expect(env.des.fields.at(-1)).toMatchObject({
            id: 'outfit',
            name: 'Outfit',
            enabled: true,
            description: expect.stringContaining('What the character is wearing'),
        });
        expect(env.autonomy.never.has('wardrobe.desField')).toBe(true);
        expect(lastJournal()).toMatchObject({
            kind: 'wardrobe.desField',
            summary: 'Спрашивать у модели, кто во что одет',
        });
        expect(await offer().run()).toMatchObject({ status: 'ok' });
        await env.switchTo('chat-2');
        await env.switchTo('chat-1');
        expect(env.ui.notices.filter((notice) => notice.options?.action)).toHaveLength(1);
        env.des.workshop = true;
        expect(await env.journal.undo(lastJournal().id)).toBe(false);
        env.des.workshop = false;
        const handler = env.journal.handlers.get(DES_FIELD_UNDO_TARGET)!;
        expect(await handler(lastJournal().changes[0]!)).toBe(true);
        expect(env.des.fields.map((field) => field.id)).toEqual(['appearance', 'demeanor']);
    });

    it('is «Одежда» with Russian fields and DES-RU giving their keys back', async () => {
        env.des.fields = [
            { id: 'appearance', name: 'Внешность', enabled: true, description: 'Внешний вид' },
            { id: 'demeanor', name: 'Поведение', enabled: true, description: 'Настроение' },
        ];
        env.desru.present = true;
        await env.start();
        const { DesFieldOffer } = await import('../../../src/features/wardrobe');
        const field = new DesFieldOffer(env.app, env.app.log);
        expect(field.proposed()).toEqual({
            name: 'Одежда',
            description: expect.stringContaining('Во что персонаж одет прямо сейчас'),
        });
        env.desru.settings.modules.fixes!.fieldKeys = false;
        expect(field.proposed()).toMatchObject({ name: 'Outfit', description: expect.stringContaining('Во что') });
        env.desru.settings.modules.fixes!.fieldKeys = true;
        expect(await field.add()).toBe('added');
        expect(env.des.fields.at(-1)).toMatchObject({ name: 'Одежда' });
        expect(await field.add()).toBe('exists');
        expect(field.status()).toBe('present');
    });

    it('waits for the DES Workshop to close, and says nothing without DES', async () => {
        await env.start();
        const { DesFieldOffer } = await import('../../../src/features/wardrobe');
        const field = new DesFieldOffer(env.app, env.app.log);
        env.des.workshop = true;
        expect(await field.add()).toBe('workshop');
        expect(env.ui.notices.at(-1)?.text).toContain('мастерскую DES');
        env.des.workshop = false;
        env.autonomy.levels.set('wardrobe.desField', 'off');
        expect(await field.add()).toBe('failed');
        env.des.present = false;
        expect(field.status()).toBe('noDes');
        expect(await offer().run()).toEqual({ status: 'skip' });
        expect(await field.add()).toBe('failed');
    });

    it('reads the clothing field DES gives back', async () => {
        await env.start();
        await env.turn(dressed('эльфийка', { Одежда: 'Обнажена' }));
        expect(anna().activeOutfit).toBe('Без одежды');
        expect(anna().outfits.at(-1)!.looks).toEqual(['Обнажена']);
    });
});

describe('revision cards that never can be taken', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv();
    });

    it('are dismissed with the reason; refused ones stay', async () => {
        env.modules.expose(
            'world',
            fakeWorld([
                { name: 'Anna', aliases: ['Анна'], passportId: 'p-anna', avatar: 'Anna.png' },
                { name: 'Vera' },
            ]),
        );
        const removal = env.revision.card('Anna took off her coat.', 2);
        const nothing = env.revision.card('Anna looks thoughtful.', 3);
        const noPassport = env.revision.card('Vera wears a red hat.', 4, 'Vera');
        const service = await env.start();
        await env.tick(50);
        expect(env.revision.dismissed).toEqual([removal.id, nothing.id, noPassport.id]);
        expect(service.droppedCards().map((card) => card.reason)).toEqual(['noPassport', 'noGarment', 'removal']);
    });
});
