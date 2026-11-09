// What an agent sees (plan §3.4, §4.1 «реестр источников»): each source has an id, a title the model reads, a default
// budget and a renderer over the open chat. Modules and neighbours are read through their public APIs (duck-typed: a
// module that is off gives nothing). Sources are computed lazily and cached per run (one canon read for three agents).
// Other modules (and neighbours, release 1.34) add sources with AgentsApi.registerSource.
import { adaptersOf } from '../../adapters';
import { parseDesTracker, desSwipeRecord } from '../../domain/des-tracker';
import type { DesCharacter } from '../../domain/des-tracker';
import type { RenderedSource } from '../../domain/agents/request';
import { stripTrackerBlocks } from '../../domain/agents/rewrite';
import { cleanForAnalysis as cleanStory } from '../../domain/text-clean';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { DirectorApi } from '../director/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type { KnowledgeApi } from '../knowledge/api';
import type { MechanicsApi } from '../mechanics/api';
import type { PlacesApi } from '../places/api';
import type { StagingApi } from '../staging/api';
import { describeEntry } from '../../domain/staging';
import type { WorldModelApi } from '../world/api';
import type { AgentsChatState } from './chat-state';

/** Story text for an agent: Maestro's cleaning plus DES tracker blocks anywhere (a continued reply). */
export function agentText(message: unknown): string {
    return stripTrackerBlocks(cleanStory(message));
}

const cleanForAnalysis = agentText;

/** The moment a source is read for. */
export interface SourceContext {
    app: App;
    agentId: string;
    /** The reply the agent works on (post, rewrite, manual on a message); undefined = the end of the chat. */
    focusIndex?: number;
    /** The text to show as the reply (a rewrite gets the reply without its service blocks). */
    replyText?: string;
    state: AgentsChatState;
}

export interface ContextSource {
    id: string;
    /** i18n key of the label in the editor. */
    labelKey: string;
    /** English title the model reads. */
    title: string;
    /** Default budget: characters ('messages': a count of messages). */
    budget: number;
    /** Stable sources go first in a request (cache, P16). */
    stable: boolean;
    /** Shown only when this is true (module on, neighbour present). */
    available?(app: App): boolean;
    render(ctx: SourceContext, budget: number): string | Promise<string>;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cutEnd(text: string, budget: number): string {
    return text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}

function cutStart(text: string, budget: number): string {
    return text.length <= budget ? text : `…${text.slice(text.length - budget + 1).trimStart()}`;
}

function chatOf(app: App): STChatMessage[] {
    try {
        return app.host.ctx().chat ?? [];
    } catch {
        return [];
    }
}

/** The index the «current» part of the chat ends before (the reply in focus, else the chat length). */
function endOf(ctx: SourceContext): number {
    const chat = chatOf(ctx.app);
    return ctx.focusIndex === undefined ? chat.length : Math.min(ctx.focusIndex, chat.length);
}

function speakerOf(message: STChatMessage): string {
    return typeof message.name === 'string' && message.name ? message.name : message.is_user ? 'User' : 'Narrator';
}

/** Story messages before `end`, newest last, as «Name: text». */
export function recentMessages(app: App, end: number, count: number): string[] {
    const chat = chatOf(app);
    const out: string[] = [];
    for (let i = Math.min(end, chat.length) - 1; i >= 0 && out.length < count; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const text = cleanForAnalysis(message);
        if (!text) continue;
        out.unshift(`${speakerOf(message)}: ${text}`);
    }
    return out;
}

function lastAssistantBefore(app: App, end: number): STChatMessage | undefined {
    const chat = chatOf(app);
    for (let i = Math.min(end, chat.length) - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) return message;
    }
    return undefined;
}

