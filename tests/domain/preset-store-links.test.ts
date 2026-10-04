import { describe, expect, it } from 'vitest';
import {
    allowRegex,
    connectionProfiles,
    disallowRegex,
    isRegexAllowed,
    moveRegexPermission,
    profileRef,
    profilesUsing,
    regexAllowList,
    repointProfiles,
} from '../../src/domain/preset-store-links';

type Dict = Record<string, unknown>;

describe('regex permissions', () => {
    it('reads, adds and removes names like the regex extension', () => {
        const ext: Dict = {};
        expect(regexAllowList(ext)).toBeNull();
        expect(isRegexAllowed(ext, 'A')).toBe(false);
        expect(allowRegex(ext, 'A')).toBe(true);
        expect(allowRegex(ext, 'A')).toBe(false);
        expect(allowRegex(ext, '')).toBe(false);
        expect(ext.preset_allowed_regex).toEqual({ openai: ['A'] });
        expect(isRegexAllowed(ext, 'A')).toBe(true);
        expect(isRegexAllowed(ext, '')).toBe(false);
        expect(disallowRegex(ext, 'B')).toBe(false);
        expect(disallowRegex(ext, 'A')).toBe(true);
        expect(disallowRegex({}, 'A')).toBe(false);
        expect(regexAllowList({ preset_allowed_regex: { openai: 'x' } })).toBeNull();
    });

    it('moves a permission on rename only when there was one', () => {
        const ext: Dict = { preset_allowed_regex: { openai: ['Old', 'Other'], textgen: ['Old'] } };
        expect(moveRegexPermission(ext, 'Old', 'New')).toBe(true);
        expect(ext.preset_allowed_regex).toEqual({ openai: ['Other', 'New'], textgen: ['Old'] });
        expect(moveRegexPermission(ext, 'Old', 'New')).toBe(false);
    });
});

describe('connection profiles', () => {
    const ext = (): Dict => ({
        connectionManager: {
            profiles: [
                { id: 'p1', name: 'Flash', mode: 'cc', preset: 'Marinara' },
                { id: 'p2', name: 'Text', mode: 'tc', preset: 'Marinara' },
                { id: 3, preset: 'Marinara' },
                'broken',
            ],
        },
    });

    it('finds Chat Completion profiles that select a preset', () => {
        expect(connectionProfiles({})).toEqual([]);
        expect(connectionProfiles({ connectionManager: { profiles: 'x' } })).toEqual([]);
        expect(profilesUsing(ext(), 'Marinara').map(profileRef)).toEqual([
            { id: 'p1', name: 'Flash' },
            { id: '3', name: '' },
        ]);
        expect(profileRef({})).toEqual({ id: '', name: '' });
    });

    it('repoints only the given profiles that still select the old name', () => {
        const settings = ext();
        expect(repointProfiles(settings, ['p1', 'p2', 'zz'], 'Marinara', 'New')).toEqual(['p1', 'p2']);
        const profiles = connectionProfiles(settings);
        expect(profiles.map((profile) => profile.preset)).toEqual(['New', 'New', 'Marinara']);
    });
});
