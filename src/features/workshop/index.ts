// M42 «Служебный режим» (release 1.21 as «Мастерская», renamed in 1.24; the key, the id, the slash command and the
// MAESTRO_API member keep the old `workshop` name): helper cards (scenario and character creators, editors, a co-author)
// carry a service tag, and their chats run without the story machinery of the stack — service.ts says what goes silent
// and how. Here: the module, its block of the Settings tab, the wrench button of the card editor and
// `/maestro-workshop [on|off]`. Exposed as app.modules.api<WorkshopApi>('workshop') and, for neighbours, as
// MAESTRO_API.workshop.
import { WORKSHOP_LORE_MODES, parseTagList } from '../../domain/workshop';
import type { WorkshopLore } from '../../domain/workshop';
import type { App, I18n, MaestroModule, SlashCommandSpec, TargetSpec } from '../../shared/contracts';
import { field, select, toggle } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { WORKSHOP_ID, WORKSHOP_KEY, defaultWorkshopSettings, readWorkshopSettings } from './api';
import type { WorkshopSettings } from './api';
import { WORKSHOP_CSS, WorkshopButton } from './editor-button';
import { CARD_TARGET, QVINK_TARGET, WorkshopService } from './service';
import { WORKSHOP_STRINGS } from './strings';

export const WORKSHOP_COMMAND = 'maestro-workshop';
/** In the Settings tab after the BunnyMo commands. */
const SECTION_ORDER = 75;

function yesNo(value: unknown, i18n: I18n): string {
    if (typeof value !== 'boolean') return '';
    return i18n.t(value ? 'm42.target.on' : 'm42.target.off');
}

export const WORKSHOP_TARGETS: TargetSpec[] = [
    { target: CARD_TARGET, valueLabelKey: 'target.workshop-card', format: yesNo },
    { target: QVINK_TARGET, valueLabelKey: 'target.workshop-qvink', format: yesNo },
];

/** `/maestro-workshop [on|off]`: the card of the open one-on-one chat becomes a helper, a story card, or switches. */
export function workshopCommand(app: App, service: WorkshopService): SlashCommandSpec {
    return {
        name: WORKSHOP_COMMAND,
        helpKey: 'm42.slash.help',
        args: [{ name: 'value', descriptionKey: 'm42.slash.value', optional: true }],
        callback: async (_args, value) => {
            const avatar = service.openAvatar();
            if (!avatar) {
                const text = app.i18n.t('m42.slash.noCard');
                app.ui.notice(text, { level: 'warn', urgent: true });
                return text;
            }
            const word = String(value ?? '')
                .trim()
                .toLowerCase();
            const on = word === 'on' || word === 'true' ? true : word === 'off' || word === 'false' ? false : null;
            const next = on ?? !service.isWorkshopCard(avatar);
            const ok = await service.setCard(avatar, next);
            if (ok) app.ui.notice(app.i18n.t(next ? 'm42.tag.added' : 'm42.tag.removed'), { urgent: true });
            return ok ? String(next) : '';
        },
    };
}

function renderSettings(app: App, settings: () => WorkshopSettings, service: WorkshopService, container: HTMLElement) {
    const t = app.i18n.t.bind(app.i18n);
    const save = (path: string) => {
        app.settings.save();
        app.settings.notify(`modules.${WORKSHOP_KEY}.${path}`);
    };
    const tags = el('textarea', { class: 'text_pole maestro-m42-tags', attrs: { rows: 2 } });
    tags.value = settings().tags.join('\n');
    tags.addEventListener('change', () => {
        const list = parseTagList(tags.value);
        settings().tags = list.length ? list : defaultWorkshopSettings().tags;
        tags.value = settings().tags.join('\n');
        save('tags');
    });
    const preset = el('input', { class: 'text_pole', attrs: { type: 'text' } });
    preset.value = settings().preset;
    preset.addEventListener('change', () => {
        settings().preset = preset.value.trim();
        save('preset');
    });
    const lore = select<WorkshopLore>({
        value: settings().lore,
        label: t('m42.settings.lore'),
        options: WORKSHOP_LORE_MODES.map((mode) => ({ value: mode, label: t(`m42.settings.lore.${mode}`) })),
        onChange: (value) => {
            settings().lore = value;
            save('lore');
        },
    });
    container.append(
        el('div', { class: 'maestro-hint', text: t('m42.settings.hint') }),
        el('div', {
            class: 'maestro-hint',
            text: t(service.active() ? 'm42.settings.state.on' : 'm42.settings.state.off'),
        }),
        field(t('m42.settings.tags'), tags, t('m42.settings.tags.hint')),
        field(t('m42.settings.preset'), preset, t('m42.settings.preset.hint')),
        field(t('m42.settings.lore'), lore),
        toggle({
            label: t('m42.settings.qvink'),
            hint: t('m42.settings.qvink.hint'),
            checked: settings().qvink,
            onChange: (checked) => {
                settings().qvink = checked;
                save('qvink');
            },
        }),
        el('div', { class: 'maestro-hint', text: t('m42.settings.qvink.hint') }),
        toggle({
            label: t('m42.settings.notice'),
            checked: settings().notice,
            onChange: (checked) => {
                settings().notice = checked;
                save('notice');
            },
        }),
    );
}

export const workshopModule: MaestroModule<WorkshopSettings> = {
    id: WORKSHOP_ID,
    key: WORKSHOP_KEY,
    // Started first: in a workshop chat opened at page load the story modules are held off before they start.
    stage: 0,
    titleKey: 'm42.title',
    enabledByDefault: true,
    defaults: defaultWorkshopSettings,
    i18n: WORKSHOP_STRINGS,
    targets: WORKSHOP_TARGETS,
    init({ app, log, own }) {
        const settings = () => readWorkshopSettings(app.settings.module<Partial<WorkshopSettings>>(WORKSHOP_KEY));
        const service = new WorkshopService(app, log, settings);
        service.install(own);
        app.modules.expose(WORKSHOP_KEY, service);
        own(() => app.modules.expose(WORKSHOP_KEY, undefined));
        own(app.ui.style('maestro-m42', WORKSHOP_CSS));
        const button = new WorkshopButton(
            app,
            log,
            (avatar) => service.isWorkshopCard(avatar),
            (avatar, on) => service.setCard(avatar, on),
        );
        own(() => button.dispose());
        own(service.onChange(() => button.update()));
        button.install();
        own(app.ui.addSlashCommand(workshopCommand(app, service)));
        if (typeof app.ui.addSettingsSection === 'function') {
            own(
                app.ui.addSettingsSection({
                    id: WORKSHOP_KEY,
                    titleKey: 'm42.settings.title',
                    order: SECTION_ORDER,
                    render: (container) => renderSettings(app, settings, service, container),
                }),
            );
        }
    },
};

export { WORKSHOP_STRINGS } from './strings';
export { WORKSHOP_KEY, WORKSHOP_KEEPS, defaultWorkshopSettings, readWorkshopSettings } from './api';
export type { WorkshopApi, WorkshopSettings } from './api';
export { WorkshopService } from './service';
