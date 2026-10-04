// W1 — first-run wizard v1 (plan §7, dev-plan 1.13). Registers seven steps into the UI shell's wizard (orders
// 20…80, after the shell's welcome step): stack, macro engine, settings baseline, the Doctor's findings, stage 1
// rules with book caps, background tasks and the policy for long old chats. Other modules (Guardian, Doctor, Rules,
// lore journal) are reached through app.modules.api and may be off: their steps then explain and step aside.
import type { MaestroModule } from '../../shared/contracts';
import { defaultWizardSettings } from './settings';
import type { WizardSettings } from './settings';
import { backgroundStep, oldChatsStep } from './steps-background';
import { CAPS_TARGET, RULE_TARGET, findingsStep, rulesStep, writeCaps } from './steps-lore';
import type { RulesWithOptions } from './steps-lore';
import { POWER_TARGET, baselineStep, macroStep, stackStep, undoPowerFlag } from './steps-setup';
import { WIZARD_STRINGS } from './strings';

export const WIZARD_KEY = 'wizard';

const WIZARD_CSS = `
.maestro-w1-rule { padding: var(--maestro-gap-sm) 0; border-bottom: 1px solid var(--maestro-border); }
.maestro-w1-compare:empty { display: none; }
.maestro-w1-compare { margin-top: var(--maestro-gap-sm); }
.maestro-w1-caps { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-w1-top { margin: var(--maestro-gap-sm) 0; padding-left: 1.2em; }
.maestro-w1-top li { margin-bottom: var(--maestro-gap-sm); overflow-wrap: anywhere; }
`;

export const wizardModule: MaestroModule<WizardSettings> = {
    id: 'W1',
    key: WIZARD_KEY,
    stage: 1,
    titleKey: 'w1.title',
    enabledByDefault: true,
    defaults: defaultWizardSettings,
    i18n: WIZARD_STRINGS,
    init({ app, settings, own }) {
        let running = true;
        own(() => {
            running = false;
        });
        const alive = () => running;

        // Undo handlers of what the wizard changes (journal targets cannot be unregistered; they check the APIs).
        app.journal.registerUndo(POWER_TARGET, (change) => undoPowerFlag(app, change));
        app.journal.registerUndo(RULE_TARGET, async (change) => {
            const rules = app.modules.api<RulesWithOptions>('rules');
            const id = change.ref.rule;
            if (!rules || typeof id !== 'string') return false;
            await rules.setEnabled(id, change.before === true);
            return true;
        });
        app.journal.registerUndo(CAPS_TARGET, async (change) => {
            const before = change.before && typeof change.before === 'object' ? change.before : {};
            const caps: Record<string, number> = {};
            for (const [book, value] of Object.entries(before)) if (typeof value === 'number') caps[book] = value;
            await writeCaps(app, settings, caps);
            return true;
        });

        own(app.ui.style('w1-wizard', WIZARD_CSS));
        for (const step of [
            stackStep(app),
            macroStep(app),
            baselineStep(app),
            findingsStep(app),
            rulesStep(app, settings, alive),
            backgroundStep(app),
            oldChatsStep(app, settings),
        ]) {
            own(app.ui.addWizardStep(step));
        }
    },
};

export type { OldChatsPolicy, WizardSettings } from './settings';
