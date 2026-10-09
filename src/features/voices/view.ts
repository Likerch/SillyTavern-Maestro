// Pult tab «Голоса» (M15): the cards that go into the next reply with their tokens, attitudes between present
// characters, the whole insert, the CarrotKernel quiet mode status (CK insert silenced, DES-RU told) and the settings.
import type { App, PultTab } from '../../shared/contracts';
import { badge, card, emptyState, lamp, section, moduleSettingsSection } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { clear, el } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type { VoicesQuietState } from './api';
import type { VoicesService } from './service';
import { MAX_CAP, MIN_CAP, cleanCap } from './settings';

export const VOICES_TAB = 'voices';

export const VOICES_CSS = `
.maestro-m15-cards { display: flex; flex-direction: column; gap: 8px; }
.maestro-m15-text { font-family: var(--monoFontFamily, monospace); font-size: 0.9em; white-space: pre-wrap;
    overflow-wrap: anywhere; }
.maestro-m15-bonds { display: flex; flex-direction: column; gap: 2px; font-size: 0.9em; }
.maestro-m15-pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85em; max-height: 40vh; overflow: auto; }
.maestro-m15-status { display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.maestro-m15-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
`;

export function voicesTab(app: App, service: VoicesService): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);

    const status = (state: 'ok' | 'warn' | 'error' | 'off', text: string): HTMLElement =>
        el('div', { class: 'maestro-m15-status' }, [lamp(state, text), el('span', { text })]);

    const ckLine = (quiet: VoicesQuietState): HTMLElement => {
        const ck = quiet.ck;
        if (!quiet.armed) return status('off', t('m15.quiet.ck.idle'));
        if (!ck) return status('warn', t('m15.quiet.ck.waiting'));
        if (ck.outcome === 'removed') {
            return status('ok', t('m15.quiet.ck.removed', { tokens: ck.tokens, time: formatTime(ck.at, i18n) }));
        }
        if (ck.outcome === 'absent') return status('ok', t('m15.quiet.ck.absent'));
        return status('error', t('m15.quiet.ck.notFound'));
    };

    const desruLine = (quiet: VoicesQuietState): HTMLElement => {
        if (quiet.desru === 'told') return status('ok', t('m15.quiet.desru.told'));
        if (quiet.desru === 'notTold') return status('error', t('m15.quiet.desru.notTold'));
        return status('off', t('m15.quiet.desru.absent'));
    };

    return {
        id: VOICES_TAB,
        titleKey: 'm15.tab',
        icon: 'fa-masks-theater',
        order: 56,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m15' });
            container.appendChild(root);

            const save = (path: string): void => {
                app.settings.save();
                app.settings.notify(path);
                draw();
            };

            const cardsView = (): HTMLElement => {
                const injection = service.injection();
                const cards = service.cards();
                const summary = el('div', { class: 'maestro-m15-summary' }, [
                    el('span', {
                        text: t('m15.cards.summary', {
                            count: cards.length,
                            tokens: injection.tokens,
                            budget: injection.budget,
                        }),
                    }),
                    badge(t(`m15.budget.${injection.budgetSource}`), 'muted'),
                ]);
                const body: (HTMLElement | null)[] = [el('div', { class: 'maestro-hint', text: t('m15.cards.hint') })];
                if (!cards.length) {
                    body.push(emptyState(t('m15.cards.empty'), 'fa-masks-theater'));
                    if (service.loading()) body.push(el('div', { class: 'maestro-muted', text: t('m15.loading') }));
                    return section(t('m15.cards.title'), body);
                }
                body.push(summary);
                if (injection.trimmed.length) {
                    const steps = injection.trimmed.map((step) => t(`m15.trim.${step}`)).join(', ');
                    body.push(el('div', { class: 'maestro-muted', text: t('m15.trimmed', { steps }) }));
                }
                if (injection.dropped.length) {
                    body.push(
                        el('div', {
                            class: 'maestro-muted',
                            text: t('m15.dropped', { names: injection.dropped.join(', ') }),
                        }),
                    );
                }
                if (service.loading()) body.push(el('div', { class: 'maestro-muted', text: t('m15.loading') }));
                body.push(
                    el(
                        'div',
                        { class: 'maestro-m15-cards' },
                        cards.map((item) =>
                            card({
                                title: item.name,
                                subtitle: badge(t('m15.tokens', { count: item.tokens }), 'muted'),
                                body: el('div', { class: 'maestro-m15-text', text: item.text }),
                            }),
                        ),
                    ),
                );
                if (injection.bonds.length) {
                    body.push(
                        el('div', { class: 'maestro-m15-bonds' }, [
                            el('div', { class: 'maestro-field-label', text: t('m15.bonds') }),
                            ...injection.bonds.map((line) => el('div', { class: 'maestro-m15-text', text: line })),
                        ]),
                    );
                }
                body.push(
                    el('details', {}, [
                        el('summary', { text: t('m15.preview') }),
                        el('pre', { class: 'maestro-m15-pre', text: injection.text }),
                    ]),
                );
                return section(t('m15.cards.title'), body);
            };

            const quietView = (): HTMLElement => {
                const quiet = service.quiet();
                return section(t('m15.quiet.title'), [
                    el('div', { class: 'maestro-hint', text: t('m15.quiet.hint') }),
                    ckLine(quiet),
                    desruLine(quiet),
                    // Release 1.17: the cards go into Dramatis's own block while it claims them.
                    quiet.dramatis?.present
                        ? status(
                              quiet.dramatis.merged ? 'ok' : 'off',
                              t(quiet.dramatis.merged ? 'm15.quiet.dramatis.merged' : 'm15.quiet.dramatis.separate'),
                          )
                        : null,
                ]);
            };

            const settingsView = (): HTMLElement => {
                const settings = service.settings();
                const injection = service.injection();
                return moduleSettingsSection(t('m15.settings.title'), [
                    field(
                        t('m15.settings.cap'),
                        numberInput({
                            value: settings.cap,
                            min: MIN_CAP,
                            max: MAX_CAP,
                            step: 50,
                            label: t('m15.settings.cap'),
                            onChange: (value) => {
                                settings.cap = cleanCap(value);
                                save('m15.cap');
                            },
                        }),
                        injection.budgetSource === 'architect'
                            ? t('m15.settings.cap.architect', { tokens: injection.budget })
                            : t('m15.settings.cap.hint'),
                    ),
                    toggle({
                        label: t('m15.settings.npcAttitudes'),
                        checked: settings.npcAttitudes,
                        onChange: (checked) => {
                            settings.npcAttitudes = checked;
                            save('m15.npcAttitudes');
                        },
                    }),
                    toggle({
                        label: t('m15.settings.goals'),
                        checked: settings.goals,
                        onChange: (checked) => {
                            settings.goals = checked;
                            save('m15.goals');
                        },
                    }),
                ]);
            };

            const draw = (): void => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m15.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsView());
                    return;
                }
                root.appendChild(cardsView());
                root.appendChild(quietView());
                root.appendChild(settingsView());
            };

            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => alive && redraw());
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
