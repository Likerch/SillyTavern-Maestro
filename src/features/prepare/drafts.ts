// What the preparation window remembers per chat while ST runs (plan-2 §7 п. 3–5): the step comes from the engine's
// state (the plan and what was applied live in the chat's document), the rest is the user's work on the plan — which
// items are chosen, where each is kept («для чата» / «для персонажа»), his edits of the texts, the estimate shown before
// the run, the result of the last apply with what was undone since. Pure: no DOM, no app.
import type { SelectionRow } from '../../domain/prepare-apply';
import { PREPARE_SECTIONS, sceneGreeting } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PrepareKind, PreparePlan, PrepareScope } from '../../domain/prepare-plan';
import type { ApplyLine, PrepareApplySummary, PrepareEstimateResult, PrepareStage } from './api';

/** The user's choice for one item of the plan. */
export interface ItemChoice {
    checked: boolean;
    scope: PrepareScope;
    /** Edited text fields of the item's data (only those that differ from the plan). */
    edits: Record<string, string>;
}

export interface EstimateSlot {
    reuse: boolean;
    state: 'loading' | 'done' | 'error';
    result?: PrepareEstimateResult;
    error?: string;
}

export interface ChatDraft {
    /** `createdAt` of the plan the choices belong to (a new analysis starts them over). */
    planAt: number | null;
    choices: Map<string, ItemChoice>;
    /** Read only what changed since the saved preparation (null: yes when there is one). */
    reuse: boolean | null;
    /** Generate NAI passports when applying (null: the module setting). */
    passports: boolean | null;
    /** Put the starting scenes into DES when applying (null: the module setting). */
    desSeed: boolean | null;
    estimate: EstimateSlot | null;
    /** What the applies of this session did (lines of later applies replace those of the same item). */
    summary: PrepareApplySummary | null;
    /** Items whose applied part was undone from the result list. */
    undone: Set<string>;
    /** The user went back from the result to the plan. */
    review: boolean;
    /** The user asked to analyse again: the first step even though a plan exists. */
    restart: boolean;
}

export function emptyDraft(): ChatDraft {
    return {
        planAt: null,
        choices: new Map(),
        reuse: null,
        passports: null,
        desSeed: null,
        estimate: null,
        summary: null,
        undone: new Set(),
        review: false,
        restart: false,
    };
}

/** The player's own character is never written as a canon character or passport. */
export function isPersona(item: AnyPrepareItem): boolean {
    return item.kind === 'character' && item.data.persona === true;
}

/** New items start chosen; what exists already and the player's own character start off. */
export function defaultChoice(item: AnyPrepareItem): ItemChoice {
    return { checked: !item.exists && !isPersona(item), scope: item.scope, edits: {} };
}

export function choiceOf(draft: ChatDraft, item: AnyPrepareItem): ItemChoice {
    let choice = draft.choices.get(item.id);
    if (!choice) {
        choice = defaultChoice(item);
        draft.choices.set(item.id, choice);
    }
    return choice;
}

/**
 * A new plan (another analysis) starts the choices over. No plan keeps them: right after a chat switch the engine
 * answers null until it has read the chat's document again.
 */
export function syncDraft(draft: ChatDraft, plan: PreparePlan | null): void {
    if (!plan || draft.planAt === plan.createdAt) return;
    draft.planAt = plan.createdAt;
    draft.choices.clear();
}

/** Text fields of each kind the window lets the user edit, in display order (all strings of the item's data). */
export const EDIT_FIELDS: Readonly<Record<PrepareKind, readonly string[]>> = {
    character: ['name', 'english', 'role', 'appearance', 'personality', 'speech', 'outfit'],
    world: ['name', 'english', 'setting', 'era', 'tone', 'laws', 'customs'],
    place: ['name', 'english', 'parent', 'kind', 'description', 'state'],
    faction: ['name', 'english', 'leader', 'goals', 'description'],
    item: ['name', 'english', 'owner', 'description'],
    tradition: ['name', 'english', 'when', 'practice', 'meaning'],
    time: ['date', 'time', 'calendar'],
    promise: ['what', 'due'],
    secret: ['text', 'about'],
    scene: ['place', 'date', 'time', 'situation', 'firstScene'],
    mechanic: ['name', 'english', 'summary', 'rules'],
    direction: ['genre', 'pacing', 'firstScene', 'notes'],
};

