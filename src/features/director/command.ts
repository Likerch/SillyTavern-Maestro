// `/maestro-scene [type|auto]` (plan-2 §10 п.3): the user's choice of the scene type for the next turns — the same
// override as the «Тип сцены» switch of the «Режиссёр» section (DirectorApi.setScene); «авто» gives the choice back to
// the director. Types are accepted by id or by name in either language («бой», «Combat», «драма»…).
import { SCENE_KINDS } from '../../domain/director-scene';
import type { App, SlashCommandSpec } from '../../shared/contracts';
import type { DirectorApi, SceneType } from './api';
import { DIRECTOR_STRINGS } from './strings';

const AUTO = ['auto', 'automatic', 'авто', 'автоматически'];

function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/["'«»“”„]/g, '')
        .replace(/[\s_-]+/g, ' ')
        .trim();
}

/** The type a name stands for, null for «auto», undefined when nothing answers to it. */
export function sceneOf(raw: string): SceneType | null | undefined {
    const name = normalize(raw);
    if (!name) return undefined;
    if (AUTO.includes(name)) return null;
    const names = (kind: SceneType) =>
        [kind, DIRECTOR_STRINGS.en[`m13.scene.type.${kind}`], DIRECTOR_STRINGS.ru[`m13.scene.type.${kind}`]]
            .filter((value): value is string => typeof value === 'string')
            .map(normalize);
    const exact = SCENE_KINDS.find((kind) => names(kind).includes(name));
    if (exact) return exact;
    // «бой» for «Бой и опасность», «интим» for «Интимная сцена».
    if (name.length < 3) return undefined;
    return SCENE_KINDS.find((kind) => names(kind).some((label) => label.startsWith(name))) ?? undefined;
}

export function sceneCommand(app: App, director: DirectorApi): SlashCommandSpec {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const label = (kind: SceneType) => t(`m13.scene.type.${kind}`);
    /** A reply to the user's own command: always shown (ST does not print a command's result). */
    const answer = (text: string, level: 'info' | 'warn' = 'info'): string => {
        app.ui.notice(text, { level, importance: 'urgent' });
        return text;
    };
    return {
        name: 'maestro-scene',
        helpKey: 'm13.slash.help',
        args: [{ name: 'value', descriptionKey: 'm13.slash.type', optional: true }],
        callback: async (_args, value) => {
            const list = SCENE_KINDS.map(label).join(', ');
            if (!app.host.chatId()) return answer(t('m13.slash.noChat'), 'warn');
            const raw = value.trim();
            if (!raw) {
                const chosen = director.override?.() ?? null;
                if (chosen) return answer(t('m13.slash.currentUser', { type: label(chosen), list }));
                const scene = director.scene();
                return answer(
                    scene ? t('m13.slash.current', { type: label(scene.type), list }) : t('m13.slash.none', { list }),
                );
            }
            const kind = sceneOf(raw);
            if (kind === undefined) return answer(t('m13.slash.unknown', { name: raw, list }), 'warn');
            await director.setScene(kind);
            return answer(kind ? t('m13.slash.set', { type: label(kind) }) : t('m13.slash.auto'));
        },
    };
}
