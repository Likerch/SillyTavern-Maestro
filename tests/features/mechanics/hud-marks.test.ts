// @vitest-environment happy-dom
// M25 HUD marks (release 1.25, hud-marks.ts): next to each value the latest story reply changed, a chip of the change
// («−15», «+1», «→ почти на нуле» in the words view) lit up once when it first shows, «Из последнего ответа» on hover
// and «· свайп отменит» while that reply is not committed yet; never for what the player may not see. ⚠ in the
// header when values may not follow the story (MechanicsApi.trackingHealth 'warn'): the problems and «Открыть
// механики»; the 'info' ones a quiet line under the panel beside the chat. Both APIs are optional.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttributeDef, TrackingProblem } from '../../../src/features/mechanics/api';
import { HUD_ID, MechanicsHud } from '../../../src/features/mechanics/hud';
import {
    DELTA_FRESH_MS,
    DeltaFreshness,
    deltaText,
    latestReplyIndex,
    replyDeltas,
    trackingProblems,
} from '../../../src/features/mechanics/hud-marks';
import { createPlayEnv, feelingsDef, settlePlay, vitalsDef } from './helpers-play';
import type { PlayEnv } from './helpers-play';
import { message } from '../../helpers/st-mock';

const t = (key: string) => (key.startsWith('m25.words.default.') ? `band ${key.slice(-1)}` : key);
const hp: AttributeDef = { id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'number', min: 0, max: 100 };

describe('how a change reads on its chip', () => {
    it('counts numbers, names the new words, lists what came and went', () => {
        expect(deltaText(t, hp, { view: 'bar' }, 80, 65)).toBe('−15');
        expect(deltaText(t, hp, { view: 'number' }, 4, 5)).toBe('+1');
        expect(deltaText(t, hp, { view: 'number' }, 4.5, 5)).toBe('+0.5');
        expect(deltaText(t, hp, { view: 'number' }, 5, 5)).toBeNull();
        expect(deltaText(t, hp, { view: 'number' }, null, 5)).toBe('→ 5');
        expect(deltaText(t, hp, { view: 'icon' }, 50, 20)).toBe('↓');
        expect(deltaText(t, hp, { view: 'words' }, 80, 20)).toBe('→ band 1');
        // Inside one band nothing the player sees changed.
        expect(deltaText(t, hp, { view: 'words' }, 80, 85)).toBeNull();
        expect(deltaText(t, hp, { view: 'hidden' }, 80, 20)).toBeNull();
        const tags: AttributeDef = { id: 'tags', name: 'Метки', promptName: 'Tags', kind: 'list' };
        expect(deltaText(t, tags, { view: 'number' }, ['огонь'], ['огонь', 'лёд'])).toBe('+ лёд');
        expect(deltaText(t, tags, { view: 'number' }, ['огонь', 'лёд'], ['лёд'])).toBe('− огонь');
        const mood: AttributeDef = {
            id: 'mood',
            name: 'Настрой',
            promptName: 'Mood',
            kind: 'scale',
            levels: ['cold', 'warm'],
        };
        expect(
            deltaText(
                t,
                mood,
                { view: 'words', words: [{ level: 'warm', label: 'warm', display: 'тепло' }] },
                'cold',
                'warm',
            ),
        ).toBe('→ тепло');
        expect(deltaText(t, mood, { view: 'number' }, 'cold', 'cold')).toBeNull();
        const note: AttributeDef = { id: 'note', name: 'Заметка', promptName: 'Note', kind: 'text' };
        expect(deltaText(t, note, { view: 'number' }, '', 'очень длинная заметка о ранении в плечо')).toBe(
            '→ очень длинная заметка…',
        );
    });

    it('finds the latest story reply', () => {
        expect(latestReplyIndex(undefined)).toBe(-1);
        expect(latestReplyIndex([message('Привет', { is_user: true })])).toBe(-1);
        expect(
            latestReplyIndex([
                message('Привет', { is_user: true }),
                message('Ответ'),
                message('Ещё', { is_user: true }),
                message('Системное', { is_system: true }),
            ]),
        ).toBe(1);
    });

    it('lights a chip up once: new for a moment through redraws, forgotten with the next reply', () => {
        const fresh = new DeltaFreshness();
        expect(fresh.age(3, 'vitals.hp@алекс', '−15', 1000)).toBe(0);
        expect(fresh.age(3, 'vitals.hp@алекс', '−15', 1500)).toBe(500);
        expect(fresh.age(3, 'vitals.hp@алекс', '−15', 1000 + DELTA_FRESH_MS)).toBeNull();
        // Another change of the same value is new again; so is everything of the next reply.
        expect(fresh.age(3, 'vitals.hp@алекс', '−20', 5000)).toBe(0);
        expect(fresh.age(5, 'vitals.hp@алекс', '−15', 5000)).toBe(0);
    });
});

