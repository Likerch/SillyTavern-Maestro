// «Карта» tab of the Preset Studio (M34 п. 1): every slot of the assembled prompt in order — role, placement
// (relative, or in chat at a depth with its order), a tokens bar, on/off, markers and the extension injections that
// land there (DES, CK, Qvink, NAI, DES-RU, Maestro…), and why an enabled block would still not be sent. Data:
// analysis.map() (analysis-api.ts); without the analysis module a reduced map from the order and PM's counts.
import { banner } from '../../ui/components/card';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { MapSlot } from './analysis-api';
import { formatTokens } from './view-blocks';

export interface MapModel {
    slots: MapSlot[] | null;
    /** Built without the analysis module (no injections, PM's last counts). */
    reduced: boolean;
    error: string | null;
    /** The generation type the map is assembled for (triggers depend on it). */
    type: string;
}

export interface MapActions {
    open(identifier: string): void;
    refresh(): Promise<void>;
    setType(type: string): void;
}

/** Generation types the map can be assembled for (triggers and the continue/impersonate tails depend on it). */
export const MAP_TYPES = ['normal', 'continue', 'impersonate', 'quiet'] as const;

const ROLE_ICON: Record<MapSlot['role'], string> = { system: 'fa-gear', user: 'fa-user', assistant: 'fa-robot' };

export function renderMapPanel(app: App, model: MapModel, actions: MapActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-map' });
    const slots = model.slots;
    const enabled = (slots ?? []).filter((slot) => slot.enabled && !slot.dropped);
    const total =
        enabled.reduce((sum, slot) => sum + (slot.tokens || 0), 0) +
        enabled.reduce((sum, slot) => sum + slot.injections.reduce((acc, item) => acc + (item.tokens || 0), 0), 0);
    const type = el('select', {
        class: 'text_pole maestro-m34-map-type',
        attrs: { 'aria-label': t('m34.map.type'), disabled: model.reduced },
        data: { focusKey: 'map-type' },
    });
    for (const trigger of MAP_TYPES) {
        type.append(el('option', { text: t(`m34.trigger.${trigger}`), attrs: { value: trigger } }));
    }
    type.value = model.type;
    type.addEventListener('change', () => actions.setType(type.value));
    root.append(
        el('div', { class: 'maestro-m34-toolbar' }, [
            el('span', { class: 'maestro-m34-count', text: t('m34.map.total', { count: formatTokens(total) }) }),
            el('label', { class: 'maestro-m34-inline' }, [el('span', { text: t('m34.map.type') }), type]),
            el('span', { class: 'maestro-muted', text: t('m34.map.hint') }),
            button({
                icon: 'fa-arrows-rotate',
                title: t('m34.map.refresh'),
                className: 'maestro-m34-map-refresh',
                onClick: () => actions.refresh(),
            }),
        ]),
    );
    if (model.reduced) root.append(banner(t('m34.map.reduced'), 'info', 'fa-circle-info'));
    if (model.error) root.append(banner(t('m34.map.failed', { error: model.error }), 'error'));
    if (!slots) {
        root.append(el('div', { class: 'maestro-empty', text: t('m34.map.loading') }));
        return root;
    }
    if (!slots.length) {
        root.append(el('div', { class: 'maestro-empty', text: t('m34.map.empty') }));
        return root;
    }
    const max = Math.max(1, ...slots.map((slot) => slot.tokens || 0));
    const list = el('ol', { class: 'maestro-m34-slots' });
    slots.forEach((slot, index) => list.append(renderSlot(slot, index)));
    root.append(list);
    return root;

    function renderSlot(slot: MapSlot, index: number): HTMLElement {
        const placement =
            slot.placement === 'depth'
                ? t('m34.map.depth', { depth: slot.depth ?? 0, order: slot.order ?? 100 })
                : t('m34.map.relative');
        const width = Math.round(((slot.tokens || 0) / max) * 100);
        return el(
            'li',
            {
                class: [
                    'maestro-m34-slot',
                    `maestro-m34-slot-${slot.placement}`,
                    slot.enabled ? null : 'maestro-m34-off',
                    slot.dropped ? 'maestro-m34-dropped' : null,
                    slot.marker ? 'maestro-m34-slot-marker' : null,
                ],
                data: { id: slot.identifier },
            },
            [
                el('span', { class: 'maestro-m34-slot-index', text: String(index + 1) }),
                el('span', { class: 'maestro-m34-slot-role', title: t(`m34.role.${slot.role}`) }, [
                    icon(ROLE_ICON[slot.role] ?? 'fa-gear'),
                    el('span', { class: 'maestro-sr-only', text: t(`m34.role.${slot.role}`) }),
                ]),
                el('div', { class: 'maestro-m34-slot-body' }, [
                    el('div', { class: 'maestro-m34-slot-head' }, [
                        el('button', {
                            class: 'maestro-m34-slot-name',
                            text: slot.name || slot.identifier,
                            attrs: { type: 'button' },
                            title: t('m34.map.open'),
                            on: { click: () => actions.open(slot.identifier) },
                        }),
                        el('span', { class: 'maestro-m34-chip', text: placement }),
                        slot.marker ? el('span', { class: 'maestro-m34-chip', text: t('m34.map.marker') }) : null,
                        slot.enabled ? null : el('span', { class: 'maestro-m34-chip', text: t('m34.map.off') }),
                        slot.triggers?.length
                            ? el('span', {
                                  class: 'maestro-m34-chip',
                                  title: t('m34.map.triggersHint'),
                                  text: slot.triggers.map((item) => t(`m34.trigger.${item}`)).join(', '),
                              })
                            : null,
                        el('span', {
                            class: ['maestro-m34-tokens', slot.tokensFrom === 'count' ? 'maestro-m34-estimated' : null],
                            title: slot.tokensFrom === 'count' ? t('m34.map.estimated') : t('m34.map.counted'),
                            text:
                                slot.tokensFrom === 'count'
                                    ? `≈ ${formatTokens(slot.tokens)}`
                                    : formatTokens(slot.tokens),
                        }),
                    ]),
                    el('div', { class: 'maestro-m34-bar', attrs: { 'aria-hidden': 'true' } }, [
                        el('span', { class: 'maestro-m34-bar-fill', attrs: { style: `width: ${width}%` } }),
                    ]),
                    slot.injections.length
                        ? el(
                              'ul',
                              { class: 'maestro-m34-injections', attrs: { 'aria-label': t('m34.map.injections') } },
                              slot.injections.map((item) =>
                                  el('li', {
                                      text: [
                                          t('m34.map.injection', {
                                              owner: item.owner,
                                              key: item.key,
                                              count: formatTokens(item.tokens),
                                          }),
                                          item.where
                                              ? t(`m34.map.where.${item.where}`, { depth: item.depth ?? 0 })
                                              : '',
                                          item.role ? t(`m34.role.${item.role}`) : '',
                                      ]
                                          .filter(Boolean)
                                          .join(' · '),
                                  }),
                              ),
                          )
                        : null,
                    slot.dropped
                        ? el('div', {
                              class: 'maestro-warn-text',
                              text: t('m34.map.dropped', { reason: slot.dropped }),
                          })
                        : null,
                    slot.note
                        ? el('div', { class: 'maestro-field-hint maestro-m34-slot-note', text: slot.note })
                        : null,
                ]),
            ],
        );
    }
}
