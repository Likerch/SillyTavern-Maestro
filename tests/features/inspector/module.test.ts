import { describe, expect, it } from 'vitest';
import { inspectorModule } from '../../../src/features/inspector';
import { loreJournalModule } from '../../../src/features/loreJournal';
import type { MaestroModule } from '../../../src/shared/contracts';

describe('M1/M2 module definitions', () => {
    it('fit the registry and carry their settings defaults', () => {
        // Compile-time: both can go into src/app/registry.ts as they are.
        const modules: MaestroModule[] = [loreJournalModule, inspectorModule];
        expect(modules.map((module) => [module.id, module.key, module.stage, module.titleKey])).toEqual([
            ['M1', 'loreJournal', 1, 'm1.title'],
            ['M2', 'inspector', 1, 'm2.title'],
        ]);
        expect(loreJournalModule.defaults()).toEqual({ keepTurns: 200 });
        expect(inspectorModule.defaults()).toEqual({ keepTurns: 100 });
        expect(loreJournalModule.requires).toEqual(['st.events.scanDone', 'st.events.entriesLoaded']);
        expect(inspectorModule.requires).toEqual(['st.events.ccPromptReady']);
        expect(loreJournalModule.enabledByDefault && inspectorModule.enabledByDefault).toBe(true);
    });
});
