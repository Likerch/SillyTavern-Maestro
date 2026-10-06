// Human names of preset parameters for journal summaries and change rows (plan-2 §3 «Понятные уведомления»): the
// «Параметры» tab's own labels (`m34.params.key.<key>`, `m34.params.opt.<key>.<option>`), so the journal speaks like
// the studio. Keys the studio does not edit (connection, logit bias, extensions) have no label.
import { formatPlain } from '../../core/labels';
import { PARAMS, optionKey } from '../../domain/preset-ui-params';
import type { I18n } from '../../shared/contracts';

/** The tab's label of a preset key, or undefined when the studio has none. */
export function paramLabel(key: string, i18n: I18n): string | undefined {
    const id = `m34.params.key.${key}`;
    const label = i18n.t(id);
    return label === id ? undefined : label;
}

/** A parameter value as the tab shows it: select options by their label, everything else as plain text. */
export function paramValue(key: string, value: unknown, i18n: I18n): string {
    const spec = PARAMS.find((item) => item.key === key);
    if (spec?.type === 'select' && (typeof value === 'string' || typeof value === 'number')) {
        const id = `m34.params.opt.${key}.${optionKey(value)}`;
        const label = i18n.t(id);
        if (label !== id) return label;
    }
    return formatPlain(value, i18n);
}
