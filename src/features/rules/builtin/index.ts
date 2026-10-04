// Built-in rules of stage 1, in the order the pult lists them (plan M22 table; dev-plan 1.7, 1.8, 1.11).
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';
import { bunnymoTagsRule, ckDumpsRule } from './display';
import { capRule, duplicatesRule, roleRule } from './lore';
import { gapGuardRule, imagePostsRule } from './qvink';
import { ckButtonRule, desPortraitBarRule } from './ui';

export function builtinRules(env: RuleEnv): RuleDefinition[] {
    return [
        roleRule(),
        capRule(env),
        duplicatesRule(),
        gapGuardRule(env),
        imagePostsRule(env),
        bunnymoTagsRule(env),
        ckButtonRule(env),
        desPortraitBarRule(env),
        ckDumpsRule(),
    ];
}

export { BUNNYMO_TAGS_RULE_ID, CK_DUMPS_RULE_ID } from './display';
export { CAP_RULE_ID, DUPLICATES_RULE_ID, ROLE_RULE_ID } from './lore';
export { GAP_RULE_ID, IMAGE_POSTS_RULE_ID, QVINK_SUMMARIZE_TASK, registerQvinkHandlers } from './qvink';
export { CK_BUTTON_RULE_ID, DES_BAR_RULE_ID } from './ui';
