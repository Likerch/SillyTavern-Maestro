// «Целостность» (M35 п. 9) and «Правки на лету» (M35 п. 4, P13): what is wrong with the BunnyMo setup, and the M22
// runtime fixes made to BunnyMo books in the last scan, each rule with its own off switch.
import { adaptersOf } from '../../adapters';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { formatValue } from '../../ui/components/diff';
import { button, clear, el } from '../../ui/components/dom';
import { tOr } from '../../ui/views/format';
import type { IntegrityFinding } from './api';
import type { RuleEditsView } from './service';
import { errorText, loading } from './view-common';
import type { ViewContext } from './view-common';

const MAX_CHANGES = 50;

function refreshButton(ctx: ViewContext): HTMLElement {
    return button({ label: ctx.t('m35b.refresh'), icon: 'fa-rotate', kind: 'ghost', onClick: () => ctx.redraw() });
}

export async function renderIntegrity(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t } = ctx;
    body.appendChild(loading(t));
    let findings: IntegrityFinding[];
    try {
        findings = await ctx.service.integrity();
    } catch (error) {
        clear(body);
        body.appendChild(el('div', { class: 'maestro-error-text', text: errorText(error) }));
        return;
    }
    clear(body);
    body.appendChild(el('div', { class: 'maestro-m35b-toolbar' }, [refreshButton(ctx)]));
    if (!findings.length) {
        body.appendChild(emptyState(t('m35b.integrity.ok')));
        return;
    }
    body.appendChild(
        el(
            'div',
            { class: 'maestro-m35b-findings' },
            findings.map((finding) =>
                el('div', { class: 'maestro-m35b-finding', data: { kind: finding.kind } }, [
                    banner(finding.text, finding.kind === 'ckBackup' ? 'info' : 'warn'),
                ]),
            ),
        ),
    );
}

function short(value: unknown): string {
    const text = formatValue(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function ruleRow(ctx: ViewContext, rule: RuleEditsView['rules'][number]): HTMLElement {
    const { t } = ctx;
    const title = tOr(ctx.app.i18n, rule.titleKey, rule.id);
    const meta: (HTMLElement | string)[] = [
        rule.changes.length ? t('m35b.edits.changes', { count: rule.changes.length }) : t('m35b.edits.none'),
    ];
    if (rule.cuts) meta.push(t('m35b.edits.cuts', { count: rule.cuts }));
    return el('div', { class: 'maestro-m35b-rule', data: { rule: rule.id } }, [
        el('div', { class: 'maestro-m35b-rule-head' }, [
            toggle({
                label: title,
                checked: rule.enabled,
                onChange: (checked) =>
                    ctx.run(async () => {
                        await ctx.service.setRuleEnabled(rule.id, checked);
                        ctx.redraw();
                    }),
            }),
            rule.waiting ? badge(t('m35b.edits.waiting'), 'muted') : null,
            rule.owner === 'desru' ? badge(t('m35b.edits.owner.desru'), 'info') : null,
        ]),
        el('div', { class: 'maestro-muted', text: meta.join(' · ') }),
        rule.changes.length
            ? el('details', {}, [
                  el('summary', { text: t('m35b.edits.changes', { count: rule.changes.length }) }),
                  el(
                      'ul',
                      { class: 'maestro-m35b-list' },
                      rule.changes.slice(0, MAX_CHANGES).map((change) =>
                          el('li', {
                              text: t('m35b.edits.change', {
                                  book: change.world,
                                  uid: change.uid,
                                  field: change.field,
                                  before: short(change.before),
                                  after: short(change.after),
                              }),
                          }),
                      ),
                  ),
              ])
            : null,
    ]);
}

function desruEnabled(ctx: ViewContext): boolean {
    try {
        return adaptersOf(ctx.app).desru.present() && adaptersOf(ctx.app).desru.moduleEnabled('bunnymo');
    } catch {
        return false;
    }
}

export async function renderEdits(ctx: ViewContext, body: HTMLElement): Promise<void> {
    const { t, service } = ctx;
    body.appendChild(loading(t));
    let view: RuleEditsView | null;
    try {
        view = await service.ruleEdits();
    } catch (error) {
        clear(body);
        body.appendChild(el('div', { class: 'maestro-error-text', text: errorText(error) }));
        return;
    }
    clear(body);
    body.appendChild(el('div', { class: 'maestro-m35b-toolbar' }, [refreshButton(ctx)]));
    body.appendChild(el('div', { class: 'maestro-hint', text: t('m35b.edits.intro') }));
    if (!view) body.appendChild(banner(t('m35b.edits.noRules'), 'info', 'fa-circle-info'));
    else
        body.appendChild(
            el(
                'div',
                { class: 'maestro-m35b-rules' },
                view.rules.map((rule) => ruleRow(ctx, rule)),
            ),
        );

    const suppressed = view?.suppressed ?? [];
    const selection = service.selection();
    body.appendChild(
        section(
            t('m35b.edits.selection'),
            suppressed.length
                ? el(
                      'ul',
                      { class: 'maestro-m35b-list' },
                      suppressed.map((item) => el('li', { text: t('m35b.edits.selectionItem', item) })),
                  )
                : el('div', { class: 'maestro-muted', text: t('m35b.edits.selectionNone') }),
            selection.mode === 'only'
                ? button({
                      label: t('m35b.edits.selectionAll'),
                      kind: 'ghost',
                      onClick: () =>
                          ctx.run(async () => {
                              await service.setSelection({ mode: 'all' });
                              ctx.redraw();
                          }),
                  })
                : undefined,
        ),
    );
    if (desruEnabled(ctx)) body.appendChild(el('div', { class: 'maestro-hint', text: t('m35b.edits.desru') }));
}
