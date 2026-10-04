// Built-in rules of stages 1–2, in the order the pult lists them (plan M22 table; dev-plan 1.7, 1.8, 1.11, 2.6).
import type { Unsubscribe } from '../../../shared/contracts';
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';
import { LORE_ENTRY_TARGET, undoLoreEntry } from '../lore-write';
import { archiveDepthRule, registerArchiveHandlers } from './archives';
import { bunnymoTagsRule, ckDumpsRule } from './display';
import { cyrillicRule } from './keys';
import { capRule, duplicatesRule, roleRule } from './lore';
import { nsfwRule, packVersionRule, registerPackHandlers } from './packs';
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
        cyrillicRule(env),
        packVersionRule(env),
        nsfwRule(),
        archiveDepthRule(env),
    ];
}

/** Undo handlers and Inbox appliers of the stage-2 lore rules; the module owns the returned disposers. */
export function registerLoreHandlers(env: RuleEnv): Unsubscribe[] {
    env.app.journal.registerUndo(LORE_ENTRY_TARGET, (change) => undoLoreEntry(env.app, change));
    return [...registerPackHandlers(env), ...registerArchiveHandlers(env)];
}

export { ARCHIVE_DEPTH_KIND, ARCHIVE_DEPTH_RULE_ID, proposeArchiveFixes } from './archives';
export { BUNNYMO_TAGS_RULE_ID, CK_DUMPS_RULE_ID } from './display';
export { CYRILLIC_RULE_ID } from './keys';
export { CAP_RULE_ID, DUPLICATES_RULE_ID, ROLE_RULE_ID } from './lore';
export { NSFW_RULE_ID, PACK_CHOICE_TARGET, PACK_VERSION_KIND, PACK_VERSION_RULE_ID } from './packs';
export { GAP_RULE_ID, IMAGE_POSTS_RULE_ID, QVINK_SUMMARIZE_TASK, registerQvinkHandlers } from './qvink';
export { CK_BUTTON_RULE_ID, DES_BAR_RULE_ID } from './ui';
