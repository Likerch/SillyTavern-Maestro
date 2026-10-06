// The plan as text lines by section (the slash command `/maestro-prepare`); the window lives in window.ts.
import { PREPARE_SECTIONS } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PreparePlan } from '../../domain/prepare-plan';
import type { App } from '../../shared/contracts';
import type { PrepareService } from './service';

/** Lines of the plan by section, for the slash command. */
export function planLines(app: App, service: PrepareService, plan: PreparePlan): string[] {
    const t = app.i18n.t.bind(app.i18n);
    const lines: string[] = [];
    for (const kind of PREPARE_SECTIONS) {
        const items = plan.items.filter((item) => item.kind === kind);
        if (!items.length) continue;
        lines.push(`${t(`m37.section.${kind}`)} (${items.length})`);
        for (const item of items) lines.push(`• ${itemLine(app, service, item)}`);
    }
    return lines;
}

function itemLine(app: App, service: PrepareService, item: AnyPrepareItem): string {
    const t = app.i18n.t.bind(app.i18n);
    const marks: string[] = [];
    if (item.exists) marks.push(t(`m37.exists.${item.exists.where}`));
    if (item.conflicts?.length) {
        marks.push(
            t('m37.conflict', { fields: item.conflicts.map((row) => t(`m37.conflictField.${row.field}`)).join(', ') }),
        );
    }
    if (item.scope === 'character') marks.push(t('m37.scope.character'));
    return `${service.describe(item)}${marks.length ? ` [${marks.join('; ')}]` : ''}`;
}
