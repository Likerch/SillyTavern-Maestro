// Read tools over the story's world (M33): dossier of an entity, relationships, who knows what, the current place,
// story time and promises, outfits, the passports NAI Studio gets for the scene. All of it comes from the chat and
// the lore: untrusted.
import type { App } from '../../../../shared/contracts';
import type { CalendarApi, StoryPromise } from '../../../calendar/api';
import type { DossierApi } from '../../../dossier/api';
import type { KnowledgeApi, KnowledgeFact } from '../../../knowledge/api';
import type { LorePassportsApi } from '../../../lorePassports/api';
import type { PlacesApi, Place } from '../../../places/api';
import type { RelationsApi, Relation } from '../../../relations/api';
import type { WardrobeApi } from '../../../wardrobe/api';
import type { Entity, WorldModelApi } from '../../../world/api';
import type { ToolSpec } from '../../api';
import { normalizeText, stems } from '../../../../domain/assistant-docs';
import {
    apiOf,
    argsOf,
    capList,
    chatTexts,
    compact,
    cut,
    intArg,
    needsApi,
    notice,
    objectSchema,
    prop,
    readTool,
    safely,
    say,
    strArg,
    when,
    withTimeout,
} from './common';
import type { Dict } from './common';

const NAME = prop.string('A name, alias or Russian case form of a character, persona or place.');

/** The entity for a name: exact resolution, else a unique name/alias containing it. */
export function findEntity(app: App, name: string): Entity | undefined {
    const world = apiOf<WorldModelApi>(app, 'world');
    if (!world) return undefined;
    const exact = safely(() => world.resolve(name), undefined);
    if (exact) return exact;
    const wanted = normalizeText(name);
    const all = safely(() => world.entities(), [] as Entity[]);
    const partial = all.filter((entity) =>
        [entity.name, ...entity.aliases].some((item) => normalizeText(item).includes(wanted)),
    );
    return partial.length === 1 ? partial[0] : undefined;
}

/** Canonical name for a name (the world model's, else the name itself). */
function canonicalName(app: App, name: string): string {
    return findEntity(app, name)?.name ?? name;
}

const dossier = (app: App): ToolSpec =>
    readTool({
        name: 'dossier',
        description:
            'Everything the stack knows about a character, persona or place (Dossier + World model): canonical name, aliases, presence in the scene, where facts live (card, DES, lore entries, canon, CK archive, NAI passport, Qvink memories, place registry) and the dossier sections (cut), plus structural findings (no entry/passport/archive, alias not a key, names disagree).',
        parameters: objectSchema({ name: NAME }, ['name']),
        available: needsApi('world'),
        async run(rawArgs, ctx) {
            const name = strArg(argsOf(rawArgs), 'name', 80);
            if (!name) return notice(ctx, 'Give a name.', 'Нужно имя.');
            const entity = findEntity(app, name);
            if (!entity) {
                const world = apiOf<WorldModelApi>(app, 'world');
                const known = safely(() => world?.entities() ?? [], [] as Entity[])
                    .slice(0, 30)
                    .map((item) => item.name);
                return notice(ctx, `No entity named «${name}».`, `Нет сущности «${name}».`, { known });
            }
            const data: Dict = {
                entity: compact({
                    id: entity.id,
                    kind: entity.kind,
                    name: entity.name,
                    aliases: entity.aliases.slice(0, 12),
                    forms: entity.forms.length ? entity.forms.slice(0, 12) : undefined,
                    present: entity.present,
                    sources: capList(
                        entity.sources.map((source) =>
                            compact({
                                kind: source.kind,
                                label: cut(source.label, 60),
                                book: source.world,
                                uid: source.uid,
                                message: source.messageIndex,
                            }),
                        ),
                        20,
                    ),
                }),
            };
            const api = apiOf<DossierApi>(app, 'dossier');
            if (api) {
                const built = await withTimeout(api.build(entity.id), 5000, null);
                if (built) {
                    data.sections = built.sections.slice(0, 14).map((section) =>
                        compact({
                            kind: section.kind,
                            title: cut(section.title, 60),
                            text: cut(section.text, 400),
                            fields: section.fields,
                            message: section.messageIndex,
                        }),
                    );
                    data.findings = built.findings
                        .slice(0, 10)
                        .map((finding) =>
                            compact({ kind: finding.kind, severity: finding.severity, text: cut(finding.text, 200) }),
                        );
                }
            }
            const world = apiOf<WorldModelApi>(app, 'world');
            const facts = safely(() => world?.facts(entity.id) ?? [], []);
            if (facts.length) {
                data.facts = facts
                    .slice(0, 10)
                    .map((fact) => compact({ text: cut(fact.text, 200), status: fact.status, time: fact.storyTime }));
            }
            return {
                data,
                untrusted: true,
                summary: say(ctx, `Dossier: ${entity.name}`, `Досье: ${entity.name}`),
            };
        },
    });

