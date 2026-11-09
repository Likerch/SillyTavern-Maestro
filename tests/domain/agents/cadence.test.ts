import { describe, expect, it } from 'vitest';
import { conditionsHold, eventOfSignal, isBreak, isDue } from '../../../src/domain/agents/cadence';
import type { ConditionContext } from '../../../src/domain/agents/cadence';
import { agentFromTemplate, AGENT_TEMPLATES, BUILTIN_SETS, templateById } from '../../../src/domain/agents/templates';
import { capabilitiesOf, sanitizeAgent } from '../../../src/domain/agents/def';

const ctx = (patch: Partial<ConditionContext> = {}): ConditionContext => ({
    scene: 'dialogue',
    recentTexts: ['Он достал Меч.', 'Ёлка горит.'],
    mode: 'balanced',
    enabled: new Set(['des', 'director']),
    isGroup: false,
    stalled: false,
    ...patch,
});

describe('conditionsHold', () => {
    it('holds without conditions', () => {
        expect(conditionsHold(undefined, ctx())).toBe(true);
        expect(conditionsHold({}, ctx())).toBe(true);
    });

    it('checks group, stall, mode, what must be on and the scene', () => {
        expect(conditionsHold({ group: 'only' }, ctx())).toBe(false);
        expect(conditionsHold({ group: 'never' }, ctx({ isGroup: true }))).toBe(false);
        expect(conditionsHold({ stalled: true }, ctx())).toBe(false);
        expect(conditionsHold({ stalled: true }, ctx({ stalled: null }))).toBe(true);
        expect(conditionsHold({ modes: ['cinema'] }, ctx())).toBe(false);
        expect(conditionsHold({ requires: ['des', 'nai'] }, ctx())).toBe(false);
        expect(conditionsHold({ requires: ['des'] }, ctx())).toBe(true);
        expect(conditionsHold({ scenes: ['combat'] }, ctx())).toBe(false);
        expect(conditionsHold({ scenes: ['combat'] }, ctx({ scene: null }))).toBe(true);
    });

    it('finds words in the last messages, any case, ё = е', () => {
        expect(conditionsHold({ words: ['меч'] }, ctx())).toBe(true);
        expect(conditionsHold({ words: ['елка'] }, ctx())).toBe(true);
        expect(conditionsHold({ words: ['меч'], scanDepth: 1 }, ctx())).toBe(false);
        expect(conditionsHold({ words: ['лук', ' '] }, ctx())).toBe(false);
    });
});

describe('isDue', () => {
    it('runs on an event or when the counter is reached', () => {
        expect(isDue({ phase: 'schedule', events: ['sceneEnd'] }, { events: new Set(['sceneEnd']) })).toEqual({
            due: true,
            reason: 'event:sceneEnd',
        });
        expect(isDue({ phase: 'schedule', everyMessages: 10 }, { sinceLastOk: 9, events: new Set() })).toEqual({
            due: false,
        });
        expect(isDue({ phase: 'schedule', everyMessages: 10 }, { sinceLastOk: 10, events: new Set() })).toEqual({
            due: true,
            reason: 'schedule',
        });
        expect(isDue({ phase: 'schedule' }, { events: new Set() })).toEqual({ due: false });
    });

    it('tells a break and maps signals to events', () => {
        expect(isBreak(0, 13 * 3_600_000, 12)).toBe(true);
        expect(isBreak(0, 11 * 3_600_000, 12)).toBe(false);
        expect(isBreak(null, 1e12, 12)).toBe(false);
        expect(eventOfSignal('scene.ended')).toBe('sceneEnd');
        expect(eventOfSignal('location.changed')).toBe('placeChange');
        expect(eventOfSignal('character.appeared')).toBe('newCharacter');
        expect(eventOfSignal('name.new')).toBe('newCharacter');
        expect(eventOfSignal('time.skipped')).toBe('timeSkip');
        expect(eventOfSignal('memory.added')).toBeNull();
    });
});

describe('templates', () => {
    it('every template makes a valid agent that survives sanitising unchanged', () => {
        for (const template of AGENT_TEMPLATES) {
            const def = agentFromTemplate(template, template.id, `u-${template.id}-aaaaa`, 1, capabilitiesOf);
            const again = sanitizeAgent(JSON.parse(JSON.stringify(def)), 1);
            expect(again).toEqual(def);
            expect(def.templateId).toBe(template.id);
            expect(def.instruction.length).toBeGreaterThan(50);
        }
        expect(templateById('prose')?.result.type).toBe('rewrite');
        expect(templateById('nope')).toBeUndefined();
    });

    it('built-in sets name existing templates; «Как в 1.27» has no agents', () => {
        for (const set of BUILTIN_SETS) {
            for (const key of Object.keys(set.agents)) expect(templateById(key.replace('template:', ''))).toBeDefined();
        }
        expect(BUILTIN_SETS.find((set) => set.id === 'as-1-27')?.agents).toEqual({});
    });
});
