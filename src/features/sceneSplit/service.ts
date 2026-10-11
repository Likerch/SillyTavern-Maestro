// M43 «Сцена и вокруг»: the service behind SceneSplitApi.
// - Every normal generation (not quiet, impersonate, a dry run or a BunnyMo sheet command) gets a short English system
//   note at depth 0 (P16: the very end, like the director's note): narrate the scene only; what happens elsewhere goes
//   after it as one `<offscreen>…</offscreen>` block in the story's language (core/language.ts), or nowhere.
// - The block is shown folded under the reply («Вокруг»): display.ts. The stored text keeps it.
// - Old blocks do not pile up in the prompt: prompt.ts (generate interceptor).
// - Departures: who the narration shows leaving is out of the scene from the next turn (domain/scene-departures.ts),
//   for MAESTRO_API.present(), voice cards, the wardrobe line, mechanics, knowledge and the architect.
// Analysis never reads the block (domain/text-clean.ts cleanForAnalysis). Off — by its switch, the module switch or a
// workshop chat — nothing of this runs and the chat looks as SillyTavern draws it.
import { adaptersOf } from '../../adapters';
import { storyLanguage } from '../../core/language';
import { DEPARTURE_LOOKBACK, departedCharacters } from '../../domain/scene-departures';
import type { DepartureCandidate } from '../../domain/scene-departures';
import { OFFSCREEN_TAG, sceneSplitInstruction } from '../../domain/scene-split';
import { presentCharacters, sceneTracker } from '../../domain/voices-cards';
import { normalizeName } from '../../domain/world-names';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type { Entity, WorldModelApi } from '../world/api';
import type { SceneSplitApi } from './api';
import { AroundDisplay } from './display';
import { PromptCleaner } from './prompt';
import { SCENE_SPLIT_INJECTION, SCENE_SPLIT_KEY } from './settings';
import type { SceneSplitSettings } from './settings';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Departure results kept (the committed reply's, the newest reply's, one chat change apart). */
const DEPARTURES_KEPT = 4;

/** Generation types that write a story reply. */
const STORY_TYPES: ReadonlySet<string> = new Set(['normal', 'swipe', 'regenerate', 'continue', '']);

