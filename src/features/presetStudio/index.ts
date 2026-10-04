// M34 «Пресет-студия» (plan M34, dev-plan stage 5). The module is built in module.ts; the data layer (store.ts), the
// user's layer (layer.ts) and the analysis (analysis.ts) come from their own files through these factories
// (contracts: store-api.ts, layer-api.ts, analysis-api.ts).
import { createPresetAnalysis } from './analysis';
import { createPresetLayer } from './layer';
import { createPresetStudioModule } from './module';
import { createPresetStore } from './store';

export const presetStudioModule = createPresetStudioModule({
    store: createPresetStore,
    layer: createPresetLayer,
    analysis: createPresetAnalysis,
});

export {
    PRESET_ANALYSIS_KEY,
    PRESET_LAYER_KEY,
    PRESET_STORE_KEY,
    PRESET_STUDIO_KEY,
    createPresetStudioModule,
    presetStudioRuntime,
} from './module';
export type { PresetFactories, PresetStudioApi, PresetStudioRuntime } from './module';
export type { PresetStudioSettings, StudioTab } from './studio';
export type {
    PresetBody,
    PresetDraftState,
    PresetOrderItem,
    PresetPrompt,
    PresetStore,
    PresetVersion,
} from './store-api';
export type { Layer, LayerAnchor, LayerApplyReport, LayerConflict, LayerOp, PresetLayerApi } from './layer-api';
export type { FindingKind, MapSlot, PresetAnalysisApi, PresetFinding, ProviderHint } from './analysis-api';
