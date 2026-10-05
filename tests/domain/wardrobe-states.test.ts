import { describe, expect, it } from 'vitest';
import {
    addTags,
    CHARACTER_STATE_RULES,
    detectStates,
    findPassportState,
    hourOf,
    missingTags,
    MISSING_TURNS,
    PLACE_STATE_RULES,
    removeTags,
    stateRule,
    stepTracked,
    timeOfDayState,
} from '../../src/domain/wardrobe-states';
import type { TrackedState } from '../../src/domain/wardrobe-states';

const rule = (id: string, rules = CHARACTER_STATE_RULES) => stateRule(id, rules)!;

describe('detectStates: characters', () => {
    it.each([
        ['Мокрая насквозь, волосы растрёпаны', ['wet', 'messy']],
        ['в крови, пьяна в стельку', ['bloody', 'drunk']],
        ['Ранен в плечо, перевязан', ['injured']],
        ['Устала, глаза слипаются', ['tired']],
        ['Чумазое лицо, в грязи по колено', ['dirty']],
        ['В поту после бега', ['sweaty']],
        ['В слезах', ['tears']],
        ['Больна, лихорадит', ['sick']],
        ['Продрогла до костей', ['cold']],
        ['Связана по рукам', ['bound']],
        ['Wounded shoulder, bandaged; exhausted', ['injured', 'tired']],
        ['soaked to the bone, tear-streaked face', ['wet', 'tears']],
        ['drunk and dishevelled', ['drunk', 'messy']],
        ['shivering, in chains', ['cold', 'bound']],
        ['feverish and covered in mud', ['dirty', 'sick']],
    ])('%s → %j', (text, ids) => {
        expect(detectStates(text)).toEqual(ids);
    });

    it('skips negations and look-alikes', () => {
        expect(detectStates('не ранен, но устал')).toEqual(['tired']);
        expect(detectStates('no longer wet. Slightly tired')).toEqual(['tired']);
        expect(detectStates('мокрая от пота')).toEqual([]);
        expect(detectStates('drenched in sweat')).toEqual(['sweaty']);
        expect(detectStates('Bloodshot eyes')).toEqual([]);
        expect(detectStates('Слезла с лошади')).toEqual([]);
        expect(detectStates('Не пьяна. Мокрая')).toEqual(['wet']);
        expect(detectStates('')).toEqual([]);
    });
});

describe('detectStates: places', () => {
    const place = (text: string) => detectStates(text, PLACE_STATE_RULES);

    it.each([
        ['Руины храма, ночь, идёт дождь', ['ruined', 'night', 'rain']],
        ['Город в огне. Вечер.', ['burning', 'evening']],
        ['Morning, light rain, 5th of May', ['dawn', 'rain', 'spring']],
        ['Праздничная площадь, гирлянды, снегопад, декабрь', ['decorated', 'snow', 'winter']],
        ['Заброшенная мельница в тумане, гроза', ['abandoned', 'fog', 'storm']],
        ['Late autumn, the abandoned village is ablaze', ['abandoned', 'burning', 'autumn']],
        ['15 июля, жаркий полдень', ['summer']],
    ])('%s → %j', (text, ids) => {
        expect(place(text)).toEqual(ids);
    });

    it('does not take a fireplace, a party or a verb for a state', () => {
        expect(place('Таверна, в камине горит огонь, вечеринка')).toEqual([]);
        expect(place('It may rain later')).toEqual(['rain']);
        expect(place('The soldiers march to the gate')).toEqual([]);
    });

    it('keeps one state of a group: the one written last', () => {
        expect(place('вечер, потом ночь')).toEqual(['night']);
        expect(place('night turns to dawn')).toEqual(['dawn']);
        expect(place('зима сменилась весной')).toEqual(['spring']);
    });
});

describe('time of day', () => {
    it.each([
        ['23:40', 23, 'night'],
        ['11:40 PM', 23, 'night'],
        ['12:10 am', 0, 'night'],
        ['7 утра', 7, 'dawn'],
        ['8 вечера', 20, 'evening'],
        ['11 ночи', 23, 'night'],
        ['2 ночи', 2, 'night'],
        ['14:00', 14, null],
        ['19:30', 19, 'evening'],
    ])('%s → %s', (time, hour, state) => {
        expect(hourOf(time)).toBe(hour);
        expect(timeOfDayState(time)).toBe(state);
    });

    it('is unknown without a clock', () => {
        expect(hourOf(undefined)).toBeNull();
        expect(hourOf('полдень')).toBeNull();
        expect(hourOf('99:00')).toBeNull();
        expect(timeOfDayState('утро')).toBeNull();
    });
});

