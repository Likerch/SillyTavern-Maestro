// Core slash commands (plan-2 §10 п.3): `/maestro [window]` opens a window (or the Maestro menu), `/maestro-undo`
// takes back Maestro's latest change after asking, `/maestro-mode` switches the mode. Window and section names are
// accepted by id or by title in either language; the answers are plain words (also shown as a notice, since ST
// does not print a command's result by itself).
import type {
    CoreSettings,
    I18n,
    Journal,
    Logger,
    SettingsService,
    SlashCommandSpec,
    Ui,
} from '../../shared/contracts';
import type { TabRegistry } from '../windows/sections';
import type { WindowManager } from '../windows/manager';
import { MODES } from './overview';
import { UI_STRINGS } from './strings';
import { UNNAMED_ARGUMENT } from './slash-commands';

export interface CoreCommandsDeps {
    i18n: I18n;
    log: Logger;
    settings: SettingsService;
    journal: Journal;
    windows: WindowManager;
    tabs: TabRegistry;
    notice: Ui['notice'];
    confirm: Ui['confirm'];
    /** Opens the Maestro menu under the top-bar icon; false when the icon is not on the page. */
    openMenu(): boolean;
}

/** Lower case, «ё» as «е», no quotes or extra spaces: «Мир», "мир" and ' МИР ' are one name. */
export function normalizeName(value: string): string {
    return value
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/["'«»“”„]/g, '')
        .replace(/[\s_-]+/g, ' ')
        .trim();
}

/** Names a window answers to: its id, its title now, and (Maestro's own windows) its title in both languages. */
function windowNames(id: string, title: string): string[] {
    const key = `ui.window.${id}`;
    return [id, title, UI_STRINGS.en[key], UI_STRINGS.ru[key]]
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .map(normalizeName);
}

/** A window id and maybe a section of it for a name; null when nothing answers to it. */
export function resolveTarget(deps: CoreCommandsDeps, raw: string): { window: string; tab?: string } | null {
    const name = normalizeName(raw);
    if (!name) return null;
    const byWindow = deps.windows.list().find((info) => windowNames(info.id, info.title).includes(name));
    if (byWindow) return { window: byWindow.id };
    const tab = deps.tabs
        .all()
        .find((item) => normalizeName(item.id) === name || normalizeName(deps.i18n.t(item.titleKey)) === name);
    if (!tab) return null;
    const window = deps.windows.windowOfTab(tab.id);
    return window ? { window, tab: tab.id } : null;
}

function modeOf(deps: CoreCommandsDeps, raw: string): CoreSettings['mode'] | null {
    const name = normalizeName(raw);
    return (
        MODES.find((mode) =>
            [mode, deps.i18n.t(`ui.mode.${mode}`), UI_STRINGS.en[`ui.mode.${mode}`], UI_STRINGS.ru[`ui.mode.${mode}`]]
                .filter((value): value is string => typeof value === 'string')
                .some((value) => normalizeName(value) === name),
        ) ?? null
    );
}

export function coreCommands(deps: CoreCommandsDeps): SlashCommandSpec[] {
    const t = deps.i18n.t.bind(deps.i18n);
    /** A reply to the user's own command: always shown. */
    const answer = (text: string, level: 'info' | 'warn' = 'info'): string => {
        deps.notice(text, { level, importance: 'urgent' });
        return text;
    };

    const maestro: SlashCommandSpec = {
        name: 'maestro',
        helpKey: 'ui.slash.maestro.help',
        args: [{ name: UNNAMED_ARGUMENT, descriptionKey: 'ui.slash.maestro.arg', optional: true }],
        callback: (_args, value) => {
            const name = value.trim();
            if (!name) {
                if (!deps.openMenu()) deps.windows.open('maestro');
                return '';
            }
            const target = resolveTarget(deps, name);
            if (!target) {
                const known = deps.windows
                    .list()
                    .filter((info) => !info.hidden && info.sections !== 0)
                    .map((info) => info.title)
                    .join(', ');
                return answer(t('ui.slash.maestro.unknown', { name, known }), 'warn');
            }
            deps.windows.open(target.window, target.tab ? { tab: target.tab } : {});
            return '';
        },
    };

    const undo: SlashCommandSpec = {
        name: 'maestro-undo',
        helpKey: 'ui.slash.undo.help',
        callback: async () => {
            const record = deps.journal.list({ limit: 200 }).find((item) => !item.undone);
            if (!record) return answer(t('ui.slash.undo.nothing'));
            const agreed = await deps.confirm(
                t('ui.slash.undo.confirmTitle'),
                t('ui.slash.undo.confirmBody', { summary: record.summary }),
            );
            if (!agreed) return answer(t('ui.slash.undo.kept', { summary: record.summary }));
            const ok = await deps.journal.undo(record.id);
            return ok
                ? answer(t('ui.slash.undo.done', { summary: record.summary }))
                : answer(t('ui.slash.undo.failed', { summary: record.summary }), 'warn');
        },
    };

    const mode: SlashCommandSpec = {
        name: 'maestro-mode',
        helpKey: 'ui.slash.mode.help',
        args: [{ name: UNNAMED_ARGUMENT, descriptionKey: 'ui.slash.mode.arg', optional: true }],
        callback: (_args, value) => {
            const core = deps.settings.core();
            const list = MODES.map((item) => t(`ui.mode.${item}`)).join(', ');
            if (!value.trim()) return answer(t('ui.slash.mode.current', { mode: t(`ui.mode.${core.mode}`), list }));
            const next = modeOf(deps, value);
            if (!next) return answer(t('ui.slash.mode.unknown', { name: value.trim(), list }), 'warn');
            if (core.mode !== next) {
                core.mode = next;
                deps.settings.save();
                deps.settings.notify('core.mode');
            }
            return answer(t('ui.slash.mode.set', { mode: t(`ui.mode.${next}`), hint: t(`ui.mode.${next}Hint`) }));
        },
    };

    return [maestro, undo, mode];
}
