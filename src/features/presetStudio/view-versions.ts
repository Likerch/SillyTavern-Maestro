// «Версии» tab of the Preset Studio (M34 п. 4): the versions the store keeps of the current preset (every save, the
// draft of a preset left unsaved, saves made outside Maestro), «what a rollback changes» against the working copy
// (blocks field by field, order, keys; secrets masked, P-096) and the rollback itself (store.restoreVersion).
import { diffCounts, presetDiff } from '../../domain/preset-ui-diff';
import type { PresetDiff } from '../../domain/preset-ui-diff';
import { banner, emptyState } from '../../ui/components/card';
import { formatValue, renderParts, wordDiff } from '../../ui/components/diff';
import { button, el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { PresetBody, PresetVersion } from './store-api';

export interface VersionsModel {
    name: string;
    /** null while loading. */
    versions: PresetVersion[] | null;
    selected: string | null;
    working: PresetBody;
    error: string | null;
}

export interface VersionsActions {
    select(id: string | null): void;
    restore(id: string): Promise<void>;
    refresh(): Promise<void>;
}

/** Block, order and key changes of a diff as a readable list. */
export function renderDiff(app: App, diff: PresetDiff, names: ReadonlyMap<string, string>): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    if (diff.same) return el('div', { class: 'maestro-m34-diff maestro-diff-none', text: t('m34.diff.same') });
    const nameOf = (identifier: string) => names.get(identifier) ?? identifier;
    const root = el('div', { class: 'maestro-m34-diff' });
    if (diff.prompts.length) {
        root.append(el('h5', { text: t('m34.diff.blocks') }));
        for (const change of diff.prompts) {
            const item = el('div', { class: ['maestro-m34-diff-block', `maestro-m34-diff-${change.kind}`] }, [
                el('div', { class: 'maestro-m34-diff-title' }, [
                    el('strong', { text: change.name }),
                    el('span', { class: 'maestro-muted', text: ` — ${t(`m34.diff.${change.kind}`)}` }),
                ]),
            ]);
            for (const field of change.fields) {
                const value =
                    typeof field.before === 'string' && typeof field.after === 'string'
                        ? renderParts(wordDiff(field.before, field.after), t)
                        : el('span', {
                              class: 'maestro-diff-change',
                              text: `${formatValue(field.before)} → ${formatValue(field.after)}`,
                          });
                item.append(
                    el('div', { class: 'maestro-m34-diff-field' }, [
                        el('span', { class: 'maestro-m34-diff-key', text: field.field }),
                        value,
                    ]),
                );
            }
            root.append(item);
        }
    }
    const order = diff.order;
    const orderLines: [string, string[]][] = [
        ['m34.diff.moved', order.moved],
        ['m34.diff.enabled', order.enabled],
        ['m34.diff.disabled', order.disabled],
        ['m34.diff.orderAdded', order.added],
        ['m34.diff.orderRemoved', order.removed],
    ];
    if (orderLines.some(([, list]) => list.length)) {
        root.append(el('h5', { text: t('m34.diff.order') }));
        for (const [key, list] of orderLines) {
            if (!list.length) continue;
            root.append(
                el('div', { class: 'maestro-m34-diff-line', text: t(key, { names: list.map(nameOf).join(', ') }) }),
            );
        }
    }
    if (diff.keys.length) {
        root.append(el('h5', { text: t('m34.diff.keys') }));
        for (const change of diff.keys) {
            root.append(
                el('div', { class: 'maestro-m34-diff-field' }, [
                    el('span', { class: 'maestro-m34-diff-key', text: change.key }),
                    change.sensitive
                        ? el('span', { class: 'maestro-muted', text: t('m34.diff.sensitive') })
                        : typeof change.before === 'string' && typeof change.after === 'string'
                          ? renderParts(wordDiff(change.before, change.after), t)
                          : el('span', {
                                class: 'maestro-diff-change',
                                text: `${formatValue(change.before)} → ${formatValue(change.after)}`,
                            }),
                ]),
            );
        }
    }
    return root;
}

export function renderVersionsPanel(
    app: App,
    model: VersionsModel,
    names: ReadonlyMap<string, string>,
    actions: VersionsActions,
): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-versions' });
    root.append(
        el('div', { class: 'maestro-m34-toolbar' }, [
            el('span', { class: 'maestro-muted', text: t('m34.versions.hint', { name: model.name }) }),
            button({
                icon: 'fa-arrows-rotate',
                title: t('m34.versions.refresh'),
                className: 'maestro-m34-versions-refresh',
                onClick: () => actions.refresh(),
            }),
        ]),
    );
    if (model.error) root.append(banner(t('m34.versions.failed', { error: model.error }), 'error'));
    if (model.versions === null) {
        root.append(el('div', { class: 'maestro-empty', text: t('m34.versions.loading') }));
        return root;
    }
    if (!model.versions.length) {
        root.append(emptyState(t('m34.versions.empty'), 'fa-clock-rotate-left'));
        return root;
    }
    const versions = [...model.versions].sort((a, b) => b.at - a.at);
    const list = el('ul', { class: 'maestro-m34-version-list' });
    for (const version of versions) {
        const on = version.id === model.selected;
        const diff = presetDiff(model.working, version.body);
        const counts = diffCounts(diff);
        list.append(
            el('li', { class: ['maestro-m34-version', on ? 'maestro-on' : null], data: { id: version.id } }, [
                el(
                    'button',
                    {
                        class: 'maestro-m34-version-pick',
                        attrs: { type: 'button', 'aria-expanded': on ? 'true' : 'false' },
                        on: { click: () => actions.select(on ? null : version.id) },
                    },
                    [
                        el('span', { class: 'maestro-m34-version-time', text: formatTime(version.at) }),
                        el('span', { class: 'maestro-m34-chip', text: t(`m34.versions.by.${byKey(version.by)}`) }),
                        el('span', { class: 'maestro-m34-version-summary', text: version.summary }),
                        el('span', {
                            class: 'maestro-muted',
                            text: diff.same ? t('m34.versions.same') : t('m34.versions.counts', counts),
                        }),
                    ],
                ),
                on
                    ? el('div', { class: 'maestro-m34-version-detail' }, [
                          el('div', { class: 'maestro-field-hint', text: t('m34.versions.diffHint') }),
                          renderDiff(app, diff, names),
                          button({
                              icon: 'fa-clock-rotate-left',
                              label: t('m34.versions.restore'),
                              kind: 'primary',
                              className: 'maestro-m34-version-restore',
                              disabled: diff.same,
                              onClick: () => actions.restore(version.id),
                          }),
                      ])
                    : null,
            ]),
        );
    }
    root.append(list);
    return root;
}

const KNOWN_BY = ['user', 'layer', 'import', 'st', 'migration', 'draft'];

function byKey(by: string): string {
    return KNOWN_BY.includes(by) ? by : 'other';
}

function formatTime(at: number): string {
    try {
        return new Date(at).toLocaleString();
    } catch {
        return String(at);
    }
}
