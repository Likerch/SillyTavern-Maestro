// M6 + M20 п. 5 «Тексты только для сканирования» (dev-plan 2.4; audit A7): when a Russian form of a known name occurs
// in the last messages, its English name goes into the WI scan through a scan-only extension prompt
// (`maestro_canonScan`, position NONE, scan true): English books and canon entries fire on Russian text, the model
// never sees the text, and app.ephemeral clears it after the generation (P8).
//
// Name pairs come from (a) canon entries (English and Russian keys of one entry), (b) DES canonical aliases and
// DES-RU's aliases, (c) Localizer markers (the source English key → the Russian keys it appended; collected from the
// last scan's entries). Case forms come from DES-RU (`DESRU_API.nameForms`, through the desru adapter when it offers
// `api()`); without DES-RU a Russian stem with a left word boundary is matched.
import { adaptersOf } from '../../adapters';
import { readLocalizerMarker } from '../../adapters/localizer';
import { isDict } from '../../domain/canon-book';
import { recentText } from '../../domain/canon-inject';
import type { EntryListsLike } from '../../domain/canon-inject';
import {
    buildGlossary,
    formatGlosses,
    hasCyrillic,
    isRegexKey,
    matchGlossary,
    pairsFromAliases,
    pairsFromKeys,
    pairsFromLocalizer,
    russianKeysFrom,
    uniqueStrings,
} from '../../domain/canon-keys';
import type { GlossPair, Glossary } from '../../domain/canon-keys';
import { stableHash } from '../../domain/hash';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { CanonSettings } from './scan';
import type { CanonStore } from './store';

/** Ephemeral injection key (extension prompt `maestro_canonScan`). */
export const GLOSS_INJECTION = 'canonScan';
const MAX_NAMES = 40;
const MAX_CHARS = 600;
/** DES aliases and DES-RU names change without events Maestro can rely on: rebuild at most this often. */
const GLOSSARY_TTL_MS = 60_000;

/** What Maestro uses of DES-RU's public API (globalThis.DESRU_API); every member is optional. */
export interface DesRuApiLike {
    nameForms?(name: string): unknown;
    nameFormsKey?(name: string): unknown;
    aliases?(): unknown;
    onNamesChanged?(callback: () => void): unknown;
}

/** DES-RU's API: from the adapter when it offers `api()`, else the global; null when absent. */
export function desruApi(app: App): DesRuApiLike | null {
    try {
        const adapter = adaptersOf(app).desru as unknown as { api?: () => unknown } | undefined;
        const fromAdapter = typeof adapter?.api === 'function' ? adapter.api() : undefined;
        const api = fromAdapter ?? (globalThis as { DESRU_API?: unknown }).DESRU_API;
        return api && typeof api === 'object' ? (api as DesRuApiLike) : null;
    } catch {
        return null;
    }
}

function safeCall(call: () => unknown, log: Logger): unknown {
    try {
        return call();
    } catch (error) {
        log.debug('DES-RU call failed', error);
        return undefined;
    }
}

export class CanonGlosses {
    private glossary: Glossary | null = null;
    private builtAt = 0;
    private building: Promise<Glossary> | null = null;
    private localizer: GlossPair[] = [];
    private localizerSignature = '';
    private lastText = '';

    constructor(
        private readonly app: App,
        private readonly store: CanonStore,
        private readonly settings: () => CanonSettings,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        offs.push(this.app.ephemeral.addProducer(GLOSS_INJECTION, () => this.produce()));
        offs.push(this.store.onChange(() => this.invalidate()));
        const chatChanged = this.app.host.events.name('CHAT_CHANGED');
        if (chatChanged) offs.push(this.app.host.events.on(chatChanged, () => this.invalidate()));
        const api = desruApi(this.app);
        const off = api?.onNamesChanged
            ? safeCall(() => api.onNamesChanged?.(() => this.invalidate()), this.log)
            : null;
        if (typeof off === 'function') offs.push(off as Unsubscribe);
        return offs;
    }

    invalidate(): void {
        this.glossary = null;
        this.building = null;
    }

    /** Text the last generation scanned (for the pult and tests). */
    last(): string {
        return this.lastText;
    }

