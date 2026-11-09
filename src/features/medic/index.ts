// M3 «Медик» (plan M3; dev-plan 1.3, 1.9, 1.12): notices failures of the neighbours right away — DES tracker
// (with a repair through DES's own pipeline, see tracker-repair.ts), DES-RU field names, NAI Studio markers, Qvink
// gaps, assistant-role lore at depth, Localizer keys, an assistant prefill in the preset, regex damage and
// Maestro's own dependencies (§4.14). Health checks live in the Pult's Health tab; per-reply checks run after
// `reply:ready`.
import { registerBuiltInAgent } from '../../core/builtin-agents';
import { removeTrackerInstruction } from './separate-tracker';
import { formatEnum } from '../../core/labels';
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import { medicHealthChecks } from './health';
import { PREFILL_KIND, PREFILL_TARGET, PrefillFix } from './prefill';
import { ReplyWatcher } from './reply';
import type { MedicSettings } from './reply';
import { MEDIC_STRINGS } from './strings';
import { REPAIR_KIND, TRACKER_TARGET, TrackerRepair } from './tracker-repair';

export type { MedicSettings } from './reply';

export const medicModule: MaestroModule<MedicSettings> = {
    id: 'M3',
    key: 'medic',
    stage: 1,
    titleKey: 'm3.title',
    enabledByDefault: true,
    defaults: () => ({ trackerRepair: true, separateTracker: false }),
    i18n: MEDIC_STRINGS,
    targets: [
        // The tracker record is DES's JSON: only under «Подробнее».
        { target: TRACKER_TARGET, technical: true },
        // 'assistant' → 'user': «Роль: модель (assistant) → ты (user)».
        { target: PREFILL_TARGET, valueLabelKey: 'm3.target.role', format: formatEnum('m3.role.') },
    ],

    init({ app, settings, log, own }) {
        const t = app.i18n.t.bind(app.i18n);
        const repair = new TrackerRepair(app, log.scope('repair'), t);
        const prefill = new PrefillFix(app, log.scope('prefill'), t);
        const replies = new ReplyWatcher(app, log, t, repair, settings);

        // Preset edits are never promoted to 'auto' (plan §8).
        app.autonomy.neverAuto(PREFILL_KIND);
        // Journal undo works even after the module is switched off (records outlive it).
        app.journal.registerUndo(TRACKER_TARGET, (change) => repair.undo(change));
        app.journal.registerUndo(PREFILL_TARGET, (change) => prefill.undo(change));

        own(
            app.inbox.registerApplier(
                REPAIR_KIND,
                (payload) => repair.apply(payload),
                (payload) => repair.stillValid(payload),
            ),
        );
        own(registerProfileTask(REPAIR_KIND, 'm3.profileTask'));
        own(app.bus.on('reply:ready', ({ messageIndex, type }) => replies.onReply(messageIndex, type)));
        // «Трекер сцены» (release 1.32): DES's tracker instruction leaves the assembled prompt of real generations.
        const promptReady = app.host.events.name('CHAT_COMPLETION_PROMPT_READY');
        if (promptReady) {
            own(
                app.host.events.on(
                    promptReady,
                    (data) => {
                        if (settings.separateTracker !== true) return;
                        removeTrackerInstruction(app, data, log);
                    },
                    { order: 'last' },
                ),
            );
        }
        own(
            registerBuiltInAgent({
                id: REPAIR_KIND,
                module: 'medic',
                group: 'world',
                icon: 'fa-table-list',
                defaultInstructions: () => [],
                defaults: { maxTokens: 2048, temperature: 0 },
                knobs: [
                    {
                        path: 'separateTracker',
                        labelKey: 'm44.bi.medic.trackerRepair.knob.separateTracker',
                        kind: 'toggle',
                        hintKey: 'm44.bi.medic.trackerRepair.knob.separateTracker.hint',
                    },
                ],
                switch: { path: 'trackerRepair' },
            }),
        );
        // M12 «Качество»: tracker repair on request (true = the tracker is there now).
        app.modules.expose('medic', { repairTracker: (index: number) => repair.repairOrWait(index) });
        for (const check of medicHealthChecks({ app, t, repair, prefill })) own(app.ui.addHealthCheck(check));
    },
};
