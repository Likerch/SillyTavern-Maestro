// The assistant's built-in tools (M33, stage 13): the read tools (Maestro and its health, the turn, lore and canon,
// regexes, the story world, the game layer, the documentation) and the write tools (./write: settings, mechanics,
// regexes, preset blocks and flags, passports, lore entries — each a before/after plan the user confirms).
// Built per app; every tool decides with available(app) whether the model is offered it now.
import type { App, Logger } from '../../../shared/contracts';
import type { ToolFactory, ToolSpec } from '../api';
import { docsTools } from './read/docs';
import { loreTools } from './read/lore';
import { maestroTools } from './read/maestro';
import { playTools } from './read/play';
import { regexTools } from './read/regex';
import { turnTools } from './read/turn';
import { worldTools } from './read/world';
import { writeTools } from './write';

/** Every read tool (kind 'read'), in the order the model sees them. */
export function readTools(app: App): ToolSpec[] {
    return [
        ...maestroTools(app),
        ...docsTools(),
        ...turnTools(app),
        ...loreTools(app),
        ...regexTools(app),
        ...worldTools(app),
        ...playTools(app),
    ];
}

export const builtinTools: ToolFactory = (app: App, log: Logger): ToolSpec[] => [
    ...readTools(app),
    ...writeTools(app, log),
];

export { knowledgeBase, maestroVersion } from './knowledge';
