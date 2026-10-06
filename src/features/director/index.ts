// M13 «Режиссёр сцены» + M14 «Темп и повороты» (plan M13, M14, M34 п.8, §11, §12, P14–P16; stage 8): the scene type
// of every committed reply drives one-shot flags `maestro_*` for conditional preset blocks; a stalled story gets a
// one-shot director's note near the end of the prompt. Exposed as app.modules.api<DirectorApi>('director').
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { DirectorApi } from './api';
import { sceneCommand } from './command';
import { DirectorService, SCENE_TASK } from './service';
import { defaultDirectorSettings, DIRECTOR_ID, DIRECTOR_KEY, readDirectorSettings } from './settings';
import type { DirectorSettings } from './settings';
import { DIRECTOR_STRINGS } from './strings';
import { DIRECTOR_CSS, directorTab } from './view';

export const directorModule: MaestroModule<DirectorSettings> = {
    id: DIRECTOR_ID,
    key: DIRECTOR_KEY,
    stage: 8,
    titleKey: 'm13.title',
    enabledByDefault: true,
    defaults: defaultDirectorSettings,
    i18n: DIRECTOR_STRINGS,
    init({ app, log, own }) {
        const settings = () => readDirectorSettings(app.settings.module<Partial<DirectorSettings>>(DIRECTOR_KEY));
        const service = new DirectorService(app, log, settings);
        service.install(own);
        app.modules.expose(DIRECTOR_KEY, service satisfies Required<DirectorApi>);
        own(registerProfileTask(SCENE_TASK, 'm13.profileTask'));
        own(app.ui.style('maestro-m13', DIRECTOR_CSS));
        own(app.ui.addTab(directorTab(app, service, settings)));
        own(app.ui.addSlashCommand(sceneCommand(app, service)));
    },
};

export { DIRECTOR_FLAGS } from '../../domain/director-flags';
export type { DirectorFlagInfo } from '../../domain/director-flags';
export type { DirectorApi, DirectorNote, SceneState, SceneType, StallState, SuppressedNote } from './api';
export { DEFAULT_TIMINGS, DirectorService, NOTE_INJECTION, SCENE_TASK } from './service';
export type { DirectorTimings, ModelState } from './service';
export { defaultDirectorSettings, DIRECTOR_ID, DIRECTOR_KEY, readDirectorSettings } from './settings';
export type { DirectorSettings } from './settings';
export { DIRECTOR_STRINGS } from './strings';
export { DIRECTOR_TAB } from './view';
