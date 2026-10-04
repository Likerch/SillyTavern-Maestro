// «Слой» tab of the Preset Studio (M34 п. 5–6, layer-api.ts): where edits go, the list of the user's layer
// operations for the current base preset, conflicts after a base update in three versions (old base / new base /
// mine) with «keep mine / take the new base / my own text», «перенести мои правки в слой» (migration from a
// reference base), transfer to another preset by anchors and picking blocks of a foreign preset into the layer.
import { promptName, promptText } from '../../domain/preset-ui-blocks';
import { MASK, isSensitiveKey } from '../../domain/preset-ui-diff';
import { isConnectionKey } from '../../domain/preset-ui-params';
import { banner, emptyState } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { renderParts, wordDiff } from '../../ui/components/diff';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { Layer, LayerApplyReport, LayerConflict, LayerOp } from './layer-api';
import type { PresetPrompt } from './store-api';

export interface ForeignPick {
    file: string;
    prompts: PresetPrompt[];
    picked: Set<string>;
}

export interface LayerModel {
    /** The layer module is running. */
    available: boolean;
    base: string;
    layer: Layer | null;
    /** Studio edits go to the layer now. */
    layerMode: boolean;
    editsToLayer: boolean;
    report: LayerApplyReport | null;
    /** Other presets (references, transfer targets). */
    names: string[];
    promptNames: ReadonlyMap<string, string>;
    foreign: ForeignPick | null;
    result: { kind: 'migrate' | 'transfer'; report: LayerApplyReport } | null;
    /** The layer module can reselect the preset (lay the layer over it again) and prepare for disabling. */
    canReselect: boolean;
    canPrepare: boolean;
}

export interface LayerActions {
    setEditsToLayer(on: boolean): void;
    start(): void;
    removeOp(index: number): Promise<void>;
    resolve(conflict: LayerConflict, choice: 'mine' | 'newBase' | 'custom'): Promise<void>;
    migrate(reference: string): Promise<void>;
    transfer(target: string): Promise<void>;
    importForeign(): Promise<void>;
    pickForeign(identifier: string, on: boolean): void;
    addForeign(): Promise<void>;
    clearForeign(): void;
    open(identifier: string): void;
    reselect(): Promise<void>;
    prepareDisable(mode: 'reselectBase' | 'saveMerged'): Promise<void>;
}

/** One layer operation as a line («Своя правка блока „Main Prompt“: content»). */
export function describeOp(app: App, op: LayerOp, names: ReadonlyMap<string, string>): string {
    const t = app.i18n.t.bind(app.i18n);
    const nameOf = (identifier: string) => names.get(identifier) ?? identifier;
    const anchor = (value: Extract<LayerOp, { op: 'add' }>['anchor']): string => {
        switch (value.kind) {
            case 'after':
                return t('m34.layer.anchor.after', { name: nameOf(value.identifier) });
            case 'before':
                return t('m34.layer.anchor.before', { name: nameOf(value.identifier) });
            case 'afterText':
                return t('m34.layer.anchor.afterText', { text: value.text });
            case 'start':
                return t('m34.layer.anchor.start');
            default:
                return t('m34.layer.anchor.end');
        }
    };
    switch (op.op) {
        case 'add':
            return t('m34.layer.op.add', { name: promptName(op.prompt), anchor: anchor(op.anchor) });
        case 'edit':
            return t('m34.layer.op.edit', { name: nameOf(op.identifier), fields: Object.keys(op.patch).join(', ') });
        case 'toggle':
            return t(op.enabled ? 'm34.layer.op.on' : 'm34.layer.op.off', { name: nameOf(op.identifier) });
        case 'move':
            return t('m34.layer.op.move', { name: nameOf(op.identifier), anchor: anchor(op.anchor) });
        default:
            return t('m34.layer.op.key', {
                key: op.key,
                value: isSensitiveKey(op.key) ? MASK : (JSON.stringify(op.value) ?? ''),
            });
    }
}

/**
 * The preview of a migration (layer.planMigration): block operations as a list, body keys apart with a checkbox each
 * — connection keys (source, model, addresses, P-094) unticked, so a reference file does not pin the model in the
 * layer by accident. `excluded()` gives the keys the user left out.
 */
