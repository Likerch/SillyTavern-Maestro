// M41 «Персона для персонажа»: a button in ST's character editor (and an item of its «More…» list, and
// `/maestro-persona [comment]`) makes the player's persona for that character. The model (task 'persona.create',
// its own profile row) reads the card, the scenario, the starting scene, what the card says about {{user}}, the lore
// and the player's comment and answers with a name, a title, the look, a background and five or six outfits; the user
// reviews and edits it; Maestro creates the persona in ST (description in Russian with a «Гардероб» line, ST's default
// avatar), links it to the card, and — with NAI Studio that keeps passports and draws avatars for any persona
// ('personaKeys') — saves its passport with these outfits (the wardrobe of that persona) and draws its picture. Making
// it the current persona only on request. No undo: a persona is deleted in ST's persona window.
// Needs personas.js (`st.personas`); without NAI Studio's feature the persona is still made and the window says what
// was skipped and why.
import { PERSONA_TASK } from '../../domain/persona-create';
import type { App, MaestroModule, SlashCommandSpec } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import { chatCard } from './collect';
import { stDialog } from './dialog';
import { EditorButton } from './editor-button';
import { PersonaUi } from './flow';
import { PersonaCreator } from './service';
import {
    PERSONA_CREATOR_ID,
    PERSONA_CREATOR_KEY,
    defaultPersonaCreatorSettings,
    readPersonaCreatorSettings,
} from './settings';
import type { PersonaCreatorSettings } from './settings';
import { PERSONA_CREATOR_STRINGS } from './strings';
import { StPersonas } from './st-personas';
import { PERSONA_CREATOR_CSS } from './view';

export const PERSONA_COMMAND = 'maestro-persona';

/** `/maestro-persona [comment]`: the window for the chat's character; with a comment the model starts at once. */
export function personaCommand(app: App, ui: Pick<PersonaUi, 'open'>): SlashCommandSpec {
    return {
        name: PERSONA_COMMAND,
        helpKey: 'm41.slash.help',
        args: [{ name: 'value', descriptionKey: 'm41.slash.value', optional: true }],
        callback: (_args, value) => {
            const card = chatCard(app);
            if (!card) {
                const text = app.i18n.t('m41.slash.noCard');
                app.ui.notice(text, { level: 'warn', importance: 'urgent' });
                return text;
            }
            const comment = String(value ?? '').trim();
            ui.open(card, { comment, autostart: comment.length > 0 });
            return '';
        },
    };
}

export const personaCreatorModule: MaestroModule<PersonaCreatorSettings> = {
    id: PERSONA_CREATOR_ID,
    key: PERSONA_CREATOR_KEY,
    stage: 15,
    titleKey: 'm41.title',
    enabledByDefault: true,
    defaults: defaultPersonaCreatorSettings,
    requires: ['st.personas'],
    i18n: PERSONA_CREATOR_STRINGS,
    init({ app, log, own }) {
        const settings = () =>
            readPersonaCreatorSettings(app.settings.module<Partial<PersonaCreatorSettings>>(PERSONA_CREATOR_KEY));
        const personas = new StPersonas(app, log);
        const service = new PersonaCreator(app, log, personas, settings);
        const ui = new PersonaUi(app, log, service, settings, stDialog(app));
        own(() => ui.dispose());
        own(registerProfileTask(PERSONA_TASK, 'm41.profileTask'));
        own(app.ui.style('maestro-m41', PERSONA_CREATOR_CSS));
        const button = new EditorButton(
            app,
            log,
            (card) => ui.open(card),
            (avatar) => ui.isBusy(avatar),
        );
        own(ui.onBusyChange(() => button.update()));
        own(() => button.dispose());
        button.install();
        own(app.ui.addSlashCommand(personaCommand(app, ui)));
    },
};

export { PERSONA_CREATOR_STRINGS } from './strings';
export { PERSONA_CREATOR_ID, PERSONA_CREATOR_KEY, defaultPersonaCreatorSettings, readPersonaCreatorSettings };
export type { PersonaCreatorSettings };
export { EditorButton, M41_NODES } from './editor-button';
export { PersonaUi, personaJobKey } from './flow';
export type { FlowStage } from './flow';
export { PersonaCreator } from './service';
export type { CreateOptions, CreateOutcome, CreatePlan, NaiSupport, StepState } from './service';
export { StPersonas, DEFAULT_PERSONA_AVATAR, AVATAR_UPLOAD_URL } from './st-personas';
export type { PersonaHost, PersonasModule } from './st-personas';
export { PersonaCollector, chatCard, editedCard } from './collect';
export type { CardRef } from './collect';
export { stDialog } from './dialog';
export type { DialogHandle, DialogOpener } from './dialog';
