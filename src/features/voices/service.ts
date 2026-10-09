// M15 «Голоса персонажей» (plan M15, M19 п. 3, §2.2, §16, P11, P15, P16): a compact card for every character present
// in the scene, one ephemeral injection near the end of the prompt, and CarrotKernel's quiet mode.
//
// - Cast: the DES tracker of the committed reply (P14; src/domain/voices-cards.ts sceneTracker), names resolved through
//   the world model, the persona and characters hidden in DES left out.
// - Data: LING tags, the Linguistics block and MBTI from the character's CK archive (the world entity's 'ck.archive'
//   source, read through M35 when it runs, else ST's loadWorldInfo; cached per entry, reloaded when its book is saved),
//   the demeanor, goal fields and relationship status of the tracker, open quests that name the character, M19's
//   history for «was …» and for attitudes between present characters.
// - Send path (P15): everything is assembled at `turn:committed` / `chat:changed` (and when a source changes); archives
//   load in the background and are warmed at `reply:ready`. The ephemeral producer only takes the cached cards.
// - Stage 9 (M18, when it runs): «Unaware of: …» — what a present character does not know among the topics of the last
//   four messages (up to the user's answer); rebuilt in the background when M18's facts change.
// - Quiet mode (§2.2): while cards go out, CK's «Character Consistency» text is taken out of the assembled prompt at
//   CHAT_COMPLETION_PROMPT_READY (CK's slot and settings are never touched), and DES-RU is told to stop rebuilding it
//   (`ck.consistencyRebuild`, given back when the module stops — P11). The code is shared with the Dramatis bridge
//   (./ck-quiet.ts).
// - Dramatis (1.17, docs/integration-dramatis.md): while Dramatis is present, claims 'voices' and says this generation
//   gets its cast block, the cards do not go out as `maestro_voices` — Dramatis renders one combined block with the
//   speech from MAESTRO_API.speech(). CK's insert still leaves the prompt while cards exist (their speech is in that
//   block), and also without cards when Dramatis claims 'ck.consistency'. Dramatis may decide its block after Maestro's
//   producers ran, so the choice is checked again at PROMPT_READY: cards already injected leave the prompt then.
import { adaptersOf, dramatisOf } from '../../adapters';
import { estimateTokens } from '../../domain/rules-lore';
import { desSwipeRecord, parseDesCharacters } from '../../domain/des-tracker';
import type { DesCharacter, DesQuests } from '../../domain/des-tracker';
import { lastUserIndex, recentStoryText, unknownLine } from '../../domain/knowledge-match';
import { lastCommittedIndex } from '../../domain/relations-history';
import { sceneCast } from '../../domain/scene-cast';
import {
    attitudeNow,
    detailGoals,
    detailState,
    fitVoices,
    presentBonds,
    presentCharacters,
    questsFor,
    relationOf,
    sceneTracker,
} from '../../domain/voices-cards';
import type { FittedVoices, RelationLike, VoiceInput } from '../../domain/voices-cards';
import { removeSlotText } from '../../domain/voices-prompt';
import { archiveVoiceFromSheet, archiveVoiceOf } from '../../domain/voices-speech';
import type { ArchiveVoice } from '../../domain/voices-speech';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type { ArchitectApi } from '../architect/api';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { KnowledgeApi } from '../knowledge/api';
import type { RelationsApi } from '../relations/api';
import type { Entity, WorldModelApi } from '../world/api';
import type { VoiceCard, VoicesApi, VoicesInjection, VoicesQuietState } from './api';
import { CkQuiet } from './ck-quiet';
import { DEFAULT_CAP, VOICES_KEY, readVoicesSettings } from './settings';
import type { VoicesSettings } from './settings';

export { CK_FUNCTION } from './ck-quiet';

/** Ephemeral injection key (extension prompt `maestro_voices`). */
export const VOICES_INJECTION = 'voices';
const ARCHIVE_CACHE_LIMIT = 300;
/** A saved book is read again a moment later: M35 drops its own copy on the same event. */
const RELOAD_DELAY_MS = 200;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SceneMember {
    /** Canonical name (world model) or the DES name. */
    name: string;
    entity?: Entity;
    character: DesCharacter;
}

