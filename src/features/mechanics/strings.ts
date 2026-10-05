// Strings of M25 «Механики»: the three parts' strings merged (definitions `m25.title`, `m25.tab`, `m25.def.*`;
// state; checks, widgets and the prompt). Each part keeps its own prefix, so the merge never overrides a key.
import type { I18nParts } from '../../shared/contracts';
import { CHECK_STRINGS } from './strings-checks';
import { DEF_STRINGS } from './strings-defs';
import { STATE_STRINGS } from './strings-state';

export const MECHANICS_STRINGS: I18nParts = {
    en: { ...DEF_STRINGS.en, ...STATE_STRINGS.en, ...CHECK_STRINGS.en },
    ru: { ...DEF_STRINGS.ru, ...STATE_STRINGS.ru, ...CHECK_STRINGS.ru },
};

export { CHECK_STRINGS, DEF_STRINGS, STATE_STRINGS };
