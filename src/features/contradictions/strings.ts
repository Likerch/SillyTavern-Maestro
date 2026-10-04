// Strings of M26c «Проверка противоречий» (`m26c.*`). Russian is the primary UI language; the user is addressed as
// «ты» (male).
import type { I18nParts } from '../../shared/contracts';

export const CONTRADICTIONS_STRINGS: I18nParts = {
    en: {
        'm26c.title': 'Contradiction check',
        'm26c.profileTask': 'Contradiction check (when the rules are not sure)',
    },
    ru: {
        'm26c.title': 'Проверка противоречий',
        'm26c.profileTask': 'Проверка противоречий (когда правила не уверены)',
    },
};
