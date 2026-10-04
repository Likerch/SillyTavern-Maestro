// Preset Studio analysis (M34 п.1 map, п.3 analysis, п.9 provider hints; stage 5). Read-only.
// - map(): ST's Chat Completion assembly order reconstructed for a preset body (domain/preset-analysis-map.ts) —
//   relative blocks in order, in-chat blocks inside the history with depth/order/role, markers and the extension
//   prompts that land at each place (owner by key prefix), why an enabled block would not be sent (strict types,
//   P-039…P-047, P-118, P-130). No generation and no dry run of our own (P-007: the studio must not run them more
//   often than the Prompt Manager): ST's own numbers of the last assembly (`promptManager.tokenHandler`, P-008) are
//   used where Maestro cannot know the text — markers (lore, card, history) and, for the working copy, blocks whose
//   macros expand; everything else is counted with ST's tokenizer (getTokenCountAsync), cached by model + text hash.
// - findings(): unsaved draft, `{{if}}` without the new macro engine (P-133), blocks that never go out or go out
//   elsewhere, strict-type mismatches, empty/whitespace messages (P-117, P-138, P-146), model quirks of the active
//   connection (DeepSeek V4: assistant prefill at the end via OpenRouter, system/assistant messages inside the
//   history), cheap contradictions, duplicates with other blocks / extension prompts / the lore of the last turn,
//   the heaviest blocks.
// - hints(): the provider/model table of domain/preset-analysis-hints.ts for the current connection.
// Nothing here writes: no preset, settings or chat changes; nothing runs on the send path (P15).
import { stableHash } from '../../domain/hash';
import { slotOwner } from '../../domain/lore-inspector';
import { findContradictions } from '../../domain/preset-analysis-contradictions';
import type { ContradictionHit } from '../../domain/preset-analysis-contradictions';
import { connectionFrom, modelProfile, modelQuirks, providerHints } from '../../domain/preset-analysis-hints';
import type { ConnectionInfo } from '../../domain/preset-analysis-hints';
import { EXTERNAL_MARKERS, assemblePrompt, promptTail, resolveOrder } from '../../domain/preset-analysis-map';
import type {
    AssembledInjection,
    AssembledSlot,
    Assembly,
    DropCode,
    ExtensionSlot,
    NoteCode,
    PromptTail,
    TypeIssueCode,
} from '../../domain/preset-analysis-map';
import {
    emptyMessageIssue,
    hasIfMacro,
    heavyBlocks,
    isOverlapping,
    overlap,
    sameText,
    shingleSet,
} from '../../domain/preset-analysis-text';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';
import type {
    MapInjection,
    MapSlot,
    PresetAnalysisApi,
    PresetAnalysisOptions,
    PresetFinding,
    ProviderHint,
} from './analysis-api';
import { ANALYSIS_STRINGS } from './analysis-strings';
import type { PresetBody, PresetStore } from './store-api';

export const PRESET_ANALYSIS_KEY = 'presetAnalysis';

const TOKEN_CACHE_LIMIT = 3000;
/** Marker identifiers whose tokens come from ST's counts or the card/lore fallback. */
const MARKER_IDS = [...EXTERNAL_MARKERS, 'dialogueExamples', 'chatHistory'];
/** Persona description goes through the marker only at this position (personas.js persona_description_positions). */
const PERSONA_IN_PROMPT = 0;
/** Lore positions of the world info markers (world_info_position.before / after). */
const WI_BEFORE = 0;
const WI_AFTER = 1;
const MAX_PAIR_FINDINGS = 10;
const NEAR_DUPLICATE = 0.8;
const DROPS_AS_TYPE: ReadonlySet<DropCode> = new Set([
    'systemPrompt',
    'triggerInvalid',
    'depthType',
    'depthRange',
    'role',
]);
const DROP_ISSUE: Partial<Record<DropCode, TypeIssueCode>> = {
    systemPrompt: 'systemPrompt',
    triggerInvalid: 'triggerValues',
    depthType: 'depth',
    depthRange: 'depth',
    role: 'role',
};
const WARN_ISSUES: ReadonlySet<TypeIssueCode> = new Set(['systemPrompt', 'position', 'depth', 'role']);

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function percent(share: number): number {
    return Math.round(share * 100);
}

