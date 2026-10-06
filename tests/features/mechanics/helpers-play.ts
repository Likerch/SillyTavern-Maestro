// Test app for the play surfaces of M25 (plan-2 §6.А: the strip under replies, the HUD, narrator messages, the window
// sections, the constructor's engine fields): the state test app (helpers-state: ST mock, real state, fake DES/world/
// journal/LLM) with the real checks and combat parts on a seeded RNG, the public MechanicsService over them, all
// strings, and a settings service that records notify/save. Fake timers drive the coalesced redraws.

import type { Rng } from '../../../src/domain/mechanics-dice';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { MechanicCombat } from '../../../src/features/mechanics/combat';
import type { PartDeps } from '../../../src/features/mechanics/parts';
import { MechanicsService } from '../../../src/features/mechanics/service';
import { MECHANICS_STRINGS } from '../../../src/features/mechanics/strings';
import type { App, SettingsService } from '../../../src/shared/contracts';
import { message } from '../../helpers/st-mock';
import { createMechanicsEnv } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

/** Vitals: health and mana (game set), conditions, an inventory paid in coins, a spell whose failure costs mana. */
export function vitalsDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'vitals',
        name: 'Жизнь',
        summary: 'Health and mana.',
        rules: 'Wounds lower health; spells cost mana.',
        attributes: [
            {
                id: 'hp',
                name: 'Здоровье',
                promptName: 'Health',
                kind: 'number',
                min: 0,
                max: 100,
                initial: 80,
                icon: '❤',
            },
            {
                id: 'mana',
                name: 'Мана',
                promptName: 'Mana',
                kind: 'number',
                min: 0,
                max: 40,
                initial: 40,
                icon: '🔷',
                events: [{ id: 'empty', when: { op: '<=', value: 0 }, text: '{holder} has no mana left.' }],
            },
            { id: 'coins', name: 'Монеты', promptName: 'Coins', kind: 'number', min: 0, initial: 30, icon: '🪙' },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Заклинание',
                promptName: 'Spell',
                dice: '1d20',
                difficulty: 10,
                triggers: ['колдую'],
                effects: [
                    { on: 'failure', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 10 }] },
                    { on: 'success', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 5 }] },
                ],
            },
        ],
        tracking: 'manual',
        scope: { kind: 'global' },
        statuses: [{ name: 'Отравлен', promptName: 'poisoned', duration: { turns: 3 }, icon: '☠' }],
        inventory: { money: 'coins' },
        ...extra,
    };
}

/** Feelings: a book scale with words, a hidden number and a secret one. */
export function feelingsDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'feelings',
        name: 'Чувства',
        summary: 'How the characters feel.',
        rules: 'Attitude changes slowly.',
        attributes: [
            {
                id: 'attitude',
                name: 'Отношение',
                promptName: 'Attitude',
                kind: 'scale',
                levels: ['cold', 'neutral', 'warm'],
                initial: 'neutral',
                visibility: {
                    preset: 'book',
                    words: [
                        { level: 'cold', label: 'cold', display: 'холодно' },
                        { level: 'neutral', label: 'neutral', display: 'ровно' },
                        { level: 'warm', label: 'warm', display: 'тепло' },
                    ],
                },
            },
            {
                id: 'trust',
                name: 'Доверие',
                promptName: 'Trust',
                kind: 'number',
                min: 0,
                max: 100,
                initial: 50,
                visibility: { preset: 'hidden' },
            },
            {
                id: 'grudge',
                name: 'Обида',
                promptName: 'Grudge',
                kind: 'number',
                min: 0,
                max: 10,
                initial: 0,
                visibility: { preset: 'secret' },
            },
        ],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'manual',
        scope: { kind: 'global' },
        ...extra,
    };
}

/** A secret mechanic: its rolls are Maestro's alone. */
export function ambushDef(): MechanicDef {
    return {
        id: 'ambush',
        name: 'Засада',
        summary: 'Hidden ambush.',
        rules: 'Ambushes happen.',
        attributes: [
            { id: 'alert', name: 'Тревога', promptName: 'Alert', kind: 'number', min: 0, max: 10, initial: 0 },
        ],
        holders: { kind: 'persona' },
        checks: [{ id: 'ambush', name: 'Засада', promptName: 'Ambush', dice: '1d20', difficulty: 10, triggers: [] }],
        tracking: 'manual',
        scope: { kind: 'global' },
        visibility: { preset: 'secret' },
    };
}

export interface PlayEnv extends MechanicsEnv {
    deps: PartDeps;
    checks: MechanicChecks;
    combat: MechanicCombat;
    api: MechanicsService;
    /** Paths given to settings.notify. */
    notified: string[];
    /** Pushes a user message and emits MESSAGE_SENT for it (ST then renders it); its index. */
    sendUser(text?: string): Promise<number>;
    /** Pushes an assistant reply (no events); its index. */
    pushReply(text?: string): number;
}

/** A settings service over the module slice: notify reaches the listeners, save is recorded. */
function settingsService(env: MechanicsEnv, notified: string[]): SettingsService {
    const listeners = new Set<(path: string) => void>();
    return {
        core: () => ({ mode: 'balanced', chatNotices: 'all' }) as ReturnType<SettingsService['core']>,
        module: <T extends object>() => env.settings as unknown as T,
        isModuleEnabled: () => true,
        setModuleEnabled: () => {},
        save: () => {},
        notify: (path: string) => {
            notified.push(path);
            for (const listener of [...listeners]) listener(path);
        },
        onChange: (listener: (path: string) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export async function createPlayEnv(
    options: { defs?: MechanicDef[]; rng?: Rng; locale?: 'en' | 'ru' } = {},
): Promise<PlayEnv> {
    const env = createMechanicsEnv(options.locale ?? 'en');
    env.app.i18n.register(MECHANICS_STRINGS);
    env.mock.context.name1 = 'Алекс';
    env.mock.context.name2 = 'Kai';
    const notified: string[] = [];
    (env.app as { settings: SettingsService }).settings = settingsService(env, notified);
    env.defs.defs = options.defs ?? [vitalsDef(), feelingsDef()];
    await env.start({ tracking: false });
    const deps: PartDeps = { app: env.app as App, log: env.app.log, settings: () => env.settings };
    const rng = options.rng ?? (() => 0.5);
    const checks = new MechanicChecks(deps, env.defs, env.state, { rng, saveMs: 0 });
    checks.install();
    await checks.ready();
    const combat = new MechanicCombat(deps, env.defs, env.state, rng);
    combat.install();
    const api = new MechanicsService(env.defs, env.state, checks, { app: env.app }, { combat });
    const play: PlayEnv = Object.assign(env, {
        deps,
        checks,
        combat,
        api,
        notified,
        async sendUser(text = 'Дальше') {
            env.mock.chat.push(message(text, { is_user: true, name: 'Алекс' }));
            const index = env.mock.chat.length - 1;
            await env.mock.eventSource.emit('message_sent', index);
            return index;
        },
        pushReply(text = 'Ответ.') {
            env.mock.chat.push(
                message(text, { name: 'Kai', swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }),
            );
            return env.mock.chat.length - 1;
        },
    });
    const stop = env.stop.bind(env);
    play.stop = () => {
        combat.dispose();
        checks.dispose();
        stop();
    };
    return play;
}

/** Lets the coalesced redraws and the state's writes run (fake timers). */
export async function settlePlay(env: MechanicsEnv, ms = 200): Promise<void> {
    await env.tick(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
