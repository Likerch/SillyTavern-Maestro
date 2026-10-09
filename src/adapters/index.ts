// The neighbour adapters (plan §4.3; Dramatis since 1.17). Each one detects its neighbour, reports capabilities into
// `host.caps` and offers read-only helpers; writes follow in later stages, by the owner's rules (plan §10).
import type { Host, Logger, NeighbourAdapter } from '../shared/contracts';
import { ExtensionLocator } from './base';
import type { AdapterDeps, AdapterOptions, ModuleNamespace } from './base';
import { BunnyMoAdapter } from './bunnymo';
import { CkAdapter } from './ck';
import { DesAdapter } from './des';
import { DesRuAdapter } from './desru';
import { DramatisAdapter } from './dramatis';
import { LocalizerAdapter } from './localizer';
import { NaiAdapter } from './nai';
import { PresetAdapter } from './preset';
import { QvinkAdapter } from './qvink';

export { ExtensionLocator, NeighbourBase } from './base';
export type { AdapterDeps, AdapterOptions, ExtensionManifest, LocatedExtension, ModuleNamespace } from './base';
export { BunnyMoAdapter } from './bunnymo';
export type { BunnyMoBooks } from './bunnymo';
export { CkAdapter } from './ck';
export type { CarrotKernelGlobal } from './ck';
export { DES_PROMPT_KEYS, DesAdapter } from './des';
export type { DesCharacterField, DesGenerationMode, DesPromptKey } from './des';
export { DesRuAdapter } from './desru';
export type { DesRuApi, DesRuFunction, DesRuModule } from './desru';
export {
    DRAMATIS_API_GLOBAL,
    DRAMATIS_API_READY_EVENT,
    DramatisAdapter,
    MAESTRO_API_GLOBAL,
    MAESTRO_API_READY_EVENT,
    QUIET_FUNCTIONS,
    dramatisOf,
    isQuietFunction,
} from './dramatis';
export type {
    ApiDecision,
    ApiEntityRef,
    ApiJournalChange,
    ApiLlmRequest,
    ApiLlmResult,
    ApiProposal,
    ApiTurnEvent,
    DramatisAgenda,
    DramatisApiV1,
    DramatisStanceInfo,
    MaestroApiV1,
    MaestroQuietFunction,
    QuietClaim,
} from './dramatis';
export { LocalizerAdapter } from './localizer';
export type {
    LocalizeEntriesOptions,
    LocalizeEntriesResult,
    LocalizerApi,
    LocalizerLanguageState,
    LocalizerMarker,
} from './localizer';
export { NAI_MARKERS_SLOT, NaiAdapter } from './nai';
export type {
    NaiBackgroundInput,
    NaiBackgroundResult,
    NaiImageReadyDetail,
    NaiImageReadyKind,
    NaiMarkerSettings,
    NaiPassport,
    NaiPassportGenInput,
    NaiPassportGenKind,
    NaiPassportKind,
    NaiPassportProvider,
    NaiPassportScope,
    NaiPassportTarget,
    NaiPassportsSavedDetail,
    NaiQualityGate,
    NaiQualityGateDetail,
    NaiRequestFailedDetail,
    NaiRequestKind,
    NaiSaveScope,
    NaiSceneHint,
    NaiSceneHintContext,
    NaiSceneProvider,
    NaiStudioApi,
    NaiStudioEvent,
    NaiStudioEvents,
} from './nai';
export { PresetAdapter } from './preset';
export type { PresetPromptInfo } from './preset';
export { QVINK_TEXT_KEYS, QvinkAdapter } from './qvink';
export type { QvinkMemory, QvinkTextKey } from './qvink';

/** Concrete adapters by id; assignable to `App['adapters']`, and typed for later stages. */
export interface Adapters {
    des: DesAdapter;
    desru: DesRuAdapter;
    ck: CkAdapter;
    bunnymo: BunnyMoAdapter;
    qvink: QvinkAdapter;
    nai: NaiAdapter;
    localizer: LocalizerAdapter;
    preset: PresetAdapter;
    dramatis: DramatisAdapter;
}

// Compile-time check that every NeighbourAdapter id has exactly its adapter.
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _ids: Exact<keyof Adapters, NeighbourAdapter['id']> = true;
void _ids;

/**
 * Typed view of `app.adapters` for features (the contract types it as plain NeighbourAdapters because
 * src/shared cannot import adapter classes). Valid for the App built by createAdapters().
 */
export function adaptersOf(app: { adapters: Record<NeighbourAdapter['id'], NeighbourAdapter> }): Adapters {
    return app.adapters as unknown as Adapters;
}

const nativeImport = (url: string): Promise<ModuleNamespace> =>
    import(/* @vite-ignore */ url) as Promise<ModuleNamespace>;

/** Builds every adapter. Capabilities are registered now; call each adapter's ready() after `host.install()`. */
export function createAdapters(host: Host, log: Logger, options: AdapterOptions = {}): Adapters {
    const fetchManifest = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
    const locator = new ExtensionLocator(host, log.scope('locator'), fetchManifest);
    const deps = (id: NeighbourAdapter['id']): AdapterDeps => ({
        host,
        log: log.scope(id),
        locator,
        importModule: options.importModule ?? nativeImport,
    });
    return {
        des: new DesAdapter(deps('des')),
        desru: new DesRuAdapter(deps('desru')),
        ck: new CkAdapter(deps('ck')),
        bunnymo: new BunnyMoAdapter(deps('bunnymo')),
        qvink: new QvinkAdapter(deps('qvink')),
        nai: new NaiAdapter(deps('nai')),
        localizer: new LocalizerAdapter(deps('localizer')),
        preset: new PresetAdapter(deps('preset')),
        dramatis: new DramatisAdapter(deps('dramatis')),
    };
}
