import { describe, expect, it } from 'vitest';
import {
    WI_SETTINGS,
    coerceSetting,
    normalizeWiPatch,
    patchEmits,
    readWiSettings,
    settingSpec,
} from '../../src/domain/lore-studio-settings';
import type { WiSettingSpec } from '../../src/domain/lore-studio-settings';

const spec = (key: string) => settingSpec(key) as WiSettingSpec;

describe('World Info settings', () => {
    it('covers the 13 controls of ST with their events', () => {
        expect(WI_SETTINGS).toHaveLength(13);
        expect(spec('world_info_include_names').event).toBe('input');
        expect(spec('world_info_character_strategy').event).toBe('change');
        expect(spec('world_info_use_group_scoring').emits).toBe(false);
        expect(spec('world_info_overflow_alert').emits).toBe(false);
        expect(settingSpec('nope')).toBeUndefined();
    });

    it('coerces and clamps like the controls', () => {
        expect(coerceSetting(spec('world_info_depth'), '7.6')).toBe(8);
        expect(coerceSetting(spec('world_info_depth'), 5000)).toBe(1000);
        expect(coerceSetting(spec('world_info_budget'), 0)).toBe(1);
        expect(coerceSetting(spec('world_info_budget'), 'x')).toBe(25);
        expect(coerceSetting(spec('world_info_recursive'), 'true')).toBe(true);
        expect(coerceSetting(spec('world_info_recursive'), 'false')).toBe(false);
        expect(coerceSetting(spec('world_info_recursive'), 1)).toBe(true);
        expect(coerceSetting(spec('world_info_character_strategy'), '2')).toBe(2);
        expect(coerceSetting(spec('world_info_character_strategy'), 9)).toBe(1);
    });

    it('reads current values with defaults', () => {
        const values = readWiSettings({ world_info_depth: 4, world_info_recursive: true, world_info_budget: null });
        expect(values.world_info_depth).toBe(4);
        expect(values.world_info_recursive).toBe(true);
        expect(values.world_info_budget).toBe(25);
        expect(values.world_info_include_names).toBe(true);
        expect(readWiSettings(null).world_info_character_strategy).toBe(1);
    });

    it('applies the mutual exclusion of min activations and max recursion steps', () => {
        const current = readWiSettings({ world_info_max_recursion_steps: 3 });
        expect(normalizeWiPatch(current, { world_info_min_activations: 2 })).toEqual({
            world_info_min_activations: 2,
            world_info_max_recursion_steps: 0,
        });
        const other = readWiSettings({ world_info_min_activations: 5 });
        expect(normalizeWiPatch(other, { world_info_max_recursion_steps: 1 })).toEqual({
            world_info_min_activations: 0,
            world_info_max_recursion_steps: 1,
        });
        // In one patch the later key wins.
        expect(
            normalizeWiPatch(readWiSettings({}), { world_info_min_activations: 2, world_info_max_recursion_steps: 4 }),
        ).toEqual({
            world_info_max_recursion_steps: 4,
        });
    });

    it('drops unknown and unchanged keys', () => {
        const current = readWiSettings({});
        expect(normalizeWiPatch(current, { world_info_depth: 2, junk: 1 })).toEqual({});
        expect(normalizeWiPatch(current, { world_info_overflow_alert: true })).toEqual({
            world_info_overflow_alert: true,
        });
        expect(patchEmits({ world_info_overflow_alert: true })).toBe(false);
        expect(patchEmits({ world_info_overflow_alert: true, world_info_depth: 3 })).toBe(true);
    });
});