function relationView(relation: Relation): Dict {
    return {
        from: relation.from,
        to: relation.to,
        now: cut(relation.current, 80),
        history: relation.history.slice(-6).map((point) =>
            compact({
                message: point.messageIndex,
                status: cut(point.status, 60),
                time: point.storyTime,
                by: point.source,
            }),
        ),
    };
}

const relations = (app: App): ToolSpec =>
    readTool({
        name: 'relations',
        description:
            "Relationships from the DES tracker and the canon, with their recent history (turn by turn): all of one character's relations, or between two (`with`). Without a name: every relation of the chat (capped).",
        parameters: objectSchema({
            name: prop.string('Character (any name, alias or case form). Omit for all relations.'),
            with: prop.string('The other side (the persona or another character).'),
        }),
        available: needsApi('relations'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const api = apiOf<RelationsApi>(app, 'relations');
            if (!api) return notice(ctx, 'Relationships are off.', 'Граф отношений выключен.');
            const name = strArg(args, 'name', 80);
            const other = strArg(args, 'with', 80);
            let list: Relation[];
            if (name && other) {
                const relation = safely(
                    () => api.between(canonicalName(app, name), canonicalName(app, other)),
                    undefined,
                );
                list = relation ? [relation] : [];
            } else if (name) {
                list = safely(() => api.of(canonicalName(app, name)), []);
            } else {
                list = safely(() => api.all(), []);
            }
            const capped = capList(list.map(relationView), 20);
            return {
                data: { relations: capped.items, total: capped.total },
                untrusted: true,
                summary: say(ctx, `Relationships: ${capped.total}`, `Отношения: ${capped.total}`),
            };
        },
    });

function factView(fact: KnowledgeFact): Dict {
    return compact({
        id: fact.id,
        text: cut(fact.text, 200),
        knownBy: fact.knownBy.slice(0, 12),
        secret: fact.secret || undefined,
        topics: fact.topics.slice(0, 8),
        message: fact.sourceMessage,
        quote: fact.quote ? cut(fact.quote, 160) : undefined,
    });
}

const knowledgeWho = (app: App): ToolSpec =>
    readTool({
        name: 'knowledge_who',
        description:
            '«Who knows what» (experimental module): facts and secrets with the characters who know them. With `name`: what that character knows, and which facts whose topic came up lately they do NOT know. With `fact`: facts matching these words and who knows them.',
        parameters: objectSchema({
            name: prop.string('A character (any name, alias or case form).'),
            fact: prop.string('Words of a fact or secret to look for.'),
        }),
        available: needsApi('knowledge'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const api = apiOf<KnowledgeApi>(app, 'knowledge');
            if (!api) return notice(ctx, '«Who knows what» is off.', '«Кто что знает» выключен.');
            let facts = safely(() => api.facts(), [] as KnowledgeFact[]);
            const query = strArg(args, 'fact', 160);
            if (query) {
                const terms = new Set(stems(query));
                facts = facts.filter((fact) => {
                    const words = new Set(stems(`${fact.text} ${fact.topics.join(' ')} ${fact.quote ?? ''}`));
                    return [...terms].some((term) => words.has(term));
                });
            }
            const name = strArg(args, 'name', 80);
            const data: Dict = {};
            if (name) {
                const character = canonicalName(app, name);
                const lower = normalizeText(character);
                const knows = facts.filter((fact) => fact.knownBy.some((who) => normalizeText(who) === lower));
                const recent = chatTexts(app, 6).join('\n');
                const unknown = safely(() => api.unknownFor(character, recent), [] as KnowledgeFact[]);
                data.character = character;
                data.knows = capList(knows.map(factView), 15);
                data.doesNotKnow = capList(unknown.map(factView), 10);
            } else {
                data.facts = capList(facts.map(factView), 20);
            }
            return {
                data,
                untrusted: true,
                summary: say(ctx, `Who knows: ${facts.length} facts`, `Кто знает: фактов ${facts.length}`),
            };
        },
    });