describe('the HUD’s marks', () => {
    let env: PlayEnv;
    let hud: MechanicsHud | null = null;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        vi.stubGlobal('innerWidth', 1600);
        vi.stubGlobal('innerHeight', 1000);
    });

    afterEach(() => {
        hud?.dispose();
        hud = null;
        env?.stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    async function setup(options: Parameters<typeof createPlayEnv>[0] = {}): Promise<void> {
        env = await createPlayEnv({ locale: 'ru', ...options });
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
    }

    const node = () => document.getElementById(HUD_ID)!;
    const value = (holder: string, name: string) =>
        [...node().querySelectorAll<HTMLElement>(`[data-holder="${holder}"] .maestro-m25-v`)].find((item) =>
            item.getAttribute('title')?.startsWith(name),
        ) ?? null;

    /** A story reply that wounds Алекс and gives him mana, as the tracking would record it. */
    async function woundingReply(): Promise<number> {
        const index = env.pushReply('Удар!');
        await env.state.apply([
            {
                mechanicId: 'vitals',
                holder: 'Алекс',
                attribute: 'hp',
                value: -10,
                delta: true,
                source: 'block',
                messageIndex: index,
            },
            {
                mechanicId: 'vitals',
                holder: 'Алекс',
                attribute: 'hp',
                value: -5,
                delta: true,
                source: 'block',
                messageIndex: index,
            },
            {
                mechanicId: 'vitals',
                holder: 'Алекс',
                attribute: 'coins',
                value: 1,
                delta: true,
                source: 'block',
                messageIndex: index,
            },
            {
                mechanicId: 'feelings',
                holder: 'Kai',
                attribute: 'trust',
                value: 5,
                delta: true,
                source: 'block',
                messageIndex: index,
            },
        ]);
        await settlePlay(env);
        return index;
    }

    it('puts the latest reply’s changes next to the values over the chat, lit up only at first', async () => {
        await setup();
        env.settings.hudHolders = ['Kai'];
        env.app.settings.notify('modules.mechanics.hudHolders');
        await woundingReply();
        const health = value('Алекс', 'Здоровье')!;
        const chip = health.querySelector<HTMLElement>('.maestro-m25-hud-delta')!;
        // Two changes of one value in one reply: one chip, from the first to the last.
        expect(chip.textContent).toBe('−15');
        expect(chip.getAttribute('title')).toBe('Из последнего ответа');
        expect(chip.classList.contains('maestro-m25-hud-delta-new')).toBe(true);
        expect(chip.classList.contains('maestro-m25-hud-delta-provisional')).toBe(false);
        expect(value('Алекс', 'Монеты')?.querySelector('.maestro-m25-hud-delta')?.textContent).toBe('+1');
        expect(value('Алекс', 'Мана')?.querySelector('.maestro-m25-hud-delta')).toBeNull();
        // A hidden value's change is never shown.
        expect(node().textContent).not.toContain('+5');
        // Redrawn a while later: the chip stays, the highlight is over.
        await settlePlay(env, DELTA_FRESH_MS + 100);
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        const later = value('Алекс', 'Здоровье')!.querySelector<HTMLElement>('.maestro-m25-hud-delta')!;
        expect(later.textContent).toBe('−15');
        expect(later.classList.contains('maestro-m25-hud-delta-new')).toBe(false);
        // The user answers and the next reply changes nothing: the chips are gone.
        env.mock.chat.push(message('Дальше', { is_user: true }));
        env.pushReply('Тишина.');
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        expect(node().querySelector('.maestro-m25-hud-delta')).toBeNull();
    });

    it('says a swipe takes it back while the reply is not committed yet', async () => {
        await setup();
        let provisional = -1;
        Object.assign(env.api, { provisionalIndex: () => provisional });
        const index = await woundingReply();
        expect(value('Алекс', 'Здоровье')?.querySelector('.maestro-m25-hud-delta')?.getAttribute('title')).toBe(
            'Из последнего ответа',
        );
        provisional = index;
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        const chip = value('Алекс', 'Здоровье')!.querySelector<HTMLElement>('.maestro-m25-hud-delta')!;
        expect(chip.getAttribute('title')).toBe('Из последнего ответа · свайп отменит');
        expect(chip.getAttribute('aria-label')).toBe('−15 · Из последнего ответа · свайп отменит');
        expect(chip.classList.contains('maestro-m25-hud-delta-provisional')).toBe(true);
    });

    it('marks the panel beside the chat too, in both views and in the words view', async () => {
        const sheld = document.createElement('div');
        sheld.id = 'sheld';
        sheld.getBoundingClientRect = () =>
            ({ left: 400, top: 40, width: 800, height: 860, right: 1200, bottom: 900, x: 400, y: 40 }) as DOMRect;
        document.body.append(sheld);
        await setup({ defs: [vitalsDef(), feelingsDef()] });
        env.settings.hudPlacement = 'left';
        env.app.settings.notify('modules.mechanics.hudPlacement');
        await woundingReply();
        expect(hud!.layoutNow().mode).toBe('side');
        expect(value('Алекс', 'Здоровье')?.querySelector('.maestro-m25-hud-delta')?.textContent).toBe('−15');
        env.settings.hudSideView = 'full';
        env.app.settings.notify('modules.mechanics.hudSideView');
        await settlePlay(env);
        expect(node().querySelector('.maestro-m25-hud-side-holder[data-holder="Kai"]')).not.toBeNull();
        expect(value('Алекс', 'Здоровье')?.querySelector('.maestro-m25-hud-delta')?.textContent).toBe('−15');
        const words = vitalsDef();
        words.attributes[0] = { ...words.attributes[0]!, visibility: { preset: 'game', view: 'words' } };
        env.defs.defs = [words, feelingsDef()];
        env.defs.emit();
        await settlePlay(env);
        expect(replyDeltas(env.app.i18n, env.api, env.mock.chat.length - 1).get('vitals.hp@алекс')).toBe('→ средне');
        expect(value('Алекс', 'Здоровье')?.querySelector('.maestro-m25-hud-delta')?.textContent).toBe('→ средне');
    });

    it('leaves the HUD unmarked without changesOf', async () => {
        await setup();
        await woundingReply();
        expect(node().querySelector('.maestro-m25-hud-delta')).not.toBeNull();
        Object.assign(env.api, { changesOf: undefined });
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        expect(node().querySelector('.maestro-m25-hud-delta')).toBeNull();
    });
});

