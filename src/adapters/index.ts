// The eight neighbour adapters (plan §4.3). Each one detects its neighbour, reports capabilities into
// `host.caps` and offers read-only helpers; writes follow in later stages, by the owner's rules (plan §10).
import type { Host, Logger, NeighbourAdapter } from '../shared/contracts';
import { ExtensionLocator } from './base';
import type { AdapterDeps, AdapterOptions, ModuleNamespace } from './base';
import { BunnyMoAdapter } from './bunnymo';
import { CkAdapter } from './ck';
import { DesAdapter } from './des';
import { DesRuAdapter } from './desru';
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
export { DesAdapter } from './des';
export type { DesGenerationMode } from './des';
export { DesRuAdapter } from './desru';
export type { DesRuModule } from './desru';
export { LocalizerAdapter } from './localizer';
export type { LocalizerLanguageState, LocalizerMarker } from './localizer';
export { NaiAdapter } from './nai';
export type { NaiPassport, NaiPassportKind } from './nai';
export { PresetAdapter } from './preset';
export type { PresetPromptInfo } from './preset';
export { QvinkAdapter } from './qvink';
export type { QvinkMemory } from './qvink';

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
    };
}