function placeView(app: App, place: Place): Dict {
    const api = apiOf<PlacesApi>(app, 'places');
    const visit = place.visits[place.visits.length - 1];
    return compact({
        id: place.id,
        name: place.name,
        path: safely(() => api?.path?.(place.id), undefined),
        aliases: place.aliases.length ? place.aliases.slice(0, 8) : undefined,
        state: place.state,
        background: place.background,
        entry: place.entry ? `${place.entry.world}#${place.entry.uid}` : undefined,
        lastVisit: visit
            ? compact({
                  from: visit.from,
                  to: visit.to,
                  present: visit.present.slice(0, 10),
                  date: visit.storyDate,
                  events: visit.events.slice(-5).map((event) => cut(event, 160)),
              })
            : undefined,
        visits: place.visits.length,
    });
}

const placesCurrent = (app: App): ToolSpec =>
    readTool({
        name: 'places_current',
        description:
            'The current place of the scene (from the DES location): nesting path, aliases, state, background, its description entry, the last visit (who was there, events), plus the recently visited places and names not yet registered as places.',
        parameters: objectSchema(),
        available: needsApi('places'),
        async run(_rawArgs, ctx) {
            const api = apiOf<PlacesApi>(app, 'places');
            if (!api) return notice(ctx, 'Places are off.', 'Места выключены.');
            const current = safely(() => api.current(), null);
            const recent = safely(() => api.list(), [] as Place[])
                .filter((place) => place.id !== current?.id)
                .sort((a, b) => b.lastSeen - a.lastSeen)
                .slice(0, 10)
                .map((place) => ({ id: place.id, name: place.name, lastSeen: place.lastSeen }));
            const candidates = safely(() => api.candidates(), [])
                .slice(0, 5)
                .map((candidate) => compact({ label: cut(candidate.label, 80), seen: candidate.seen.length }));
            return {
                data: compact({
                    current: current ? placeView(app, current) : null,
                    recent,
                    candidates: candidates.length ? candidates : undefined,
                }),
                untrusted: true,
                summary: current
                    ? say(ctx, `Place: ${current.name}`, `Место: ${current.name}`)
                    : say(ctx, 'No current place', 'Текущего места нет'),
            };
        },
    });

function promiseView(promise: StoryPromise): Dict {
    return compact({
        id: promise.id,
        who: promise.who,
        toWhom: promise.toWhom,
        what: cut(promise.what, 160),
        due: promise.due?.label,
        status: promise.status,
        quote: cut(promise.quote, 160),
        message: promise.sourceMessage,
    });
}

