// Every plan module, in stage order. Stages add their modules here.
import { architectModule } from '../features/architect';
import { assistantModule } from '../features/assistant';
import { backgroundsModule } from '../features/backgrounds';
import { bookRolesModule } from '../features/bookRoles';
import { bunnymoModeModule } from '../features/bunnymoMode';
import { calendarModule } from '../features/calendar';
import { canonModule } from '../features/canon';
import { contradictionsModule } from '../features/contradictions';
import { chronicleModule } from '../features/chronicle';
import { directorModule } from '../features/director';
import { dockModule } from '../features/dock';
import { doctorModule } from '../features/doctor';
import { dossierModule } from '../features/dossier';
import { guardianModule } from '../features/guardian';
import { inspectorModule } from '../features/inspector';
import { knowledgeModule } from '../features/knowledge';
import { loreJournalModule } from '../features/loreJournal';
import { livingCanonModule } from '../features/livingCanon';
import { lorePassportsModule } from '../features/lorePassports';
import { loreStudioModule } from '../features/loreStudio';
import { mechanicsModule } from '../features/mechanics';
import { medicModule } from '../features/medic';
import { messageStyleModule } from '../features/messageStyle';
import { metricsModule } from '../features/metrics';
import { neighbourPromptsModule } from '../features/neighbourPrompts';
import { offscreenModule } from '../features/offscreen';
import { placesModule } from '../features/places';
import { presetStudioModule } from '../features/presetStudio';
import { promptAuditModule } from '../features/promptAudit';
import { qualityModule } from '../features/quality';
import { relationsModule } from '../features/relations';
import { revisionModule } from '../features/revision';
import { rulesModule } from '../features/rules';
import { scenariosModule } from '../features/scenarios';
import { sheetsModule } from '../features/sheets';
import { signalsModule } from '../features/signals';
import { themeModule } from '../features/theme';
import { treasurerModule } from '../features/treasurer';
import { voicesModule } from '../features/voices';
import { wardrobeModule } from '../features/wardrobe';
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
    // Stage 4: signals, contradictions, revision, living canon, chronicle, metrics.
    signalsModule,
    contradictionsModule,
    revisionModule,
    livingCanonModule,
    chronicleModule,
    metricsModule,
    // Stage 5: Preset Studio.
    presetStudioModule,
    // Release 1.13: neighbour prompts (M36) — its prompt-ready listener runs before the architect's (stage 7).
    neighbourPromptsModule,
    // Stage 6: reply quality.
    qualityModule,
    // Stage 7: resources.
    architectModule,
    treasurerModule,
    // Stage 8: direction.
    directorModule,
    voicesModule,
    // Stage 9: living world.
    offscreenModule,
    calendarModule,
    knowledgeModule,
    // Stage 10: visual link.
    wardrobeModule,
    lorePassportsModule,
    backgroundsModule,
    // Stage 11: mechanics.
    mechanicsModule,
    // Stage 12: unified look and the dock.
    themeModule,
    dockModule,
    messageStyleModule,
    // Stage 13: the assistant.
    assistantModule,
    // Release 1.13, second wave: the prompt audit (M38) — after the assistant, whose tools it registers.
    promptAuditModule,
];