describe('tracking problems in the HUD', () => {
    let env: PlayEnv;
    let hud: MechanicsHud | null = null;
    let problems: TrackingProblem[] = [];

    beforeEach(async () => {
        vi.useFakeTimers();
        localStorage.clear();
        vi.stubGlobal('innerWidth', 1600);
        vi.stubGlobal('innerHeight', 1000);
        problems = [];
        env = await createPlayEnv({ locale: 'ru' });
        Object.assign(env.api, { trackingHealth: () => problems });
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
    });

    afterEach(() => {
        hud?.dispose();
        hud = null;
        env?.stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    const node = () => document.getElementById(HUD_ID)!;
    const warn: TrackingProblem = {
        code: 'noProfile',
        level: 'warn',
        text: 'Фоновому разбору не хватает профиля подключения: значения не меняются сами.',
        mechanics: ['vitals'],
    };
    const failed: TrackingProblem = {
        code: 'extractFailed',
        level: 'warn',
        text: 'Последний разбор ответа не удался.',
        mechanics: [],
        detail: 'timeout',
    };
    const info: TrackingProblem = {
        code: 'otherTab',
        level: 'info',
        text: 'Значения считает другая вкладка этого чата.',
        mechanics: [],
    };

    it('reads the problems defensively', () => {
        expect(trackingProblems(env.api)).toEqual({ warn: [], info: [] });
        problems = [warn, info];
        expect(trackingProblems(env.api)).toEqual({ warn: [warn], info: [info] });
        Object.assign(env.api, {
            trackingHealth: () => {
                throw new Error('boom');
            },
        });
        expect(trackingProblems(env.api)).toEqual({ warn: [], info: [] });
        Object.assign(env.api, { trackingHealth: () => 'nonsense' });
        expect(trackingProblems(env.api)).toEqual({ warn: [], info: [] });
    });

    it('shows ⚠ when values may not follow the story, the problems on a click and the way to the mechanics', async () => {
        expect(node().querySelector('.maestro-m25-hud-warn')).toBeNull();
        problems = [warn, failed, info];
        // The API tells about it through onChange (any change of the mechanics redraws).
        await env.api.addStatus('Алекс', { name: 'Отравлен', duration: { turns: 3 } }, 'vitals');
        await settlePlay(env);
        const button = node().querySelector<HTMLButtonElement>('.maestro-m25-hud-warn')!;
        expect(button.getAttribute('title')).toBe('Значения могут не поспевать за историей');
        expect(button.getAttribute('aria-expanded')).toBe('false');
        // Over the chat the 'info' ones are not shown.
        expect(node().textContent).not.toContain('другая вкладка');
        button.click();
        const panel = node().querySelector<HTMLElement>('.maestro-m25-hud-health')!;
        expect([...panel.querySelectorAll('.maestro-m25-hud-health-item')].map((item) => item.textContent)).toEqual([
            warn.text,
            `${failed.text}timeout`,
        ]);
        const open = vi.spyOn(env.ui, 'openWindow');
        panel.querySelector<HTMLButtonElement>('.maestro-m25-hud-health-open')!.click();
        expect(panel.querySelector('.maestro-m25-hud-health-open')?.textContent).toBe('Открыть механики');
        expect(open).toHaveBeenCalledWith('mechanics', { tab: 'mechanics' });
        expect(node().querySelector('.maestro-m25-hud-health')).toBeNull();
        // Fixed: ⚠ goes away.
        problems = [];
        await env.api.removeStatus('Алекс', 'Отравлен');
        await settlePlay(env);
        expect(node().querySelector('.maestro-m25-hud-warn')).toBeNull();
    });

    it('beside the chat: ⚠ in the panel’s header and the quiet line under it', async () => {
        const sheld = document.createElement('div');
        sheld.id = 'sheld';
        sheld.getBoundingClientRect = () =>
            ({ left: 400, top: 40, width: 800, height: 860, right: 1200, bottom: 900, x: 400, y: 40 }) as DOMRect;
        document.body.append(sheld);
        problems = [warn, info];
        env.settings.hudPlacement = 'right';
        env.app.settings.notify('modules.mechanics.hudPlacement');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'right' });
        expect(node().querySelector('.maestro-m25-hud-side-head .maestro-m25-hud-warn')).not.toBeNull();
        expect(node().querySelector('.maestro-m25-hud-foot')?.textContent).toBe(info.text);
        // The problems close on a click elsewhere.
        node().querySelector<HTMLButtonElement>('.maestro-m25-hud-warn')!.click();
        expect(node().querySelector('.maestro-m25-hud-health')).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(node().querySelector('.maestro-m25-hud-health')).toBeNull();
    });
});