function cardOf(app: App): Dict | undefined {
    try {
        const ctx = app.host.ctx();
        if (app.host.isGroupChat()) return undefined;
        const id = ctx.characterId;
        const card = id === undefined || id === '' ? undefined : (ctx.characters[Number(id)] as unknown);
        return isDict(card) ? card : undefined;
    } catch {
        return undefined;
    }
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function characterLines(characters: readonly DesCharacter[]): string {
    return characters
        .map((character) => {
            const fields = [
                ...Object.entries(character.details ?? {})
                    .filter(([, value]) => typeof value === 'string' && value.trim())
                    .map(([key, value]) => `${key}: ${value}`),
                character.relationship ? `relationship: ${character.relationship}` : '',
                character.thoughts ? `thoughts: ${character.thoughts}` : '',
            ]
                .filter(Boolean)
                .join('; ');
            const away = character.offScene ? ' (off-scene)' : '';
            return `- ${character.name}${away}${fields ? ` — ${fields}` : ''}`;
        })
        .join('\n');
}

/* ------------------------------------------------------------------ the built-in sources */

export const BUILTIN_SOURCES: readonly ContextSource[] = [
    {
        id: 'messages',
        labelKey: 'm44.src.messages',
        title: 'Recent messages (oldest first)',
        budget: 6,
        stable: false,
        render: (ctx, budget) =>
            cutStart(recentMessages(ctx.app, endOf(ctx), Math.max(1, Math.min(60, budget))).join('\n\n'), 12_000),
    },
    {
        id: 'userMessage',
        labelKey: 'm44.src.userMessage',
        title: "The player's latest message",
        budget: 3000,
        stable: false,
        render: (ctx, budget) => {
            const chat = chatOf(ctx.app);
            for (let i = endOf(ctx) - 1; i >= 0; i--) {
                const message = chat[i];
                if (message?.is_user) return cutEnd(cleanForAnalysis(message), budget);
            }
            return '';
        },
    },
    {
        id: 'reply',
        labelKey: 'm44.src.reply',
        title: 'The reply',
        budget: 12_000,
        stable: false,
        render: (ctx, budget) => {
            if (ctx.replyText !== undefined) return ctx.replyText.slice(0, budget);
            const chat = chatOf(ctx.app);
            const index = ctx.focusIndex ?? chat.length - 1;
            const message = chat[index];
            if (!message || message.is_user) return '';
            return cutEnd(cleanForAnalysis(message), budget);
        },
    },
    {
        id: 'card',
        labelKey: 'm44.src.card',
        title: 'Character card',
        budget: 1500,
        stable: true,
        render: (ctx, budget) => {
            const card = cardOf(ctx.app);
            if (!card) return '';
            const data = isDict(card.data) ? card.data : card;
            const parts = [
                `Name: ${str(card.name)}`,
                str(data.description ?? card.description),
                str(data.personality ?? card.personality)
                    ? `Personality: ${str(data.personality ?? card.personality)}`
                    : '',
                str(data.scenario ?? card.scenario) ? `Scenario: ${str(data.scenario ?? card.scenario)}` : '',
            ].filter(Boolean);
            return cutEnd(parts.join('\n'), budget);
        },
    },
    {
        id: 'persona',
        labelKey: 'm44.src.persona',
        title: "The player's persona",
        budget: 800,
        stable: true,
        render: (ctx, budget) => {
            try {
                const c = ctx.app.host.ctx() as unknown as Dict;
                const power = isDict(c.powerUserSettings) ? c.powerUserSettings : {};
                const name = str(c.name1);
                const description = str(power.persona_description);
                return cutEnd([name ? `Name: ${name}` : '', description].filter(Boolean).join('\n'), budget);
            } catch {
                return '';
            }
        },
    },
    {
        id: 'lore',
        labelKey: 'm44.src.lore',
        title: 'Lorebook entries active this turn',
        budget: 3000,
        stable: true,
        available: (app) => app.modules.api<LoreJournalApi>('loreJournal') !== undefined,
        render: (ctx, budget) => {
            const journal = ctx.app.modules.api<LoreJournalApi>('loreJournal');
            const contents = journal?.lastContents?.() ?? [];
            const text = contents
                .filter((entry) => entry.content.trim())
                .map(
                    (entry) =>
                        `[${entry.comment || entry.world} · ${entry.world}#${entry.uid}] ${entry.content.trim()}`,
                )
                .join('\n\n');
            return cutEnd(text, budget);
        },
    },
    {
        id: 'canon',
        labelKey: 'm44.src.canon',
        title: 'Facts of this chat (canon)',
        budget: 2000,
        stable: true,
        available: (app) => app.modules.api('canon') !== undefined,
        render: async (ctx, budget) => {
            const canon = ctx.app.modules.api<{ list(filter?: Dict): Promise<unknown[]> }>('canon');
            if (!canon) return '';
            try {
                const items = await canon.list({ status: 'active' });
                const lines = items
                    .filter(isDict)
                    .map((item) => {
                        const entry = isDict(item.entry) ? item.entry : {};
                        const name = str(entry.comment);
                        const text = str(entry.content);
                        return text ? `- ${name ? `${name}: ` : ''}${text}` : '';
                    })
                    .filter(Boolean);
                return cutEnd(lines.join('\n'), budget);
            } catch {
                return '';
            }
        },
    },
    {
        id: 'qvink',
        labelKey: 'm44.src.qvink',
        title: 'Story memory (summaries)',
        budget: 2000,
        stable: true,
        available: (app) => adaptersOf(app).qvink?.present() === true,
        render: (ctx, budget) => {
            const qvink = adaptersOf(ctx.app).qvink as unknown as { memoryOf?(index: number): Dict | null } | undefined;
            if (!qvink?.memoryOf) return '';
            const chat = chatOf(ctx.app);
            const lines: string[] = [];
            for (let i = 0; i < Math.min(endOf(ctx), chat.length); i++) {
                const memory = qvink.memoryOf(i);
                const text = memory && !memory.exclude ? str(memory.memory) : '';
                if (text && (memory?.include || memory?.remember)) lines.push(text);
            }
            return cutStart(lines.join('\n'), budget);
        },
    },
    {
        id: 'desScene',
        labelKey: 'm44.src.desScene',
        title: 'The scene now (place, time, weather, who is here)',
        budget: 600,
        stable: false,
        available: (app) => adaptersOf(app).des?.present() === true,
        render: (ctx, budget) => {
            const message = lastAssistantBefore(ctx.app, (ctx.focusIndex ?? chatOf(ctx.app).length - 1) + 1);
            const record = message ? desSwipeRecord(message) : null;
            if (!record) return '';
            const snapshot = parseDesTracker(record);
            const info = snapshot.infoBox;
            const lines: string[] = [];
            if (info) {
                for (const [label, value] of [
                    ['Place', info.location],
                    ['Date', info.date],
                    ['Time', info.time ? `${info.time.start ?? ''}${info.time.end ? `–${info.time.end}` : ''}` : ''],
                    ['Weather', info.weather?.forecast ?? ''],
                ] as const) {
                    if (typeof value === 'string' && value.trim()) lines.push(`${label}: ${value.trim()}`);
                }
            }
            const present = snapshot.characters
                .filter((character) => !character.offScene)
                .map((character) => character.name);
            if (present.length) lines.push(`Present: ${present.join(', ')}`);
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'desCharacters',
        labelKey: 'm44.src.desCharacters',
        title: 'Characters of the scene (tracker)',
        budget: 1500,
        stable: false,
        available: (app) => adaptersOf(app).des?.present() === true,
        render: (ctx, budget) => {
            const message = lastAssistantBefore(ctx.app, (ctx.focusIndex ?? chatOf(ctx.app).length - 1) + 1);
            const record = message ? desSwipeRecord(message) : null;
            if (!record) return '';
            return cutEnd(characterLines(parseDesTracker(record).characters), budget);
        },
    },
    {
        id: 'mechanics',
        labelKey: 'm44.src.mechanics',
        title: 'Game state (mechanics)',
        budget: 1200,
        stable: false,
        available: (app) => app.modules.api<MechanicsApi>('mechanics') !== undefined,
        render: (ctx, budget) => {
            const preview = ctx.app.modules.api<MechanicsApi>('mechanics')?.previewPrompt?.();
            return preview ? cutEnd((preview.state ?? preview.text).trim(), budget) : '';
        },
    },
    {
        id: 'director',
        labelKey: 'm44.src.director',
        title: 'Scene type and pace (director)',
        budget: 300,
        stable: false,
        available: (app) => app.modules.api<DirectorApi>('director') !== undefined,
        render: (ctx, budget) => {
            const director = ctx.app.modules.api<DirectorApi>('director');
            if (!director) return '';
            const scene = director.scene();
            const stall = director.stall();
            const lines = [
                scene ? `Scene type: ${scene.type} (held ${scene.held} turns)` : '',
                stall.turns ? `Stalling for ${stall.turns} turns (${stall.reasons.join(', ')})` : '',
            ].filter(Boolean);
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'knowledge',
        labelKey: 'm44.src.knowledge',
        title: 'Who knows what (secrets and known facts)',
        budget: 1500,
        stable: false,
        available: (app) => app.modules.api<KnowledgeApi>('knowledge') !== undefined,
        render: (ctx, budget) => {
            const facts = ctx.app.modules.api<KnowledgeApi>('knowledge')?.facts() ?? [];
            const lines = facts.map(
                (fact) =>
                    `- ${fact.secret ? '[secret] ' : ''}${fact.text} — known by: ${fact.knownBy.join(', ') || 'nobody'}`,
            );
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'worldNames',
        labelKey: 'm44.src.worldNames',
        title: 'Names the world already knows (characters, places, things)',
        budget: 1500,
        stable: true,
        available: (app) => app.modules.api<WorldModelApi>('world') !== undefined,
        render: (ctx, budget) => {
            const world = ctx.app.modules.api<WorldModelApi>('world');
            if (!world) return '';
            const byKind = new Map<string, string[]>();
            for (const entity of world.entities()) {
                const list = byKind.get(entity.kind) ?? [];
                list.push(
                    entity.aliases.length ? `${entity.name} (${entity.aliases.slice(0, 3).join(', ')})` : entity.name,
                );
                byKind.set(entity.kind, list);
            }
            const lines = [...byKind.entries()].map(([kind, list]) => `${kind}: ${list.join('; ')}`);
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'places',
        labelKey: 'm44.src.places',
        title: 'Places (the current one first)',
        budget: 800,
        stable: false,
        available: (app) => app.modules.api<PlacesApi>('places') !== undefined,
        render: (ctx, budget) => {
            const places = ctx.app.modules.api<PlacesApi>('places');
            if (!places) return '';
            const current = places.current();
            const others = places
                .list()
                .filter((place) => place.id !== current?.id)
                .map((place) => place.name);
            const lines = [
                current
                    ? `Now: ${current.name}${current.entry ? ` (lore: ${current.entry.world}#${current.entry.uid})` : ' (no lore entry yet)'}`
                    : '',
                others.length ? `Known: ${others.join(', ')}` : '',
            ].filter(Boolean);
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'wardrobe',
        labelKey: 'm44.src.wardrobe',
        title: 'Who wears what (and their known outfits)',
        budget: 800,
        stable: false,
        available: (app) => typeof app.modules.api<{ agentText?: () => string }>('wardrobe')?.agentText === 'function',
        render: (ctx, budget) =>
            cutEnd(ctx.app.modules.api<{ agentText?: () => string }>('wardrobe')?.agentText?.() ?? '', budget),
    },
    {
        id: 'staging',
        labelKey: 'm44.src.staging',
        title: 'Staging now (poses and positions)',
        budget: 800,
        stable: false,
        available: (app) => app.modules.api<StagingApi>('staging') !== undefined,
        render: (ctx, budget) => {
            const staging = ctx.app.modules.api<StagingApi>('staging');
            const entries = staging?.current() ?? [];
            return cutEnd(entries.map((entry) => `- ${describeEntry(entry)}`).join('\n'), budget);
        },
    },
    {
        id: 'ownMemory',
        labelKey: 'm44.src.ownMemory',
        title: 'Your own records in this chat',
        budget: 1500,
        stable: false,
        render: (ctx, budget) => {
            const memory = ctx.state.memory(ctx.agentId);
            const lines = Object.entries(memory.fields).map(([name, value]) => {
                const locked = memory.locked.includes(name) ? ' (locked: keep as is)' : '';
                return `${name}${locked}: ${value}`;
            });
            return cutEnd(lines.join('\n'), budget);
        },
    },
    {
        id: 'lastResult',
        labelKey: 'm44.src.lastResult',
        title: 'What you answered last time',
        budget: 1500,
        stable: false,
        render: (ctx, budget) => {
            const doc = ctx.state.doc;
            const prepared = doc.prepared[ctx.agentId]?.text;
            const standing = doc.standing[ctx.agentId]?.text;
            const last = [...doc.results].reverse().find((item) => item.agentId === ctx.agentId);
            const text = prepared ?? standing ?? (last ? JSON.stringify(last.data) : '');
            return cutEnd(text, budget);
        },
    },
];

/* ------------------------------------------------------------------ registry */

export class SourceRegistry {
    private readonly sources = new Map<string, ContextSource>();

    constructor() {
        for (const source of BUILTIN_SOURCES) this.sources.set(source.id, source);
    }

    register(source: ContextSource): Unsubscribe {
        this.sources.set(source.id, source);
        return () => {
            if (this.sources.get(source.id) === source) this.sources.delete(source.id);
        };
    }

    get(id: string): ContextSource | undefined {
        return this.sources.get(id);
    }

    list(app: App): ContextSource[] {
        return [...this.sources.values()].filter((source) => {
            try {
                return source.available ? source.available(app) : true;
            } catch {
                return false;
            }
        });
    }

    /** Renders the sources an agent asked for; a failing source gives nothing. */
    async render(refs: readonly { id: string; budget?: number }[], ctx: SourceContext): Promise<RenderedSource[]> {
        const out: RenderedSource[] = [];
        for (const ref of refs) {
            const source = this.sources.get(ref.id);
            if (!source) continue;
            try {
                if (source.available && !source.available(ctx.app)) continue;
                const text = await source.render(ctx, ref.budget ?? source.budget);
                if (text.trim()) out.push({ id: source.id, title: source.title, text, stable: source.stable });
            } catch {
                // a module changed under us: the agent runs without this source
            }
        }
        return out;
    }
}
