// Wizard steps 1–3: the stack (neighbours, capabilities, unsupported cases), the ST macro engine and the settings
// baseline (plan §7, §4.14; dev-plan 1.13).
import type { App, JournalChange, WizardStep } from '../../shared/contracts';
import { banner, lamp } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { groupCapabilities } from '../../ui/views/overview';
import { tOr } from '../../ui/views/format';
import type { GuardianApi } from '../guardian/api';

/** Neighbours in the order of plan §2. */
const NEIGHBOURS = ['des', 'desru', 'ck', 'bunnymo', 'qvink', 'nai', 'localizer', 'preset'] as const;

/** Journal target of ST power-user settings changed by the wizard (undo handler in index.ts). */
export const POWER_TARGET = 'wizard-power-user';
export const MACRO_FLAG = 'experimental_macro_engine';

export function stackStep(app: App): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.stack',
        order: 20,
        titleKey: 'w1.stack.title',
        render(container, done) {
            const body = el('div', { class: 'maestro-w1-stack' });
            const draw = (): void => {
                clear(body);
                const groups = groupCapabilities(app.host.caps.report());
                const ids: ('st' | (typeof NEIGHBOURS)[number])[] = ['st', ...NEIGHBOURS];
                const rows = ids.map((id) => {
                    const adapter = id === 'st' ? null : app.adapters[id];
                    let present = id === 'st';
                    let version: string | undefined = id === 'st' ? app.host.version() : undefined;
                    try {
                        if (adapter) {
                            present = adapter.present();
                            version = adapter.version();
                        }
                    } catch (error) {
                        app.log.debug(`adapter ${id} failed`, error);
                    }
                    const caps = groups.get(id) ?? [];
                    const ok = caps.filter((item) => item.ok).length;
                    const failing = caps.filter((item) => !item.ok);
                    const state = !present ? 'off' : failing.length === 0 ? 'ok' : ok === 0 ? 'error' : 'warn';
                    return el('div', { class: 'maestro-stack-row', data: { neighbour: id } }, [
                        lamp(state, t(state === 'off' ? 'w1.stack.notFound' : `ui.lamp.${state}`)),
                        el('span', { class: 'maestro-stack-name', text: tOr(app.i18n, `ui.stack.${id}`, id) }),
                        el('span', {
                            class: 'maestro-muted',
                            text: [
                                present ? (version ? t('w1.stack.version', { version }) : '') : t('w1.stack.notFound'),
                                present && caps.length ? t('w1.stack.caps', { ok, total: caps.length }) : '',
                            ]
                                .filter(Boolean)
                                .join(' · '),
                        }),
                        present && failing.length
                            ? el('details', { class: 'maestro-stack-missing' }, [
                                  el('summary', { text: t('w1.stack.missing', { count: failing.length }) }),
                                  el(
                                      'ul',
                                      {},
                                      failing.map((item) =>
                                          el('li', { text: item.detail ? `${item.id} — ${item.detail}` : item.id }),
                                      ),
                                  ),
                              ])
                            : null,
                    ]);
                });
                const unsupported: HTMLElement[] = [];
                if (app.host.isGroupChat()) unsupported.push(banner(t('w1.stack.group'), 'warn', 'fa-users'));
                if (!app.host.isChatCompletion())
                    unsupported.push(banner(t('w1.stack.textCompletion'), 'warn', 'fa-circle-info'));
                if (!app.host.caps.has('st.cm')) unsupported.push(banner(t('w1.stack.noCm'), 'warn', 'fa-plug'));
                body.append(
                    el('p', { text: t('w1.stack.intro') }),
                    el('div', { class: 'maestro-stack' }, rows),
                    el('h4', { text: t('w1.stack.unsupported') }),
                    ...(unsupported.length
                        ? unsupported
                        : [banner(t('w1.stack.allSupported'), 'ok', 'fa-circle-check')]),
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            label: t('w1.stack.recheck'),
                            icon: 'fa-rotate',
                            kind: 'ghost',
                            onClick: async () => {
                                await app.host.caps.refresh();
                                draw();
                            },
                        }),
                    ]),
                );
            };
            container.appendChild(body);
            draw();
            done();
        },
    };
}