export function renderMigrationPreview(
    app: App,
    plan: { ops: LayerOp[]; report: LayerApplyReport },
    names: ReadonlyMap<string, string>,
): { content: HTMLElement; excluded(): Set<string> } {
    const t = app.i18n.t.bind(app.i18n);
    const blocks = plan.ops.filter((op) => op.op !== 'key');
    const keys = plan.ops.filter((op): op is Extract<LayerOp, { op: 'key' }> => op.op === 'key');
    const boxes: { key: string; box: HTMLInputElement }[] = [];
    const content = el('div', { class: 'maestro-m34-migration' }, [
        el('p', {
            text: t('m34.layer.migratePreview', {
                ops: plan.ops.length,
                conflicts: plan.report.conflicts.length,
                orphaned: plan.report.orphaned.length,
            }),
        }),
        el('h5', { text: t('m34.layer.previewBlocks', { count: blocks.length }) }),
        blocks.length
            ? el(
                  'ul',
                  { class: 'maestro-m34-migration-ops' },
                  blocks.map((op) => el('li', { text: describeOp(app, op, names) })),
              )
            : el('div', { class: 'maestro-muted', text: t('m34.layer.previewNone') }),
        el('h5', { text: t('m34.layer.previewKeys', { count: keys.length }) }),
        keys.length
            ? el('div', { class: 'maestro-field-hint', text: t('m34.layer.previewKeysHint') })
            : el('div', { class: 'maestro-muted', text: t('m34.layer.previewNone') }),
        el(
            'ul',
            { class: 'maestro-m34-migration-keys' },
            keys.map((op) => {
                const connection = isConnectionKey(op.key);
                const box = el('input', {
                    attrs: { type: 'checkbox' },
                    class: 'maestro-m34-migration-key',
                    data: { key: op.key },
                });
                box.checked = !connection;
                boxes.push({ key: op.key, box });
                return el('li', {}, [
                    el('label', { class: 'checkbox_label' }, [
                        box,
                        el('code', { text: op.key }),
                        el('span', { text: ` = ${isSensitiveKey(op.key) ? MASK : (JSON.stringify(op.value) ?? '')}` }),
                        connection
                            ? el('span', {
                                  class: 'maestro-m34-badge maestro-m34-badge-warn',
                                  text: t('m34.layer.connectionKey'),
                              })
                            : null,
                    ]),
                ]);
            }),
        ),
    ]);
    return {
        content,
        excluded: () => new Set(boxes.filter(({ box }) => !box.checked).map(({ key }) => key)),
    };
}

