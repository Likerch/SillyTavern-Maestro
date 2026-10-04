// Every plan module, in stage order. Stages add their modules here.
import { bookRolesModule } from '../features/bookRoles';
import { bunnymoModeModule } from '../features/bunnymoMode';
import { canonModule } from '../features/canon';
import { doctorModule } from '../features/doctor';
import { dossierModule } from '../features/dossier';
import { guardianModule } from '../features/guardian';
import { inspectorModule } from '../features/inspector';
import { loreJournalModule } from '../features/loreJournal';
import { loreStudioModule } from '../features/loreStudio';
import { medicModule } from '../features/medic';
import { placesModule } from '../features/places';
import { relationsModule } from '../features/relations';
import { rulesModule } from '../features/rules';
import { scenariosModule } from '../features/scenarios';
import { sheetsModule } from '../features/sheets';
import { wizardModule } from '../features/wizard';
import { worldModule } from '../features/world';
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
    // Stage 2: book roles, chat canon, Lore Studio.
    bookRolesModule,
    canonModule,
    loreStudioModule,
    // Stage 3: places, world model, relations, dossier, BunnyMo mode.
    placesModule,
    worldModule,
    relationsModule,
    dossierModule,
    bunnymoModeModule,
];
