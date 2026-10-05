// The assistant's write tools (M33, plan M33 п.4 «делает»; §4.13): each one validates the request and describes the
// change (WritePlan: summary, target, before/after) without touching anything; the core shows the card and calls
// apply() only after the user confirms. apply() writes through the owning module's API (which journals with undo)
// or journals the change itself with an undo handler registered here.
//
// | tool                   | writes through                                                  | journal (undo)     |
// |------------------------|-----------------------------------------------------------------|--------------------|
// | setting_set            | ToolContext.settings.plan (the core's allowlist)                | the core           |
// | module_toggle          | app.modules.enable/disable                                      | assistant-module   |
// | autonomy_set           | app.autonomy.setLevel (default: core settings, as Settings)     | assistant-autonomy |
// | mechanic_save          | mechanics.save                                                  | mechanics          |
// | mechanic_toggle_chat   | mechanics.setEnabledInChat                                      | assistant-mech-chat|
// | regex_create/_toggle   | ST regex engine saveScriptsByType(GLOBAL) / extension_settings  | assistant-regex    |
// | preset_block_add/_cond | presetLayer.record + presetStore.addPrompt/updatePrompt         | preset layer/store |
// | lore_entry_create/_upd | loreStore.createEntry/updateEntry (+ bookRoles registry type)   | Lore Studio        |
// | passport_set           | lorePassports.set                                               | lorePassports      |
import type { App, JournalChange, Logger } from '../../../../shared/contracts';
import type { ToolFactory, ToolSpec } from '../../api';
import { UNDO_TARGETS } from './common';
import { loreEntryCreateTool, loreEntryUpdateTool, passportSetTool } from './lore';
import { mechanicSaveTool, mechanicToggleChatTool, undoMechanicChat } from './mechanics';
import { presetBlockAddTool, presetBlockConditionTool } from './preset';
import { regexCreateTool, regexToggleTool, undoRegex } from './regex';
import { autonomySetTool, moduleToggleTool, settingSetTool, undoAutonomy, undoModule } from './settings';

export { WRITE_STRINGS } from './strings';
export { UNDO_TARGETS } from './common';

/**
 * Undo handlers of the changes the write tools journal themselves. Registered when the tools are built (the module's
 * init), so records of earlier sessions can be undone after a reload; registering again replaces them.
 */
export function registerWriteUndo(app: App, log: Logger): void {
    const guard =
        (name: string, handler: (app: App, change: JournalChange) => Promise<boolean>) =>
        async (change: JournalChange): Promise<boolean> => {
            try {
                return await handler(app, change);
            } catch (error) {
                log.warn(`assistant: undo of ${name} failed`, error);
                return false;
            }
        };
    app.journal.registerUndo(UNDO_TARGETS.module, guard('module', undoModule));
    app.journal.registerUndo(UNDO_TARGETS.autonomy, guard('autonomy', undoAutonomy));
    app.journal.registerUndo(UNDO_TARGETS.mechanicChat, guard('mechanic', undoMechanicChat));
    app.journal.registerUndo(UNDO_TARGETS.regex, guard('regex', undoRegex));
}

/** The write tools, in the order they are offered. */
export const writeTools: ToolFactory = (app: App, log: Logger): ToolSpec[] => {
    registerWriteUndo(app, log);
    return [
        settingSetTool(),
        moduleToggleTool(),
        autonomySetTool(),
        mechanicSaveTool(),
        mechanicToggleChatTool(),
        regexCreateTool(),
        regexToggleTool(),
        presetBlockAddTool(),
        presetBlockConditionTool(),
        loreEntryCreateTool(),
        loreEntryUpdateTool(),
        passportSetTool(),
    ];
};