const calendarNow = (app: App): ToolSpec =>
    readTool({
        name: 'calendar_now',
        description:
            'Story time now (from the DES tracker) and the promises and deadlines of the chat: open, due, overdue (done/cancelled/broken on request).',
        parameters: objectSchema({
            all: prop.boolean('Include done, cancelled and broken promises (default false).'),
        }),
        available: needsApi('calendar'),
        async run(rawArgs, ctx) {
            const api = apiOf<CalendarApi>(app, 'calendar');
            if (!api) return notice(ctx, 'The calendar is off.', 'Календарь выключен.');
            const all = argsOf(rawArgs).all === true;
            const now = safely(() => api.now(), null);
            const promises = safely(() => api.promises(), [] as StoryPromise[]).filter(
                (promise) => all || ['open', 'due', 'overdue'].includes(promise.status),
            );
            const list = capList(promises.map(promiseView), 15);
            return {
                data: compact({ now, promises: list.items, total: list.total }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Story time: ${now?.label ?? '?'}; promises: ${list.total}`,
                    `Время истории: ${now?.label ?? '?'}; обещаний: ${list.total}`,
                ),
            };
        },
    });

const wardrobe = (app: App): ToolSpec =>
    readTool({
        name: 'wardrobe',
        description:
            'Known outfits (named outfits in the chat-level NAI Studio passports, recognised from the DES tracker) of one character or of everyone, which one is worn, and the latest state changes (wet, wounded, night, ruined…).',
        parameters: objectSchema({
            name: prop.string('A character (omit for everyone).'),
            limit: prop.integer('Outfits (1-30, default 15).', { minimum: 1, maximum: 30 }),
        }),
        available: needsApi('wardrobe'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const api = apiOf<WardrobeApi>(app, 'wardrobe');
            if (!api) return notice(ctx, 'The wardrobe is off.', 'Гардероб выключен.');
            const name = strArg(args, 'name', 80);
            const character = name ? canonicalName(app, name) : undefined;
            const outfits = safely(() => api.outfits(character), []);
            const list = capList(
                outfits.map((outfit) =>
                    compact({
                        character: outfit.character,
                        name: outfit.name,
                        tags: cut(outfit.tags, 160),
                        active: outfit.active || undefined,
                        seenAs: outfit.seenAs.slice(0, 3).map((item) => cut(item, 80)),
                        lastSeen: outfit.lastSeen,
                    }),
                ),
                intArg(args, 'limit', 15, 1, 30),
            );
            const changes = safely(() => api.changes(10), []).map((change) =>
                compact({
                    kind: change.kind,
                    subject: change.subject,
                    state: change.state,
                    on: change.enabled,
                    message: change.messageIndex,
                }),
            );
            return {
                data: { outfits: list.items, total: list.total, stateChanges: changes },
                untrusted: true,
                summary: say(ctx, `Wardrobe: ${list.total} outfits`, `Гардероб: нарядов ${list.total}`),
            };
        },
    });

const passportsScene = (app: App): ToolSpec =>
    readTool({
        name: 'passports_scene',
        description:
            'Visual passports of the lore entries activated or mentioned in the current scene (what NAI Studio receives), what was sent last, and which generator would make new passports.',
        parameters: objectSchema(),
        available: needsApi('lorePassports'),
        async run(_rawArgs, ctx) {
            const api = apiOf<LorePassportsApi>(app, 'lorePassports');
            if (!api) return notice(ctx, 'Passports in lorebooks are off.', 'Паспорта в лорбуках выключены.');
            const scene = safely(() => api.forScene(), []);
            const list = capList(
                scene.map((item) =>
                    compact({
                        book: item.world,
                        uid: item.uid,
                        name: cut(item.name, 60),
                        kind: typeof item.passport.kind === 'string' ? item.passport.kind : undefined,
                        tags: cut(
                            typeof item.passport.tags === 'string'
                                ? item.passport.tags
                                : JSON.stringify(item.passport.tags ?? ''),
                            200,
                        ),
                    }),
                ),
                15,
            );
            const sent = safely(() => api.lastSent?.() ?? null, null);
            return {
                data: compact({
                    scene: list.items,
                    total: list.total,
                    lastSent: sent
                        ? { at: when(sent.at), message: sent.messageIndex, count: sent.passports.length }
                        : undefined,
                    generator: safely(() => api.generator?.(), undefined),
                }),
                untrusted: true,
                summary: say(ctx, `Scene passports: ${list.total}`, `Паспорта сцены: ${list.total}`),
            };
        },
    });

export function worldTools(app: App): ToolSpec[] {
    return [
        dossier(app),
        relations(app),
        knowledgeWho(app),
        placesCurrent(app),
        calendarNow(app),
        wardrobe(app),
        passportsScene(app),
    ];
}
