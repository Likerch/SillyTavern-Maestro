// Pult tab «Ревизия» (M8): the trigger state, «Ревизия сейчас», when to revise (signals, every N messages, scene
// end, minimum confidence) and the last runs — reason, message range, changes, what the checks rejected and why,
// cost. Proposals themselves live in the Inbox tab.
import { parseRejection } from '../../domain/revision-checks';
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section, moduleSettingsSection } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { append, button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime, formatUsd, tOr } from '../../ui/views/format';
import type { RevisionChange, RevisionRun } from './api';
import { REVISION_KEY, REVISION_TAB, readRevisionSettings } from './settings';
import type { RevisionSettings } from './settings';
import type { RevisionService } from './service';

export const REVISION_CSS = `
.maestro-m8-run { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius); }
.maestro-m8-run-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.maestro-m8-run ul { margin: 0; padding-left: 1.2em; }
.maestro-m8-run li { overflow-wrap: anywhere; }
.maestro-m8-runs { display: flex; flex-direction: column; gap: 8px; }
`;

const RUNS_SHOWN = 10;

export function revisionTab(app: App, service: RevisionService): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const settings = (): RevisionSettings =>
        readRevisionSettings(app.settings.module<Partial<RevisionSettings>>(REVISION_KEY));
    const commit = (path: string) => {
        app.settings.save();
        app.settings.notify(`${REVISION_KEY}.${path}`);
    };

    const errorText = (error: string): string => tOr(app.i18n, `m8.error.${error}`, t('m8.error.other', { error }));

    const changeLine = (change: RevisionChange): string => {
        const line = t('m8.run.change', {
            target: tOr(app.i18n, `m8.target.${change.target}`, change.target),
            name: change.entityName,
            value: change.value,
        });
        return change.class === 'new' ? `${line} (${t('m8.run.new')})` : line;
    };

    const rejectionLine = (item: RevisionRun['rejected'][number]): string => {
        const rejection = parseRejection(item.reason);
        const why = tOr(app.i18n, `m8.reject.${rejection.code}`, item.reason, { detail: rejection.detail ?? '' });
        return `${changeLine(item.change)} — ${why}`;
    };

    const runView = (run: RevisionRun): HTMLElement =>
        el('div', { class: 'maestro-m8-run' }, [
            el('div', { class: 'maestro-m8-run-head' }, [
                el('strong', { text: formatTime(run.at, app.i18n) }),
                badge(tOr(app.i18n, `m8.run.reason.${run.reason}`, run.reason), 'muted'),
                el('span', {
                    class: 'maestro-muted',
                    text: t('m8.run.range', { from: run.fromMessage, to: run.toMessage }),
                }),
                el('span', {
                    class: 'maestro-muted',
                    text: t('m8.run.cost', { cost: formatUsd(run.costUsd, app.i18n) }),
                }),
            ]),
            run.error
                ? el('div', { class: 'maestro-warn-text', text: t('m8.run.error', { error: errorText(run.error) }) })
                : null,
            run.changes.length
                ? el('details', {}, [
                      el('summary', { text: t('m8.run.changes', { count: run.changes.length }) }),
                      el(
                          'ul',
                          {},
                          run.changes.map((change) => el('li', { text: changeLine(change) })),
                      ),
                  ])
                : null,
            run.rejected.length
                ? el('details', {}, [
                      el('summary', { text: t('m8.run.rejected', { count: run.rejected.length }) }),
                      el(
                          'ul',
                          {},
                          run.rejected.map((item) => el('li', { text: rejectionLine(item) })),
                      ),
                  ])
                : null,
        ]);

    const settingsView = (): HTMLElement => {
        const current = settings();
        return moduleSettingsSection(t('m8.settings.title'), [
            field(
                t('m8.settings.threshold'),
                numberInput({
                    value: current.signalThreshold,
                    min: 1,
                    max: 50,
                    step: 1,
                    label: t('m8.settings.threshold'),
                    onChange: (value) => {
                        settings().signalThreshold = Math.round(value);
                        commit('signalThreshold');
                    },
                }),
                t('m8.settings.threshold.hint'),
            ),
            field(
                t('m8.settings.every'),
                numberInput({
                    value: current.everyMessages,
                    min: 0,
                    max: 500,
                    step: 1,
                    label: t('m8.settings.every'),
                    onChange: (value) => {
                        settings().everyMessages = Math.round(value);
                        commit('everyMessages');
                    },
                }),
                t('m8.settings.every.hint'),
            ),
            field(
                t('m8.settings.confidence'),
                numberInput({
                    value: Math.round(current.minConfidence * 100),
                    min: 0,
                    max: 100,
                    step: 5,
                    label: t('m8.settings.confidence'),
                    onChange: (value) => {
                        settings().minConfidence = Math.min(1, Math.max(0, value / 100));
                        commit('minConfidence');
                    },
                }),
                t('m8.settings.confidence.hint'),
            ),
            toggle({
                label: t('m8.settings.sceneEnd'),
                hint: t('m8.settings.sceneEnd.hint'),
                checked: current.sceneEnd,
                onChange: (checked) => {
                    settings().sceneEnd = checked;
                    commit('sceneEnd');
                },
            }),
        ]);
    };

    return {
        id: REVISION_TAB,
        titleKey: 'm8.tab',
        icon: 'fa-wand-magic-sparkles',
        order: 49,
        render(container) {
            const root = el('div', { class: 'maestro-view maestro-m8' });
            container.appendChild(root);
            const draw = () => {
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m8.noChat'), 'fa-comment-slash'));
                    return;
                }
                if (app.host.isGroupChat()) {
                    root.appendChild(emptyState(t('m8.group'), 'fa-users'));
                    return;
                }
                const status = service.status();
                const runs = service.api().runs().slice(-RUNS_SHOWN).reverse();
                const runNow = button({
                    label: t('m8.runNow'),
                    title: t('m8.runNow.hint'),
                    icon: 'fa-play',
                    kind: 'primary',
                    disabled: status.queued,
                    onClick: async () => {
                        try {
                            await service.request('manual');
                            app.ui.notice(t('m8.queued'), { urgent: true });
                        } catch (error) {
                            app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn' });
                        }
                        draw();
                    },
                });
                append(root, [
                    el('div', { class: 'maestro-hint', text: t('m8.hint') }),
                    el('div', { class: 'maestro-row' }, [
                        el('span', { text: t('m8.status', { pending: status.pending, since: status.messagesSince }) }),
                        el('span', { class: 'maestro-grow' }),
                        runNow,
                    ]),
                    status.queued ? el('div', { class: 'maestro-muted', text: t('m8.status.queued') }) : null,
                    status.signalsApi ? null : el('div', { class: 'maestro-muted', text: t('m8.status.noSignals') }),
                    section(
                        t('m8.runs.title'),
                        runs.length
                            ? el('div', { class: 'maestro-m8-runs' }, runs.map(runView))
                            : emptyState(t('m8.runs.empty'), 'fa-clock-rotate-left'),
                    ),
                    settingsView(),
                ]);
            };
            draw();
            const later = coalesce(draw, 80);
            const off = service.onChange(later);
            return () => {
                later.cancel();
                off();
            };
        },
    };
}
