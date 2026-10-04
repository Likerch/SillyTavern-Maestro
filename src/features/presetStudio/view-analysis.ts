// «Анализ» tab of the Preset Studio (M34 п. 3, п. 9): findings of the analysis module (blocks that are never sent,
// strict-type traps, contradictions, repeats with lore and injections, heavy blocks, unsaved toggles, the macro
// engine, model quirks) and provider hints for the current connection, plus the studio's own findings about
// conditional blocks (`extra`, M34 п.8). Read-only; a finding opens its block.
import { banner, emptyState } from '../../ui/components/card';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { PresetFinding, ProviderHint } from './analysis-api';
import type { ExtraFinding } from './conditional';

export interface AnalysisModel {
    /** null while loading. */
    findings: PresetFinding[] | null;
    hints: ProviderHint[];
    /** The analysis module is not running. */
    unavailable: boolean;
    error: string | null;
    names: ReadonlyMap<string, string>;
    /** Findings of other parts of the studio (conditional blocks), with their own labels. */
    extra?: ExtraFinding[];
}

export interface AnalysisActions {
    open(identifier: string): void;
    refresh(): Promise<void>;
}

export function renderAnalysisPanel(app: App, model: AnalysisModel, actions: AnalysisActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-analysis' });
    root.append(
        el('div', { class: 'maestro-m34-toolbar' }, [
            el('span', { class: 'maestro-muted', text: t('m34.analysis.hint') }),
            button({
                icon: 'fa-arrows-rotate',
                title: t('m34.analysis.refresh'),
                className: 'maestro-m34-analysis-refresh',
                disabled: model.unavailable,
                onClick: () => actions.refresh(),
            }),
        ]),
    );
    if (model.unavailable) {
        root.append(banner(t('m34.analysis.unavailable'), 'info', 'fa-circle-info'));
        return root;
    }
    if (model.error) root.append(banner(t('m34.analysis.failed', { error: model.error }), 'error'));
    if (model.findings === null) {
        root.append(el('div', { class: 'maestro-empty', text: t('m34.analysis.loading') }));
        return root;
    }
    const findings: (ExtraFinding & { otherIdentifier?: string })[] = [
        ...model.findings.map((finding) => ({ ...finding, label: t(`m34.finding.${finding.kind}`) })),
        ...(model.extra ?? []),
    ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
    root.append(el('h4', { class: 'maestro-m34-h', text: t('m34.analysis.findings', { count: findings.length }) }));
    if (!findings.length) root.append(emptyState(t('m34.analysis.clean')));
    else {
        root.append(
            el(
                'ul',
                { class: 'maestro-m34-findings' },
                findings.map((finding) => {
                    const name = finding.identifier
                        ? (model.names.get(finding.identifier) ?? finding.identifier)
                        : null;
                    return el('li', { class: ['maestro-m34-finding', `maestro-m34-sev-${finding.severity}`] }, [
                        icon(finding.severity === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'),
                        el('div', { class: 'maestro-m34-finding-body' }, [
                            el('div', { class: 'maestro-m34-finding-kind', text: finding.label }),
                            el('div', { text: finding.text }),
                        ]),
                        el('div', { class: 'maestro-m34-finding-links' }, [
                            finding.identifier && name ? openButton(finding.identifier, name) : null,
                            finding.otherIdentifier
                                ? openButton(
                                      finding.otherIdentifier,
                                      model.names.get(finding.otherIdentifier) ?? finding.otherIdentifier,
                                  )
                                : null,
                        ]),
                    ]);
                }),
            ),
        );
    }
    root.append(el('h4', { class: 'maestro-m34-h', text: t('m34.analysis.hints') }));
    if (!model.hints.length) root.append(el('div', { class: 'maestro-muted', text: t('m34.analysis.noHints') }));
    else {
        root.append(
            el(
                'ul',
                { class: 'maestro-m34-hints' },
                model.hints.map((hint) =>
                    el('li', {}, [el('strong', { text: hint.model }), el('span', { text: ` — ${hint.text}` })]),
                ),
            ),
        );
    }
    return root;

    function openButton(identifier: string, name: string): HTMLButtonElement {
        return button({
            label: name,
            icon: 'fa-pen',
            kind: 'ghost',
            title: t('m34.analysis.open'),
            className: 'maestro-m34-finding-open',
            onClick: () => actions.open(identifier),
        });
    }
}
