// DES's own ES modules for writing its tracker the way DES does (research/des.md §4 "Importing DES modules", §8): the
// tracker repair of M3 «Медик» and the prepared starting scenes of M37 «Подготовить к игре» (release 1.18). They are
// imported by the same URL DES's index.js uses, so ST's module map hands back DES's live instances: `export let`
// values (lastGeneratedData, committedTrackerData, isGenerating) are read through the namespace every time, never
// cached. Every module below is statically imported by DES's index.js, so importing it runs no DES code a second time.
// Plan §10.8–9: callers check the Workshop first; the roster goes through DES's accessors (persistence.js
// getActiveKnownCharacters / saveCharacterRosterChange), never `chat_metadata.dooms_tracker` directly.
import type { App, Logger } from '../../shared/contracts';

type Namespace = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

/** Sections as DES stores them: JSON strings or null. */
export interface DesSections {
    quests: string | null;
    infoBox: string | null;
    characterThoughts: string | null;
}

export interface DesParsed extends DesSections {
    parsingFailed?: boolean;
}

/** DES module paths relative to its folder and the exports Maestro calls. */
export const DES_KIT_MODULES = {
    state: { path: 'src/core/state.js', required: ['lastGeneratedData', 'committedTrackerData'] },
    persistence: { path: 'src/core/persistence.js', required: ['saveChatData'] },
    parser: { path: 'src/systems/generation/parser.js', required: ['parseResponse'] },
    promptBuilder: { path: 'src/systems/generation/promptBuilder.js', required: ['generateSeparateUpdatePrompt'] },
    lockManager: { path: 'src/systems/generation/lockManager.js', required: ['removeLocks'] },
    aliases: { path: 'src/systems/features/characterAliases.js', required: ['applyCharacterAliases'] },
    guards: { path: 'src/utils/messageGuards.js', required: ['isSyntheticTrackerMessage'] },
    infoBox: { path: 'src/systems/rendering/infoBox.js', required: ['renderInfoBox'] },
    thoughts: { path: 'src/systems/rendering/thoughts.js', required: ['renderThoughts', 'updateChatThoughts'] },
    quests: { path: 'src/systems/rendering/quests.js', required: ['renderQuests'] },
    sceneHeaders: { path: 'src/systems/rendering/sceneHeaders.js', required: ['updateChatSceneHeaders'] },
    portraitBar: { path: 'src/systems/ui/portraitBar.js', required: ['updatePortraitBar'] },
    weather: { path: 'src/systems/ui/weatherEffects.js', required: ['updateWeatherEffect'] },
    bubbles: { path: 'src/systems/rendering/chatBubbles.js', required: ['harvestNewSpeakerColors'] },
    trackerJson: { path: 'src/systems/rendering/trackerJsonInline.js', required: ['syncTrackerJsonForMessage'] },
    injector: { path: 'src/systems/generation/injector.js', required: ['clearBoostForAppearedFields'] },
} as const;

export type DesKitKey = keyof typeof DES_KIT_MODULES;

/** Without these the kit cannot write DES's state the way DES does. */
const REQUIRED: readonly DesKitKey[] = ['state', 'persistence', 'parser'];

/**
 * Root-relative URL of DES's folder (`/scripts/extensions/third-party/<folder>/`). DES's manifest loads
 * `index.js` from the folder root, and its modules live under `src/` next to it.
 */
export function desFolderPath(extensionName: string): string {
    return `/scripts/extensions/${extensionName.split('/').map(encodeURIComponent).join('/')}/`;
}

/** The display/generation sections of a prepared start (quests are never written). */
export interface DesStartSections {
    infoBox: string | null;
    characterThoughts: string | null;
}

