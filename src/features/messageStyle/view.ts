// The editor of message style rules (M32 «Стиль сообщений»): a pult tab in «Настройки». Presets, a live preview of
// a sample message for a character and for the player, the rules (switch, name, kind, whose messages, colour chips
// from the theme tokens, slant, weight, opacity, font, marks, extras; reordering; custom regex rules with live
// validation and a tester), the player's look and the optional hint to the model. Phone-first: one column, big
// targets. Every edit is saved at once and shows in the chat and the preview right away.
import {
    APPLY_TO,
    COLOR_TOKENS,
    FONT_TOKENS,
    MARKS,
    MATCH_KINDS,
    MAX_NAME,
    MAX_PATTERN,
    MAX_RULES,
    PLAYER_ALIGN,
    PLAYER_MARKS,
    PRESET_IDS,
    clampOpacity,
    cleanFlags,
    compileCustom,
    isDialogueKind,
    isHexColor,
    makeStyle,
    newRuleId,
    normalizeStyle,
    presetRules,
    sameRules,
    supportsDecoration,
} from '../../domain/message-style';
import type { ColorValue, MatchKind, PresetId, Scope, StyleRule } from '../../domain/message-style';
import { canStyle, colorValue } from '../../domain/message-style-css';
import { findMatches } from '../../domain/message-style-match';
import type { App, PultTab, Unsubscribe } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { field, segmented, select, toggle, uid } from '../../ui/components/controls';
import { append, button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { currentHint } from './hint';
import type { MessageStyleSettings } from './settings';
import { PREVIEW_CLASS } from './styler';
import type { MessageStyler } from './styler';

export const MESSAGE_STYLE_TAB = 'messageStyle';
export const MESSAGE_STYLE_TAB_ORDER = 97;

export const EDITOR_CSS = `
.maestro-m32m { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m32m-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.maestro-m32m .maestro-m32m-preset {
    display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 2px;
    height: auto; min-height: 44px; margin: 0; padding: 6px 8px; text-align: left; white-space: normal;
}
.maestro-m32m-preset[aria-pressed='true'] { outline: 2px solid var(--maestro-accent); outline-offset: -2px; }
.maestro-m32m-preset-name { font-weight: 600; }
.maestro-m32m-preset-desc { font-size: 0.8em; opacity: 0.8; }
.maestro-m32m-previews { display: grid; gap: 8px; }
.${PREVIEW_CLASS} {
    padding: 8px 10px; border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    background-color: var(--maestro-raised);
}
.${PREVIEW_CLASS}-name { margin-bottom: 4px; font-size: 0.9em; font-weight: 600; }
.${PREVIEW_CLASS}-label { float: right; font-size: 0.75em; opacity: 0.7; }
.${PREVIEW_CLASS}-text {
    color: var(--SmartThemeBodyColor); font-family: var(--mainFontFamily); line-height: 1.5; overflow-wrap: anywhere;
}
.${PREVIEW_CLASS}-text p { margin: 0 0 0.5em; }
.${PREVIEW_CLASS}-text p:last-child { margin-bottom: 0; }
.${PREVIEW_CLASS}-text q { color: var(--SmartThemeQuoteColor); }
.${PREVIEW_CLASS}-text q::before, .${PREVIEW_CLASS}-text q::after { content: ''; }
.${PREVIEW_CLASS}-text :is(em, i) { color: var(--SmartThemeEmColor); }
.${PREVIEW_CLASS}-text q :is(em, i) { color: inherit; }
.${PREVIEW_CLASS}-text u { color: var(--SmartThemeUnderlineColor); }
.maestro-m32m-rules { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.maestro-m32m-rule { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); }
.maestro-m32m-rule.maestro-off .maestro-m32m-rule-title { opacity: 0.6; }
.maestro-m32m-rule-head { display: flex; align-items: center; gap: 6px; padding: 2px 6px; }
.maestro-m32m-rule-head input[type='checkbox'] { flex: none; margin: 0; }
.maestro-m32m-rule-title {
    display: flex; flex: 1; flex-direction: column; align-items: flex-start; min-width: 0; min-height: 40px;
    padding: 4px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.maestro-m32m-rule-name { overflow-wrap: anywhere; }
.maestro-m32m-rule-meta { font-size: 0.8em; opacity: 0.75; }
.maestro-m32m-rule-actions { display: flex; flex: none; gap: 2px; }
.maestro-m32m-rule-actions .menu_button { min-width: 36px; min-height: 36px; margin: 0; padding: 0 6px; }
.maestro-m32m-rule-body {
    display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 10px; border-top: 1px solid var(--maestro-border);
}
.maestro-m32m-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.maestro-m32m .maestro-m32m-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 32px; margin: 0; padding: 2px 8px; }
.maestro-m32m-chip[aria-checked='true'] { outline: 2px solid var(--maestro-accent); outline-offset: -2px; }
.maestro-m32m-chip input[type='color'] { width: 18px; height: 18px; padding: 0; border: 0; background: none; }
.maestro-m32m-swatch {
    flex: none; width: 14px; height: 14px; border: 1px solid var(--maestro-border); border-radius: 50%;
}
.maestro-m32m-swatch-none {
    background: repeating-linear-gradient(45deg, transparent 0 3px, var(--maestro-border) 3px 4px);
}
.maestro-m32m-toggles { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.maestro-m32m-opacity { display: flex; align-items: center; gap: 8px; }
.maestro-m32m-opacity input { flex: 1; min-width: 0; }
.maestro-m32m-opacity-value { min-width: 3em; text-align: right; font-variant-numeric: tabular-nums; }
.maestro-m32m-pattern { width: 100%; font-family: var(--monoFontFamily, monospace); }
.maestro-m32m-pattern-status { font-size: 0.85em; }
.maestro-m32m-pattern-status[data-state='error'] { color: var(--maestro-error); }
.maestro-m32m-pattern-status[data-state='ok'] { color: var(--maestro-ok); }
.maestro-m32m-test { width: 100%; min-height: 3.5em; margin: 0; resize: vertical; }
.maestro-m32m-test-result {
    margin-top: 4px; padding: 4px 6px; border-radius: var(--maestro-radius-sm); background-color: var(--maestro-raised);
    white-space: pre-wrap; overflow-wrap: anywhere;
}
.maestro-m32m-hit { border-radius: 3px; background-color: var(--maestro-accent-soft); color: inherit; }
.maestro-m32m-add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m32m-add .maestro-select { flex: 1; min-width: 160px; margin: 0; }
.maestro-m32m-hint-text {
    padding: 6px 8px; border-left: 3px solid var(--maestro-accent); background-color: var(--maestro-raised);
    white-space: pre-wrap;
}
@media screen and (max-width: 1000px) {
    .maestro-m32m .maestro-field { grid-template-columns: 1fr; }
    .maestro-m32m-presets { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
}
`;

export interface EditorDeps {
    app: App;
    styler: MessageStyler;
}

type Tri = 'st' | 'on' | 'off';

const triOf = (value: boolean | null): Tri => (value === null ? 'st' : value ? 'on' : 'off');
const triValue = (value: Tri): boolean | null => (value === 'st' ? null : value === 'on');

/** `#abc` → `#aabbcc` (what `<input type=color>` accepts). */
function longHex(hex: string): string {
    return /^#[0-9a-f]{3}$/i.test(hex) ? `#${[...hex.slice(1)].map((char) => char + char).join('')}` : hex;
}

/** Renders the editor into `container` and keeps it in sync with the settings; returns the cleanup. */
export function renderEditor(container: HTMLElement, deps: EditorDeps): Unsubscribe {
    const { app, styler } = deps;
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const root = el('div', { class: 'maestro-m32m' });
    container.appendChild(root);
    /** Rules whose settings are open. */
    const expanded = new Set<string>();
    /** Custom patterns being typed (kept while invalid) and the testers' texts. */
    const drafts = new Map<string, string>();
    const samples = new Map<string, string>();
    let quiet = false;
    let focusNext: string | null = null;

    const commit = (path: string, change: (settings: MessageStyleSettings) => void, redraw = true): void => {
        quiet = !redraw;
        try {
            styler.update(path, change);
        } finally {
            quiet = false;
        }
    };

    const editRule = (id: string, change: (rule: StyleRule) => void, redraw = true): void =>
        commit(
            'rules',
            (settings) => {
                const rule = settings.rules.find((item) => item.id === id);
                if (rule) change(rule);
            },
            redraw,
        );

    /** Marks the focusable element of a control so focus survives redraws. */
    const control = <T extends HTMLElement>(node: T, key: string): T => {
        const target = node.matches('input, button, select, textarea')
            ? node
            : node.querySelector<HTMLElement>('input, button, select, textarea');
        if (target) target.dataset.m32mControl = key;
        return node;
    };

    const seg = <T extends string>(
        key: string,
        label: string,
        value: T,
        options: { value: T; label: string }[],
        onChange: (value: T) => void,
    ) => {
        const node = segmented({ label, value, options, onChange });
        for (const item of node.querySelectorAll<HTMLElement>('button')) {
            item.dataset.m32mControl = `${key}-${item.dataset.value ?? ''}`;
        }
        return node;
    };

    const hint = (key: string): HTMLElement => el('div', { class: 'maestro-hint', text: t(key) });

    const ruleLabel = (rule: StyleRule): string => rule.name || t(`m32m.kind.${rule.match.kind}`);

    /* ------------------------------------------------------------ presets */

    const choosePreset = async (id: PresetId): Promise<void> => {
        const settings = styler.settings();
        const modified = !sameRules(settings.rules, presetRules(settings.preset));
        if (id === settings.preset && !modified) return;
        if (modified) {
            const name = t(`m32m.preset.${id}`);
            const ok = await app.ui.confirm(t('m32m.preset.confirmTitle'), t('m32m.preset.confirmBody', { name }));
            if (!ok) return;
        }
        expanded.clear();
        drafts.clear();
        commit('preset', (current) => {
            current.preset = id;
            current.rules = presetRules(id);
        });
    };

    const presetsSection = (settings: MessageStyleSettings): HTMLElement => {
        const modified = !sameRules(settings.rules, presetRules(settings.preset));
        const buttons = PRESET_IDS.map((id) => {
            const current = id === settings.preset;
            const name = t(`m32m.preset.${id}`);
            const node = el(
                'button',
                {
                    class: ['menu_button', 'maestro-btn', 'maestro-m32m-preset'],
                    attrs: { type: 'button', 'aria-pressed': current ? 'true' : 'false' },
                    data: { preset: id, m32mControl: `preset-${id}` },
                },
                [
                    el('span', {
                        class: 'maestro-m32m-preset-name',
                        text: current && modified ? `${name} · ${t('m32m.preset.modified')}` : name,
                    }),
                    el('span', { class: 'maestro-m32m-preset-desc', text: t(`m32m.preset.${id}.desc`) }),
                ],
            );
            node.addEventListener('click', () => void choosePreset(id));
            return node;
        });
        return section(t('m32m.presets'), [
            hint('m32m.presetsHint'),
            el(
                'div',
                { class: 'maestro-m32m-presets', attrs: { role: 'group', 'aria-label': t('m32m.presets') } },
                buttons,
            ),
            modified
                ? control(
                      button({
                          label: t('m32m.preset.reset'),
                          icon: 'fa-rotate-left',
                          onClick: () => choosePreset(settings.preset),
                      }),
                      'preset-reset',
                  )
                : null,
        ]);
    };

    /* ------------------------------------------------------------ preview */

    const previewBox = (scope: Scope): HTMLElement => {
        const name = t(scope === 'user' ? 'm32m.sample.userName' : 'm32m.sample.charName');
        const text = el('div', { class: `${PREVIEW_CLASS}-text` });
        // ST's formatter output (sanitised by ST) or Maestro's escaped imitation of it.
        text.innerHTML = styler.formatPreview(t(`m32m.sample.${scope}`), scope, name);
        return el('div', { class: PREVIEW_CLASS, data: { msScope: scope } }, [
            el('div', { class: `${PREVIEW_CLASS}-name` }, [
                el('span', { class: `${PREVIEW_CLASS}-label`, text: t(`m32m.preview.${scope}`) }),
                name,
            ]),
            text,
        ]);
    };

    const previewSection = (): HTMLElement =>
        section(t('m32m.preview'), [
            hint('m32m.previewHint'),
            el('div', { class: 'maestro-m32m-previews' }, [previewBox('char'), previewBox('user')]),
        ]);

    /* ------------------------------------------------------------ controls */

    const swatch = (value: ColorValue | null): HTMLElement => {
        const node = el('span', {
            class: ['maestro-m32m-swatch', value === null ? 'maestro-m32m-swatch-none' : null],
            attrs: { 'aria-hidden': 'true' },
        });
        if (value !== null) node.style.background = colorValue(value);
        return node;
    };

    const colorChips = (
        key: string,
        value: ColorValue | null,
        allowNone: boolean,
        onPick: (value: ColorValue | null) => void,
    ): HTMLElement => {
        const group = el('div', {
            class: 'maestro-m32m-chips',
            attrs: { role: 'radiogroup', 'aria-label': t('m32m.rule.color') },
        });
        const options: (ColorValue | null)[] = [...(allowNone ? [null] : []), ...COLOR_TOKENS];
        for (const option of options) {
            const checked = option === value;
            const chip = el(
                'button',
                {
                    class: ['menu_button', 'maestro-btn', 'maestro-m32m-chip'],
                    attrs: { type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false' },
                    data: { m32mControl: `${key}-${option ?? 'none'}`, color: option ?? '' },
                },
                [swatch(option), el('span', { text: t(`m32m.color.${option ?? 'none'}`) })],
            );
            chip.addEventListener('click', () => onPick(option));
            group.appendChild(chip);
        }
        const custom = isHexColor(value) ? value : null;
        const picker = el('input', {
            attrs: { type: 'color', 'aria-label': t('m32m.color.custom') },
            data: { m32mControl: `${key}-custom` },
        });
        picker.value = longHex(custom ?? '#888888');
        picker.addEventListener('change', () => onPick(picker.value.toLowerCase()));
        group.appendChild(
            el(
                'label',
                {
                    class: ['menu_button', 'maestro-btn', 'maestro-m32m-chip'],
                    attrs: { role: 'radio', 'aria-checked': custom ? 'true' : 'false' },
                },
                [picker, el('span', { text: t('m32m.color.custom') })],
            ),
        );
        return group;
    };

    /* ------------------------------------------------------------ custom rules */

    const renderTest = (result: HTMLElement, text: string, rule: StyleRule | null): void => {
        clear(result);
        if (!rule) return;
        const matches = findMatches(text, [rule]).filter((match) => match.kind === 'custom');
        let pos = 0;
        for (const match of matches) {
            if (match.start > pos) result.append(text.slice(pos, match.start));
            result.append(el('mark', { class: 'maestro-m32m-hit', text: text.slice(match.start, match.end) }));
            pos = match.end;
        }
        if (pos < text.length) result.append(text.slice(pos));
        result.append(
            el('div', {
                class: 'maestro-hint',
                text: matches.length ? t('m32m.custom.hits', { count: matches.length }) : t('m32m.custom.none'),
            }),
        );
    };

    const customFields = (rule: StyleRule): Child[] => {
        const id = rule.id;
        const flags = rule.match.flags ?? '';
        const statusId = uid('maestro-m32m-status');
        const input = el('input', {
            class: 'text_pole maestro-m32m-pattern',
            attrs: {
                type: 'text',
                spellcheck: 'false',
                autocomplete: 'off',
                maxlength: MAX_PATTERN,
                'aria-label': t('m32m.custom.pattern'),
                'aria-describedby': statusId,
            },
            data: { m32mControl: `rule-${id}-pattern` },
        });
        input.value = drafts.get(id) ?? rule.match.pattern ?? '';
        const status = el('div', {
            class: 'maestro-m32m-pattern-status',
            attrs: { id: statusId, role: 'status', 'aria-live': 'polite' },
        });
        const area = el('textarea', {
            class: 'text_pole maestro-m32m-test',
            attrs: { rows: 3, 'aria-label': t('m32m.custom.test') },
            data: { m32mControl: `rule-${id}-test` },
        });
        area.value = samples.get(id) ?? t('m32m.custom.testDefault');
        const result = el('div', { class: 'maestro-m32m-test-result', attrs: { 'aria-live': 'polite' } });
        const refresh = (): void => {
            const check = compileCustom(input.value, flags);
            status.dataset.state = check.ok ? 'ok' : 'error';
            status.textContent = check.ok
                ? t('m32m.custom.ok')
                : t(`m32m.custom.error.${check.reason}`, { detail: check.detail ?? '' });
            input.setAttribute('aria-invalid', check.ok ? 'false' : 'true');
            const probe: StyleRule = {
                ...rule,
                enabled: true,
                applyTo: 'all',
                match: { kind: 'custom', pattern: input.value, flags },
            };
            renderTest(result, area.value, check.ok ? probe : null);
        };
        input.addEventListener('input', () => {
            drafts.set(id, input.value);
            refresh();
        });
        input.addEventListener('change', () => {
            if (!compileCustom(input.value, flags).ok) return;
            drafts.delete(id);
            editRule(id, (item) => {
                item.match.pattern = input.value;
            });
        });
        area.addEventListener('input', () => {
            samples.set(id, area.value);
            refresh();
        });
        refresh();
        return [
            field(t('m32m.custom.pattern'), el('div', {}, [input, status]), t('m32m.custom.patternHint')),
            control(
                toggle({
                    label: t('m32m.custom.ignoreCase'),
                    checked: flags.includes('i'),
                    onChange: (checked) =>
                        editRule(id, (item) => {
                            const current = item.match.flags ?? '';
                            item.match.flags = cleanFlags(checked ? `${current}i` : current.replace('i', ''));
                        }),
                }),
                `rule-${id}-ignoreCase`,
            ),
            field(t('m32m.custom.test'), el('div', {}, [area, result])),
        ];
    };

    /* ------------------------------------------------------------ rules */

    const changeKind = (rule: StyleRule, kind: MatchKind): void => {
        rule.match =
            kind === 'custom'
                ? { kind, pattern: rule.match.pattern ?? '', flags: cleanFlags(rule.match.flags) }
                : { kind };
        rule.style = normalizeStyle(rule.style, kind);
    };

    const ruleBody = (rule: StyleRule, annotated: boolean): HTMLElement => {
        const id = rule.id;
        const kind = rule.match.kind;
        const style = rule.style;
        const parts: Child[] = [];
        if (!canStyle(rule, annotated)) parts.push(banner(t('m32m.rule.cannot'), 'warn'));
        if (kind === 'narration') parts.push(hint('m32m.rule.narrationHint'));
        if (kind === 'asterisk' || kind === 'underscore') parts.push(hint('m32m.rule.sharedEm'));

        const name = el('input', {
            class: 'text_pole',
            attrs: {
                type: 'text',
                maxlength: MAX_NAME,
                placeholder: t(`m32m.kind.${kind}`),
                'aria-label': t('m32m.rule.name'),
            },
            data: { m32mControl: `rule-${id}-name` },
        });
        name.value = rule.name;
        name.addEventListener('change', () =>
            editRule(id, (item) => {
                item.name = name.value.trim().slice(0, MAX_NAME);
            }),
        );
        parts.push(field(t('m32m.rule.name'), name));

        parts.push(
            field(
                t('m32m.rule.kind'),
                control(
                    select<MatchKind>({
                        label: t('m32m.rule.kind'),
                        value: kind,
                        options: MATCH_KINDS.map((value) => ({ value, label: t(`m32m.kind.${value}`) })),
                        onChange: (value) => editRule(id, (item) => changeKind(item, value)),
                    }),
                    `rule-${id}-kind`,
                ),
            ),
        );
        parts.push(
            field(
                t('m32m.rule.applyTo'),
                seg(
                    `rule-${id}-applyTo`,
                    t('m32m.rule.applyTo'),
                    rule.applyTo,
                    APPLY_TO.map((value) => ({ value, label: t(`m32m.applyTo.${value}`) })),
                    (value) =>
                        editRule(id, (item) => {
                            item.applyTo = value;
                        }),
                ),
            ),
        );
        if (kind === 'custom') parts.push(...customFields(rule));

        parts.push(
            field(
                t('m32m.rule.color'),
                colorChips(`rule-${id}-color`, style.color, true, (value) =>
                    editRule(id, (item) => {
                        item.style.color = value;
                    }),
                ),
            ),
        );
        const tri = (key: 'italic' | 'bold') =>
            seg<Tri>(
                `rule-${id}-${key}`,
                t(`m32m.rule.${key}`),
                triOf(style[key]),
                [
                    { value: 'st', label: t('m32m.tri.st') },
                    { value: 'on', label: t(`m32m.${key}.on`) },
                    { value: 'off', label: t(`m32m.${key}.off`) },
                ],
                (value) =>
                    editRule(id, (item) => {
                        item.style[key] = triValue(value);
                    }),
            );
        parts.push(field(t('m32m.rule.italic'), tri('italic')), field(t('m32m.rule.bold'), tri('bold')));

        const range = el('input', {
            attrs: { type: 'range', min: 30, max: 100, step: 5, 'aria-label': t('m32m.rule.opacity') },
            data: { m32mControl: `rule-${id}-opacity` },
        });
        range.value = String(Math.round(style.opacity * 100));
        const shown = el('span', {
            class: 'maestro-m32m-opacity-value',
            text: t('m32m.rule.opacityValue', { value: range.value }),
        });
        range.addEventListener('input', () => {
            shown.textContent = t('m32m.rule.opacityValue', { value: range.value });
            // The stylesheet follows at once; the editor itself needs no redraw while the slider moves.
            editRule(
                id,
                (item) => {
                    item.style.opacity = clampOpacity(Number(range.value) / 100);
                },
                false,
            );
        });
        parts.push(field(t('m32m.rule.opacity'), el('div', { class: 'maestro-m32m-opacity' }, [range, shown])));

        parts.push(
            field(
                t('m32m.rule.font'),
                control(
                    select<string>({
                        label: t('m32m.rule.font'),
                        value: style.font ?? '',
                        options: [
                            { value: '', label: t('m32m.font.none') },
                            ...FONT_TOKENS.map((value) => ({ value, label: t(`m32m.font.${value}`) })),
                        ],
                        onChange: (value) =>
                            editRule(id, (item) => {
                                item.style.font = (FONT_TOKENS as readonly string[]).includes(value)
                                    ? (value as (typeof FONT_TOKENS)[number])
                                    : null;
                            }),
                    }),
                    `rule-${id}-font`,
                ),
            ),
        );

        if (isDialogueKind(kind)) {
            parts.push(
                field(
                    t('m32m.rule.marks'),
                    control(
                        select({
                            label: t('m32m.rule.marks'),
                            value: style.marks,
                            options: MARKS.map((value) => ({ value, label: t(`m32m.marks.${value}`) })),
                            onChange: (value) =>
                                editRule(id, (item) => {
                                    item.style.marks = value;
                                }),
                        }),
                        `rule-${id}-marks`,
                    ),
                    t('m32m.rule.marksHint'),
                ),
            );
        }

        const flag = (key: 'underline' | 'spacing' | 'highlight' | 'bar') =>
            control(
                toggle({
                    label: t(`m32m.rule.${key}`),
                    checked: style[key],
                    onChange: (checked) =>
                        editRule(id, (item) => {
                            item.style[key] = checked;
                        }),
                }),
                `rule-${id}-${key}`,
            );
        const decorated = supportsDecoration(kind);
        parts.push(
            field(
                t('m32m.rule.decor'),
                el('div', { class: 'maestro-m32m-toggles' }, [
                    decorated ? flag('underline') : null,
                    flag('spacing'),
                    decorated ? flag('highlight') : null,
                    decorated ? flag('bar') : null,
                ]),
            ),
        );
        return el('div', { class: 'maestro-m32m-rule-body' }, parts);
    };

    const move = (id: string, delta: number): void =>
        commit('rules', (settings) => {
            const from = settings.rules.findIndex((item) => item.id === id);
            const to = from + delta;
            if (from < 0 || to < 0 || to >= settings.rules.length) return;
            const [rule] = settings.rules.splice(from, 1);
            settings.rules.splice(to, 0, rule!);
        });

    const remove = (id: string): void => {
        expanded.delete(id);
        drafts.delete(id);
        commit('rules', (settings) => {
            settings.rules = settings.rules.filter((item) => item.id !== id);
        });
    };

    const iconButton = (name: string, label: string, disabled: boolean, onClick: () => void, key: string) =>
        control(button({ icon: name, title: label, disabled, onClick }), key);

    const ruleItem = (rule: StyleRule, index: number, count: number, annotated: boolean): HTMLElement => {
        const label = ruleLabel(rule);
        const open = expanded.has(rule.id);
        const enabled = el('input', {
            attrs: { type: 'checkbox', 'aria-label': t('m32m.rule.enable', { name: label }) },
            data: { m32mControl: `rule-${rule.id}-enabled` },
        });
        enabled.checked = rule.enabled;
        enabled.addEventListener('change', () =>
            editRule(rule.id, (item) => {
                item.enabled = enabled.checked;
            }),
        );
        const title = el(
            'button',
            {
                class: 'maestro-m32m-rule-title',
                title: t('m32m.rule.expand', { name: label }),
                attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
                data: { m32mControl: `rule-${rule.id}-open` },
            },
            [
                el('span', { class: 'maestro-m32m-rule-name', text: label }),
                el('span', {
                    class: 'maestro-m32m-rule-meta',
                    text: `${t(`m32m.kind.${rule.match.kind}`)} · ${t(`m32m.applyTo.${rule.applyTo}`)}`,
                }),
            ],
        );
        title.addEventListener('click', () => {
            if (expanded.has(rule.id)) expanded.delete(rule.id);
            else expanded.add(rule.id);
            draw();
        });
        return el(
            'li',
            { class: ['maestro-m32m-rule', rule.enabled ? null : 'maestro-off'], data: { rule: rule.id } },
            [
                el('div', { class: 'maestro-m32m-rule-head' }, [
                    enabled,
                    title,
                    el('div', { class: 'maestro-m32m-rule-actions' }, [
                        iconButton(
                            'fa-arrow-up',
                            t('m32m.rule.up'),
                            index === 0,
                            () => move(rule.id, -1),
                            `rule-${rule.id}-up`,
                        ),
                        iconButton(
                            'fa-arrow-down',
                            t('m32m.rule.down'),
                            index === count - 1,
                            () => move(rule.id, 1),
                            `rule-${rule.id}-down`,
                        ),
                        iconButton(
                            'fa-trash-can',
                            t('m32m.rule.delete'),
                            false,
                            () => remove(rule.id),
                            `rule-${rule.id}-delete`,
                        ),
                    ]),
                ]),
                open ? ruleBody(rule, annotated) : null,
            ],
        );
    };

    const addRule = (kind: MatchKind): void => {
        const rules = styler.settings().rules;
        if (rules.length >= MAX_RULES) return;
        const id = newRuleId(rules, kind === 'custom' ? 'c' : 'r');
        expanded.add(id);
        focusNext = kind === 'custom' ? `rule-${id}-pattern` : `rule-${id}-name`;
        commit('rules', (settings) => {
            settings.rules.push({
                id,
                name: kind === 'custom' ? t('m32m.rule.newCustom') : '',
                enabled: true,
                match: kind === 'custom' ? { kind, pattern: '', flags: '' } : { kind },
                applyTo: 'all',
                style: makeStyle(kind === 'custom' ? { color: 'accent' } : {}),
            });
        });
    };

    const rulesSection = (settings: MessageStyleSettings, annotated: boolean): HTMLElement => {
        let kind: MatchKind = 'custom';
        const list = el(
            'ol',
            { class: 'maestro-m32m-rules' },
            settings.rules.map((rule, index) => ruleItem(rule, index, settings.rules.length, annotated)),
        );
        const add = el('div', { class: 'maestro-m32m-add' }, [
            control(
                select<MatchKind>({
                    label: t('m32m.add.kind'),
                    value: kind,
                    options: MATCH_KINDS.map((value) => ({ value, label: t(`m32m.kind.${value}`) })),
                    onChange: (value) => {
                        kind = value;
                    },
                }),
                'add-kind',
            ),
            control(
                button({
                    label: t('m32m.add.button'),
                    icon: 'fa-plus',
                    disabled: settings.rules.length >= MAX_RULES,
                    onClick: () => addRule(kind),
                }),
                'add',
            ),
        ]);
        return section(t('m32m.rules'), [
            hint('m32m.rulesHint'),
            settings.rules.length ? list : emptyState(t('m32m.rules.empty'), 'fa-paintbrush'),
            field(t('m32m.add'), add),
        ]);
    };

    /* ------------------------------------------------------------ the player and the hint */

    const playerSection = (settings: MessageStyleSettings): HTMLElement => {
        const player = settings.player;
        const edit = (change: (value: MessageStyleSettings['player']) => void) =>
            commit('player', (current) => change(current.player));
        return section(t('m32m.player.title'), [
            control(
                toggle({
                    label: t('m32m.player.enabled'),
                    hint: t('m32m.player.enabledHint'),
                    checked: player.enabled,
                    onChange: (checked) =>
                        edit((value) => {
                            value.enabled = checked;
                        }),
                }),
                'player-enabled',
            ),
            field(
                t('m32m.player.mark'),
                seg(
                    'player-mark',
                    t('m32m.player.mark'),
                    player.mark,
                    PLAYER_MARKS.map((value) => ({ value, label: t(`m32m.player.mark.${value}`) })),
                    (mark) =>
                        edit((value) => {
                            value.mark = mark;
                        }),
                ),
            ),
            field(
                t('m32m.player.color'),
                colorChips('player-color', player.color, false, (color) =>
                    edit((value) => {
                        value.color = color ?? 'accent';
                    }),
                ),
            ),
            control(
                toggle({
                    label: t('m32m.player.name'),
                    checked: player.name,
                    onChange: (checked) =>
                        edit((value) => {
                            value.name = checked;
                        }),
                }),
                'player-name',
            ),
            field(
                t('m32m.player.align'),
                seg(
                    'player-align',
                    t('m32m.player.align'),
                    player.align,
                    PLAYER_ALIGN.map((value) => ({ value, label: t(`m32m.player.align.${value}`) })),
                    (align) =>
                        edit((value) => {
                            value.align = align;
                        }),
                ),
                t('m32m.player.alignHint'),
            ),
        ]);
    };

    const hintSection = (settings: MessageStyleSettings): HTMLElement => {
        const text = settings.hint ? currentHint(app, settings) : '';
        return section(t('m32m.hint.title'), [
            control(
                toggle({
                    label: t('m32m.hint.toggle'),
                    checked: settings.hint,
                    onChange: (checked) =>
                        commit('hint', (current) => {
                            current.hint = checked;
                        }),
                }),
                'hint',
            ),
            hint('m32m.hint.desc'),
            settings.hint && text ? hint('m32m.hint.preview') : null,
            settings.hint && text ? el('div', { class: 'maestro-m32m-hint-text', text }) : null,
            settings.hint && !text ? hint('m32m.hint.empty') : null,
        ]);
    };

    /* ------------------------------------------------------------ the whole tab */

    function draw(): void {
        const active = root.ownerDocument.activeElement as HTMLElement | null;
        const focused = focusNext ?? (root.contains(active) ? active?.dataset?.m32mControl : undefined);
        focusNext = null;
        clear(root);
        const settings = styler.settings();
        const annotated = styler.annotated();
        append(root, [
            hint('m32m.intro'),
            control(
                toggle({
                    label: t('m32m.enabled'),
                    hint: t('m32m.enabledHint'),
                    checked: settings.enabled,
                    onChange: (checked) =>
                        commit('enabled', (current) => {
                            current.enabled = checked;
                        }),
                }),
                'enabled',
            ),
            settings.enabled
                ? null
                : el('div', { class: 'maestro-hint', attrs: { role: 'status' }, text: t('m32m.off') }),
            annotated ? null : banner(t('m32m.noHook'), 'warn'),
            presetsSection(settings),
            previewSection(),
            rulesSection(settings, annotated),
            playerSection(settings),
            hintSection(settings),
        ]);
        if (focused) root.querySelector<HTMLElement>(`[data-m32m-control="${focused}"]`)?.focus();
    }

    draw();
    const off = styler.onChange(() => {
        if (!quiet) draw();
    });
    return () => {
        off();
        root.remove();
    };
}

/** The pult tab «Стиль сообщений» (group «Настройки»). */
export function messageStyleTab(deps: EditorDeps): PultTab {
    return {
        id: MESSAGE_STYLE_TAB,
        titleKey: 'm32m.tab',
        icon: 'fa-paintbrush',
        order: MESSAGE_STYLE_TAB_ORDER,
        group: 'settings',
        render: (container) => renderEditor(container, deps),
    };
}
