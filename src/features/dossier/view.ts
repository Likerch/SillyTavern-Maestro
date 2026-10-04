// Pult tab «Досье» (M7): entity picker (search; persona first, then characters on scene, then the rest), the dossier
// page with collapsible sections and «Открыть», structural findings with fix buttons, «Сверить с ИИ» with a size and
// cost estimate, and the «Разнести» editor (field, value, target checkboxes). Mobile-first: one column, wrapping rows.
import type { App, Decision, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { select } from '../../ui/components/controls';
import { append, button, clear, el, icon } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { formatTime, formatUsd, tOr } from '../../ui/views/format';
import type { Entity, EntitySource } from '../world/api';
import { ProtectedBookError } from './actions';
import type { Dossier, DossierFinding, DossierSection, SpreadEdit } from './api';
import { CompareError } from './compare';
import type { DossierOpener } from './opener';
import { DOSSIER_TAB } from './service';
import type { DossierService, LoadedDossier } from './service';

const PICKER_LIMIT = 60;
const TEXT_PREVIEW = 1200;
const OPEN_SECTIONS = 3;

export const DOSSIER_CSS = `
.maestro-m7 { display: flex; flex-direction: column; gap: var(--maestro-gap); }
.maestro-m7-search { width: 100%; box-sizing: border-box; }
.maestro-m7-picker { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.maestro-m7-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.maestro-m7-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.maestro-m7-chip.maestro-m7-present { border-color: var(--maestro-accent); }
.maestro-m7-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m7-name { font-weight: 600; font-size: 1.1em; overflow-wrap: anywhere; }
.maestro-m7-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m7-findings { display: flex; flex-direction: column; gap: 6px; }
.maestro-m7-finding { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.maestro-m7-finding-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.maestro-m7-finding-text { overflow-wrap: anywhere; white-space: pre-wrap; }
.maestro-m7-sources { display: flex; flex-wrap: wrap; gap: 4px; font-size: 0.85em; }
.maestro-m7-sections { display: flex; flex-direction: column; gap: 6px; }
.maestro-m7-section { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 4px 8px; }
.maestro-m7-section > summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 32px; }
.maestro-m7-section-title { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m7-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px 10px; margin: 6px 0; }
.maestro-m7-field { display: flex; flex-direction: column; }
.maestro-m7-field dt { color: var(--maestro-muted); font-size: 0.85em; }
.maestro-m7-field dd { margin: 0; overflow-wrap: anywhere; }
@media (min-width: 700px) {
  .maestro-m7-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
.maestro-m7-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; font-size: 0.95em; }
.maestro-m7-spread { display: flex; flex-direction: column; gap: 6px; }
.maestro-m7-spread-value { width: 100%; box-sizing: border-box; min-height: 2.5em; }
.maestro-m7-targets { display: flex; flex-direction: column; gap: 2px; }
`;

type Field = SpreadEdit['field'];
const FIELDS: readonly Field[] = ['alias', 'name', 'appearance', 'description', 'relationship', 'custom'];

const TARGET_KINDS: Record<Field, readonly string[]> = {
    alias: ['lore.entry', 'canon.entry', 'nai.passport', 'place', 'des.character', 'chat.alias'],
    name: ['lore.entry', 'canon.entry', 'nai.passport', 'place', 'des.character'],
    appearance: ['lore.entry', 'canon.entry', 'nai.passport'],
    description: ['lore.entry', 'canon.entry'],
    relationship: ['lore.entry', 'canon.entry', 'des.character'],
    custom: ['lore.entry', 'canon.entry'],
};

/** Targets of «Разнести» for a field: the dossier's sources that can take it (plus the chat alias map). */
export function spreadTargets(
    dossier: Dossier,
    field: Field,
    options: { naiWrites: boolean; worldOn: boolean; chatAliasLabel: string },
): EntitySource[] {
    const allowed = TARGET_KINDS[field];
    const out: EntitySource[] = [];
    const seen = new Set<string>();
    for (const item of dossier.sections) {
        const source = item.source;
        if (!source || !allowed.includes(source.kind)) continue;
        if (source.kind === 'nai.passport' && (!options.naiWrites || !source.avatar)) continue;
        if (item.fields?.protected) continue;
        const id = `${source.kind}:${source.ref}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(source);
    }
    if (field === 'alias' && options.worldOn && dossier.kind !== 'place') {
        out.push({ kind: 'chat.alias', ref: dossier.entityId, label: options.chatAliasLabel });
    }
    return out;
}

const KIND_ICONS: Record<string, string> = {
    persona: 'fa-user',
    character: 'fa-user-group',
    place: 'fa-location-dot',
};

export function dossierTab(app: App, service: DossierService, opener: DossierOpener): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const fieldLabel = (key: string): string => {
        if (key.startsWith('base.')) return t('m7.field.base', { field: fieldLabel(key.slice('base.'.length)) });
        const dot = key.indexOf('.');
        const head = dot > 0 ? key.slice(0, dot) : key;
        const rest = dot > 0 ? key.slice(dot + 1) : '';
        if (['stat', 'tag', 'state', 'rag'].includes(head) && rest) return rest;
        if (head === 'detail' && rest) return rest.replace(/_/g, ' ');
        if (head === 'slot' && rest) return tOr(app.i18n, `m7.field.slot.${rest}`, rest);
        return tOr(app.i18n, `m7.field.${key}`, key);
    };
    const notifyError = (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        app.ui.notice(text, { level: error instanceof ProtectedBookError ? 'warn' : 'error' });
    };

    return {
        id: DOSSIER_TAB,
        titleKey: 'm7.tab',
        icon: 'fa-address-card',
        order: 44,
        render(container) {
            let alive = true;
            let query = '';
            let loaded: LoadedDossier | null = null;
            let loadingId: string | null = null;
            let error = '';
            let spreadField: Field = 'alias';
            const root = el('div', { class: 'maestro-view maestro-m7' });
            container.appendChild(root);

            /* ------------------------------------------------------------ picker */

            const chip = (entity: Entity): HTMLElement =>
                button({
                    label: entity.name,
                    icon: KIND_ICONS[entity.kind] ?? 'fa-circle',
                    title: [tOr(app.i18n, `m7.entity.${entity.kind}`, entity.kind), ...entity.aliases].join(' · '),
                    className: ['maestro-m7-chip', entity.present ? 'maestro-m7-present' : '']
                        .filter(Boolean)
                        .join(' '),
                    onClick: () => service.select(entity.id),
                });

            const pickerList = el('div', { class: 'maestro-m7-picker' });
            const fillPicker = () => {
                clear(pickerList);
                const { entities } = service.entities(query);
                if (!entities.length) {
                    pickerList.appendChild(
                        emptyState(t(query ? 'm7.picker.noMatch' : 'm7.picker.empty'), 'fa-user-slash'),
                    );
                    return;
                }
                for (const entity of entities.slice(0, PICKER_LIMIT)) pickerList.appendChild(chip(entity));
                if (entities.length > PICKER_LIMIT) {
                    pickerList.appendChild(
                        el('div', {
                            class: 'maestro-muted',
                            text: t('m7.picker.more', { shown: PICKER_LIMIT, total: entities.length }),
                        }),
                    );
                }
            };

            const pickerView = (): HTMLElement => {
                const { worldOn } = service.entities();
                const search = el('input', {
                    class: 'text_pole maestro-m7-search',
                    attrs: { type: 'search', placeholder: t('m7.picker.search'), 'aria-label': t('m7.picker.search') },
                });
                search.value = query;
                search.addEventListener('input', () => {
                    query = search.value;
                    fillPicker();
                });
                fillPicker();
                return section(t('m7.title'), [
                    worldOn ? null : banner(t('m7.worldOff'), 'info', 'fa-circle-info'),
                    el('div', { class: 'maestro-hint', text: t('m7.picker.hint') }),
                    search,
                    pickerList,
                ]);
            };

            /* ------------------------------------------------------------ findings */

            const decisionText = (decision: Decision): string => t(`m7.decision.${decision}`);

            const sourceChip = (source: EntitySource): HTMLElement =>
                el('span', {
                    class: 'maestro-badge-pill maestro-level-muted',
                    text: `${t(`m7.source.${source.kind}`)}: ${source.label}`,
                });

            const findingView = (finding: DossierFinding): HTMLElement => {
                const fix = finding.fix;
                return el('div', { class: 'maestro-m7-finding', data: { kind: finding.kind } }, [
                    el('div', { class: 'maestro-m7-finding-head' }, [
                        badge(t(`m7.findingKind.${finding.kind}`), finding.severity === 'warn' ? 'warn' : 'info'),
                    ]),
                    el('div', { class: 'maestro-m7-finding-text', text: finding.text }),
                    finding.sources.length
                        ? el('div', { class: 'maestro-m7-sources' }, finding.sources.map(sourceChip))
                        : null,
                    fix
                        ? el('div', { class: 'maestro-m7-actions' }, [
                              button({
                                  label: fix.label,
                                  icon: 'fa-wrench',
                                  onClick: async () => {
                                      try {
                                          const decision = await service.actions.fix(finding);
                                          app.ui.notice(decisionText(decision));
                                      } catch (problem) {
                                          notifyError(problem);
                                      }
                                      if (alive) void reload();
                                  },
                              }),
                          ])
                        : null,
                ]);
            };

            /* ------------------------------------------------------------ sections */

            const textView = (text: string): HTMLElement | null => {
                if (!text) return null;
                const node = el('div', { class: 'maestro-m7-text' });
                if (text.length <= TEXT_PREVIEW) {
                    node.textContent = text;
                    return node;
                }
                let full = false;
                const body = el('span', { text: `${text.slice(0, TEXT_PREVIEW)}…` });
                const toggle = button({
                    label: t('m7.text.more'),
                    kind: 'ghost',
                    onClick: () => {
                        full = !full;
                        body.textContent = full ? text : `${text.slice(0, TEXT_PREVIEW)}…`;
                        const label = toggle.querySelector('span');
                        if (label) label.textContent = t(full ? 'm7.text.less' : 'm7.text.more');
                    },
                });
                node.append(body, el('div', {}, [toggle]));
                return node;
            };

            const sectionView = (item: DossierSection, index: number): HTMLElement => {
                const details = el('details', { class: 'maestro-m7-section', data: { kind: item.kind } });
                if (index < OPEN_SECTIONS) details.open = true;
                const fields = Object.entries(item.fields ?? {});
                append(details, [
                    el('summary', {}, [
                        badge(t(`m7.kind.${item.kind}`), 'muted'),
                        el('span', { class: 'maestro-m7-section-title', text: item.title }),
                    ]),
                    fields.length
                        ? el(
                              'dl',
                              { class: 'maestro-m7-fields' },
                              fields.map(([key, value]) =>
                                  el('div', { class: 'maestro-m7-field' }, [
                                      el('dt', { text: fieldLabel(key) }),
                                      el('dd', { text: value }),
                                  ]),
                              ),
                          )
                        : null,
                    textView(item.text),
                    opener.canOpen(item)
                        ? el('div', { class: 'maestro-m7-actions' }, [
                              button({
                                  label: t('m7.open'),
                                  icon: 'fa-arrow-up-right-from-square',
                                  kind: 'ghost',
                                  onClick: () => opener.open(item),
                              }),
                          ])
                        : null,
                ]);
                return details;
            };

            /* ------------------------------------------------------------ AI comparison */

            const compareView = (data: LoadedDossier): HTMLElement => {
                const { estimate, snippets } = service.compare.plan(data.facts);
                const blocker = service.compare.blocker();
                const last = service.compare.lastCached(data.dossier.entityId);
                const summary = app.cost.summary();
                const lines: Child[] = [
                    el('div', {
                        class: 'maestro-muted',
                        text:
                            snippets.length >= 2
                                ? t('m7.compare.estimate', {
                                      stores: snippets.length,
                                      tokens: estimate.input + estimate.output,
                                      usd: formatUsd(estimate.usd, app.i18n),
                                  })
                                : t('m7.compare.tooFew'),
                    }),
                    blocker ? el('div', { class: 'maestro-warn-text', text: t(`m7.compare.${blocker}`) }) : null,
                    last
                        ? el('div', {
                              class: 'maestro-muted',
                              text: t(last.costUsd !== undefined ? 'm7.compare.lastCost' : 'm7.compare.last', {
                                  time: formatTime(last.at, app.i18n),
                                  count: last.findings.length,
                                  usd: formatUsd(last.costUsd ?? 0, app.i18n),
                              }),
                          })
                        : null,
                    el('div', {
                        class: 'maestro-muted',
                        text: t('m7.compare.today', { usd: formatUsd(summary.backgroundTodayUsd, app.i18n) }),
                    }),
                ];
                return el('div', { class: 'maestro-m7-compare' }, [
                    el('div', { class: 'maestro-m7-actions' }, [
                        button({
                            label: t('m7.compare.action'),
                            icon: 'fa-wand-magic-sparkles',
                            disabled: !!blocker || snippets.length < 2,
                            title: t('m7.compare.hint'),
                            onClick: async () => {
                                try {
                                    const findings = await service.compareWithAi(data.dossier.entityId);
                                    app.ui.notice(
                                        findings.length
                                            ? t('m7.compare.found', { count: findings.length })
                                            : t('m7.compare.none'),
                                    );
                                } catch (problem) {
                                    notifyError(problem instanceof CompareError ? new Error(problem.message) : problem);
                                }
                                if (alive) void reload();
                            },
                        }),
                    ]),
                    ...lines,
                ]);
            };

            /* ------------------------------------------------------------ «Разнести» */

            const spreadView = (data: LoadedDossier): HTMLElement => {
                const naiWrites = !!service.sources.naiApi();
                const box = el('div', { class: 'maestro-m7-spread' });
                const targetsBox = el('div', { class: 'maestro-m7-targets' });
                const value = el('textarea', {
                    class: 'text_pole maestro-m7-spread-value',
                    attrs: { rows: 2, placeholder: t('m7.spread.value'), 'aria-label': t('m7.spread.value') },
                });
                let checked = new Map<string, { source: EntitySource; input: HTMLInputElement }>();
                const fillTargets = () => {
                    clear(targetsBox);
                    checked = new Map();
                    const targets = spreadTargets(data.dossier, spreadField, {
                        naiWrites,
                        worldOn: data.facts.worldOn,
                        chatAliasLabel: t('m7.spread.chatAlias'),
                    });
                    if (!targets.length) {
                        targetsBox.appendChild(el('div', { class: 'maestro-muted', text: t('m7.spread.noTargets') }));
                        return;
                    }
                    for (const source of targets) {
                        const input = el('input', { attrs: { type: 'checkbox' } });
                        input.checked = true;
                        checked.set(`${source.kind}:${source.ref}`, { source, input });
                        targetsBox.appendChild(
                            el('label', { class: 'checkbox_label' }, [
                                input,
                                el('span', { text: `${t(`m7.source.${source.kind}`)}: ${source.label}` }),
                            ]),
                        );
                    }
                };
                fillTargets();
                box.append(
                    el('div', { class: 'maestro-hint', text: t('m7.spread.hint') }),
                    select<Field>({
                        value: spreadField,
                        label: t('m7.spread.field'),
                        options: FIELDS.map((field) => ({ value: field, label: t(`m7.spread.field.${field}`) })),
                        onChange: (field) => {
                            spreadField = field;
                            fillTargets();
                        },
                    }),
                    value,
                    targetsBox,
                    el('div', { class: 'maestro-m7-actions' }, [
                        button({
                            label: t('m7.spread.action'),
                            icon: 'fa-share-nodes',
                            kind: 'primary',
                            onClick: async () => {
                                const text = value.value.trim();
                                const targets = [...checked.values()]
                                    .filter((item) => item.input.checked)
                                    .map((item) => item.source);
                                if (!text || !targets.length) {
                                    app.ui.notice(t('m7.spread.empty'), { level: 'warn' });
                                    return;
                                }
                                try {
                                    const count = await service.spread({
                                        entityId: data.dossier.entityId,
                                        field: spreadField,
                                        value: text,
                                        targets,
                                    });
                                    app.ui.notice(count ? t('m7.spread.done', { count }) : t('m7.spread.nothing'));
                                    if (count) value.value = '';
                                } catch (problem) {
                                    notifyError(problem);
                                }
                            },
                        }),
                    ]),
                );
                return box;
            };

            /* ------------------------------------------------------------ page */

            const dossierView = (data: LoadedDossier): HTMLElement[] => {
                const { dossier, facts } = data;
                const entity = facts.entity;
                const structural = dossier.findings.filter(
                    (finding) => finding.kind !== 'appearanceMismatch' && finding.kind !== 'descriptionMismatch',
                );
                const ai = dossier.findings.filter((finding) => !structural.includes(finding));
                const head = section(
                    t('m7.title'),
                    [
                        el('div', { class: 'maestro-m7-head' }, [
                            icon(KIND_ICONS[entity.kind] ?? 'fa-circle'),
                            el('span', { class: 'maestro-m7-name', text: dossier.name }),
                            badge(tOr(app.i18n, `m7.entity.${entity.kind}`, entity.kind), 'muted'),
                            entity.present ? badge(t('m7.present'), 'ok') : null,
                        ]),
                        entity.aliases.length
                            ? el('div', {
                                  class: 'maestro-muted',
                                  text: t('m7.aliases', { list: entity.aliases.join(', ') }),
                              })
                            : null,
                        facts.worldOn ? null : banner(t('m7.worldOff'), 'info', 'fa-circle-info'),
                        el('div', {
                            class: 'maestro-muted',
                            text: t('m7.builtAt', { time: formatTime(dossier.builtAt, app.i18n) }),
                        }),
                    ],
                    [
                        button({
                            label: t('m7.back'),
                            icon: 'fa-arrow-left',
                            kind: 'ghost',
                            onClick: () => service.select(null),
                        }),
                        button({ label: t('m7.refresh'), icon: 'fa-rotate', onClick: () => reload() }),
                    ],
                );
                const findingsBlock = section(t('m7.findings.title', { count: dossier.findings.length }), [
                    structural.length
                        ? el('div', { class: 'maestro-m7-findings' }, structural.map(findingView))
                        : emptyState(t('m7.findings.none')),
                    ai.length ? el('div', { class: 'maestro-m7-findings' }, ai.map(findingView)) : null,
                    compareView(data),
                ]);
                const sectionsBlock = section(
                    t('m7.sections.title', { count: dossier.sections.length }),
                    dossier.sections.length
                        ? el('div', { class: 'maestro-m7-sections' }, dossier.sections.map(sectionView))
                        : emptyState(t('m7.sections.none'), 'fa-folder-open'),
                );
                const spreadBlock = section(t('m7.spread.title'), spreadView(data));
                return [head, findingsBlock, sectionsBlock, spreadBlock];
            };

            const draw = () => {
                if (!alive) return;
                clear(root);
                const current = service.currentId();
                if (!current) {
                    root.appendChild(pickerView());
                    return;
                }
                if (error) {
                    root.append(
                        banner(error, 'error'),
                        button({ label: t('m7.back'), icon: 'fa-arrow-left', onClick: () => service.select(null) }),
                    );
                    return;
                }
                if (!loaded || loaded.dossier.entityId !== current) {
                    root.appendChild(el('div', { class: 'maestro-muted', text: t('m7.loading') }));
                    return;
                }
                root.append(...dossierView(loaded));
            };

            const reload = async (): Promise<void> => {
                const current = service.currentId();
                if (!current) {
                    loaded = null;
                    error = '';
                    draw();
                    return;
                }
                loadingId = current;
                error = '';
                draw();
                try {
                    const result = await service.load(current);
                    if (!alive || loadingId !== current) return;
                    loaded = result;
                } catch (problem) {
                    if (!alive || loadingId !== current) return;
                    loaded = null;
                    error = problem instanceof Error ? problem.message : String(problem);
                }
                loadingId = null;
                draw();
            };

            const offChange = service.onChange((entityId) => {
                if (!alive) return;
                if (entityId === null || entityId !== service.currentId()) {
                    void reload();
                    return;
                }
                if (loadingId === entityId) return;
                void reload();
            });
            const world = service.sources.world();
            const offWorld = world?.onChange(() => {
                if (alive && !service.currentId()) fillPicker();
            });
            void reload();
            return () => {
                alive = false;
                offChange();
                offWorld?.();
            };
        },
    };
}
