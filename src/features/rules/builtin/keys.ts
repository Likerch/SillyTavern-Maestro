// Rule 'keys.cyrillicLeftBoundary' (plan M22 «Кириллица и «целое слово»», Q35; audit T2, №4, B5): on the scan copies
// of entries with effective whole-word matching, plain one-word Cyrillic keys become regex keys with a left word
// boundary only (src/domain/rules-keys.ts). The global settings come from world-info.js's live bindings, loaded once
// when the rule starts (the scan itself never waits). CK archives are left to DES-RU when its BunnyMo module is on: it
// widens Cyrillic archive keys to every case form in the same event, and a regex key would make it skip them.
import { isCharacterArchive } from '../../../domain/bunnymo';
import { convertKeyList, effectiveFlag } from '../../../domain/rules-keys';
import type { EntryLists, RuleChange, RuleDefinition } from '../api';
import { entriesOf } from '../env';
import type { RuleEnv } from '../env';

export const CYRILLIC_RULE_ID = 'keys.cyrillicLeftBoundary';
/** DES-RU's BunnyMo module widens archive keys (adapters/desru). */
const DESRU_BUNNYMO = 'desru.bunnymo';

interface WorldInfoGlobals {
    world_info_case_sensitive?: unknown;
    world_info_match_whole_words?: unknown;
}

export function cyrillicRule(env: RuleEnv): RuleDefinition {
    let globals: WorldInfoGlobals | null = null;
    let loading: Promise<void> | null = null;
    const load = (): Promise<void> => {
        loading ??= env.app.host.modules
            .worldInfo()
            .then((namespace) => {
                globals = namespace as WorldInfoGlobals;
            })
            .catch((error: unknown) => {
                env.log.debug('world-info.js is not available', error);
                loading = null;
            });
        return loading;
    };

    return {
        id: CYRILLIC_RULE_ID,
        titleKey: 'm22.rule.keys.cyrillicLeftBoundary.title',
        descriptionKey: 'm22.rule.keys.cyrillicLeftBoundary.description',
        owner: 'maestro',
        stage: 2,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded'],
        order: 12,
        start(): void {
            void load();
        },
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            if (!globals) void load();
            // Live `export let` bindings: read on every scan, the user may switch them at any time.
            const wholeWords = globals?.world_info_match_whole_words === true;
            const caseSensitiveGlobal = globals?.world_info_case_sensitive === true;
            let skipArchives: boolean | null = null;
            for (const entry of entriesOf(lists)) {
                if (entry.disable === true || !effectiveFlag(entry.matchWholeWords, wholeWords)) continue;
                const caseSensitive = effectiveFlag(entry.caseSensitive, caseSensitiveGlobal);
                const key = convertKeyList(entry.key, caseSensitive);
                const secondary = convertKeyList(entry.keysecondary, caseSensitive);
                if (!key && !secondary) continue;
                skipArchives ??= env.capability(DESRU_BUNNYMO);
                if (skipArchives && isCharacterArchive(entry)) continue;
                if (key) {
                    changes.push({ world: entry.world, uid: entry.uid, field: 'key', before: entry.key, after: key });
                    entry.key = key;
                }
                if (secondary) {
                    changes.push({
                        world: entry.world,
                        uid: entry.uid,
                        field: 'keysecondary',
                        before: entry.keysecondary,
                        after: secondary,
                    });
                    entry.keysecondary = secondary;
                }
            }
        },
    };
}
