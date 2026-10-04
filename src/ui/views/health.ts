// Health tab: registered health checks with "Fix" buttons, the capability report and recent warnings.
import { ConsoleLogger } from '../../core/logger';
import type { HealthCheck, PultTab } from '../../shared/contracts';
import { emptyState, lamp, section } from '../components/card';
import { button, clear, el } from '../components/dom';
import { table } from '../components/table';
import { formatTime, moduleTitle } from './format';
import type { ViewEnv } from './types';

export const HEALTH_TAB = 'health';

type Status = 'ok' | 'warn' | 'error' | 'skip';

interface Result {
    status: Status | 'running';
    message?: string;
    fix?: () => Promise<void>;
}

const LAMP: Record<Status | 'running', 'ok' | 'warn' | 'error' | 'off'> = {
    ok: 'ok',
    warn: 'warn',
    error: 'error',
    skip: 'off',
    running: 'off',
};

export function healthTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);

    return {
        id: HEALTH_TAB,
        titleKey: 'ui.tab.health',
        icon: 'fa-heart-pulse',
        order: 70,
        render(container) {
            let alive = true;
            const results = new Map<string, Result>();

            const runCheck = async (check: HealthCheck) => {
                results.set(check.id, { status: 'running' });
                draw();
                try {
                    const result = await check.run();
                    results.set(check.id, result);
                } catch (error) {
                    shell.log.error(`health check ${check.id} failed`, error);
                    results.set(check.id, {
                        status: 'error',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
                if (alive) draw();
            };
            const runAll = async () => {
                await Promise.all(shell.healthChecks().map(runCheck));
            };

            const checksView = (): HTMLElement => {
                const checks = shell.healthChecks();
                if (!checks.length) return emptyState(t('ui.health.noChecks'), 'fa-stethoscope');
                return el(
                    'div',
                    { class: 'maestro-checks' },
                    checks.map((check) => {
                        const result = results.get(check.id);
                        const status = result?.status ?? 'running';
                        const fix = result?.fix;
                        return el('div', { class: ['maestro-check', `maestro-check-${status}`] }, [
                            lamp(LAMP[status], t(`ui.health.status.${status}`)),
                            el('div', { class: 'maestro-check-main' }, [
                                el('div', { class: 'maestro-check-title', text: t(check.titleKey) }),
                                el('div', {
                                    class: 'maestro-muted',
                                    text: `${moduleTitle(env.modules, i18n, check.module)} · ${t(`ui.health.status.${status}`)}`,
                                }),
                                result?.message
                                    ? el('div', { class: 'maestro-check-message', text: result.message })
                                    : null,
                            ]),
                            fix
                                ? button({
                                      label: t('ui.health.fix'),
                                      icon: 'fa-screwdriver-wrench',
                                      kind: 'primary',
                                      onClick: async () => {
                                          await fix();
                                          await runCheck(check);
                                      },
                                  })
                                : null,
                        ]);
                    }),
                );
            };

            const capsView = (): HTMLElement =>
                table(
                    [
                        {
                            key: 'state',
                            label: t('ui.health.state'),
                            cell: (row) => lamp(row.ok ? 'ok' : 'error', t(row.ok ? 'ui.lamp.ok' : 'ui.lamp.error')),
                        },
                        { key: 'id', label: t('ui.health.capability'), cell: (row) => row.id },
                        { key: 'detail', label: t('ui.health.detail'), cell: (row) => row.detail ?? '' },
                    ],
                    [...env.caps.report()].sort((a, b) => Number(a.ok) - Number(b.ok) || a.id.localeCompare(b.id)),
                    { empty: t('ui.overview.stackEmpty') },
                );

            const logView = (): HTMLElement => {
                const lines = ConsoleLogger.recent().slice(-20).reverse();
                if (!lines.length) return emptyState(t('ui.health.logEmpty'));
                return el(
                    'ul',
                    { class: 'maestro-log' },
                    lines.map((line) =>
                        el(
                            'li',
                            {
                                class: [
                                    'maestro-log-line',
                                    `maestro-level-${line.level === 'error' ? 'error' : 'warn'}`,
                                ],
                            },
                            [
                                el('span', { class: 'maestro-notice-time', text: formatTime(line.at, i18n) }),
                                el('span', { class: 'maestro-muted', text: line.scope }),
                                el('span', { text: line.text }),
                            ],
                        ),
                    ),
                );
            };

            function draw(): void {
                if (!alive) return;
                clear(container);
                container.append(
                    el('div', { class: 'maestro-view maestro-health' }, [
                        section(
                            t('ui.health.checks'),
                            checksView(),
                            button({ label: t('ui.health.runAll'), icon: 'fa-play', onClick: runAll }),
                        ),
                        section(
                            t('ui.health.capabilities'),
                            capsView(),
                            button({
                                label: t('ui.health.recheck'),
                                icon: 'fa-arrows-rotate',
                                onClick: async () => {
                                    await env.caps.refresh();
                                    draw();
                                },
                            }),
                        ),
                        section(t('ui.health.log'), logView()),
                    ]),
                );
            }

            draw();
            void runAll();
            return () => {
                alive = false;
            };
        },
    };
}