export class SceneSplitService implements SceneSplitApi {
    readonly tag = OFFSCREEN_TAG;
    private readonly display: AroundDisplay;
    private readonly prompt: PromptCleaner;
    private running = false;
    /** Departures by what they were read from (the committed and the newest reply alternate: a few are kept). */
    private readonly departures = new Map<string, string[]>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => SceneSplitSettings,
        refreshMs?: number,
    ) {
        this.display = new AroundDisplay(app, log, () => ({ active: this.active(), label: this.label() }), refreshMs);
        this.prompt = new PromptCleaner(app, log, () => this.settings().keepRecent);
    }

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { app } = this;
        this.running = true;
        own(() => {
            this.running = false;
            this.departures.clear();
        });
        own(app.ephemeral.addProducer(SCENE_SPLIT_INJECTION, (gen) => this.produce(gen)));
        own(app.turn.onIntercept((chat, info) => this.intercept(chat, info)));
        own(
            app.bus.on('chat:changed', () => {
                this.prompt.reset();
                this.departures.clear();
                this.display.sync();
            }),
        );
        own(
            app.settings.onChange((path) => {
                if (path === `modules.${SCENE_SPLIT_KEY}` || path.startsWith(`modules.${SCENE_SPLIT_KEY}.`)) {
                    this.departures.clear();
                    this.display.sync();
                }
            }),
        );
        this.display.start();
        own(() => this.display.dispose());
    }

    /* ---------------------------------------------------------------- SceneSplitApi */

    active(): boolean {
        return this.running && this.settings().enabled;
    }

    departed(chat?: readonly unknown[], options: { latest?: boolean } = {}): string[] {
        if (!this.active()) return [];
        try {
            const ctx = this.app.host.ctx();
            const base = chat ?? ((ctx.chat ?? []) as readonly unknown[]);
            const view = options.latest === true ? [...base, { is_user: true }] : base;
            const tracker = sceneTracker(view);
            if (!tracker) return [];
            const own = normalizeName(String(ctx.name1 ?? ''));
            const present = presentCharacters(tracker.snapshot.characters, this.hiddenInDes()).filter(
                (character) => normalizeName(character.name) !== own,
            );
            if (!present.length) return [];
            const key = this.keyOf(
                view,
                present.map((character) => character.name),
            );
            const known = this.departures.get(key);
            if (known) return [...known];
            const candidates = present
                .map((character) => this.candidate(character.name))
                .filter((candidate): candidate is DepartureCandidate => candidate !== null);
            const names = departedCharacters(view, candidates);
            if (this.departures.size >= DEPARTURES_KEPT) this.departures.delete(this.departures.keys().next().value!);
            this.departures.set(key, names);
            return [...names];
        } catch (error) {
            this.log.debug('scene split: departures not readable', error);
            return [];
        }
    }

    /** The summary of the folded box. */
    label(): string {
        return this.settings().label.trim() || this.app.i18n.t('m43.summary');
    }

    /** The formatter hooks are in place (ST 1.19). */
    hooked(): boolean {
        return this.display.hooked();
    }

    /** The note the next generation gets ('' while off). */
    instruction(): string {
        if (!this.active()) return '';
        return sceneSplitInstruction(storyLanguage(this.app), String(this.app.host.ctx().name1 ?? ''));
    }

    /* ---------------------------------------------------------------- the generation */

    private produce(gen: GenerationInfo): void {
        if (gen.quiet || gen.dryRun || gen.sheetCommand || !STORY_TYPES.has(gen.type)) return;
        if (!this.active() || !this.app.host.chatId()) return;
        const text = this.instruction();
        if (!text) return;
        // P16: one-shot, at the very end of the chat history, as a system note; never scanned for lore.
        this.app.ephemeral.setInjection(SCENE_SPLIT_INJECTION, { text, position: 1, depth: 0, role: 0, scan: false });
    }

    private async intercept(chat: STChatMessage[], info: GenerationInfo): Promise<void> {
        if (!this.active()) return;
        await this.prompt.clean(chat, info);
    }

    /* ---------------------------------------------------------------- departures */

    private hiddenInDes(): string[] {
        try {
            const des = adaptersOf(this.app).des as { removedCharacters?: () => string[] } | undefined;
            return typeof des?.removedCharacters === 'function' ? des.removedCharacters() : [];
        } catch {
            return [];
        }
    }

    private candidate(name: string): DepartureCandidate | null {
        let entity: Entity | undefined;
        try {
            const world = this.app.modules.api<WorldModelApi>('world');
            entity = world?.resolve(name, 'character') ?? world?.resolve(name) ?? undefined;
        } catch {
            entity = undefined;
        }
        if (entity?.kind === 'persona') return null;
        const names = entity ? [entity.name, ...entity.aliases] : [];
        let forms = entity?.forms ?? [];
        if (!forms.length) {
            try {
                const found = adaptersOf(this.app).desru.api()?.nameForms(name);
                forms = Array.isArray(found) ? found.filter((form): form is string => typeof form === 'string') : [];
            } catch {
                forms = [];
            }
        }
        return { name, names, forms };
    }

    /** What departures depend on: the chat, the messages read back and the cast. */
    private keyOf(view: readonly unknown[], names: readonly string[]): string {
        const parts: string[] = [this.app.host.chatId() ?? '', String(view.length), names.join('\u0001')];
        let replies = 0;
        let started = false;
        for (let i = view.length - 1; i >= 0 && replies <= DEPARTURE_LOOKBACK; i--) {
            const message = view[i];
            if (!isDict(message)) continue;
            if (message.is_user === true) started = true;
            if (!started) continue;
            if (message.is_user !== true && message.is_system !== true) replies++;
            const length = typeof message.mes === 'string' ? message.mes.length : -1;
            parts.push(`${i}:${String(message.swipe_id ?? '')}:${length}:${message.is_system === true ? 1 : 0}`);
        }
        return parts.join('|');
    }
}
