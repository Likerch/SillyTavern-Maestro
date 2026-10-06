import { describe, expect, it } from 'vitest';
import type { RevisionRejectCode } from '../../../src/domain/revision-checks';
import { REVISION_TARGETS } from '../../../src/domain/revision-prompt';
import { revisionModule } from '../../../src/features/revision';
import type { RevisionApi } from '../../../src/features/revision/api';
import { ROUTED_KINDS } from '../../../src/features/revision/routes';
import { defaultRevisionSettings, readRevisionSettings } from '../../../src/features/revision/settings';
import { REVISION_STRINGS } from '../../../src/features/revision/strings';
import { profileTasks } from '../../../src/ui/views/registries';
import { createRevisionTestApp, startModule } from './helpers';

describe('M8 module', () => {
    it('exposes its API, adds the tab, the slash command and the profile task, and removes them when off', async () => {
        const env = createRevisionTestApp();
        const running = await startModule(env, revisionModule);
        expect(revisionModule).toMatchObject({ id: 'M8', key: 'revision', stage: 4, titleKey: 'm8.title' });
        const api = env.modules.api<RevisionApi>('revision')!;
        expect(typeof api.run).toBe('function');
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['revision', 'm8.tab', 49]]);
        expect(env.ui.styles.has('m8-revision')).toBe(true);
        expect(profileTasks()).toContainEqual({ id: 'revision', labelKey: 'm8.profileTask' });
        const slash = env.slash.find((spec) => spec.name === 'maestro-revise')!;
        expect(await slash.callback({}, '')).toBe(REVISION_STRINGS.en['m8.slash.queued']);
        expect((env.app.tasks as unknown as { queued: unknown[] }).queued).toHaveLength(1);
        env.mock.chatId = undefined;
        expect(await slash.callback({}, '')).toBe('No chat is open.');
        await running.stop();
        expect(env.modules.api('revision')).toBeUndefined();
        expect(env.ui.tabs).toEqual([]);
        expect(profileTasks().some((task) => task.id === 'revision')).toBe(false);
    });

    it('repairs its settings slice', () => {
        expect(readRevisionSettings({})).toEqual(defaultRevisionSettings());
        expect(
            readRevisionSettings({
                signalThreshold: 0,
                everyMessages: 9999,
                sceneEnd: 'yes' as unknown as boolean,
                minConfidence: 7,
            }),
        ).toEqual({ signalThreshold: 1, everyMessages: 500, sceneEnd: true, minConfidence: 1 });
    });
});

describe('M8 strings', () => {
    it('have the same keys in English and Russian, none empty, with their own prefixes', () => {
        expect(Object.keys(REVISION_STRINGS.ru).sort()).toEqual(Object.keys(REVISION_STRINGS.en).sort());
        for (const [key, text] of Object.entries(REVISION_STRINGS.ru)) expect(text.trim(), key).not.toBe('');
        for (const key of Object.keys(REVISION_STRINGS.en))
            expect(key.startsWith('m8.') || key.startsWith('kind.') || key.startsWith('target.revision.'), key).toBe(
                true,
            );
    });

    it('name every target, autonomy kind, rejection and run reason', () => {
        const codes: RevisionRejectCode[] = [
            'lowConfidence',
            'unknownEntity',
            'unknownPlace',
            'noTarget',
            'noDictionary',
            'tag',
            'cyrillic',
            'notEnglish',
            'placeholder',
            'transitional',
            'malformed',
            'duplicate',
            'multiBlock',
            'anatomy',
            'uppercase',
            'slot',
            'keys',
            'name',
            'markup',
            'beforeMissing',
            'noChange',
            'protectedBook',
            'empty',
            'tooLong',
            'failed',
        ];
        for (const code of codes) expect(REVISION_STRINGS.en).toHaveProperty([`m8.reject.${code}`]);
        for (const target of REVISION_TARGETS) expect(REVISION_STRINGS.en).toHaveProperty([`m8.target.${target}`]);
        for (const kind of ROUTED_KINDS) expect(REVISION_STRINGS.en).toHaveProperty([`kind.${kind}`]);
        for (const reason of ['signals', 'interval', 'sceneEnd', 'manual']) {
            expect(REVISION_STRINGS.en).toHaveProperty([`m8.run.reason.${reason}`]);
        }
        for (const error of ['cap', 'no-cm', 'no-profile', 'breaker-open', 'refusal', 'parse', 'empty']) {
            expect(REVISION_STRINGS.en).toHaveProperty([`m8.error.${error}`]);
        }
    });
});