function sectionText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export class DesKit {
    constructor(
        private readonly modules: Partial<Record<DesKitKey, Namespace>>,
        private readonly log: Logger,
    ) {}

    has(key: DesKitKey): boolean {
        return !!this.modules[key];
    }

    private fn(key: DesKitKey, name: string): Fn | null {
        const value = this.modules[key]?.[name];
        return typeof value === 'function' ? (value as Fn) : null;
    }

    /** Calls an optional DES function; failures are logged, never thrown (rendering is cosmetic). */
    private call(key: DesKitKey, name: string, ...args: unknown[]): unknown {
        const fn = this.fn(key, name);
        if (!fn) return undefined;
        try {
            return fn(...args);
        } catch (error) {
            this.log.warn(`DES ${name} failed`, error);
            return undefined;
        }
    }

    /** DES's live display state (`lastGeneratedData`), read through the namespace (reassigned on chat load). */
    lastGenerated(): Record<string, unknown> | null {
        const value = this.modules.state?.lastGeneratedData;
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    }

    committed(): Record<string, unknown> | null {
        const value = this.modules.state?.committedTrackerData;
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    }

    /** DES runs its own separate/external update right now. */
    isGenerating(): boolean {
        return this.modules.state?.isGenerating === true;
    }

    canBuildPrompt(): boolean {
        return !!this.fn('promptBuilder', 'generateSeparateUpdatePrompt');
    }

    /** DES's separate-mode update prompt (history + previous committed tracker + FORMAT spec). */
    async updatePrompt(): Promise<{ role: string; content: string }[] | null> {
        const build = this.fn('promptBuilder', 'generateSeparateUpdatePrompt');
        if (!build) return null;
        const result = await build();
        if (!Array.isArray(result)) return null;
        return result
            .filter((item): item is { role: string; content: string } => {
                const entry = item as { role?: unknown; content?: unknown };
                return typeof entry?.role === 'string' && typeof entry.content === 'string';
            })
            .map((item) => ({ role: item.role, content: item.content }));
    }

    /** DES's parser (parser.js parseResponse): sections as JSON strings. */
    parse(text: string): DesParsed | null {
        const parse = this.fn('parser', 'parseResponse');
        if (!parse) return null;
        const result = parse(text) as Partial<DesParsed> | null | undefined;
        if (!result || typeof result !== 'object') return null;
        const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
        return {
            quests: str(result.quests),
            infoBox: str(result.infoBox),
            characterThoughts: str(result.characterThoughts),
            parsingFailed: result.parsingFailed === true,
        };
    }

    /**
     * What DES does to parsed sections before storing them (sillytavern.js onMessageReceived, apiClient.js
     * updateRPGData): strip lock markers, then canonicalise character names through the alias map.
     */
    normalise(parsed: DesSections): DesSections {
        const unlock = (value: string | null) => {
            if (value === null) return null;
            const result = this.call('lockManager', 'removeLocks', value);
            return typeof result === 'string' ? result : value;
        };
        const sections: DesSections = {
            quests: unlock(parsed.quests),
            infoBox: unlock(parsed.infoBox),
            characterThoughts: unlock(parsed.characterThoughts),
        };
        if (sections.characterThoughts !== null) {
            const aliased = this.call('aliases', 'applyCharacterAliases', sections.characterThoughts, {
                suggestSimilar: true,
            });
            if (typeof aliased === 'string') sections.characterThoughts = aliased;
        }
        return sections;
    }

    isSynthetic(message: unknown): boolean {
        return this.call('guards', 'isSyntheticTrackerMessage', message) === true;
    }

    /**
     * Updates DES's in-memory state like its together-mode parse: `lastGeneratedData` per present section (and
     * the global quests mirror through parseQuests); `committedTrackerData` only when nothing was committed yet,
     * as updateRPGData does on the very first update.
     */
    adopt(sections: DesSections, messageText: string): void {
        const last = this.lastGenerated();
        if (last) {
            if (sections.quests !== null) {
                last.quests = sections.quests;
                this.call('parser', 'parseQuests', sections.quests);
            }
            if (sections.infoBox !== null) last.infoBox = sections.infoBox;
            if (sections.characterThoughts !== null) {
                last.characterThoughts = sections.characterThoughts;
                this.call('bubbles', 'harvestNewSpeakerColors', messageText, sections.characterThoughts);
            }
        }
        const committed = this.committed();
        if (committed && !hasCommittedContent(committed)) {
            committed.quests = sections.quests;
            committed.infoBox = sections.infoBox;
            committed.characterThoughts = sections.characterThoughts;
        }
    }

    /** Restores `lastGeneratedData` sections (undo). */
    restoreLastGenerated(sections: Partial<DesSections>): void {
        const last = this.lastGenerated();
        if (!last) return;
        for (const key of ['quests', 'infoBox', 'characterThoughts'] as const) {
            if (key in sections) last[key] = sections[key] ?? null;
        }
    }

    /** DES's panels, scene headers, portraits and inline dropdowns for the repaired message. */
    render(sections: Partial<DesSections>, messageIndex: number): void {
        if (sections.infoBox) {
            this.call('injector', 'clearBoostForAppearedFields');
            this.call('infoBox', 'renderInfoBox');
        }
        if (sections.characterThoughts) this.call('thoughts', 'renderThoughts');
        if (sections.quests) this.call('quests', 'renderQuests');
        this.call('sceneHeaders', 'updateChatSceneHeaders');
        this.call('portraitBar', 'updatePortraitBar');
        if (sections.characterThoughts) this.call('thoughts', 'updateChatThoughts');
        this.call('trackerJson', 'syncTrackerJsonForMessage', messageIndex);
    }

    /* ---------------------------------------------------------------- a prepared start (M37, release 1.18) */

    /** The scene and characters sections DES shows and generates from now (copies of the strings). */
    startState(): { last: DesStartSections | null; committed: DesStartSections | null } {
        const pick = (value: Record<string, unknown> | null): DesStartSections | null =>
            value
                ? { infoBox: sectionText(value.infoBox), characterThoughts: sectionText(value.characterThoughts) }
                : null;
        return { last: pick(this.lastGenerated()), committed: pick(this.committed()) };
    }

    /**
     * Makes a starting scene's record what DES shows and generates from: `lastGeneratedData` and
     * `committedTrackerData` both get its scene and characters sections, nulls included (a swipe to a greeting without
     * a prepared scene clears the previous cast: DES's renderers fall back to the committed data). Quests stay. Through
     * DES's setters (state.js updateLastGeneratedData / updateCommittedTrackerData) when it exports them.
     */
    setStart(sections: DesStartSections, committed: DesStartSections = sections): void {
        const write = (setter: string, target: Record<string, unknown> | null, value: DesStartSections) => {
            const patch = { infoBox: value.infoBox, characterThoughts: value.characterThoughts };
            const fn = this.fn('state', setter);
            if (fn) {
                try {
                    fn(patch);
                    return;
                } catch (error) {
                    this.log.warn(`DES ${setter} failed`, error);
                }
            }
            if (target) Object.assign(target, patch);
        };
        write('updateLastGeneratedData', this.lastGenerated(), sections);
        write('updateCommittedTrackerData', this.committed(), committed);
    }

    /**
     * Redraws everything a starting scene's record shows (sillytavern.js onMessageSwiped does the same): the panels,
     * the scene headers (cache reset first), the portrait bar (it also adds present names to DES's roster), the weather
     * effect, the inline thoughts and the JSON dropdown of message `messageIndex`.
     */
    renderStart(messageIndex: number): void {
        this.call('infoBox', 'renderInfoBox');
        this.call('thoughts', 'renderThoughts');
        this.call('sceneHeaders', 'resetSceneHeaderCache');
        this.call('sceneHeaders', 'updateChatSceneHeaders');
        this.call('portraitBar', 'updatePortraitBar');
        this.call('weather', 'updateWeatherEffect');
        this.call('thoughts', 'updateChatThoughts');
        this.call('trackerJson', 'syncTrackerJsonForMessage', messageIndex);
    }

    /** DES's roster of this chat (persistence.js getActiveKnownCharacters: the live object), null without it. */
    roster(): Record<string, unknown> | null {
        const value = this.call('persistence', 'getActiveKnownCharacters');
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    }

    /** Saves a roster change where DES keeps it (persistence.js saveCharacterRosterChange). */
    saveRoster(): void {
        this.call('persistence', 'saveCharacterRosterChange');
    }

    /** persistence.saveChatData({immediate: true}): rebuilds chat_metadata.dooms_tracker and saves the chat. */
    async save(): Promise<void> {
        const save = this.fn('persistence', 'saveChatData');
        if (!save) return;
        await save({ immediate: true });
    }
}