describe('findPassportState', () => {
    const presets = [
        { id: 'wet', tags: 'wet, wet hair, wet clothes', enabled: false },
        { id: 'sleepy', tags: 'sleepy, half-closed eyes', enabled: true },
        { id: 'battered', tags: 'injury, bandages, bruise', enabled: false },
    ];

    it('finds a state by id, by an alias as id, or by a tag', () => {
        expect(findPassportState(presets, rule('wet'))?.id).toBe('wet');
        expect(findPassportState(presets, rule('tired'))?.id).toBe('sleepy');
        expect(findPassportState(presets, rule('injured'))?.id).toBe('battered');
        expect(findPassportState(presets, rule('drunk'))).toBeNull();
    });
});

describe('stepTracked', () => {
    const rules = CHARACTER_STATE_RULES;

    it('switches a new state on and off after it is missing for two turns', () => {
        const tracked: Record<string, TrackedState> = {};
        expect(stepTracked(tracked, ['wet'], { rules })).toEqual({ on: ['wet'], off: [], forgotten: [] });
        tracked.wet = { since: 1, missing: 0, stateId: 'wet' };
        expect(stepTracked(tracked, ['wet'], { rules }).on).toEqual([]);
        expect(stepTracked(tracked, [], { rules })).toEqual({ on: [], off: [], forgotten: [] });
        expect(tracked.wet!.missing).toBe(1);
        expect(stepTracked(tracked, ['wet'], { rules }).off).toEqual([]);
        expect(tracked.wet!.missing).toBe(0);
        stepTracked(tracked, [], { rules });
        expect(stepTracked(tracked, [], { rules }).off).toEqual(['wet']);
        expect(MISSING_TURNS).toBe(2);
    });

    it('leaves states the passport has on already, and forgets suppressed ones when the wording is gone', () => {
        const tracked: Record<string, TrackedState> = {
            tears: { since: 1, missing: 0, stateId: 'tears', suppressed: true },
        };
        const step = stepTracked(tracked, ['tired', 'tears'], { rules, alreadyOn: (id) => id === 'tired' });
        expect(step.on).toEqual([]);
        stepTracked(tracked, [], { rules });
        expect(stepTracked(tracked, [], { rules }).forgotten).toEqual(['tears']);
    });

    it('switches the rest of a group off at once and keeps lasting place states', () => {
        const tracked: Record<string, TrackedState> = {
            night: { since: 1, missing: 0, stateId: 'night' },
            winter: { since: 1, missing: 0, stateId: 'winter', suppressed: true },
            ruined: { since: 1, missing: 0, stateId: 'ruined' },
        };
        const options = { rules: PLACE_STATE_RULES };
        const step = stepTracked(tracked, ['dawn', 'spring'], options);
        expect(step).toEqual({ on: ['dawn', 'spring'], off: ['night'], forgotten: ['winter'] });
        for (let i = 0; i < 5; i++) expect(stepTracked(tracked, [], options).off).not.toContain('ruined');
        expect(tracked.ruined!.missing).toBe(0);
    });

    it('lets a suppressed lasting state go when its wording is gone', () => {
        const tracked: Record<string, TrackedState> = {
            ruined: { since: 1, missing: 0, stateId: 'ruined', suppressed: true },
        };
        stepTracked(tracked, [], { rules: PLACE_STATE_RULES });
        expect(stepTracked(tracked, [], { rules: PLACE_STATE_RULES }).forgotten).toEqual(['ruined']);
    });

    it('ignores unknown rules', () => {
        expect(stateRule('nope', rules)).toBeUndefined();
        expect(stepTracked({}, ['nope'], { rules }).on).toEqual(['nope']);
    });
});

describe('tag lists', () => {
    it('adds, finds missing and removes tags case-insensitively', () => {
        expect(missingTags('Tavern, Night', 'night, dark, , dark')).toEqual(['dark']);
        expect(addTags('tavern', ['night', 'Tavern', ' ', 'dark'])).toBe('tavern, night, dark');
        expect(addTags('', ['rain'])).toBe('rain');
        expect(removeTags('tavern, Night, dark', ['night', 'dark'])).toBe('tavern');
        expect(removeTags('', ['night'])).toBe('');
    });
});
