// Quick ways to change clothes (M27): «Переодеться» at the Maestro button at the message box (the scene's characters
// and «Я» → their outfits with the one on marked, the own clothes, «Описать…», «Открыть гардероб»), the line under a
// message after a change made by itself («Отменить», «Другое…») and `/maestro-wear <кто> <наряд|описание>`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WARDROBE_GROUP } from '../../../src/features/wardrobe';
import type { WardrobeService } from '../../../src/features/wardrobe';
import type { ComposerItem } from '../../../src/shared/contracts';
import { message } from '../../helpers/st-mock';
import { createWardrobeEnv, passport, reply } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;
let service: WardrobeService;

const anna = () => env.nai.getPassport('p-anna')!;
const alex = () => env.nai.getPassport('p-alex')!;
const group = () => env.ui.composer.find((item) => item.id === WARDROBE_GROUP)!;
const byLabel = (items: ComposerItem[], label: string) => items.find((item) => item.label === label)!;
const slash = () => env.ui.slash.find((command) => command.name === 'maestro-wear')!;

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWardrobeEnv('ru');
    env.nai.persona = [passport('p-alex', '', { outfits: [{ name: 'Домашнее', tags: 'casual clothes' }] })];
    service = await env.start();
    await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('«Переодеться» at the message box', () => {
    it('lists the scene and «Я» with what they wear; shown in a chat and while switched on', () => {
        expect(group().label()).toBe('Переодеться');
        expect(group().visible!()).toBe(true);
        const items = group().items();
        expect(items.map((item) => item.label)).toEqual(['Anna', 'Я (Алекс)']);
        expect(items[0]!.hint).toBe('в синих джинсах и серой толстовке');
        env.slices.wardrobe!.composer = false;
        expect(group().visible!()).toBe(false);
        env.slices.wardrobe!.composer = true;
        (env.host as unknown as { group: boolean }).group = true;
        expect(group().visible!()).toBe(false);
    });

    it('offers the outfits with the one on marked and puts one on at once', async () => {
        const outfits = group().items()[0]!.submenu!();
        expect(outfits.map((item) => item.label)).toEqual(['ballgown', 'Своя одежда', 'Описать…', 'Открыть гардероб']);
        expect(byLabel(outfits, 'Своя одежда').active).toBe(true);
        await byLabel(outfits, 'ballgown').run!();
        expect(anna().activeOutfit).toBe('ballgown');
        expect(env.ui.notices.at(-1)?.text).toBe('Anna → ballgown');
        expect(byLabel(group().items()[0]!.submenu!(), 'ballgown').active).toBe(true);
        byLabel(outfits, 'Открыть гардероб').run!();
        expect(env.ui.opened).toEqual(['wardrobe']);
    });

    it('describes clothes in words for «Я»', async () => {
        env.ui.answers.push('серый плащ и сапоги');
        const me = group().items().at(-1)!.submenu!();
        await byLabel(me, 'Описать…').run!();
        expect(env.ui.prompts).toEqual(['Во что переодеть — Алекс?']);
        expect(service.current().find((item) => item.persona)?.wording).toBe('серый плащ и сапоги');
        expect(alex().activeOutfit).toBeTruthy();
        // Cancelled: nothing happens.
        await byLabel(me, 'Описать…').run!();
        expect(service.current().find((item) => item.persona)?.wording).toBe('серый плащ и сапоги');
    });
});

describe('the line under the message', () => {
    it('shows an automatic change with «Отменить» and «Другое…»', async () => {
        env.mock.chat.push(message('Переодеваюсь в домашнее.', { is_user: true, name: 'Алекс' }));
        const index = env.mock.chat.length - 1;
        await env.ephemeral.generate();
        const strip = env.ui.strips[0]!;
        const [line] = strip.items(index);
        expect(line).toMatchObject({ kind: 'change', icon: 'fa-shirt', text: 'Алекс → Домашнее' });
        expect(strip.items(index - 1)).toEqual([]);
        const changed = vi.fn();
        const off = strip.onChange(changed);
        env.ui.answers.push('пижама');
        await line!.actions![1]!.run();
        expect(service.current().find((item) => item.persona)?.wording).toBe('пижама');
        expect(changed).toHaveBeenCalled();
        off();
        await line!.actions![0]!.run();
        expect(strip.items(index)).toEqual([]);
    });
});

describe('/maestro-wear', () => {
    it('puts an outfit on by name, or clothes in words, for a character or «я»', async () => {
        expect(await slash().callback({}, 'Anna ballgown')).toBe('Anna → ballgown');
        expect(anna().activeOutfit).toBe('ballgown');
        expect(await slash().callback({}, 'Anna своё')).toBe('Anna → Своя одежда');
        expect(anna().activeOutfit).toBe('');
        expect(await slash().callback({}, 'я домашнее')).toBe('Алекс → Домашнее');
        expect(alex().activeOutfit).toBe('Домашнее');
        expect(await slash().callback({}, 'Анна красное вечернее платье')).toMatch(/^Anna → /);
        expect(service.current('Anna')[0]?.wording).toBe('красное вечернее платье');
    });

    it('explains what is missing and opens the wardrobe without arguments', async () => {
        expect(await slash().callback({}, 'Незнакомка платье')).toBe('Кого переодеть? Начни с имени или «я».');
        expect(await slash().callback({}, 'Anna')).toBe('Во что? Добавь название наряда или опиши одежду.');
        expect(await slash().callback({}, '   ')).toBe('');
        expect(env.ui.opened).toEqual(['wardrobe']);
        env.mock.chat.push(reply({ text: 'x' }));
    });
});