/** Sets ST's power-user flag the way its own checkbox does (the input event saves and offers a reload). */
export function setPowerFlag(app: App, key: string, value: boolean): void {
    const power = app.host.ctx().powerUserSettings;
    const box = typeof document === 'undefined' ? null : document.getElementById(key);
    if (box instanceof HTMLInputElement && box.type === 'checkbox') {
        box.checked = value;
        box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    power[key] = value;
    app.host.ctx().saveSettingsDebounced();
}

/** Undo of POWER_TARGET changes. */
export async function undoPowerFlag(app: App, change: JournalChange): Promise<boolean> {
    const key = change.ref.key;
    if (typeof key !== 'string') return false;
    setPowerFlag(app, key, change.before === true);
    await app.host.caps.refresh();
    return true;
}

export function macroStep(app: App): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.macros',
        order: 30,
        titleKey: 'w1.macros.title',
        render(container, done) {
            const body = el('div', { class: 'maestro-w1-macros' });
            container.appendChild(body);
            const flag = app.host.ctx().powerUserSettings?.[MACRO_FLAG];
            if (app.host.caps.has('st.macros.newEngine') || flag === true) {
                body.append(banner(t('w1.macros.on'), 'ok', 'fa-circle-check'));
                done();
                return;
            }
            if (flag === undefined) {
                body.append(banner(t('w1.macros.unsupported'), 'info', 'fa-circle-info'));
                done();
                return;
            }
            // Only on the user's click (dev-plan 1.13): a global ST setting.
            body.append(
                el('p', { text: t('w1.macros.off') }),
                button({
                    label: t('w1.macros.enable'),
                    icon: 'fa-code',
                    kind: 'primary',
                    onClick: async () => {
                        setPowerFlag(app, MACRO_FLAG, true);
                        await app.journal.record({
                            module: 'W1',
                            kind: 'wizard.macroEngine',
                            summary: t('w1.macros.journal'),
                            changes: [{ target: POWER_TARGET, ref: { key: MACRO_FLAG }, before: false, after: true }],
                        });
                        await app.host.caps.refresh();
                        clear(body);
                        body.append(
                            banner(t('w1.macros.enabled'), 'ok', 'fa-circle-check'),
                            button({
                                label: t('w1.macros.reload'),
                                icon: 'fa-rotate-right',
                                kind: 'ghost',
                                onClick: () => globalThis.location?.reload(),
                            }),
                        );
                        done();
                    },
                }),
            );
        },
    };
}

export function baselineStep(app: App): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.baseline',
        order: 40,
        titleKey: 'w1.baseline.title',
        render(container, done) {
            const guardian = app.modules.api<GuardianApi>('guardian');
            if (!guardian) {
                container.append(banner(t('w1.baseline.off'), 'info', 'fa-circle-info'));
                done();
                return;
            }
            const status = el('div', { class: 'maestro-muted' });
            const action = el('div', { class: 'maestro-actions' });
            const draw = (): void => {
                const has = guardian.hasBaseline();
                status.textContent = has ? t('w1.baseline.has') : t('w1.baseline.none');
                clear(action);
                action.append(
                    button({
                        label: has ? t('w1.baseline.retake') : t('w1.baseline.take'),
                        icon: 'fa-camera',
                        kind: has ? 'ghost' : 'primary',
                        onClick: async () => {
                            await guardian.takeBaseline('wizard');
                            draw();
                            status.textContent = t('w1.baseline.taken');
                            done();
                        },
                    }),
                );
            };
            container.append(el('p', { text: t('w1.baseline.intro') }), status, action);
            draw();
            if (guardian.hasBaseline()) done();
        },
    };
}
