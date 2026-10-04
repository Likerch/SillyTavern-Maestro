import { describe, expect, it } from 'vitest';
import { scenariosModule } from '../../../src/features/scenarios';
import { sheetsModule } from '../../../src/features/sheets';
import type { MaestroModule } from '../../../src/shared/contracts';

// Both go into src/app/registry.ts MODULES as they are (compile-time check).
const REGISTRY_ENTRIES: MaestroModule[] = [scenariosModule, sheetsModule];

describe('strings of M31 and M34s', () => {
    it.each(REGISTRY_ENTRIES)('$key has the same keys in English and Russian', (module) => {
        const parts = module.i18n!;
        expect(Object.keys(parts.ru).sort()).toEqual(Object.keys(parts.en).sort());
        expect(parts.en[module.titleKey]).toBeTruthy();
        for (const key of Object.keys(parts.en)) {
            expect(key.startsWith('m31.') || key.startsWith('scn.') || key.startsWith('kind.sheets.')).toBe(true);
        }
    });

    it('declares the module identities the registry expects', () => {
        expect([sheetsModule.id, sheetsModule.key, sheetsModule.stage]).toEqual(['M31', 'sheets', 1]);
        expect([scenariosModule.id, scenariosModule.key, scenariosModule.stage]).toEqual(['M34s', 'scenarios', 1]);
        expect(scenariosModule.requires).toEqual([
            'st.events.ccPromptReady',
            'st.events.ccSettingsReady',
            'st.chatCompletion',
        ]);
        expect(sheetsModule.defaults()).toEqual({
            maxTokens: 6000,
            temperature: 0.7,
            excerptMessages: 12,
            collapse: true,
        });
    });
});
