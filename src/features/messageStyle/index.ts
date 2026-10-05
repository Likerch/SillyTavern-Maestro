// M32 «Стиль сообщений» (stage 12): how chat messages look — narration, "…"/«…»/dash dialogue, *thoughts*,
// **accents**, (asides), [notes], `code` and the user's own regex rules — for the player and for the characters, with
// presets, an editor with a live preview, the player's own look and an optional hint to the model. Display only: the
// stored messages never change; turn the module off and the chat looks as SillyTavern draws it (P11).
// Exposed as app.modules.api<MessageStyleApi>('messageStyle').
import type { MaestroModule } from '../../shared/contracts';
import type { MessageStyleApi } from './api';
import { installHint } from './hint';
import { MESSAGE_STYLE_ID, MESSAGE_STYLE_KEY, defaultMessageStyleSettings } from './settings';
import type { MessageStyleSettings } from './settings';
import { MESSAGE_STYLE_STRINGS } from './strings';
import { MessageStyler } from './styler';
import { EDITOR_CSS, messageStyleTab } from './view';

export const EDITOR_STYLE_ID = 'maestro-m32m-view';

export const messageStyleModule: MaestroModule<MessageStyleSettings> = {
    id: MESSAGE_STYLE_ID,
    key: MESSAGE_STYLE_KEY,
    stage: 12,
    titleKey: 'm32m.title',
    enabledByDefault: true,
    defaults: defaultMessageStyleSettings,
    i18n: MESSAGE_STYLE_STRINGS,
    init({ app, log, own }) {
        const styler = new MessageStyler({ app, log: log.scope('msgstyle') });
        own(() => styler.dispose());
        styler.start();
        own(installHint(app, () => styler.settings()));
        own(app.ui.style(EDITOR_STYLE_ID, EDITOR_CSS));
        own(app.ui.addTab(messageStyleTab({ app, styler })));
        const api: MessageStyleApi = {
            enabled: () => styler.active(),
            preset: () => styler.settings().preset,
            annotated: () => styler.annotated(),
            refresh: () => styler.refresh(),
            onChange: (listener) => styler.onChange(listener),
        };
        app.modules.expose(MESSAGE_STYLE_KEY, api);
    },
};

export type { MessageStyleApi } from './api';
export { annotateHtml, annotateNode, clearAnnotations, hasAnnotations } from './annotate';
export { HINT_INJECTION, chatLanguage, currentHint, installHint } from './hint';
export { MESSAGE_STYLE_ID, MESSAGE_STYLE_KEY, defaultMessageStyleSettings, readMessageStyleSettings } from './settings';
export type { MessageStyleSettings } from './settings';
export { MESSAGE_STYLE_STRINGS } from './strings';
export { HOOK_ORDER, MESSAGE_STYLE_CLASS, MessageStyler, PREVIEW_CLASS, RESTYLE_MS, RULES_STYLE_ID } from './styler';
export type { MessageStylerDeps } from './styler';
export { EDITOR_CSS, MESSAGE_STYLE_TAB, MESSAGE_STYLE_TAB_ORDER, messageStyleTab, renderEditor } from './view';
export type { EditorDeps } from './view';
