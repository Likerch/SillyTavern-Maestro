// Display and analysis rules of stage 1 (plan M22 table; audit T10; dev-plan 1.8).
import { escapeBunnyMoTags } from '../../../domain/rules-display';
import type { Unsubscribe } from '../../../shared/contracts';
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';

export const BUNNYMO_TAGS_RULE_ID = 'display.bunnymoTags';
export const CK_DUMPS_RULE_ID = 'prompt.ckDumpsIgnore';

/**
 * ST's message formatter has no removeHook: the hook is added once per formatter for the page and only acts while
 * the rule runs, so a disabled rule (or module) leaves the text untouched (P11).
 */
const hooks = new WeakMap<object, { active: boolean }>();

export function bunnymoTagsRule(env: RuleEnv): RuleDefinition {
    return {
        id: BUNNYMO_TAGS_RULE_ID,
        titleKey: 'm22.rule.display.bunnymoTags.title',
        descriptionKey: 'm22.rule.display.bunnymoTags.description',
        owner: 'maestro',
        stage: 1,
        kind: 'display',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.messageFormatter'],
        start(): Unsubscribe | void {
            const formatter = env.app.host.ctx().messageFormatter;
            if (!formatter || typeof formatter.addHook !== 'function') return;
            let state = hooks.get(formatter);
            if (!state) {
                const created = { active: false };
                // afterRegex: after the user's regexes, before Markdown and the sanitizer (message-formatter.js).
                // A plain (not async) function: ST rejects async hooks.
                formatter.addHook(
                    function maestroBunnyMoTags(mes: string): string {
                        return created.active ? escapeBunnyMoTags(mes) : mes;
                    },
                    { stage: 'afterRegex' },
                );
                hooks.set(formatter, created);
                state = created;
            }
            const current = state;
            current.active = true;
            return () => {
                current.active = false;
            };
        },
    };
}

/**
 * Not a prompt change: analysis modules read messages through `cleanForAnalysis` (src/domain/text-clean.ts) while
 * this rule is on. It may run before the wizard: it changes nothing the user sees.
 */
export function ckDumpsRule(): RuleDefinition {
    return {
        id: CK_DUMPS_RULE_ID,
        titleKey: 'm22.rule.prompt.ckDumpsIgnore.title',
        descriptionKey: 'm22.rule.prompt.ckDumpsIgnore.description',
        owner: 'maestro',
        stage: 1,
        kind: 'prompt',
        defaultLevel: 'auto',
        enabledByDefault: true,
        safeBeforeWizard: true,
    };
}
