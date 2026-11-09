// The template catalogue (plan §3.9): ready agents the user takes into work as his own copy. Release 1.28: the groups
// «текст», «сюжет», «игрок». Names and descriptions are i18n keys (`m44.tpl.<id>.name` / `.desc`); instructions are
// English (the model reads them; the user may rewrite them in any language). Every template is off until taken.
import { DEFAULT_INJECT } from './def';
import type { AgentDef, AgentResultSpec, AgentSet, AgentSourceRef, AgentTrigger, AgentModel } from './types';

export type TemplateGroup = 'text' | 'story' | 'player' | 'trackers' | 'mechanics' | 'creators' | 'images';

export interface AgentTemplate {
    id: string;
    group: TemplateGroup;
    icon: string;
    /** First release with this template. */
    since: string;
    instruction: string;
    vars?: Record<string, string>;
    sources: AgentSourceRef[];
    trigger: AgentTrigger;
    result: AgentResultSpec;
    model?: AgentModel;
}

const RECENT = (count: number): AgentSourceRef => ({ id: 'messages', budget: count });

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
    {
        id: 'prose',
        group: 'text',
        icon: 'fa-feather-pointed',
        since: '1.28',
        instruction: [
            'You are the prose editor of the reply. Fix only the style; never change what happens, who says what, or the facts.',
            'Remove or replace these words and phrases: {{agent.forbidden}}.',
            'Avoid: {{agent.avoid}}.',
            'Prefer: {{agent.prefer}}.',
            'Cut repeated words and images of the last replies, purple prose and bureaucratic phrasing. Keep the length, the paragraphs, the dialogue and the language ({{язык_истории}}).',
        ].join('\n'),
        vars: {
            forbidden:
                'shivers down the spine, a mix of, ministrations, barely above a whisper, eyes sparkling with mischief',
            avoid: 'clichés, explaining emotions instead of showing them, ending on a question to the player',
            prefer: 'concrete details, short sentences in action, natural speech',
        },
        sources: [RECENT(3), { id: 'reply' }],
        trigger: { phase: 'post', priority: 10 },
        result: { type: 'rewrite', options: { holdReply: true } },
        model: { temperature: 0.4 },
    },
    {
        id: 'continuity',
        group: 'text',
        icon: 'fa-person-walking-arrow-loop-left',
        since: '1.28',
        instruction:
            'Check the reply for physical, spatial and temporal mistakes against the recent story and the scene: a character who stands up without having sat down, speaks after leaving, holds something they put away, is in two places, wears clothes they took off, night that turns into day without time passing. Fix only those mistakes with the smallest possible edits; never touch the plot, the dialogue meaning or the style.',
        sources: [RECENT(6), { id: 'desScene' }, { id: 'desCharacters' }, { id: 'reply' }],
        trigger: { phase: 'post', priority: 20 },
        result: { type: 'rewrite', options: { holdReply: false } },
        model: { temperature: 0.2 },
    },
    {
        id: 'voice',
        group: 'text',
        icon: 'fa-comment-dots',
        since: '1.28',
        instruction:
            'Check whether every character in the reply speaks and acts in their own voice: their manner of speech, vocabulary, temperament and attitude as the card, the lore and the recent story show them. Report only clear breaks of character (a rough soldier speaking like a scholar, a shy girl suddenly brazen without a reason), never style preferences.',
        sources: [{ id: 'card' }, { id: 'lore' }, RECENT(6), { id: 'reply' }],
        trigger: { phase: 'post' },
        result: { type: 'verdict', options: { action: 'mark' } },
        model: { temperature: 0.2 },
    },
    {
        id: 'critic',
        group: 'player',
        icon: 'fa-glasses',
        since: '1.28',
        instruction:
            "Write a short critique of the reply for the player (not for the story): where the model faked it — ignored the player's action, spoke for {{user}}, repeated itself, softened, rushed or stalled — and one concrete suggestion for the player's next move or for the instruction to give. Two or three sentences, in {{язык_истории}}.",
        sources: [RECENT(4), { id: 'reply' }],
        trigger: { phase: 'post' },
        result: { type: 'note', options: { show: 'strip' } },
        model: { temperature: 0.5 },
    },
    {
        id: 'choices',
        group: 'player',
        icon: 'fa-list-ol',
        since: '1.28',
        instruction:
            'Offer the player options for their next move as {{user}}, in the spirit of the scene: different in tone (bold, careful, emotional, unexpected), each one short and concrete, in {{язык_истории}}. Never decide for other characters.',
        sources: [{ id: 'persona' }, RECENT(4), { id: 'reply' }],
        trigger: { phase: 'post' },
        result: { type: 'choices', options: { count: 4, send: false } },
        model: { temperature: 0.9 },
    },
    {
        id: 'scene-chronicler',
        group: 'player',
        icon: 'fa-book-bookmark',
        since: '1.28',
        instruction:
            'The scene has just ended. Write a short summary of it for the player in {{язык_истории}}: what happened, what changed between the characters, what is left unresolved. Three to five sentences, no headings.',
        sources: [RECENT(20)],
        trigger: { phase: 'schedule', events: ['sceneEnd'] },
        result: { type: 'note', options: { show: 'strip' } },
        model: { temperature: 0.4 },
    },
    {
        id: 'diary',
        group: 'player',
        icon: 'fa-book-open',
        since: '1.28',
        instruction:
            "Write {{char}}'s private diary entry about the scene that just ended, in first person and in their own voice: what they think of {{user}} now, what they felt, what they want and fear. In {{язык_истории}}, one paragraph. Keep the earlier entries in mind; do not repeat them.",
        sources: [{ id: 'card' }, RECENT(16), { id: 'ownMemory' }],
        trigger: { phase: 'schedule', events: ['sceneEnd'] },
        result: {
            type: 'memory',
            options: {
                fields: [{ name: 'entry', hint: 'the new diary entry' }],
                inject: false,
                injectOptions: { ...DEFAULT_INJECT, lifetime: 'untilNext' },
            },
        },
        model: { temperature: 0.8 },
    },
    {
        id: 'director-hint',
        group: 'story',
        icon: 'fa-bullhorn',
        since: '1.28',
        instruction:
            'You are the director of this story. Read where the scene is and give ONE short directive for the next reply: who should act, what to intensify or slow down, what detail to bring in. Never write the reply itself and never decide for {{user}}. One or two sentences.',
        sources: [{ id: 'director' }, { id: 'desScene' }, RECENT(6)],
        trigger: { phase: 'prefetch' },
        result: { type: 'inject', options: { ...DEFAULT_INJECT, depth: 1 } },
        model: { temperature: 0.7 },
    },
    {
        id: 'plotline',
        group: 'story',
        icon: 'fa-route',
        since: '1.28',
        instruction:
            'You keep a hidden plot line for this story: a goal, the stages towards it and where the story is now. Update your records from the recent story (advance the stage when it was reached, adapt the plan when the player went elsewhere — never force them back). Then, in the field "next", write a short directive for the narrator on how to lead towards the next stage without revealing it.',
        sources: [{ id: 'card' }, { id: 'canon' }, RECENT(12), { id: 'ownMemory' }],
        trigger: { phase: 'schedule', everyMessages: 10 },
        result: {
            type: 'memory',
            options: {
                fields: [
                    { name: 'goal', hint: 'where the story is heading (hidden from the player)' },
                    { name: 'stages', hint: 'the stages towards the goal, the current one marked' },
                    { name: 'next', hint: 'a directive for the narrator: how to lead towards the next stage' },
                ],
                inject: true,
                injectOptions: { ...DEFAULT_INJECT, depth: 3, lifetime: 'untilNext' },
            },
        },
        model: { temperature: 0.6 },
    },
    {
        id: 'complications',
        group: 'story',
        icon: 'fa-bolt',
        since: '1.28',
        instruction:
            'The story has stalled. Propose ONE complication in the spirit of the world for the next reply: an obstacle, a visitor, news, an accident, a choice — something that gives the scene a push without breaking it. Write it as a directive for the narrator in one or two sentences.',
        sources: [{ id: 'director' }, { id: 'desScene' }, RECENT(8)],
        trigger: { phase: 'prefetch', when: { stalled: true } },
        result: { type: 'inject', options: { ...DEFAULT_INJECT, depth: 1 } },
        model: { temperature: 0.9 },
    },
    {
        id: 'anti-loop',
        group: 'story',
        icon: 'fa-arrows-spin',
        since: '1.28',
        instruction:
            'Look at the recent story as a whole: is it going in circles — the same argument, the same intimacy beats, the same fight, the same jokes, the same scene shape again and again? If yes, write a short directive for the narrator naming the pattern and asking for a different one. If the story is moving, answer NONE.',
        sources: [RECENT(30)],
        trigger: { phase: 'schedule', everyMessages: 15 },
        result: { type: 'inject', options: { ...DEFAULT_INJECT, depth: 2, lifetime: 'untilNext' } },
        model: { temperature: 0.4 },
    },
    {
        id: 'names',
        group: 'story',
        icon: 'fa-signature',
        since: '1.28',
        instruction:
            'Prepare a short list of names the narrator may use when a new character appears: fitting the world\'s cultures and the setting, varied, with no names already used in the story and no overused ones (Elara, Lyra, Kael, Seraphina, Thorne and the like). Six to ten names with a two-word note each (who could carry it). Answer as a directive: "If a new character needs a name, take one from this list: …".',
        sources: [{ id: 'card' }, { id: 'lore' }, RECENT(10)],
        trigger: { phase: 'schedule', everyMessages: 20, events: ['chatOpen'] },
        result: { type: 'inject', options: { ...DEFAULT_INJECT, depth: 4, lifetime: 'untilNext' } },
        model: { temperature: 1.0 },
    },
    {
        id: 'secrets',
        group: 'text',
        icon: 'fa-user-secret',
        since: '1.31',
        instruction:
            'Check whether any character in the reply knows or uses something they could not know: a secret they were not told, an event they did not witness, a name nobody said to them. Use the record of who knows what and the story. Report only clear cases with the quote; never style preferences.',
        sources: [{ id: 'knowledge' }, { id: 'canon' }, RECENT(10), { id: 'reply' }],
        trigger: { phase: 'post' },
        result: { type: 'verdict', options: { action: 'offerRedo' } },
        model: { temperature: 0.2 },
    },
    {
        id: 'character-creator',
        group: 'creators',
        icon: 'fa-user-plus',
        since: '1.31',
        instruction:
            'A new person has entered the story. For every named character who now matters to the story (speaks, acts, will clearly come back) and is neither in the known names nor in the lore, propose a lore entry of this chat: who they are, how they look, how they speak and behave, how they relate to {{user}} and to the others — only what the story showed or clearly implied, nothing invented beyond that. Skip passers-by and unnamed extras. Name them exactly as the story does, in {{язык_истории}}.',
        sources: [{ id: 'worldNames' }, { id: 'lore' }, { id: 'canon' }, RECENT(14)],
        trigger: { phase: 'schedule', events: ['newCharacter'] },
        result: { type: 'proposals', options: { receivers: ['canon.agentEntry'], max: 2 } },
        model: { temperature: 0.4 },
    },
    {
        id: 'character-editor',
        group: 'creators',
        icon: 'fa-user-pen',
        since: '1.31',
        instruction:
            "The scene has ended. Look at the characters' lore entries and at what the scene did to them: wounds and scars, a new role or title, changed relations, a new look or new clothes for good, a secret revealed. For each entry the story clearly changed, propose its updated text (keep everything still true). Do not touch entries the scene did not change.",
        sources: [{ id: 'lore' }, { id: 'canon' }, RECENT(20)],
        trigger: { phase: 'schedule', events: ['sceneEnd'] },
        result: { type: 'proposals', options: { receivers: ['canon.agentEdit'], max: 3 } },
        model: { temperature: 0.3 },
    },
    {
        id: 'biographer',
        group: 'creators',
        icon: 'fa-book-open-reader',
        since: '1.31',
        instruction:
            'Find a character of the story whose lore entry is thin (a line or two) although they have played a real part. Write their entry out: background that fits what the story showed, manner of speech, habits, appearance details, wants and fears — consistent with everything known, never contradicting it, and marked as inferred where the story did not state it. Propose the whole updated text of that one entry.',
        sources: [{ id: 'lore' }, { id: 'canon' }, { id: 'worldNames' }, RECENT(20)],
        trigger: { phase: 'schedule', everyMessages: 25 },
        result: { type: 'proposals', options: { receivers: ['canon.agentEdit'], max: 1 } },
        model: { temperature: 0.6 },
    },
    {
        id: 'cartographer',
        group: 'creators',
        icon: 'fa-map-location-dot',
        since: '1.31',
        instruction:
            'The story has moved to a place. If this place (or another named place the story now uses) has no lore entry yet, propose one: what it is, where it lies relative to known places, what it looks like, sounds and smells like, who is usually there, what can be found there — what the story showed plus a few details that fit the world, never contradicting it. Name it as the story does, in {{язык_истории}}.',
        sources: [{ id: 'places' }, { id: 'worldNames' }, { id: 'lore' }, { id: 'desScene' }, RECENT(8)],
        trigger: { phase: 'schedule', events: ['placeChange'] },
        result: { type: 'proposals', options: { receivers: ['canon.agentEntry'], max: 2 } },
        model: { temperature: 0.6 },
    },
    {
        id: 'world-chronicler',
        group: 'creators',
        icon: 'fa-landmark',
        since: '1.31',
        instruction:
            "Read the recent story and find things it keeps relying on that the lore does not describe: factions and families, customs and holidays, items of note, past events people refer to. For the most important ones propose lore entries — only what the story showed or clearly implied, written as the world's own truth. Skip what is already known.",
        sources: [{ id: 'worldNames' }, { id: 'lore' }, { id: 'canon' }, RECENT(30)],
        trigger: { phase: 'schedule', everyMessages: 30 },
        result: { type: 'proposals', options: { receivers: ['canon.agentEntry'], max: 3 } },
        model: { temperature: 0.4 },
    },
    {
        id: 'staging',
        group: 'trackers',
        icon: 'fa-people-arrows',
        since: '1.32',
        instruction:
            "Keep the staging of the scene: after the reply, update where everyone present is and how — pose, place in the room, who they are next to and how, what they hold, what is visible on them. Change only what the reply changed or what the current staging lacks; keep everything else. Write short phrases in the story's language ({{язык_истории}}).",
        sources: [{ id: 'staging' }, { id: 'desScene' }, RECENT(2), { id: 'reply' }],
        trigger: { phase: 'post', priority: 30 },
        result: { type: 'proposals', options: { receivers: ['staging.set'], max: 1 } },
        model: { temperature: 0.1 },
    },
    {
        id: 'costumer',
        group: 'trackers',
        icon: 'fa-shirt',
        since: '1.32',
        instruction:
            "You keep the wardrobe. Read the reply: did anyone dress, undress, change clothes or take something off? For each such person say what they wear now — one of their known outfits by its exact name when it fits, otherwise the clothes in the story's words. Ignore people whose clothes did not change; never guess.",
        sources: [{ id: 'wardrobe' }, RECENT(2), { id: 'reply' }],
        trigger: { phase: 'post', priority: 30 },
        result: { type: 'proposals', options: { receivers: ['wardrobe.agentWear'], max: 4 } },
        model: { temperature: 0.1 },
    },
    {
        id: 'outfit-hint',
        group: 'trackers',
        icon: 'fa-vest-patches',
        since: '1.32',
        instruction:
            "Look at what everyone wears and at the scene: place, time of day, weather, what is happening. If someone's clothes no longer fit — night and still in armour, a ball in travel clothes, soaked by rain, a fight in a nightgown, days in the same dress — write ONE short directive for the narrator: who could change into what (prefer their known outfits) and why, to be shown naturally in the story. If the clothes fit, answer NONE.",
        sources: [{ id: 'wardrobe' }, { id: 'desScene' }, { id: 'director' }, RECENT(6)],
        trigger: { phase: 'prefetch' },
        result: { type: 'inject', options: { position: 'depth', depth: 2, role: 'system', lifetime: 'turn' } },
        model: { temperature: 0.5 },
    },
    {
        id: 'own-mechanic',
        group: 'mechanics',
        icon: 'fa-gauge-high',
        since: '1.32',
        instruction:
            'You run a game mechanic of this story that the engine does not have: {{agent.mechanic}}. Its rules: {{agent.rules}}. After every few messages update its values in your records from what happened in the story, following the rules strictly (no change without a cause in the story). In the field "effects" write what the current values mean for the next replies, as a short directive for the narrator.',
        vars: {
            mechanic: 'hunger and fatigue of the player character',
            rules: 'hunger 0-100 grows by 10 every few hours of story time and drops by 40 after a meal; fatigue 0-100 grows with effort and drops after sleep; at 70+ the character is weakened, at 90+ can barely act',
        },
        sources: [{ id: 'ownMemory' }, { id: 'desScene' }, RECENT(6)],
        trigger: { phase: 'schedule', everyMessages: 2 },
        result: {
            type: 'memory',
            options: {
                fields: [
                    { name: 'values', hint: 'the current values, e.g. «hunger 40/100; fatigue 65/100»' },
                    { name: 'effects', hint: 'what they mean for the next replies, as a directive' },
                ],
                inject: true,
                injectOptions: { position: 'depth', depth: 1, role: 'system', lifetime: 'untilNext' },
            },
        },
        model: { temperature: 0.2 },
    },
];

