// M22 «Правила» — on-the-fly fixes and compatibility (plan M22; dev-plan 1.6–1.8, 1.11, 2.6). Stage 1: the engine, the
// pult tab and nine built-in rules; stage 2: Cyrillic left boundary, pack version conflicts, the `<NSFW>` wrapper and
// CK archive proposals. Later stages add rules through RulesApi.register().
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import type { RulesSettings } from './api';
import {
    ARCHIVE_DEPTH_KIND,
    PACK_CHOICE_TARGET,
    PACK_VERSION_KIND,
    builtinRules,
    registerLoreHandlers,
    registerQvinkHandlers,
} from './builtin';
import { QVINK_EXCLUDE_TARGET } from './builtin/qvink';
import { RULE_FLAG_TARGET, RULES_KEY, RulesEngine, defaultRulesSettings } from './engine';
import { RULES_STRINGS } from './strings';
import { RULES_VIEW_CSS, rulesTab } from './view';

const onOff =
    (on: string, off: string) =>
    (value: unknown, i18n: I18n): string =>
        typeof value === 'boolean' ? i18n.t(value ? on : off) : '';

/**
 * Journal targets of M22. 'lore-entry' (the archive fixes) is shared with M5 and described there. The rule switch's
 * `null` before is «по умолчанию» and reads as a new value.
 */
export const RULES_TARGETS: TargetSpec[] = [
    { target: RULE_FLAG_TARGET, format: onOff('m22.value.ruleOn', 'm22.value.ruleOff') },
    { target: QVINK_EXCLUDE_TARGET, format: onOff('m22.value.excluded', 'm22.value.summarised') },
    {
        target: PACK_CHOICE_TARGET,
        // A book name, or '' for «keep every version».
        format: (value, i18n) =>
            typeof value === 'string'
                ? value
                    ? i18n.t('m22.pack.keep', { book: value })
                    : i18n.t('m22.pack.keepAll')
                : '',
    },
];

export const rulesModule: MaestroModule<RulesSettings> = {
    id: 'M22',
    key: RULES_KEY,
    stage: 1,
    titleKey: 'm22.title',
    enabledByDefault: true,
    defaults: defaultRulesSettings,
    i18n: RULES_STRINGS,
    targets: RULES_TARGETS,
    init({ app, log, own }) {
        const engine = new RulesEngine(app, log);
        own(() => engine.dispose());
        for (const off of engine.install()) own(off);
        const env = engine.env();
        for (const off of registerQvinkHandlers(env)) own(off);
        for (const off of registerLoreHandlers(env)) own(off);
        // Base books and pack choices (plan §8, P13, A13): a file fix or a version choice never becomes «auto».
        app.autonomy.neverAuto(ARCHIVE_DEPTH_KIND);
        app.autonomy.neverAuto(PACK_VERSION_KIND);
        for (const rule of builtinRules(env)) own(engine.register(rule));
        app.modules.expose(RULES_KEY, engine.api());
        own(app.ui.style('m22-view', RULES_VIEW_CSS));
        own(app.ui.addTab(rulesTab(engine, app)));
        engine.sync();
    },
};

export type { RulesApi, RulesSettings } from './api';
