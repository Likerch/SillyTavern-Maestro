// M43 «Сцена и вокруг»: the look of the folded box in the chat and the settings section (Settings tab).
// Classes inside messages come out of ST's sanitizer prefixed (`custom-maestro-around`); both spellings are matched.
// Colours are SillyTavern's theme variables: the box lives in the chat, not in Maestro's windows.
import type { App } from '../../shared/contracts';
import { append, el } from '../../ui/components/dom';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { KEEP_MAX, LABEL_MAX, SCENE_SPLIT_KEY } from './settings';
import type { SceneSplitSettings } from './settings';

export const SCENE_SPLIT_SECTION_ORDER = 65;

const BOX = ':is(.maestro-around, .custom-maestro-around)';
const DETAILS = ':is(.maestro-around-box, .custom-maestro-around-box)';
const SUMMARY = ':is(.maestro-around-summary, .custom-maestro-around-summary)';
const BODY = ':is(.maestro-around-body, .custom-maestro-around-body)';

export const SCENE_SPLIT_CSS = `
.mes_text ${BOX} { margin: 0.5em 0 0; padding: 0; clear: both; }
.mes_text ${DETAILS} {
    border-left: 2px solid var(--SmartThemeQuoteColor, currentColor);
    padding: 0.15em 0 0.15em 0.65em;
    margin: 0;
}
.mes_text ${SUMMARY} {
    cursor: pointer; user-select: none; width: fit-content;
    font-size: 0.85em; letter-spacing: 0.02em; opacity: 0.7;
}
.mes_text ${SUMMARY}:hover, .mes_text ${DETAILS}[open] > ${SUMMARY} { opacity: 1; }
.mes_text ${BODY} { margin-top: 0.3em; font-size: 0.95em; opacity: 0.9; }
.mes_text ${BODY} > :first-child { margin-top: 0; }
.mes_text ${BODY} > :last-child { margin-bottom: 0; }
`;

/** The settings section: on/off, how many recent replies keep the block in the prompt, the label of the box. */
export function renderSceneSplitSettings(
    app: App,
    settings: () => SceneSplitSettings,
    hooked: () => boolean,
    container: HTMLElement,
): void {
    const t = app.i18n.t.bind(app.i18n);
    const save = (path: string) => {
        app.settings.save();
        app.settings.notify(`modules.${SCENE_SPLIT_KEY}.${path}`);
    };
    const keep = numberInput({
        value: settings().keepRecent,
        min: 0,
        max: KEEP_MAX,
        step: 1,
        label: t('m43.settings.keep'),
        onChange: (value) => {
            settings().keepRecent = Math.round(value);
            save('keepRecent');
        },
    });
    const label = el('input', {
        class: 'text_pole',
        attrs: {
            type: 'text',
            maxlength: LABEL_MAX,
            placeholder: t('m43.summary'),
            'aria-label': t('m43.settings.label'),
        },
    });
    label.value = settings().label;
    label.addEventListener('change', () => {
        settings().label = label.value.trim().slice(0, LABEL_MAX);
        label.value = settings().label;
        save('label');
    });
    append(container, [
        el('div', { class: 'maestro-hint', text: t('m43.settings.hint') }),
        hooked() ? null : el('div', { class: 'maestro-hint', text: t('m43.settings.noHook') }),
        toggle({
            label: t('m43.settings.enabled'),
            hint: t('m43.settings.enabled.hint'),
            checked: settings().enabled,
            onChange: (checked) => {
                settings().enabled = checked;
                save('enabled');
            },
        }),
        el('div', { class: 'maestro-hint', text: t('m43.settings.enabled.hint') }),
        field(t('m43.settings.keep'), keep, t('m43.settings.keep.hint')),
        field(t('m43.settings.label'), label, t('m43.settings.label.hint')),
    ]);
}