/**
 * What the factory returns: the API itself (module.ts exposes the result as 'presetAnalysis' and feature-detects
 * install/dispose), the same API as `api`, `install()` (strings, openai.js prefetch; its disposers drop the caches)
 * and `dispose()` (the same cleanup, for callers that do not keep the disposers).
 */
export interface PresetAnalysis extends PresetAnalysisApi {
    api: PresetAnalysisApi;
    install(): Unsubscribe[];
    dispose(): void;
}

interface Prepared {
    body: PresetBody;
    working: boolean;
    assembly: Assembly;
    /** Prompt Manager counts of the last assembly (null when unavailable). */
    counts: Record<string, number> | null;
    markerTokens: Map<string, { tokens: number; from: 'st' | 'count' }>;
    markersWithText: Set<string>;
    slots: ExtensionSlot[];
    connection: ConnectionInfo | null;
}

class PresetAnalyzer implements PresetAnalysisApi {
    private readonly tokenCache = new Map<string, number>();
    private readonly pending = new Map<string, Promise<number>>();
    private openai: Dict | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly store?: PresetStore,
    ) {}

    install(): Unsubscribe[] {
        this.app.i18n.register(ANALYSIS_STRINGS);
        void this.loadOpenAi();
        return [() => this.dispose()];
    }

    dispose(): void {
        this.tokenCache.clear();
        this.pending.clear();
        this.openai = null;
    }

    /* ---------------------------------------------------------------- sources */

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private storeOf(): PresetStore | null {
        return this.store ?? this.app.modules.api<PresetStore>('presetStore') ?? null;
    }

    /** ST's live Chat Completion settings (oai_settings). */
    private live(): Dict | null {
        const settings = this.app.host.ctx().chatCompletionSettings;
        return isDict(settings) ? settings : null;
    }

    private workingBody(): PresetBody {
        const store = this.storeOf();
        if (store) {
            try {
                return store.working();
            } catch (error) {
                this.log.debug('preset store working copy', error);
            }
        }
        const live = this.live();
        return {
            prompts: live?.prompts as PresetBody['prompts'],
            prompt_order: live?.prompt_order as PresetBody['prompt_order'],
        };
    }

    private async loadOpenAi(): Promise<Dict | null> {
        if (this.openai) return this.openai;
        if (!this.app.host.caps.has('st.oai.promptManager')) return null;
        try {
            this.openai = await this.app.host.modules.openai();
        } catch (error) {
            this.log.debug('openai.js is not available; marker tokens are estimated', error);
        }
        return this.openai;
    }

    /** `promptManager.tokenHandler` counts of the last assembly (dry runs included, P-008). */
    private async promptManagerCounts(): Promise<Record<string, number> | null> {
        const openai = await this.loadOpenAi();
        const pm = openai?.promptManager;
        if (!isDict(pm)) return null;
        try {
            const handler = pm.tokenHandler as { getCounts?: () => unknown } | undefined;
            const counts = handler?.getCounts?.();
            if (!isDict(counts)) return null;
            const copy: Record<string, number> = {};
            for (const [identifier, value] of Object.entries(counts)) {
                if (typeof value === 'number' && Number.isFinite(value)) copy[identifier] = value;
            }
            return copy;
        } catch (error) {
            this.log.debug('Prompt Manager counts', error);
            return null;
        }
    }

    private extensionSlots(): ExtensionSlot[] {
        const prompts = this.app.host.ctx().extensionPrompts ?? {};
        const slots: ExtensionSlot[] = [];
        for (const [key, prompt] of Object.entries(prompts)) {
            if (!prompt || typeof prompt.value !== 'string' || !prompt.value) continue;
            slots.push({
                key,
                value: prompt.value,
                position: Number(prompt.position),
                depth: Number(prompt.depth),
                role: Number(prompt.role) || 0,
            });
        }
        return slots;
    }

    private character(): Dict | null {
        const ctx = this.app.host.ctx();
        if (this.app.host.isGroupChat() || ctx.characterId === undefined) return null;
        const character = ctx.characters?.[Number(ctx.characterId)];
        return isDict(character) ? character : null;
    }

    /** Marker texts Maestro can read itself (used when ST has no count for them). */
    private markerTexts(): Map<string, string> {
        const texts = new Map<string, string>();
        const character = this.character();
        const field = (key: string): string => {
            const value = character?.[key];
            return typeof value === 'string' ? value : '';
        };
        texts.set('charDescription', field('description'));
        texts.set('charPersonality', field('personality'));
        texts.set('scenario', field('scenario'));
        texts.set('dialogueExamples', field('mes_example'));
        const user = this.app.host.ctx().powerUserSettings ?? {};
        if (Number(user.persona_description_position ?? PERSONA_IN_PROMPT) === PERSONA_IN_PROMPT) {
            texts.set(
                'personaDescription',
                typeof user.persona_description === 'string' ? user.persona_description : '',
            );
        }
        return texts;
    }

    /** Lore tokens of the last real turn by world info marker (M1). */
    private loreTokens(): Map<string, number> {
        const result = new Map<string, number>();
        const record = this.app.modules.api<LoreJournalApi>('loreJournal')?.last();
        for (const activation of record?.activations ?? []) {
            if (activation.cut) continue;
            const id =
                activation.position === WI_BEFORE
                    ? 'worldInfoBefore'
                    : activation.position === WI_AFTER
                      ? 'worldInfoAfter'
                      : '';
            if (id) result.set(id, (result.get(id) ?? 0) + Math.max(0, activation.tokens));
        }
        return result;
    }

    /** Main / jailbreak replaced by the character card (P-049). */
    private overridden(): Set<string> {
        const result = new Set<string>();
        const data = this.character()?.data;
        const user = this.app.host.ctx().powerUserSettings ?? {};
        if (!isDict(data)) return result;
        if (
            user.prefer_character_prompt !== false &&
            typeof data.system_prompt === 'string' &&
            data.system_prompt.trim()
        ) {
            result.add('main');
        }
        if (
            user.prefer_character_jailbreak !== false &&
            typeof data.post_history_instructions === 'string' &&
            data.post_history_instructions.trim()
        ) {
            result.add('jailbreak');
        }
        return result;
    }

    /* ---------------------------------------------------------------- tokens */

    /** ST's tokenizer for the current model, cached by model + text hash. */
    async tokens(text: string): Promise<number> {
        if (!text) return 0;
        const model = connectionFrom(this.live())?.model ?? '';
        const key = `${model}|${stableHash(text)}`;
        const cached = this.tokenCache.get(key);
        if (cached !== undefined) return cached;
        const running = this.pending.get(key);
        if (running) return running;
        const job = (async () => {
            let value: number;
            try {
                const counted = Number(await this.app.host.ctx().getTokenCountAsync(text));
                value = Number.isFinite(counted) && counted >= 0 ? counted : Math.ceil(text.length / 3.5);
            } catch {
                value = Math.ceil(text.length / 3.5);
            }
            if (this.tokenCache.size >= TOKEN_CACHE_LIMIT) {
                const oldest = this.tokenCache.keys().next().value;
                if (oldest !== undefined) this.tokenCache.delete(oldest);
            }
            this.tokenCache.set(key, value);
            this.pending.delete(key);
            return value;
        })();
        this.pending.set(key, job);
        return job;
    }

    /* ---------------------------------------------------------------- assembly */

    private async prepare(body: PresetBody | undefined, options: PresetAnalysisOptions = {}): Promise<Prepared> {
        const working = body === undefined;
        const source = body ?? this.workingBody();
        const counts = await this.promptManagerCounts();
        const texts = this.markerTexts();
        const lore = this.loreTokens();
        const markerTokens = new Map<string, { tokens: number; from: 'st' | 'count' }>();
        for (const id of MARKER_IDS) {
            const counted = counts?.[id];
            if (typeof counted === 'number' && counted > 0) {
                markerTokens.set(id, { tokens: counted, from: 'st' });
                continue;
            }
            const loreTokens = lore.get(id);
            if (loreTokens) {
                markerTokens.set(id, { tokens: loreTokens, from: 'count' });
                continue;
            }
            const text = texts.get(id);
            if (text) markerTokens.set(id, { tokens: await this.tokens(text), from: 'count' });
        }
        const markersWithText = new Set([...markerTokens].filter(([, value]) => value.tokens > 0).map(([id]) => id));
        const slots = this.extensionSlots();
        const assembly = assemblePrompt({
            prompts: source.prompts,
            order: resolveOrder(source.prompt_order),
            type: options.type,
            slots,
            markersWithText,
            overridden: this.overridden(),
        });
        return {
            body: source,
            working,
            assembly,
            counts,
            markerTokens,
            markersWithText,
            slots,
            connection: connectionFrom(this.live()),
        };
    }

    private async slotTokens(
        prepared: Prepared,
        slot: AssembledSlot,
    ): Promise<{ tokens: number; from: 'st' | 'count' }> {
        if (slot.marker) return prepared.markerTokens.get(slot.identifier) ?? { tokens: 0, from: 'count' };
        // ST's count is better only where macros expand; main's count also holds the injections around it.
        const counted = prepared.counts?.[slot.identifier];
        if (
            prepared.working &&
            slot.identifier !== 'main' &&
            slot.placement === 'relative' &&
            typeof counted === 'number' &&
            counted > 0 &&
            slot.content.includes('{{')
        ) {
            return { tokens: counted, from: 'st' };
        }
        return { tokens: await this.tokens(slot.content), from: 'count' };
    }

    private droppedText(slot: AssembledSlot, type: string): string {
        const code = slot.dropped!;
        const issue = DROP_ISSUE[code];
        const value = (issue && slot.typeIssues.find((item) => item.code === issue)?.value) ?? '';
        return this.t(`m34.an.drop.${code}`, { value, type, triggers: (slot.triggers ?? []).join(', ') });
    }

    private noteText(note: NoteCode, slot: AssembledSlot, assembly: Assembly): string {
        if (note !== 'merged') return this.t(`m34.an.note.${note}`, { type: assembly.type });
        const names = (slot.mergedWith ?? []).map(
            (id) => assembly.slots.find((other) => other.identifier === id)?.name ?? id,
        );
        if (slot.injections.some((injection) => injection.where === 'chat')) {
            names.push(this.t('m34.an.note.mergedInjections'));
        }
        return this.t('m34.an.note.merged', { others: names.join(', ') });
    }

    private async mapInjection(injection: AssembledInjection): Promise<MapInjection> {
        const result: MapInjection = {
            owner: injection.owner,
            key: injection.key,
            tokens: await this.tokens(injection.text),
            where: injection.where,
        };
        if (injection.depth !== undefined) result.depth = injection.depth;
        if (injection.role !== undefined) result.role = injection.role;
        return result;
    }

    private async toMap(prepared: Prepared): Promise<MapSlot[]> {
        const { assembly } = prepared;
        const result: MapSlot[] = [];
        for (const slot of assembly.slots) {
            const { tokens, from } = await this.slotTokens(prepared, slot);
            const item: MapSlot = {
                identifier: slot.identifier,
                name: slot.name,
                role: slot.role,
                placement: slot.placement,
                tokens,
                tokensFrom: from,
                enabled: slot.enabled,
                marker: slot.marker,
                injections: [],
            };
            if (slot.depth !== undefined) item.depth = slot.depth;
            if (slot.order !== undefined) item.order = slot.order;
            if (slot.triggers) item.triggers = [...slot.triggers];
            for (const injection of slot.injections) item.injections.push(await this.mapInjection(injection));
            if (slot.dropped && slot.enabled) {
                item.dropped = this.droppedText(slot, assembly.type);
                item.droppedCode = slot.dropped;
            }
            if (slot.notes.length) {
                item.noteCodes = [...slot.notes];
                item.note = slot.notes.map((note) => this.noteText(note, slot, assembly)).join(' ');
            }
            result.push(item);
        }
        return result;
    }

    /* ---------------------------------------------------------------- API */

    async map(body?: PresetBody, options?: PresetAnalysisOptions): Promise<MapSlot[]> {
        return this.toMap(await this.prepare(body, options));
    }

    async findings(body?: PresetBody, options?: PresetAnalysisOptions): Promise<PresetFinding[]> {
        const prepared = await this.prepare(body, options);
        const map = await this.toMap(prepared);
        const findings: PresetFinding[] = [];
        this.unsavedFindings(prepared, findings);
        this.macroFindings(prepared, findings);
        this.placementFindings(prepared, findings);
        this.typeFindings(prepared, findings);
        this.emptyFindings(prepared, findings);
        this.quirkFindings(prepared, findings);
        this.contradictionFindings(prepared, findings);
        this.duplicateFindings(prepared, findings);
        this.heavyFindings(prepared, map, findings);
        // Warnings first; the order inside a severity follows the checks above.
        return [
            ...findings.filter((item) => item.severity === 'warn'),
            ...findings.filter((item) => item.severity === 'info'),
        ];
    }

    hints(): ProviderHint[] {
        if (!this.app.host.isChatCompletion()) return [];
        return providerHints(connectionFrom(this.live())).map((line) => ({
            model: line.model,
            key: line.key,
            text: this.t(`m34.an.hint.${line.key}`, { current: '—', ...line.params }),
        }));
    }

    /* ---------------------------------------------------------------- findings */

    /** Blocks the model really gets (texts of their own). */
    private sentBlocks(prepared: Prepared): AssembledSlot[] {
        return prepared.assembly.slots.filter(
            (slot) => slot.enabled && slot.sent && !slot.marker && slot.content.trim(),
        );
    }

    private unsavedFindings(prepared: Prepared, out: PresetFinding[]): void {
        const store = this.storeOf();
        if (!prepared.working || !store) return;
        try {
            const draft = store.draft();
            if (!draft.dirty) return;
            out.push({
                kind: 'unsaved',
                severity: 'warn',
                text: this.t('m34.an.f.unsaved', {
                    prompts: draft.changedPrompts.length,
                    keys: draft.changedKeys.length,
                }),
            });
        } catch (error) {
            this.log.debug('preset draft state', error);
        }
    }

    private macroFindings(prepared: Prepared, out: PresetFinding[]): void {
        if (this.app.host.ctx().powerUserSettings?.experimental_macro_engine !== false) return;
        const blocks = prepared.assembly.slots.filter((slot) => slot.enabled && hasIfMacro(slot.content));
        if (!blocks.length) return;
        out.push({
            kind: 'macroEngineOff',
            severity: 'warn',
            identifier: blocks[0]!.identifier,
            text: this.t('m34.an.f.macroEngineOff', { blocks: blocks.map((slot) => `«${slot.name}»`).join(', ') }),
        });
    }

    private placementFindings(prepared: Prepared, out: PresetFinding[]): void {
        const { assembly } = prepared;
        if (!assembly.history) {
            const history = assembly.slots.find((slot) => slot.identifier === 'chatHistory');
            const reason = !history
                ? this.t('m34.an.f.history.missing')
                : !history.enabled
                  ? this.t('m34.an.f.history.disabled')
                  : this.t('m34.an.f.history.trigger', { type: assembly.type });
            out.push({
                kind: 'neverIncluded',
                severity: 'warn',
                identifier: 'chatHistory',
                text: this.t('m34.an.f.history', { reason }),
            });
        }
        for (const slot of assembly.slots) {
            if (!slot.enabled) continue;
            if (
                slot.dropped &&
                !DROPS_AS_TYPE.has(slot.dropped) &&
                slot.dropped !== 'noHistory' &&
                slot.dropped !== 'trigger'
            ) {
                out.push({
                    kind: 'neverIncluded',
                    severity: 'info',
                    identifier: slot.identifier,
                    text: this.t('m34.an.f.dropped', {
                        name: slot.name,
                        reason: this.droppedText(slot, assembly.type),
                    }),
                });
            }
            for (const note of slot.notes) {
                if (note !== 'movedToEnd' && note !== 'notInList') continue;
                out.push({
                    kind: 'neverIncluded',
                    severity: 'warn',
                    identifier: slot.identifier,
                    text: this.t('m34.an.f.moved', { name: slot.name, note: this.noteText(note, slot, assembly) }),
                });
            }
        }
        const lostMain = assembly.lost.filter((injection) => injection.where !== 'chat');
        if (lostMain.length) {
            out.push({
                kind: 'neverIncluded',
                severity: 'warn',
                identifier: 'main',
                text: this.t('m34.an.f.lostMain', { keys: lostMain.map((item) => item.key).join(', ') }),
            });
        }
        const lostChat = assembly.lost.filter((injection) => injection.where === 'chat');
        if (lostChat.length && assembly.history) {
            out.push({
                kind: 'neverIncluded',
                severity: 'warn',
                text: this.t('m34.an.f.lostChat', { keys: lostChat.map((item) => item.key).join(', ') }),
            });
        }
    }

    private typeFindings(prepared: Prepared, out: PresetFinding[]): void {
        const { assembly } = prepared;
        for (const slot of assembly.slots) {
            if (!slot.enabled) continue;
            const reported = new Set<TypeIssueCode>();
            if (slot.dropped && DROPS_AS_TYPE.has(slot.dropped)) {
                const issue = DROP_ISSUE[slot.dropped];
                if (issue) reported.add(issue);
                out.push({
                    kind: 'typeMismatch',
                    severity: 'warn',
                    identifier: slot.identifier,
                    text: this.t('m34.an.f.dropped', {
                        name: slot.name,
                        reason: this.droppedText(slot, assembly.type),
                    }),
                });
            }
            for (const issue of slot.typeIssues) {
                if (reported.has(issue.code)) continue;
                reported.add(issue.code);
                out.push({
                    kind: 'typeMismatch',
                    severity: WARN_ISSUES.has(issue.code) ? 'warn' : 'info',
                    identifier: slot.identifier,
                    text: this.t(`m34.an.f.type.${issue.code}`, { name: slot.name, value: issue.value }),
                });
            }
        }
    }

    private emptyFindings(prepared: Prepared, out: PresetFinding[]): void {
        for (const slot of prepared.assembly.slots) {
            if (!slot.enabled || !slot.sent || slot.marker || slot.placement !== 'relative') continue;
            const issue = emptyMessageIssue(slot.content);
            if (!issue) continue;
            out.push({
                kind: 'emptyMessage',
                severity: 'warn',
                identifier: slot.identifier,
                text: this.t(`m34.an.f.empty.${issue}`, { name: slot.name }),
            });
        }
    }

    private tailSource(tail: PromptTail, assembly: Assembly): string {
        if (tail.via === 'bias') return this.t('m34.an.tail.bias');
        if (tail.via === 'continue') return this.t('m34.an.tail.continue');
        if (tail.via === 'injection') return this.t('m34.an.tail.injection', { key: tail.identifier });
        const name = assembly.slots.find((slot) => slot.identifier === tail.identifier)?.name ?? tail.identifier;
        return this.t('m34.an.tail.block', { name });
    }

    private quirkFindings(prepared: Prepared, out: PresetFinding[]): void {
        const { assembly, connection } = prepared;
        const profile = connection ? modelProfile(connection.model) : null;
        const quirks = modelQuirks(connection);
        if (!profile || !connection) return;
        const model = profile.label;
        if (quirks.has('prefillEos')) {
            const user = this.app.host.ctx().powerUserSettings ?? {};
            const tail = promptTail(assembly, {
                bias: typeof user.user_prompt_bias === 'string' ? user.user_prompt_bias : '',
                continuePrefill: connection.continuePrefill,
                markersWithText: prepared.markersWithText,
            });
            if (tail?.role === 'assistant') {
                const finding: PresetFinding = {
                    kind: 'modelQuirk',
                    severity: 'warn',
                    text: this.t('m34.an.f.quirk.prefill', { model, source: this.tailSource(tail, assembly) }),
                };
                if (tail.via === 'block') finding.identifier = tail.identifier;
                out.push(finding);
            }
        }
        const depthSent = assembly.slots.filter((slot) => slot.placement === 'depth' && slot.enabled && slot.sent);
        if (quirks.has('systemMerge')) {
            const blocks = depthSent.filter((slot) => slot.role === 'system' && (slot.depth ?? 0) >= 1);
            const owners = new Map<string, number>();
            for (const slot of assembly.slots) {
                for (const injection of slot.injections) {
                    if (injection.where !== 'chat' || injection.role !== 'system' || (injection.depth ?? 0) < 1)
                        continue;
                    owners.set(injection.owner, (owners.get(injection.owner) ?? 0) + 1);
                }
            }
            const list = [
                ...blocks.map((slot) => `«${slot.name}» @${slot.depth}`),
                ...[...owners].map(([owner, count]) => `${owner} ×${count}`),
            ];
            if (list.length) {
                const finding: PresetFinding = {
                    kind: 'modelQuirk',
                    severity: 'info',
                    text: this.t('m34.an.f.quirk.systemMerge', { model, list: list.join(', ') }),
                };
                if (blocks[0]) finding.identifier = blocks[0].identifier;
                out.push(finding);
            }
        }
        if (quirks.has('assistantDepth')) {
            const blocks = depthSent.filter((slot) => slot.role === 'assistant' && !slot.marker);
            if (blocks.length) {
                out.push({
                    kind: 'modelQuirk',
                    severity: 'info',
                    identifier: blocks[0]!.identifier,
                    text: this.t('m34.an.f.quirk.assistantDepth', {
                        model,
                        list: blocks.map((slot) => `«${slot.name}» @${slot.depth}`).join(', '),
                    }),
                });
            }
        }
    }

    private valueLabel(hit: ContradictionHit, value: string): string {
        if (hit.topic === 'length') return value;
        const negated = value.startsWith('!');
        const label = this.t(`m34.an.val.${negated ? value.slice(1) : value}`);
        return negated ? this.t('m34.an.val.not', { value: label }) : label;
    }

    private contradictionFindings(prepared: Prepared, out: PresetFinding[]): void {
        const blocks = this.sentBlocks(prepared);
        const names = new Map(blocks.map((slot) => [slot.identifier, slot.name]));
        const hits = findContradictions(blocks.map((slot) => ({ identifier: slot.identifier, text: slot.content })));
        for (const hit of hits.slice(0, MAX_PAIR_FINDINGS)) {
            out.push({
                kind: 'contradiction',
                severity: hit.topic === 'length' ? 'info' : 'warn',
                identifier: hit.a,
                otherIdentifier: hit.b,
                text: this.t('m34.an.f.contradiction', {
                    a: names.get(hit.a) ?? hit.a,
                    b: names.get(hit.b) ?? hit.b,
                    topic: this.t(`m34.an.topic.${hit.topic}`),
                    left: this.valueLabel(hit, hit.left),
                    right: this.valueLabel(hit, hit.right),
                }),
            });
        }
    }

    private duplicateFindings(prepared: Prepared, out: PresetFinding[]): void {
        const blocks = this.sentBlocks(prepared);
        const shingles = new Map(blocks.map((slot) => [slot.identifier, shingleSet(slot.content)]));
        // Blocks among themselves.
        let pairs = 0;
        for (let i = 0; i < blocks.length && pairs < MAX_PAIR_FINDINGS; i++) {
            for (let j = i + 1; j < blocks.length && pairs < MAX_PAIR_FINDINGS; j++) {
                const a = blocks[i]!;
                const b = blocks[j]!;
                if (sameText(a.content, b.content)) {
                    out.push({
                        kind: 'duplicateBlock',
                        severity: 'warn',
                        identifier: a.identifier,
                        otherIdentifier: b.identifier,
                        text: this.t('m34.an.f.dupBlock.same', { a: a.name, b: b.name }),
                    });
                    pairs++;
                    continue;
                }
                const left = shingles.get(a.identifier)!;
                const right = shingles.get(b.identifier)!;
                const value = overlap(left, right);
                if (value.containment < NEAR_DUPLICATE || !isOverlapping(value)) continue;
                const [small, large] = left.size <= right.size ? [a, b] : [b, a];
                out.push({
                    kind: 'duplicateBlock',
                    severity: 'info',
                    identifier: small.identifier,
                    otherIdentifier: large.identifier,
                    text: this.t('m34.an.f.dupBlock.near', {
                        a: small.name,
                        b: large.name,
                        percent: percent(value.containment),
                    }),
                });
                pairs++;
            }
        }
        // Blocks against extension prompts (DES tracker instructions copied into the preset, …).
        const injections = prepared.slots
            .filter((slot) => slot.position !== -1)
            .map((slot) => ({ slot, shingles: shingleSet(slot.value) }));
        for (const block of blocks) {
            const own = shingles.get(block.identifier)!;
            const best = new Map<string, { key: string; containment: number }>();
            for (const { slot, shingles: theirs } of injections) {
                const value = overlap(own, theirs);
                if (!isOverlapping(value)) continue;
                const owner = slotOwner(slot.key);
                const previous = best.get(owner);
                if (!previous || previous.containment < value.containment) {
                    best.set(owner, { key: slot.key, containment: value.containment });
                }
            }
            for (const [owner, value] of best) {
                out.push({
                    kind: 'duplicateWithInjection',
                    severity: 'info',
                    identifier: block.identifier,
                    text: this.t('m34.an.f.dupInjection', {
                        name: block.name,
                        owner,
                        key: value.key,
                        percent: percent(value.containment),
                    }),
                });
            }
        }
        // Blocks against the lore that reached the prompt on the last real turn (M1).
        const lore = this.app.modules.api<LoreJournalApi>('loreJournal')?.lastContents?.() ?? [];
        if (!lore.length) return;
        const entries = lore.map((entry) => ({ entry, shingles: shingleSet(entry.content) }));
        for (const block of blocks) {
            const own = shingles.get(block.identifier)!;
            const matches = entries
                .map(({ entry, shingles: theirs }) => ({ entry, value: overlap(own, theirs) }))
                .filter(({ value }) => isOverlapping(value))
                .sort((a, b) => b.value.containment - a.value.containment)
                .slice(0, 2);
            for (const { entry, value } of matches) {
                out.push({
                    kind: 'duplicateWithLore',
                    severity: 'info',
                    identifier: block.identifier,
                    text: this.t('m34.an.f.dupLore', {
                        name: block.name,
                        entry: entry.comment || String(entry.uid),
                        book: entry.world,
                        percent: percent(value.containment),
                    }),
                });
            }
        }
    }

    private heavyFindings(prepared: Prepared, map: MapSlot[], out: PresetFinding[]): void {
        const sent = new Set(this.sentBlocks(prepared).map((slot) => slot.identifier));
        const weighted = map
            .filter((slot) => sent.has(slot.identifier))
            .map((slot) => ({ identifier: slot.identifier, tokens: slot.tokens, name: slot.name }));
        for (const block of heavyBlocks(weighted)) {
            const name = weighted.find((item) => item.identifier === block.identifier)?.name ?? block.identifier;
            out.push({
                kind: 'heavyBlock',
                severity: 'info',
                identifier: block.identifier,
                text: this.t('m34.an.f.heavy', { name, tokens: block.tokens, percent: percent(block.share) }),
            });
        }
    }
}

/**
 * The analysis service of the Preset Studio, exposed as 'presetAnalysis' (PRESET_ANALYSIS_KEY). The result is the API
 * itself (with `api` pointing to the same functions), `install()` registers the strings and returns the disposers,
 * `dispose()` drops the caches.
 */
export function createPresetAnalysis(app: App, log: Logger, store?: PresetStore): PresetAnalysis {
    const analyzer = new PresetAnalyzer(app, log, store);
    const api: PresetAnalysisApi = {
        map: (body, options) => analyzer.map(body, options),
        findings: (body, options) => analyzer.findings(body, options),
        hints: () => analyzer.hints(),
    };
    return {
        ...api,
        api,
        install: () => analyzer.install(),
        dispose: () => analyzer.dispose(),
    };
}
