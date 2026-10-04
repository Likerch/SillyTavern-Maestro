// Settings tab (plan §7): language, debug, mode, budgets, profiles per task, autonomy levels, modules and data
// actions. Values are written straight into CoreSettings, then saved and announced with notify(path).
import { ConsoleLogger } from '../../core/logger';
import type { AutonomyLevel, CoreSettings, PultTab } from '../../shared/contracts';
import { banner, emptyState, section } from '../components/card';
import { field, numberInput, select, toggle } from '../components/controls';
import type { SelectOption } from '../components/controls';
import { button, clear, el } from '../components/dom';
import { MODES } from './overview';
import {
    BUILTIN_PROFILE_TASKS,
    BUILTIN_SETTINGS_ACTIONS,
    profileTasks,
    settingsAction,
    settingsActions,
} from './registries';
import type { ViewEnv } from './types';

export const SETTINGS_TAB = 'settings';
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['auto', 'notify', 'inbox', 'ask', 'off'];
const LANGUAGES: readonly CoreSettings['uiLanguage'][] = ['auto', 'ru', 'en'];
/** What an empty choice means: no main profile, no fallback, or "same as main" for task kinds. */
const EMPTY_PROFILE_LABEL: Record<string, string> = {
    default: 'ui.settings.profileNone',
    fallback: 'ui.settings.profileNoFallback',
};
const LIMIT_ACTIONS: readonly CoreSettings['dailyLimit']['action'][] = ['warn', 'economy', 'stopBackground'];