    /** Localizer pairs of the entries ST just loaded (rebuilt only when they change). */
    collectLocalizer(lists: EntryListsLike): void {
        const pairs: GlossPair[] = [];
        for (const list of Object.values(lists)) {
            for (const entry of list) {
                if (!isDict(entry) || !isDict(entry.extensions) || !entry.extensions.lorebook_localizer) continue;
                const marker = readLocalizerMarker(entry);
                if (!marker) continue;
                for (const state of Object.values(marker.languages)) {
                    pairs.push(...pairsFromLocalizer(state.sources, [...state.added.key, ...state.added.keysecondary]));
                }
            }
        }
        const signature = pairs.length ? stableHash(JSON.stringify(pairs)) : '';
        if (signature === this.localizerSignature) return;
        this.localizerSignature = signature;
        this.localizer = pairs;
        this.invalidate();
    }

    /** Builds (or returns) the glossary of the current chat. */
    glossaryNow(): Promise<Glossary> {
        if (this.glossary && Date.now() - this.builtAt < GLOSSARY_TTL_MS) return Promise.resolve(this.glossary);
        if (!this.building) {
            const building = this.build().then((glossary) => {
                if (this.building === building) {
                    this.glossary = glossary;
                    this.builtAt = Date.now();
                    this.building = null;
                }
                return glossary;
            });
            this.building = building;
        }
        return this.building;
    }

    private async build(): Promise<Glossary> {
        const pairs: GlossPair[] = [];
        const book = this.store.bookName();
        if (book) {
            const { items } = await this.store.state(book);
            for (const item of items) {
                if (item.meta.kind !== 'addition' && item.meta.kind !== 'override') continue;
                const keys = [item.entry.key, item.entry.keysecondary].flatMap((list) =>
                    Array.isArray(list) ? list : [],
                );
                pairs.push(...pairsFromKeys(keys));
            }
        }
        try {
            pairs.push(...pairsFromAliases(adaptersOf(this.app).des.aliases()));
        } catch (error) {
            this.log.debug('DES aliases are not available', error);
        }
        const api = desruApi(this.app);
        if (api?.aliases) pairs.push(...pairsFromAliases(safeCall(() => api.aliases?.(), this.log)));
        pairs.push(...this.localizer);
        // DES-RU case forms of every Russian name (one call per name).
        const forms = new Map<string, string[]>();
        if (api?.nameForms) {
            for (const pair of pairs) {
                if (forms.has(pair.ru) || isRegexKey(pair.ru) || !hasCyrillic(pair.ru)) continue;
                const result = safeCall(() => api.nameForms?.(pair.ru), this.log);
                forms.set(pair.ru, Array.isArray(result) ? uniqueStrings(result) : []);
            }
        }
        return buildGlossary(pairs.map((pair) => ({ ...pair, forms: forms.get(pair.ru) ?? [] })));
    }

    /** Ephemeral producer: sets the scan-only injection for this generation. */
    async produce(): Promise<void> {
        this.lastText = '';
        if (!this.settings().scanGlosses) return;
        const count = Math.max(1, Math.min(50, Math.floor(this.settings().glossMessages) || 6));
        const text = recentText(this.app.host.ctx().chat ?? [], count);
        if (!text) return;
        const names = matchGlossary(await this.glossaryNow(), text, MAX_NAMES);
        const scan = formatGlosses(names, MAX_CHARS);
        if (!scan) return;
        this.lastText = scan;
        this.app.ephemeral.setInjection(GLOSS_INJECTION, { text: scan, position: -1, depth: 0, scan: true, role: 0 });
    }

    /** Russian key forms of a term (CanonApi.russianKeys). */
    russianKeys(term: string): string[] {
        const api = desruApi(this.app);
        const forms = api?.nameForms ? safeCall(() => api.nameForms?.(term), this.log) : undefined;
        const plain = Array.isArray(forms) ? uniqueStrings(forms) : [];
        const key = !plain.length && api?.nameFormsKey ? safeCall(() => api.nameFormsKey?.(term), this.log) : undefined;
        return russianKeysFrom(term, plain, key);
    }
}
