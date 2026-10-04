// Every plan module, in stage order. Stages add their modules here.
import { doctorModule } from '../features/doctor';
import { guardianModule } from '../features/guardian';
import { inspectorModule } from '../features/inspector';
import { loreJournalModule } from '../features/loreJournal';
import { medicModule } from '../features/medic';
import { rulesModule } from '../features/rules';
import { scenariosModule } from '../features/scenarios';
import { sheetsModule } from '../features/sheets';
import { wizardModule } from '../features/wizard';
import type { MaestroModule } from '../shared/contracts';

export const MODULES: MaestroModule[] = [
    // Stage 1: observation and quick fixes.
    loreJournalModule,
    inspectorModule,
    medicModule,
    guardianModule,
    doctorModule,
    rulesModule,
    scenariosModule,
    sheetsModule,
    wizardModule,
];
