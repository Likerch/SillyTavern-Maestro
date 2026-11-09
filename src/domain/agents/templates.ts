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
];

export const DEFAULT_SET_ID = 'as-1-27';
