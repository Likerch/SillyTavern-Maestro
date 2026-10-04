// Wizard steps 6–7: background tasks (daily cap, default profile; plan M21 п. 5) and the policy for long old chats
// (plan §7 п. 6; used by stage 4). Values are saved as soon as they change.
import { bootstrapCostUsd, historyTokens } from '../../domain/doctor-budget';
import type { App, WizardStep } from '../../shared/contracts';
import { banner } from '../../ui/components/card';
import { field, numberInput, segmented, select } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { formatUsd } from '../../ui/views/format';
import type { OldChatsPolicy, WizardSettings } from './settings';

function profiles(app: App): { id: string; name: string }[] | null {
    if (!app.host.caps.has('st.cm')) return null;
    try {
        return app.host.ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? null;
    } catch (error) {
        app.log.debug('connection profiles are not available', error);
        return null;
    }
}

export function backgroundStep(app: App): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.background',
        order: 70,
        titleKey: 'w1.background.title',
        render(container, done) {
            const core = app.settings.core();
            const commit = (path: string) => {
                app.settings.save();
                app.settings.notify(path);
            };
            const list = profiles(app);
            const current = core.profiles.default ?? '';
            const options = [
                { value: '', label: t('w1.background.profileNone') },
                ...(list ?? []).map((profile) => ({ value: profile.id, label: profile.name })),
            ];
            if (current && !options.some((option) => option.value === current))
                options.push({ value: current, label: t('w1.background.profileMissing', { id: current }) });
            container.append(
                el('p', { text: t('w1.background.intro') }),
                field(
                    t('w1.background.cap'),
                    numberInput({
                        value: core.backgroundDailyCapUsd,
                        min: 0,
                        step: 0.1,
                        label: t('w1.background.cap'),
                        onChange: (value) => {
                            app.settings.core().backgroundDailyCapUsd = value;
                            commit('core.backgroundDailyCapUsd');
                        },
                    }),
                    t('w1.background.capHint'),
                ),
                list
                    ? field(
                          t('w1.background.profile'),
                          select({
                              value: current,
                              label: t('w1.background.profile'),
                              options,
                              onChange: (value) => {
                                  const stored = app.settings.core().profiles;
                                  if (value) stored.default = value;
                                  else delete stored.default;
                                  commit('core.profiles.default');
                              },
                          }),
                          t('w1.background.profileHint'),
                      )
                    : banner(t('w1.background.noCm'), 'warn', 'fa-plug'),
            );
            done();
        },
    };
}

export function oldChatsStep(app: App, settings: WizardSettings): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.oldChats',
        order: 80,
        titleKey: 'w1.oldChats.title',
        render(container, done) {
            const hint = el('div', { class: 'maestro-hint' });
            const describe = (policy: OldChatsPolicy) => {
                hint.textContent = t(policy === 'bootstrap' ? 'w1.oldChats.bootstrapHint' : 'w1.oldChats.fromNowHint');
            };
            const chat = app.host.chatId() !== null ? (app.host.ctx().chat ?? []) : [];
            const messages = chat.filter((message) => !message.is_system);
            const chars = messages.reduce(
                (sum, message) => sum + (typeof message.mes === 'string' ? message.mes.length : 0),
                0,
            );
            const tokens = historyTokens(chars);
            const locale = app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US';
            container.append(
                el('p', { text: t('w1.oldChats.intro') }),
                segmented<OldChatsPolicy>({
                    value: settings.oldChatsPolicy,
                    label: t('w1.oldChats.title'),
                    options: [
                        { value: 'fromNow', label: t('w1.oldChats.fromNow') },
                        { value: 'bootstrap', label: t('w1.oldChats.bootstrap') },
                    ],
                    onChange: (value) => {
                        settings.oldChatsPolicy = value;
                        app.settings.save();
                        app.settings.notify('wizard.oldChatsPolicy');
                        describe(value);
                    },
                }),
                hint,
                messages.length
                    ? el('p', {
                          class: 'maestro-w1-cost',
                          text: t('w1.oldChats.cost', {
                              messages: messages.length.toLocaleString(locale),
                              tokens: tokens.toLocaleString(locale),
                              usd: formatUsd(bootstrapCostUsd(tokens), app.i18n),
                          }),
                      })
                    : el('p', { class: 'maestro-muted', text: t('w1.oldChats.noChat') }),
                el('div', { class: 'maestro-muted', text: t('w1.oldChats.stage') }),
            );
            describe(settings.oldChatsPolicy);
            done();
        },
    };
}
