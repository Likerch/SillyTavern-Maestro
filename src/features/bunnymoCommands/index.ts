// M40 «Команды BunnyMo»: BunnyMo's sheet commands as buttons of the Maestro button at the message box (the user kept
// forgetting the `!` words). The group, its targets and the insert/send logic are in group.ts; the pure command text in
// src/domain/bunnymo-commands.ts. The one setting («Отправлять сразу») is a block of the Settings tab.
// Exposed as app.modules.api<BunnyMoCommands>('bunnymoCommands').
import type { MaestroModule } from '../../shared/contracts';
import { toggle } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { BunnyMoCommands, defaultBunnyMoCommandsSettings, readBunnyMoCommandsSettings } from './group';
import type { BunnyMoCommandsSettings } from './group';
import { BUNNYMO_COMMANDS_STRINGS } from './strings';

export const BUNNYMO_COMMANDS_ID = 'M40';
export const BUNNYMO_COMMANDS_KEY = 'bunnymoCommands';
/** In the Settings tab after the look (theme) and the assistant. */
const SECTION_ORDER = 70;

export const bunnymoCommandsModule: MaestroModule<BunnyMoCommandsSettings> = {
    id: BUNNYMO_COMMANDS_ID,
    key: BUNNYMO_COMMANDS_KEY,
    stage: 15,
    titleKey: 'm40.title',
    enabledByDefault: true,
    defaults: defaultBunnyMoCommandsSettings,
    i18n: BUNNYMO_COMMANDS_STRINGS,
    init({ app, log, own }) {
        const t = app.i18n.t.bind(app.i18n);
        const settings = () =>
            readBunnyMoCommandsSettings(app.settings.module<Partial<BunnyMoCommandsSettings>>(BUNNYMO_COMMANDS_KEY));
        const commands = new BunnyMoCommands(app, log.scope('bunnymo-commands'), settings);
        app.modules.expose(BUNNYMO_COMMANDS_KEY, commands);
        if (typeof app.ui.addComposerAction === 'function') own(app.ui.addComposerAction(commands.group()));
        if (typeof app.ui.addSettingsSection === 'function') {
            own(
                app.ui.addSettingsSection({
                    id: BUNNYMO_COMMANDS_KEY,
                    titleKey: 'm40.settings.title',
                    order: SECTION_ORDER,
                    render(container) {
                        container.append(
                            el('div', { class: 'maestro-hint', text: t('m40.settings.hint') }),
                            toggle({
                                label: t('m40.settings.sendNow'),
                                hint: t('m40.settings.sendNow.hint'),
                                checked: settings().sendNow,
                                onChange: (checked) => {
                                    settings().sendNow = checked;
                                    app.settings.save();
                                    app.settings.notify(`modules.${BUNNYMO_COMMANDS_KEY}.sendNow`);
                                },
                            }),
                            el('div', { class: 'maestro-hint', text: t('m40.settings.sendNow.hint') }),
                        );
                    },
                }),
            );
        }
    },
};

export { BUNNYMO_COMMANDS_STRINGS } from './strings';
export { BunnyMoCommands, BUNNYMO_GROUP, defaultBunnyMoCommandsSettings, readBunnyMoCommandsSettings } from './group';
export type { BunnyMoCommandsSettings } from './group';