export function templateById(id: string): AgentTemplate | undefined {
    return AGENT_TEMPLATES.find((template) => template.id === id);
}

/** A new own agent from a template (name translated by the caller). */
export function agentFromTemplate(
    template: AgentTemplate,
    name: string,
    id: string,
    now: number,
    capabilities: (def: Pick<AgentDef, 'result' | 'sources'>) => string[],
): AgentDef {
    const sources = template.sources.map((source) => ({ ...source }));
    const result = JSON.parse(JSON.stringify(template.result)) as AgentResultSpec;
    const def: AgentDef = {
        v: 1,
        id,
        kind: 'custom',
        name,
        icon: template.icon,
        origin: `template:${template.id}`,
        templateId: template.id,
        instruction: template.instruction,
        sources,
        trigger: JSON.parse(JSON.stringify(template.trigger)) as AgentTrigger,
        result,
        model: { ...(template.model ?? {}) },
        capabilities: capabilities({ result, sources }),
        updatedAt: now,
    };
    if (template.vars) def.vars = { ...template.vars };
    return def;
}

/* ------------------------------------------------------------------ built-in sets (plan §3.15) */

/** Release 1.28: «Как в 1.27» (no own agents) and «Рассказчик». The other sets come with their agents. */
export const BUILTIN_SETS: readonly AgentSet[] = [
    {
        id: 'as-1-27',
        name: 'As in 1.27',
        builtin: true,
        titleKey: 'm44.set.asBefore',
        descriptionKey: 'm44.set.asBefore.desc',
        agents: {},
    },
    {
        id: 'storyteller',
        name: 'Storyteller',
        builtin: true,
        titleKey: 'm44.set.storyteller',
        descriptionKey: 'm44.set.storyteller.desc',
        agents: {
            'template:prose': { on: true },
            'template:continuity': { on: true },
            'template:director-hint': { on: true },
            'template:names': { on: true },
            'template:anti-loop': { on: true },
        },
    },
    // Release 1.31: «Мир растёт» — the creators.
    {
        id: 'world-grows',
        name: 'World grows',
        builtin: true,
        titleKey: 'm44.set.worldGrows',
        descriptionKey: 'm44.set.worldGrows.desc',
        agents: {
            'template:character-creator': { on: true },
            'template:cartographer': { on: true },
            'template:world-chronicler': { on: true },
            'template:biographer': { on: true },
        },
    },
    // Release 1.32: «Игра» and «Кино» (pictures join the cinema set with 1.33).
    {
        id: 'game',
        name: 'Game',
        builtin: true,
        titleKey: 'm44.set.game',
        descriptionKey: 'm44.set.game.desc',
        agents: {
            'template:costumer': { on: true },
            'template:staging': { on: true },
            'template:choices': { on: true },
        },
    },
    {
        id: 'cinema',
        name: 'Cinema',
        builtin: true,
        titleKey: 'm44.set.cinema',
        descriptionKey: 'm44.set.cinema.desc',
        agents: {
            'template:costumer': { on: true },
            'template:staging': { on: true },
            'template:outfit-hint': { on: true },
        },
    },
];

export const DEFAULT_SET_ID = 'as-1-27';
