// «Включить правило» from a finding: the M22 rule is switched on through app.autonomy (kind 'doctor.enableRule',
// default 'auto'), so the change is journaled and can be undone; with a stricter level it becomes an Inbox card.
import type { App, Decision, JournalChange, Unsubscribe } from '../../shared/contracts';
import type { RuleState, RulesApi } from '../rules/api';
import type { Finding } from './api';

export const ENABLE_RULE_KIND = 'doctor.enableRule';
/** Journal target of rule switches made by the doctor (undo handler below). */
export const RULE_TARGET = 'doctor-rule';

export interface EnableRulePayload {
    rule: string;
}

export function rulesApi(app: App): RulesApi | undefined {
    return app.modules.api<RulesApi>('rules');
}

export function ruleState(app: App, id: string): RuleState | undefined {
    try {
        return rulesApi(app)
            ?.list()
            .find((rule) => rule.id === id);
    } catch (error) {
        app.log.debug('rules list failed', error);
        return undefined;
    }
}

function rulePayload(value: unknown): EnableRulePayload | null {
    if (!value || typeof value !== 'object') return null;
    const rule = (value as Record<string, unknown>).rule;
    return typeof rule === 'string' && rule ? { rule } : null;
}

async function applyRule(app: App, payload: unknown): Promise<void> {
    const parsed = rulePayload(payload);
    const rules = rulesApi(app);
    if (!parsed || !rules) throw new Error('the rules module is not running');
    await rules.setEnabled(parsed.rule, true);
}

async function stillOff(app: App, payload: unknown): Promise<boolean> {
    const parsed = rulePayload(payload);
    const rules = rulesApi(app);
    return !!parsed && !!rules && !rules.isEnabled(parsed.rule);
}

/** Inbox applier for cards that survive a reload, plus the undo handler of the journal target. */
export function registerRuleActions(app: App): Unsubscribe {
    app.journal.registerUndo(RULE_TARGET, async (change: JournalChange) => {
        const rules = rulesApi(app);
        const id = change.ref.rule;
        if (!rules || typeof id !== 'string') return false;
        await rules.setEnabled(id, change.before === true);
        return true;
    });
    return app.inbox.registerApplier(
        ENABLE_RULE_KIND,
        (payload) => applyRule(app, payload),
        (payload) => stillOff(app, payload),
    );
}

/** Proposes switching the rule on; returns the autonomy decision. */
export async function enableRule(app: App, state: RuleState, finding: Finding, message: string): Promise<Decision> {
    const t = app.i18n.t.bind(app.i18n);
    const title = t('m5.enableRuleTitle', { rule: t(state.definition.titleKey) });
    const payload: EnableRulePayload = { rule: state.id };
    return app.autonomy.decide<EnableRulePayload>(
        {
            module: 'M5',
            kind: ENABLE_RULE_KIND,
            title,
            description: t('m5.enableRuleDescription', { finding: message }),
            changes: [
                { target: RULE_TARGET, ref: { rule: state.id, finding: finding.id }, before: false, after: true },
            ],
            payload,
            apply: (value) => applyRule(app, value),
            stillValid: () => stillOff(app, payload),
        },
        'auto',
    );
}