interface Scene {
    key: string;
    /** Message the tracker was read from (-1: none). */
    base: number;
    persona: string;
    members: SceneMember[];
    quests: DesQuests | null;
    /** Story text of the last messages (M18 topics); '' while M18 is off. */
    recent: string;
}

interface Built {
    key: string;
    fitted: FittedVoices;
    budgetSource: 'architect' | 'cap';
}

interface Bound<T> {
    api: T | undefined;
    off: Unsubscribe | null;
}

function splitRef(ref: string): { book: string; uid: number } {
    const at = ref.lastIndexOf('#');
    return { book: ref.slice(0, at), uid: Number(ref.slice(at + 1)) };
}

export class VoicesService {
    private scene: Scene | null = null;
    private built: Built | null = null;
    private persona: { key: string; name: string } | null = null;
    private readonly archives = new Map<string, ArchiveVoice | null>();
    /** Load generation per archive ref: a newer load (the book was saved) wins over an older one still running. */
    private readonly loads = new Map<string, number>();
    private readonly running = new Set<string>();
    private readonly versions = { world: 0, relations: 0, archives: 0, knowledge: 0 };
    private readonly world: Bound<WorldModelApi> = { api: undefined, off: null };
    private readonly relations: Bound<RelationsApi> = { api: undefined, off: null };
    private readonly knowledge: Bound<KnowledgeApi> = { api: undefined, off: null };
    private armed = false;
    /** A real generation is running (its producer ran): PROMPT_READY may change its prompt. */
    private live = false;
    /** The cards text injected into the running generation ('' when none went out as `maestro_voices`). */
    private injected = '';
    /** The last real generation's cards went into Dramatis's block instead of `maestro_voices`. */
    private merged = false;
    private lastCk: VoicesQuietState['ck'] = null;
    private readonly ck: CkQuiet;
    private readonly listeners = new Set<() => void>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.ck = new CkQuiet(app, log);
    }

    settings(): VoicesSettings {
        return readVoicesSettings(this.app.settings.module<Partial<VoicesSettings>>(VOICES_KEY));
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { host, bus } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown): void => {
            const name = host.events.name(key);
            if (!name) {
                this.log.debug(`ST event ${key} is missing`);
                return;
            }
            own(host.events.on(name, handler));
        };
        own(this.app.ephemeral.addProducer(VOICES_INJECTION, (gen) => this.produce(gen)));
        // Normal order: CK's text leaves before M20 (last) measures the final prompt.
        on('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data));
        on('WORLDINFO_UPDATED', (name) => this.onBookSaved(name));
        own(
            bus.on('chat:changed', () => {
                this.armed = false;
                this.live = false;
                this.injected = '';
                this.scene = null;
                this.built = null;
                this.claimDesRu();
                this.refresh();
            }),
        );
        own(bus.on('turn:committed', () => this.refresh()));
        own(bus.on('message:invalidated', () => this.refresh()));
        own(bus.on('reply:ready', ({ messageIndex }) => this.warm(messageIndex)));
        own(
            bus.on('generation:ended', () => {
                this.armed = false;
                this.live = false;
                this.injected = '';
            }),
        );
        own(
            this.app.settings.onChange((path) => {
                if (path.startsWith('m15.') || path.startsWith('m20.')) this.changed();
            }),
        );
        own(() => this.dispose());
        // Dramatis's claims and its cast change what goes out: the view follows them.
        const dramatis = dramatisOf(this.app);
        if (dramatis) {
            own(dramatis.onQuietChange(() => this.changed()));
            own(dramatis.onChange(() => this.changed()));
        }
        this.claimDesRu();
        this.refresh();
    }

    private dispose(): void {
        this.disposed = true;
        this.armed = false;
        this.live = false;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        for (const bound of [this.world, this.relations, this.knowledge] as Bound<unknown>[]) {
            bound.off?.();
            bound.off = null;
            bound.api = undefined;
        }
        this.releaseDesRu();
        this.listeners.clear();
    }

    private later(task: () => void, ms: number): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.disposed) return;
            try {
                task();
            } catch (error) {
                this.log.warn('voices background step failed', error);
            }
        }, ms);
        this.timers.add(timer);
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('voices listener failed', error);
            }
        }
    }

    /** The scene changed (a committed turn, another chat, an edit): the cards are assembled again now. */
    refresh(): void {
        if (this.disposed) return;
        this.scene = null;
        try {
            this.ensureFresh();
        } catch (error) {
            this.log.warn('voice cards could not be built', error);
        }
        this.changed();
    }

    /* ---------------------------------------------------------------- neighbours */

    private bind<T extends { onChange(listener: () => void): Unsubscribe }>(
        bound: Bound<T>,
        key: string,
        bump: () => void,
    ): T | undefined {
        const api = this.app.modules.api<T>(key);
        if (api === bound.api) return api;
        bound.off?.();
        bound.off = null;
        bound.api = api;
        bump();
        if (api && !this.disposed) {
            try {
                bound.off = api.onChange(() => {
                    bump();
                    this.changed();
                });
            } catch (error) {
                this.log.debug(`cannot follow ${key}`, error);
            }
        }
        return api;
    }

    /** Re-binds to the world model and M19 (cheap identity checks; a restarted module gives a new API object). */
    private follow(): void {
        this.bind(this.world, 'world', () => {
            this.versions.world++;
        });
        this.bind(this.relations, 'relations', () => {
            this.versions.relations++;
        });
        // M18's facts change a moment after a commit: the cards are rebuilt then, not in the next send.
        this.bind(this.knowledge, 'knowledge', () => {
            this.versions.knowledge++;
            this.later(() => this.ensureFresh(), 0);
        });
    }

    /** «Unaware of: …» from M18 (feature-detected; '' while it is off or nothing came up). */
    private unknownOf(name: string, recent: string): string {
        const api = this.knowledge.api;
        if (!api || !recent) return '';
        try {
            return unknownLine(api.unknownFor(name, recent));
        } catch (error) {
            this.log.debug('M18 knowledge is not available', error);
            return '';
        }
    }

    private resolve(name: string): Entity | undefined {
        const world = this.world.api;
        if (!world) return undefined;
        try {
            return world.resolve(name, 'character') ?? world.resolve(name);
        } catch {
            return undefined;
        }
    }

    /** The persona's canonical name (cached per name and world version: the producer must not query the world). */
    private personaName(): string {
        const name = (this.app.host.ctx().name1 ?? '').trim();
        const key = `${name}|${this.versions.world}`;
        if (this.persona?.key === key) return this.persona.name;
        let resolved = name;
        if (name) {
            try {
                resolved = this.world.api?.resolve(name, 'persona')?.name ?? name;
            } catch {
                resolved = name;
            }
        }
        this.persona = { key, name: resolved };
        return resolved;
    }

    /** Names hidden from DES's «Present Characters» in this chat. */
    private hiddenNames(): string[] {
        try {
            const des = adaptersOf(this.app).des as { removedCharacters?: () => string[] } | undefined;
            return typeof des?.removedCharacters === 'function' ? des.removedCharacters() : [];
        } catch {
            return [];
        }
    }

    private relationList(): RelationLike[] {
        try {
            return this.relations.api?.all() ?? [];
        } catch (error) {
            this.log.debug('relations are not available', error);
            return [];
        }
    }

    private budget(settings: VoicesSettings): { tokens: number; source: 'architect' | 'cap' } {
        try {
            const row = this.app.modules
                .api<ArchitectApi>('architect')
                ?.budgets()
                .find((item) => item.source === 'voices');
            if (row && row.tokens > 0) return { tokens: row.tokens, source: 'architect' };
        } catch (error) {
            this.log.debug('architect budgets are not available', error);
        }
        return { tokens: settings.cap > 0 ? settings.cap : DEFAULT_CAP, source: 'cap' };
    }

    /* ---------------------------------------------------------------- archives */

    private archiveSource(entity: Entity): { book: string; uid: number } | null {
        const source = entity.sources.find(
            (item) => item.kind === 'ck.archive' && !!item.world && typeof item.uid === 'number',
        );
        return source?.world !== undefined && source.uid !== undefined ? { book: source.world, uid: source.uid } : null;
    }

    /** The cached voice of the entity's archive; a missing one starts loading (the cards follow when it arrives). */
    private archiveOf(entity: Entity): ArchiveVoice | null {
        const source = this.archiveSource(entity);
        if (!source) return null;
        const ref = `${source.book}#${source.uid}`;
        if (this.archives.has(ref)) return this.archives.get(ref) ?? null;
        this.load(ref, false);
        return null;
    }

    private load(ref: string, force: boolean): void {
        if (this.disposed) return;
        if (!force && (this.archives.has(ref) || this.running.has(ref))) return;
        const generation = (this.loads.get(ref) ?? 0) + 1;
        this.loads.set(ref, generation);
        this.running.add(ref);
        const { book, uid } = splitRef(ref);
        void this.readArchive(book, uid)
            .then((voice) => {
                if (this.disposed || this.loads.get(ref) !== generation) return;
                if (this.archives.size >= ARCHIVE_CACHE_LIMIT && !this.archives.has(ref)) this.archives.clear();
                this.archives.set(ref, voice);
                this.versions.archives++;
                this.changed();
            })
            .catch((error: unknown) => this.log.debug(`archive ${ref} could not be read`, error))
            .finally(() => {
                if (this.loads.get(ref) === generation) this.running.delete(ref);
            });
    }

    private async readArchive(book: string, uid: number): Promise<ArchiveVoice | null> {
        const mode = this.app.modules.api<BunnyMoModeApi>('bunnymoMode');
        if (mode) {
            try {
                const sheet = await mode.readSheet(book, uid);
                return sheet ? archiveVoiceFromSheet(sheet) : null;
            } catch (error) {
                this.log.debug(`M35 could not read ${book}#${uid}`, error);
            }
        }
        const load = this.app.host.ctx().loadWorldInfo;
        if (typeof load !== 'function') return null;
        const data = await load(book);
        const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
        const entry =
            Object.values(entries).find((item) => isDict(item) && Number(item.uid) === uid) ?? entries[String(uid)];
        return isDict(entry) ? archiveVoiceOf(entry.content) : null;
    }

    /** WORLDINFO_UPDATED: archives of the saved book are read again (the old voice stays until the new one is in). */
    private onBookSaved(name: unknown): void {
        if (typeof name !== 'string' || this.disposed) return;
        const refs = [...this.archives.keys(), ...this.running].filter((ref) => splitRef(ref).book === name);
        if (!refs.length) return;
        this.later(() => {
            for (const ref of new Set(refs)) this.load(ref, true);
        }, RELOAD_DELAY_MS);
    }

    /** `reply:ready`: archives of the characters in the new reply are loaded before the user sends the next message. */
    private warm(messageIndex: number): void {
        if (this.disposed) return;
        try {
            this.follow();
            const record = desSwipeRecord(this.app.host.ctx().chat?.[messageIndex]);
            if (!record) return;
            for (const character of presentCharacters(parseDesCharacters(record.characterThoughts))) {
                const entity = this.resolve(character.name);
                if (entity && entity.kind !== 'persona') this.archiveOf(entity);
            }
        } catch (error) {
            this.log.debug('archives could not be warmed', error);
        }
    }

    /* ---------------------------------------------------------------- cards */

    private sceneNow(): Scene {
        const chat = (this.app.host.ctx().chat ?? []) as unknown[];
        const chatId = this.app.host.chatId();
        const committed = lastCommittedIndex(chat as STChatMessage[]);
        const message = chat[committed];
        const hidden = this.hiddenNames();
        const persona = this.personaName();
        // M18 reads the user's answer too: an edit of it changes the topics.
        const knowing = !!this.knowledge.api;
        const user = knowing ? lastUserIndex(chat) : -1;
        const answer = chat[user];
        const key = [
            chatId ?? '',
            committed,
            isDict(message) ? String(message.swipe_id ?? 0) : '',
            isDict(message) && typeof message.mes === 'string' ? message.mes.length : 0,
            persona,
            hidden.join('\u0001'),
            this.versions.world,
            knowing ? `${user}:${isDict(answer) && typeof answer.mes === 'string' ? answer.mes.length : 0}` : '',
        ].join('|');
        if (this.scene?.key === key) return this.scene;

        const tracker = chatId ? sceneTracker(chat) : null;
        const members: SceneMember[] = sceneCast<Entity>(tracker, {
            persona,
            ownName: this.app.host.ctx().name1 ?? '',
            hidden,
            resolve: (name) => this.resolve(name),
        });
        this.scene = {
            key,
            base: tracker?.index ?? -1,
            persona,
            members,
            quests: tracker?.snapshot.quests ?? null,
            recent: knowing && members.length ? recentStoryText(chat) : '',
        };
        return this.scene;
    }

    private inputs(scene: Scene, relations: readonly RelationLike[]): VoiceInput[] {
        return scene.members.map((member) => {
            const entity = member.entity;
            const needles = entity ? [entity.name, ...entity.aliases, ...entity.forms] : [member.name];
            const goals = [
                ...detailGoals(member.character.details),
                ...questsFor(scene.quests, needles).map((quest) => `quest: ${quest}`),
            ];
            const relation =
                relationOf(relations, member.name, scene.persona) ??
                relationOf(relations, member.character.name, scene.persona);
            const input: VoiceInput = {
                name: member.name,
                aliases: entity ? entity.aliases : [],
                voice: entity ? this.archiveOf(entity) : null,
                persona: scene.persona,
                attitude: attitudeNow(member.character.relationship, relation, scene.base),
                goals,
            };
            if (entity) input.entityId = entity.id;
            const state = detailState(member.character.details);
            if (state) input.state = state;
            const unknown = this.unknownOf(member.name, scene.recent);
            if (unknown) input.unknown = unknown;
            return input;
        });
    }

    /** The cards for the next generation, rebuilt only when the scene, a source, the budget or a setting changed. */
    private ensureFresh(): Built {
        this.follow();
        const scene = this.sceneNow();
        const settings = this.settings();
        const budget = this.budget(settings);
        const key = [
            scene.key,
            budget.tokens,
            settings.goals,
            settings.npcAttitudes,
            this.versions.archives,
            this.versions.relations,
            this.versions.knowledge,
        ].join('|');
        if (this.built?.key === key) return this.built;
        const relations = scene.members.length ? this.relationList() : [];
        const bonds = settings.npcAttitudes
            ? presentBonds(
                  relations,
                  scene.members.map((member) => member.name),
                  scene.persona,
              )
            : [];
        const fitted = fitVoices(this.inputs(scene, relations), bonds, {
            budget: budget.tokens,
            goals: settings.goals,
            bonds: settings.npcAttitudes,
        });
        this.built = { key, fitted, budgetSource: budget.source };
        return this.built;
    }

    /** Archives are still being read (the cards will fill in). */
    loading(): boolean {
        return this.running.size > 0;
    }

    cards(): VoiceCard[] {
        if (this.disposed) return [];
        return this.ensureFresh().fitted.cards.map((card) => ({ ...card }));
    }

    injection(): VoicesInjection {
        const built = this.ensureFresh();
        const { fitted } = built;
        return {
            text: fitted.text,
            tokens: fitted.tokens,
            budget: fitted.budget,
            budgetSource: built.budgetSource,
            trimmed: [...fitted.trimmed],
            dropped: [...fitted.dropped],
            bonds: [...fitted.bonds],
        };
    }

    /* ---------------------------------------------------------------- generation */

    /** Dramatis silences this function for the generation (present, claims it, its cast block goes out). */
    private dramatisSilences(fn: 'voices' | 'ck.consistency'): boolean {
        try {
            return dramatisOf(this.app)?.silences(fn) === true;
        } catch (error) {
            this.log.debug('Dramatis is not readable', error);
            return false;
        }
    }

    /**
     * Ephemeral producer: the cached cards go into every real generation (not quiet, dry or a sheet command) — unless
     * Dramatis takes them into its own block.
     */
    private produce(gen: GenerationInfo): void {
        this.armed = false;
        this.live = false;
        this.injected = '';
        if (this.disposed || gen.quiet || gen.dryRun || gen.sheetCommand || !this.app.host.chatId()) return;
        this.live = true;
        this.claimDesRu();
        const { fitted } = this.ensureFresh();
        this.merged = false;
        if (!fitted.text) return;
        // Cards exist: CK's insert leaves the prompt whether they go out here or in Dramatis's block.
        this.armed = true;
        if (this.dramatisSilences('voices')) {
            this.merged = true;
            return;
        }
        // P16: in chat at depth 1 (right before the last message), system role, never scanned.
        this.app.ephemeral.setInjection(VOICES_INJECTION, {
            text: fitted.text,
            position: 1,
            depth: 1,
            role: 0,
            scan: false,
        });
        this.injected = fitted.text;
    }

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    /**
     * CHAT_COMPLETION_PROMPT_READY of a real generation: CK's «Character Consistency» text leaves the prompt when cards
     * exist or Dramatis claims it; cards that went out leave it again when Dramatis took them over after the producer.
     */
    private onPromptReady(data: unknown): void {
        if (!this.live || !isDict(data) || data.dryRun !== false || !Array.isArray(data.chat)) return;
        const messages = data.chat as unknown[];
        if (this.injected && this.dramatisSilences('voices')) {
            try {
                const result = removeSlotText(messages, this.injected, (text) => this.substitute(text));
                if (result.removed) {
                    this.merged = true;
                    this.log.debug(
                        `voice cards left the prompt for the Dramatis block (${estimateTokens(result.chars)})`,
                    );
                }
            } catch (error) {
                this.log.warn('voice cards could not be taken out for Dramatis', error);
            }
            this.injected = '';
        }
        if (!this.armed && !this.dramatisSilences('ck.consistency')) return;
        this.lastCk = this.ck.remove(messages);
        this.changed();
    }

    /* ---------------------------------------------------------------- DES-RU */

    /** DES-RU stops rebuilding CK's insert (its other functions Maestro owns stay as they are). */
    private claimDesRu(): void {
        if (this.disposed) return;
        this.ck.claimDesRu();
    }

    /** P11: the function goes back to DES-RU when the module stops. */
    private releaseDesRu(): void {
        this.ck.releaseDesRu();
    }

    quiet(): VoicesQuietState {
        const armed = !this.disposed && this.ensureFresh().fitted.cards.length > 0;
        return {
            armed,
            ck: this.lastCk ? { ...this.lastCk } : null,
            desru: this.ck.desRuState(),
            dramatis: this.dramatisState(),
        };
    }

    /** What Dramatis does with the cards now: they go into its block, or Maestro sends them itself. */
    private dramatisState(): NonNullable<VoicesQuietState['dramatis']> {
        const present = ((): boolean => {
            try {
                return dramatisOf(this.app)?.present() === true;
            } catch {
                return false;
            }
        })();
        return { present, merged: present && this.dramatisSilences('voices'), lastMerged: this.merged };
    }

    /** Quiet mode works: cards go out, CK's insert was not left in the last prompt, DES-RU (when there) was told. */
    ckSilenced(): boolean {
        const state = this.quiet();
        return state.armed && state.ck?.outcome !== 'notFound' && state.desru !== 'notTold';
    }

    api(): VoicesApi {
        return {
            cards: () => this.cards(),
            ckSilenced: () => this.ckSilenced(),
            onChange: (listener) => this.onChange(listener),
            quiet: () => this.quiet(),
            injection: () => this.injection(),
        };
    }
}
