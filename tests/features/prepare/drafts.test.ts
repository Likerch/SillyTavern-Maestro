// What the preparation window remembers per chat: which step it is on (from the engine's state and the user's moves),
// the default choice of an item, the rows apply() gets (scopes and edits), the result of several applies.
import { describe, expect, it } from 'vitest';
import {
    choiceOf,
    defaultChoice,
    emptyDraft,
    fieldValue,
    mergeSummary,
    selectionRows,
    setEdit,
    stepOf,
    syncDraft,
} from '../../../src/features/prepare/drafts';
import { samplePlan } from './ui-helpers';

describe('prepare drafts: the step', () => {
    const draft = emptyDraft();
    const step = (stage: Parameters<typeof stepOf>[0]['stage'], hasPlan: boolean, eligible = true) =>
        stepOf({ eligible, stage, hasPlan, draft });

    it('follows the engine: start, run, review, result; blocked in a chat that is not new', () => {
        expect(step('none', false)).toBe('start');
        expect(step('failed', false)).toBe('start');
        expect(step('none', false, false)).toBe('blocked');
        expect(step('running', false)).toBe('running');
        expect(step('ready', true)).toBe('review');
        expect(step('ready', true, false)).toBe('review');
        expect(step('applied', true)).toBe('done');
        expect(step('applied', false, false)).toBe('done');
    });

    it('follows the user: back to the plan from the result, back to the first step to analyse again', () => {
        const moved = { ...emptyDraft(), review: true };
        expect(stepOf({ eligible: true, stage: 'applied', hasPlan: true, draft: moved })).toBe('review');
        const again = { ...emptyDraft(), restart: true };
        expect(stepOf({ eligible: true, stage: 'ready', hasPlan: true, draft: again })).toBe('start');
        expect(stepOf({ eligible: false, stage: 'ready', hasPlan: true, draft: again })).toBe('review');
        expect(stepOf({ eligible: true, stage: 'running', hasPlan: true, draft: again })).toBe('running');
        const result = { ...emptyDraft(), summary: { done: [], skipped: [], failed: [], proposals: [] } };
        expect(stepOf({ eligible: true, stage: 'ready', hasPlan: true, draft: result })).toBe('done');
    });
});

describe('prepare drafts: choices', () => {
    it('chooses new items, not what exists or the player himself', () => {
        const plan = samplePlan();
        const byId = new Map(plan.items.map((item) => [item.id, defaultChoice(item).checked]));
        expect(byId.get('character:elizabeth')).toBe(true);
        expect(byId.get('character:kai')).toBe(false);
        expect(byId.get('place:old fort')).toBe(false);
        expect(byId.get('mechanic:reputation')).toBe(true);
    });

    it('gives apply() the chosen rows with scopes and only the real edits', () => {
        const plan = samplePlan();
        const draft = emptyDraft();
        syncDraft(draft, plan);
        const elizabeth = plan.items.find((item) => item.id === 'character:elizabeth')!;
        const choice = choiceOf(draft, elizabeth);
        setEdit(elizabeth, choice, 'name', 'Лиза');
        setEdit(elizabeth, choice, 'appearance', 'Red hair, green eyes');
        setEdit(elizabeth, choice, 'present', 'yes');
        expect(choice.edits).toEqual({ name: 'Лиза' });
        expect(fieldValue(elizabeth, choice, 'name')).toBe('Лиза');
        expect(fieldValue(elizabeth, choice, 'english')).toBe('Elizabeth');
        choice.scope = 'character';
        choiceOf(
            draft,
            plan.items.find((item) => item.id === 'secret:abc')!,
        ).checked = false;
        choiceOf(
            draft,
            plan.items.find((item) => item.id === 'place:old fort')!,
        ).checked = true;
        expect(selectionRows(plan, draft)).toEqual([
            { id: 'world', scope: 'chat' },
            { id: 'character:elizabeth', scope: 'character', data: { name: 'Лиза' } },
            { id: 'place:rusty anchor', scope: 'chat' },
            { id: 'place:old fort', scope: 'chat' },
            { id: 'mechanic:reputation', scope: 'chat' },
        ]);
    });

    it('starts the choices over for a new analysis, keeps them for the same plan', () => {
        const draft = emptyDraft();
        syncDraft(draft, samplePlan(1));
        choiceOf(draft, samplePlan(1).items[0]!).checked = false;
        syncDraft(draft, samplePlan(1));
        expect(draft.choices.size).toBe(1);
        syncDraft(draft, samplePlan(2));
        expect(draft.choices.size).toBe(0);
    });

    it('a later apply replaces the lines of the same item', () => {
        const first = {
            done: [{ itemId: 'a', kind: 'world' as const, text: 'A' }],
            skipped: [{ itemId: 'b', kind: 'place' as const, text: 'B skipped' }],
            failed: [],
            proposals: ['bg'],
        };
        const second = {
            done: [{ itemId: 'b', kind: 'place' as const, text: 'B done' }],
            skipped: [],
            failed: [],
            proposals: ['bg', 'bg2'],
        };
        expect(mergeSummary(first, second)).toEqual({
            done: [first.done[0], second.done[0]],
            skipped: [],
            failed: [],
            proposals: ['bg', 'bg2'],
        });
    });
});