/** Fields that hold a paragraph (a text area), the others are one line. */
export const LONG_FIELDS: ReadonlySet<string> = new Set([
    'appearance',
    'personality',
    'speech',
    'outfit',
    'setting',
    'laws',
    'customs',
    'description',
    'state',
    'goals',
    'practice',
    'meaning',
    'calendar',
    'what',
    'text',
    'situation',
    'summary',
    'rules',
    'notes',
]);

/** The value of a text field: the user's edit, else the plan's. */
export function fieldValue(item: AnyPrepareItem, choice: ItemChoice | undefined, field: string): string {
    if (choice && field in choice.edits) return choice.edits[field] ?? '';
    const value = (item.data as unknown as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
}

/** Records an edit (an edit back to the plan's text is no edit). */
export function setEdit(item: AnyPrepareItem, choice: ItemChoice, field: string, value: string): void {
    const original = (item.data as unknown as Record<string, unknown>)[field];
    if (typeof original !== 'string') return;
    if (value === original) delete choice.edits[field];
    else choice.edits[field] = value;
}

/** The rows `apply()` takes: the chosen items with their scope and edits, in plan order. */
export function selectionRows(plan: PreparePlan, draft: ChatDraft): SelectionRow[] {
    const rows: SelectionRow[] = [];
    for (const item of plan.items) {
        const choice = draft.choices.get(item.id) ?? defaultChoice(item);
        if (!choice.checked) continue;
        const row: SelectionRow = { id: item.id, scope: choice.scope };
        if (Object.keys(choice.edits).length) row.data = { ...choice.edits };
        rows.push(row);
    }
    return rows;
}

export interface PlanSection {
    kind: PrepareKind;
    items: AnyPrepareItem[];
}

/**
 * The window's order of the sections (plan-2 §7 п. 2: characters first, then the world, places…, direction last); the
 * engine writes them in its own order (PREPARE_SECTIONS: places before the characters who live there).
 */
export const WINDOW_SECTIONS: readonly PrepareKind[] = [
    'character',
    'world',
    'place',
    'faction',
    'item',
    'tradition',
    'time',
    'secret',
    'promise',
    'scene',
    'mechanic',
    'direction',
];

/** The plan by sections in the window's order (empty sections left out; starting scenes by greeting). */
export function sectionsOf(items: readonly AnyPrepareItem[]): PlanSection[] {
    const order = [...WINDOW_SECTIONS, ...PREPARE_SECTIONS.filter((kind) => !WINDOW_SECTIONS.includes(kind))];
    return order
        .map((kind) => {
            const list = items.filter((item) => item.kind === kind);
            if (kind === 'scene') list.sort((a, b) => sceneGreeting(a) - sceneGreeting(b));
            return { kind, items: list };
        })
        .filter((section) => section.items.length > 0);
}

/** blocked: not a new chat and no plan; start: what will be read and the price; then the run, the review, the result. */
export type PrepareStep = 'blocked' | 'start' | 'running' | 'review' | 'done';

export function stepOf(input: {
    eligible: boolean;
    stage: PrepareStage;
    hasPlan: boolean;
    draft: ChatDraft;
}): PrepareStep {
    const { eligible, stage, hasPlan, draft } = input;
    if (stage === 'running') return 'running';
    if (draft.restart && eligible) return 'start';
    if (hasPlan && draft.review) return 'review';
    if (stage === 'applied' || draft.summary) return 'done';
    if (hasPlan) return 'review';
    return eligible ? 'start' : 'blocked';
}

/** Lines of a later apply replace the lines of the same item; proposals once each. */
export function mergeSummary(previous: PrepareApplySummary | null, next: PrepareApplySummary): PrepareApplySummary {
    if (!previous) return { ...next, done: [...next.done], skipped: [...next.skipped], failed: [...next.failed] };
    const ids = new Set([...next.done, ...next.skipped, ...next.failed].map((line) => line.itemId));
    const keep = (lines: readonly ApplyLine[]) => lines.filter((line) => !ids.has(line.itemId));
    return {
        done: [...keep(previous.done), ...next.done],
        skipped: [...keep(previous.skipped), ...next.skipped],
        failed: [...keep(previous.failed), ...next.failed],
        proposals: [...new Set([...previous.proposals, ...next.proposals])],
    };
}