export function renderLayerPanel(app: App, model: LayerModel, actions: LayerActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-layer' });
    if (!model.available) {
        root.append(banner(t('m34.layer.unavailable'), 'info', 'fa-circle-info'));
        return root;
    }

    /* ------------------------------------------------------------ where edits go */
    root.append(
        el('section', { class: 'maestro-m34-layer-mode' }, [
            el('div', {
                class: 'maestro-m34-count',
                text: model.layerMode
                    ? t('m34.layer.modeLayer', { base: model.base })
                    : t('m34.layer.modeStore', { base: model.base }),
            }),
            toggle({
                label: t('m34.layer.editsToLayer'),
                checked: model.editsToLayer,
                onChange: (on) => actions.setEditsToLayer(on),
            }),
            el('div', { class: 'maestro-field-hint', text: t('m34.layer.editsToLayerHint') }),
            !model.layer && model.editsToLayer && !model.layerMode
                ? el('div', { class: 'maestro-row' }, [
                      button({
                          icon: 'fa-layer-group',
                          label: t('m34.layer.start'),
                          kind: 'primary',
                          className: 'maestro-m34-layer-start',
                          onClick: () => actions.start(),
                      }),
                      el('span', { class: 'maestro-field-hint', text: t('m34.layer.startHint') }),
                  ])
                : null,
        ]),
    );

    /* ------------------------------------------------------------ conflicts */
    const conflicts = model.report?.conflicts ?? [];
    if (conflicts.length) {
        const section = el('section', { class: 'maestro-m34-conflicts' }, [
            el('h4', { class: 'maestro-m34-h', text: t('m34.layer.conflicts', { count: conflicts.length }) }),
            el('div', { class: 'maestro-field-hint', text: t('m34.layer.conflictsHint') }),
        ]);
        for (const conflict of conflicts) section.append(renderConflict(conflict));
        root.append(section);
    }

    /* ------------------------------------------------------------ operations */
    const ops = model.layer?.ops ?? [];
    const opsSection = el('section', { class: 'maestro-m34-ops' }, [
        el('h4', { class: 'maestro-m34-h', text: t('m34.layer.ops', { count: ops.length, base: model.base }) }),
    ]);
    if (!ops.length) opsSection.append(emptyState(t('m34.layer.noOps'), 'fa-layer-group'));
    else {
        const list = el('ol', { class: 'maestro-m34-op-list' });
        ops.forEach((op, index) => {
            const identifier = op.op === 'add' ? op.prompt.identifier : op.op === 'key' ? null : op.identifier;
            list.append(
                el('li', { class: 'maestro-m34-op', data: { index } }, [
                    el('span', { class: 'maestro-m34-op-text', text: describeOp(app, op, model.promptNames) }),
                    identifier
                        ? button({
                              icon: 'fa-pen',
                              kind: 'ghost',
                              title: t('m34.layer.openBlock'),
                              onClick: () => actions.open(identifier),
                          })
                        : null,
                    button({
                        icon: 'fa-trash-can',
                        kind: 'ghost',
                        title: t('m34.layer.removeOp'),
                        className: 'maestro-m34-op-remove',
                        onClick: () => actions.removeOp(index),
                    }),
                ]),
            );
        });
        opsSection.append(list);
    }
    const orphaned = model.report?.orphaned ?? [];
    if (orphaned.length) {
        opsSection.append(
            el('div', { class: 'maestro-warn-text', text: t('m34.layer.orphaned', { count: orphaned.length }) }),
            el(
                'ul',
                { class: 'maestro-m34-orphaned' },
                orphaned.map((op) => el('li', { text: describeOp(app, op, model.promptNames) })),
            ),
        );
    }
    root.append(opsSection);

    /* ------------------------------------------------------------ working copy, preparing to disable */
    if (model.canReselect || model.canPrepare) {
        root.append(
            el('section', { class: 'maestro-m34-layer-working' }, [
                el('h4', { class: 'maestro-m34-h', text: t('m34.layer.workingTitle') }),
                model.canReselect && ops.length
                    ? el('div', { class: 'maestro-row' }, [
                          button({
                              icon: 'fa-rotate',
                              label: t('m34.layer.reselect'),
                              className: 'maestro-m34-reselect',
                              onClick: () => actions.reselect(),
                          }),
                          el('span', { class: 'maestro-field-hint', text: t('m34.layer.reselectHint') }),
                      ])
                    : null,
                model.canPrepare && ops.length
                    ? el('div', { class: 'maestro-m34-prepare' }, [
                          el('h5', { text: t('m34.layer.prepareTitle') }),
                          el('div', { class: 'maestro-field-hint', text: t('m34.layer.prepareHint') }),
                          el('div', { class: 'maestro-row' }, [
                              button({
                                  icon: 'fa-power-off',
                                  label: t('m34.layer.prepareBase'),
                                  className: 'maestro-m34-prepare-base',
                                  onClick: () => actions.prepareDisable('reselectBase'),
                              }),
                              button({
                                  icon: 'fa-file-circle-plus',
                                  label: t('m34.layer.prepareMerged'),
                                  className: 'maestro-m34-prepare-merged',
                                  onClick: () => actions.prepareDisable('saveMerged'),
                              }),
                          ]),
                      ])
                    : null,
            ]),
        );
    }

    /* ------------------------------------------------------------ migrate, transfer */
    const others = model.names.filter((name) => name !== model.base);
    const reference = presetSelect(others, t('m34.layer.reference'), 'maestro-m34-reference');
    const target = presetSelect(others, t('m34.layer.target'), 'maestro-m34-target');
    root.append(
        el('section', { class: 'maestro-m34-layer-tools' }, [
            el('h4', { class: 'maestro-m34-h', text: t('m34.layer.migrateTitle') }),
            el('div', { class: 'maestro-field-hint', text: t('m34.layer.migrateHint', { base: model.base }) }),
            el('div', { class: 'maestro-row' }, [
                reference,
                button({
                    icon: 'fa-right-to-bracket',
                    label: t('m34.layer.migrate'),
                    className: 'maestro-m34-migrate',
                    disabled: !others.length,
                    onClick: async () => {
                        if (reference.value) await actions.migrate(reference.value);
                    },
                }),
            ]),
            el('h4', { class: 'maestro-m34-h', text: t('m34.layer.transferTitle') }),
            el('div', { class: 'maestro-field-hint', text: t('m34.layer.transferHint') }),
            el('div', { class: 'maestro-row' }, [
                target,
                button({
                    icon: 'fa-share-from-square',
                    label: t('m34.layer.transfer'),
                    className: 'maestro-m34-transfer',
                    disabled: !others.length || !ops.length,
                    onClick: async () => {
                        if (target.value) await actions.transfer(target.value);
                    },
                }),
            ]),
            model.result ? renderReport(model.result.kind, model.result.report) : null,
        ]),
    );

    /* ------------------------------------------------------------ foreign preset */
    const foreign = model.foreign;
    const foreignSection = el('section', { class: 'maestro-m34-foreign' }, [
        el('h4', { class: 'maestro-m34-h', text: t('m34.layer.foreignTitle') }),
        el('div', { class: 'maestro-field-hint', text: t('m34.layer.foreignHint') }),
        el('div', { class: 'maestro-row' }, [
            button({
                icon: 'fa-file-import',
                label: t('m34.layer.foreignPick'),
                className: 'maestro-m34-foreign-import',
                onClick: () => actions.importForeign(),
            }),
        ]),
    ]);
    if (foreign) {
        foreignSection.append(
            el('div', {
                class: 'maestro-m34-count',
                text: t('m34.layer.foreignFile', { file: foreign.file, count: foreign.prompts.length }),
            }),
        );
        const list = el('ul', { class: 'maestro-m34-foreign-list' });
        for (const prompt of foreign.prompts) {
            const box = el('input', {
                attrs: { type: 'checkbox' },
                class: 'maestro-m34-foreign-box',
                data: { focusKey: `foreign:${prompt.identifier}` },
            });
            box.checked = foreign.picked.has(prompt.identifier);
            box.addEventListener('change', () => actions.pickForeign(prompt.identifier, box.checked));
            const text = promptText(prompt);
            list.append(
                el('li', { class: 'maestro-m34-foreign-item', data: { id: prompt.identifier } }, [
                    el('label', { class: 'checkbox_label' }, [box, el('strong', { text: promptName(prompt) })]),
                    el('div', {
                        class: 'maestro-muted maestro-m34-foreign-text',
                        text: text.length > 280 ? `${text.slice(0, 280)}…` : text,
                    }),
                ]),
            );
        }
        foreignSection.append(
            list,
            el('div', { class: 'maestro-row' }, [
                button({
                    icon: 'fa-plus',
                    label: t('m34.layer.foreignAdd', { count: foreign.picked.size }),
                    kind: 'primary',
                    className: 'maestro-m34-foreign-add',
                    disabled: !foreign.picked.size,
                    onClick: () => actions.addForeign(),
                }),
                button({ label: t('m34.layer.foreignClear'), kind: 'ghost', onClick: () => actions.clearForeign() }),
            ]),
        );
    }
    root.append(foreignSection);
    return root;

    function presetSelect(names: string[], label: string, className: string): HTMLSelectElement {
        const node = el('select', { class: ['text_pole', className], attrs: { 'aria-label': label } });
        for (const name of names) node.append(el('option', { text: name, attrs: { value: name } }));
        node.disabled = !names.length;
        return node;
    }

    function renderReport(kind: 'migrate' | 'transfer', report: LayerApplyReport): HTMLElement {
        const removed = report.removed ?? [];
        return el('div', { class: 'maestro-m34-report' }, [
            icon(report.conflicts.length || report.orphaned.length ? 'fa-triangle-exclamation' : 'fa-circle-check'),
            el('span', {
                text: t(`m34.layer.report.${kind}`, {
                    applied: report.applied,
                    conflicts: report.conflicts.length,
                    orphaned: report.orphaned.length,
                }),
            }),
            removed.length
                ? el('span', {
                      class: 'maestro-muted',
                      text: t('m34.layer.report.removed', {
                          names: removed
                              .map((identifier) => model.promptNames.get(identifier) ?? identifier)
                              .join(', '),
                      }),
                  })
                : null,
        ]);
    }

    function renderConflict(conflict: LayerConflict): HTMLElement {
        const name = model.promptNames.get(conflict.identifier) ?? conflict.identifier;
        const column = (title: string, content: HTMLElement) =>
            el('div', { class: 'maestro-m34-conflict-col' }, [
                el('div', { class: 'maestro-m34-label', text: title }),
                content,
            ]);
        return el('div', { class: 'maestro-m34-conflict', data: { id: conflict.identifier } }, [
            el('div', { class: 'maestro-m34-conflict-head' }, [
                el('strong', { text: name }),
                button({
                    icon: 'fa-pen',
                    kind: 'ghost',
                    title: t('m34.layer.openBlock'),
                    onClick: () => actions.open(conflict.identifier),
                }),
            ]),
            el('div', { class: 'maestro-m34-conflict-cols' }, [
                column(t('m34.layer.oldBase'), el('div', { class: 'maestro-m34-text', text: conflict.oldBase })),
                column(
                    t('m34.layer.newBase'),
                    el('div', { class: 'maestro-m34-text' }, [
                        renderParts(wordDiff(conflict.oldBase, conflict.newBase), t),
                    ]),
                ),
                column(
                    t('m34.layer.mine'),
                    el('div', { class: 'maestro-m34-text' }, [
                        renderParts(wordDiff(conflict.oldBase, conflict.mine), t),
                    ]),
                ),
            ]),
            el('div', { class: 'maestro-row' }, [
                button({
                    label: t('m34.layer.keepMine'),
                    kind: 'primary',
                    className: 'maestro-m34-keep-mine',
                    onClick: () => actions.resolve(conflict, 'mine'),
                }),
                button({
                    label: t('m34.layer.takeNew'),
                    className: 'maestro-m34-take-new',
                    onClick: () => actions.resolve(conflict, 'newBase'),
                }),
                button({
                    label: t('m34.layer.custom'),
                    className: 'maestro-m34-custom',
                    onClick: () => actions.resolve(conflict, 'custom'),
                }),
            ]),
        ]);
    }
}
