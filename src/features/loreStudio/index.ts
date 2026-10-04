// M23 «Лор-студия» (plan M23, dev-plan 2.2, 2.9). The module itself is built in module.ts; the entry form comes
// from form/index.ts (the form contract is form-api.ts).
import { renderEntryForm } from './form';
import { createLoreStudioModule } from './module';

export const loreStudioModule = createLoreStudioModule(renderEntryForm);

export { LORE_STUDIO_KEY, createLoreStudioModule, loreStudioRuntime } from './module';
export type { LoreStudioRuntime } from './module';
export { STORE_KEY, LoreStoreService } from './store';
export type { LoreStudioSettings } from './studio';
export type {
    EntryVersion,
    LoreStore,
    SaveReason,
    WiBindings,
    WiBookData,
    WiEntry,
    WiGlobalSettings,
} from './store-api';
export type { EntryFormContext, RenderEntryForm } from './form-api';