/** updateRPGData's "is there any committed content" test (apiClient.js). */
function hasCommittedContent(committed: Record<string, unknown>): boolean {
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return (
        text(committed.quests) !== '' ||
        (text(committed.infoBox) !== '' && committed.infoBox !== 'Info Box\n---\n') ||
        (text(committed.characterThoughts) !== '' && committed.characterThoughts !== 'Present Characters\n---\n')
    );
}

/**
 * Imports DES's modules through `app.host.modules.load` (same-origin, root-relative URL). Null when DES is not
 * located or one of the required modules fails; optional modules are simply left out.
 */
export async function loadDesKit(app: App, log: Logger): Promise<DesKit | null> {
    const adapter = app.adapters.des as unknown as { extensionName?(): string | undefined };
    const name = typeof adapter.extensionName === 'function' ? adapter.extensionName() : undefined;
    if (!name) return null;
    const base = desFolderPath(name);
    const modules: Partial<Record<DesKitKey, Namespace>> = {};
    await Promise.all(
        (Object.keys(DES_KIT_MODULES) as DesKitKey[]).map(async (key) => {
            const spec = DES_KIT_MODULES[key];
            try {
                const namespace = await app.host.modules.load(`${base}${spec.path}`);
                if (spec.required.every((exported) => exported in namespace)) modules[key] = namespace;
                else log.debug(`DES ${spec.path} lacks ${spec.required.join(', ')}`);
            } catch (error) {
                log.debug(`DES ${spec.path} did not load`, error);
            }
        }),
    );
    const missing = REQUIRED.filter((key) => !modules[key]);
    if (missing.length) {
        log.warn(`DES modules missing for writing the tracker: ${missing.join(', ')}`);
        return null;
    }
    return new DesKit(modules, log);
}