export function settingsTab(env: ViewEnv): PultTab {
    const { i18n, shell, settings } = env;
    const t = i18n.t.bind(i18n);
    const core = () => settings.core();
    const commit = (path: string) => {
        settings.save();
        settings.notify(path);
    };

    const generalBlock = (): HTMLElement =>
        section(t('ui.settings.general'), [
            field(
                t('ui.settings.language'),
                select({
                    value: core().uiLanguage,
                    label: t('ui.settings.language'),
                    options: LANGUAGES.map((value) => ({ value, label: t(`ui.settings.language.${value}`) })),
                    onChange: (value) => {
                        core().uiLanguage = value;
                        commit('core.uiLanguage');
                        shell.relocalize();
                    },
                }),
            ),
            field(
                t('ui.settings.mode'),
                select({
                    value: core().mode,
                    label: t('ui.settings.mode'),
                    options: MODES.map((value) => ({ value, label: t(`ui.mode.${value}`) })),
                    onChange: (value) => {
                        core().mode = value;
                        commit('core.mode');
                    },
                }),
                t('ui.settings.modeHint'),
            ),
            toggle({
                label: t('ui.settings.debug'),
                hint: t('ui.settings.debugHint'),
                checked: core().debug,
                onChange: (checked) => {
                    core().debug = checked;
                    ConsoleLogger.setLevel(checked ? 'debug' : 'info');
                    commit('core.debug');
                },
            }),
        ]);

    const budgetBlock = (): HTMLElement => {
        const limit = core().dailyLimit;
        return section(t('ui.settings.budget'), [
            field(
                t('ui.settings.backgroundCap'),
                numberInput({
                    value: core().backgroundDailyCapUsd,
                    min: 0,
                    step: 0.05,
                    label: t('ui.settings.backgroundCap'),
                    onChange: (value) => {
                        core().backgroundDailyCapUsd = value;
                        commit('core.backgroundDailyCapUsd');
                    },
                }),
                t('ui.settings.backgroundCapHint'),
            ),
            toggle({
                label: t('ui.settings.dailyLimit'),
                hint: t('ui.settings.dailyLimitHint'),
                checked: limit.enabled,
                onChange: (checked) => {
                    core().dailyLimit.enabled = checked;
                    commit('core.dailyLimit.enabled');
                },
            }),
            field(
                t('ui.settings.dailyLimitUsd'),
                numberInput({
                    value: limit.usd,
                    min: 0,
                    step: 0.5,
                    label: t('ui.settings.dailyLimitUsd'),
                    onChange: (value) => {
                        core().dailyLimit.usd = value;
                        commit('core.dailyLimit.usd');
                    },
                }),
            ),
            field(
                t('ui.settings.dailyLimitAction'),
                select({
                    value: limit.action,
                    label: t('ui.settings.dailyLimitAction'),
                    options: LIMIT_ACTIONS.map((value) => ({ value, label: t(`ui.settings.limitAction.${value}`) })),
                    onChange: (value) => {
                        core().dailyLimit.action = value;
                        commit('core.dailyLimit.action');
                    },
                }),
            ),
        ]);
    };

    const supportedProfiles = (): { id: string; name: string }[] | null => {
        try {
            const service = shell.host.ctx().ConnectionManagerRequestService;
            if (!service?.getSupportedProfiles) return null;
            return service.getSupportedProfiles();
        } catch (error) {
            shell.log.debug('connection profiles unavailable', error);
            return null;
        }
    };

    const profilesBlock = (): HTMLElement => {
        const profiles = supportedProfiles();
        if (!profiles)
            return section(
                t('ui.settings.profiles'),
                banner(t('ui.settings.noConnectionManager'), 'warn', 'fa-plug-circle-xmark'),
            );
        const stored = core().profiles;
        const tasks = [
            ...BUILTIN_PROFILE_TASKS,
            ...profileTasks().filter((task) => !BUILTIN_PROFILE_TASKS.some((builtin) => builtin.id === task.id)),
        ];
        for (const id of Object.keys(stored)) {
            if (!tasks.some((task) => task.id === id)) tasks.push({ id, labelKey: id });
        }
        const rows = tasks.map((task) => {
            const current = stored[task.id] ?? '';
            const options: SelectOption<string>[] = [
                {
                    value: '',
                    label: t(EMPTY_PROFILE_LABEL[task.id] ?? 'ui.settings.profileInherit'),
                },
                ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
            ];
            if (current && !profiles.some((profile) => profile.id === current)) {
                options.push({ value: current, label: t('ui.settings.profileMissing', { id: current }) });
            }
            const label = task.labelKey === task.id ? task.id : t(task.labelKey);
            return field(
                label,
                select({
                    value: current,
                    label,
                    options,
                    onChange: (value) => {
                        if (value) core().profiles[task.id] = value;
                        else delete core().profiles[task.id];
                        commit(`core.profiles.${task.id}`);
                    },
                }),
            );
        });
        return section(t('ui.settings.profiles'), [
            el('div', { class: 'maestro-hint', text: t('ui.settings.profilesHint') }),
            ...rows,
        ]);
    };

    const autonomyBlock = (): HTMLElement => {
        const stored = core().autonomy;
        const kinds = [...new Set([...env.autonomy.stats().map((stat) => stat.kind), ...Object.keys(stored)])].sort();
        if (!kinds.length)
            return section(t('ui.settings.autonomy'), emptyState(t('ui.settings.autonomyEmpty'), 'fa-scale-balanced'));
        const options: SelectOption<AutonomyLevel | ''>[] = [
            { value: '', label: t('ui.settings.autonomyDefault') },
            ...AUTONOMY_LEVELS.map((level) => ({ value: level, label: t(`ui.autonomy.${level}`) })),
        ];
        return section(t('ui.settings.autonomy'), [
            el('div', { class: 'maestro-hint', text: t('ui.settings.autonomyHint') }),
            ...kinds.map((kind) =>
                field(
                    kind,
                    select<AutonomyLevel | ''>({
                        value: stored[kind] ?? '',
                        label: kind,
                        options,
                        onChange: (value) => {
                            if (value) core().autonomy[kind] = value;
                            else delete core().autonomy[kind];
                            commit(`core.autonomy.${kind}`);
                        },
                    }),
                ),
            ),
        ]);
    };

    const modulesBlock = (redraw: () => void): HTMLElement => {
        const list = env.modules
            .list()
            .sort((a, b) => a.module.stage - b.module.stage || a.module.id.localeCompare(b.module.id));
        if (!list.length) return section(t('ui.settings.modules'), emptyState(t('ui.modules.none'), 'fa-puzzle-piece'));
        return section(
            t('ui.settings.modules'),
            list.map((item) =>
                el('div', { class: 'maestro-module-row' }, [
                    toggle({
                        label: `${t(item.module.titleKey)} (${item.module.id})`,
                        checked: item.enabled,
                        onChange: async (checked) => {
                            try {
                                if (checked) await env.modules.enable(item.module.key);
                                else await env.modules.disable(item.module.key);
                            } catch (error) {
                                shell.log.error(`module ${item.module.key} toggle failed`, error);
                                shell.notice(t('ui.settings.moduleToggleFailed', { title: t(item.module.titleKey) }), {
                                    level: 'error',
                                });
                            }
                            redraw();
                            shell.updateBadges();
                        },
                    }),
                    item.missing.length
                        ? el('div', {
                              class: 'maestro-field-hint maestro-warn-text',
                              text: t('ui.settings.moduleMissing', { caps: item.missing.join(', ') }),
                          })
                        : null,
                ]),
            ),
        );
    };

    const runAction = async (id: string) => {
        const action = settingsAction(id);
        if (!action) {
            shell.notice(t('ui.settings.actionUnavailable'), { level: 'info', urgent: true });
            return;
        }
        await action.run();
    };

    const dataBlock = (): HTMLElement => {
        const builtin = BUILTIN_SETTINGS_ACTIONS.map((action) =>
            button({
                label: t(action.labelKey),
                icon: action.icon,
                kind: action.danger ? 'danger' : 'default',
                onClick: () => runAction(action.id),
            }),
        );
        const extra = settingsActions()
            .filter((action) => !BUILTIN_SETTINGS_ACTIONS.some((builtinAction) => builtinAction.id === action.id))
            .map((action) =>
                button({
                    label: t(action.labelKey),
                    icon: action.icon ?? 'fa-gear',
                    kind: action.danger ? 'danger' : 'default',
                    onClick: () => runAction(action.id),
                }),
            );
        return section(t('ui.settings.data'), [
            el('div', { class: 'maestro-actions' }, [...builtin, ...extra]),
            el('div', { class: 'maestro-hint', text: t('ui.settings.prepareDisableHint') }),
            el('div', { class: 'maestro-actions' }, [
                button({ label: t('ui.settings.runWizard'), icon: 'fa-hat-wizard', onClick: () => shell.runWizard() }),
            ]),
        ]);
    };

    return {
        id: SETTINGS_TAB,
        titleKey: 'ui.tab.settings',
        icon: 'fa-gear',
        order: 90,
        render(container) {
            const draw = () => {
                clear(container);
                container.append(
                    el('div', { class: 'maestro-view maestro-settings' }, [
                        generalBlock(),
                        budgetBlock(),
                        profilesBlock(),
                        autonomyBlock(),
                        modulesBlock(draw),
                        dataBlock(),
                    ]),
                );
            };
            draw();
            return shell.onRegistryChange(draw);
        },
    };
}
