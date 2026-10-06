import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleDefinition, RulesApi } from '../../../src/features/rules/api';
import { CAP_RULE_ID, DUPLICATES_RULE_ID, ROLE_RULE_ID } from '../../../src/features/rules/builtin';
import { RULE_FLAG_TARGET, RULE_TOGGLE_KIND, RulesEngine } from '../../../src/features/rules/engine';
import { createRulesTestApp, FakeLoreJournal, loggedErrors } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import { activationsOf, book, entry, freezeNested, listsOf, runScan } from '../../helpers/rules-wi';
import { EVENT_TYPES } from '../../helpers/st-mock';

let env: RulesTestApp;

beforeEach(() => {
    env = createRulesTestApp();
});

function listenerCount(event: string): number {
    return env.mock.eventSource.events.get(event)?.length ?? 0;
}

describe('module lifecycle', () => {
    it('registers the stage-1 and stage-2 rules, the tab, the styles and exposes the API', async () => {
        const rules = await startRules(env);
        const ids = rules.api.list().map((state) => state.id);
        expect(ids).toEqual([
            'role.assistantToSystem',
            'book.cap',
            'pack.duplicates',
            'qvink.gapGuard',
            'qvink.excludeImagePosts',
            'display.bunnymoTags',
            'ui.ckVectorizeButton',
            'ui.desPortraitBarMobile',
            'prompt.ckDumpsIgnore',
            'keys.cyrillicLeftBoundary',
            'pack.versionConflict',
            'wrapper.nsfwCollision',
            'ck.archiveDepth',
        ]);
        const tab = env.ui.tabs.find((item) => item.id === 'rules');
        expect(tab).toMatchObject({ titleKey: 'm22.tab', order: 60 });
        expect(env.ui.styles.has('m22-view')).toBe(true);
        expect(env.ui.styles.has('m22-ck-vectorize-button')).toBe(true);
        expect(env.ui.styles.has('m22-des-portrait-bar')).toBe(true);
        for (const state of rules.api.list()) {
            expect(env.app.i18n.t(state.definition.titleKey)).not.toBe(state.definition.titleKey);
            expect(env.app.i18n.t(state.definition.descriptionKey)).not.toBe(state.definition.descriptionKey);
        }
    });

    it('leaves no trace when stopped', async () => {
        const before = {
            loaded: listenerCount(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!),
            scan: listenerCount(EVENT_TYPES.WORLDINFO_SCAN_DONE!),
            received: listenerCount(EVENT_TYPES.MESSAGE_RECEIVED!),
        };
        env.finishWizard();
        const rules = await startRules(env);
        expect(listenerCount(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!)).toBe(before.loaded + 1);
        expect(listenerCount(EVENT_TYPES.WORLDINFO_SCAN_DONE!)).toBe(before.scan + 1);
        expect(listenerCount(EVENT_TYPES.MESSAGE_RECEIVED!)).toBe(before.received + 1);
        expect(env.turn.handlers.size).toBe(1);
        expect(env.tasks.runners.has('rules.qvinkSummarize')).toBe(true);

        await rules.stop();
        expect(listenerCount(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!)).toBe(before.loaded);
        expect(listenerCount(EVENT_TYPES.WORLDINFO_SCAN_DONE!)).toBe(before.scan);
        expect(listenerCount(EVENT_TYPES.MESSAGE_RECEIVED!)).toBe(before.received);
        expect(env.turn.handlers.size).toBe(0);
        expect(env.ui.styles.size).toBe(0);
        expect(env.ui.tabs).toEqual([]);
        expect(env.tasks.runners.size).toBe(0);
        expect(env.inbox.appliers.size).toBe(0);
        expect(env.modules.api('rules')).toBeUndefined();
    });
});

describe('enabled state', () => {
    let rules: Required<RulesApi>;

    beforeEach(async () => {
        rules = (await startRules(env)).api;
    });

    it('lets lore, prompt and neighbour rules wait for the first-run wizard; display and ui act at once', async () => {
        // "Enabled" is the intention (default or the user's switch); the wizard compares it with the user's choice.
        expect(rules.list().every((state) => state.enabled)).toBe(true);
        const waiting = Object.fromEntries(rules.list().map((state) => [state.id, state.waiting]));
        expect(waiting).toEqual({
            'role.assistantToSystem': true,
            'book.cap': true,
            'pack.duplicates': true,
            'qvink.gapGuard': true,
            'qvink.excludeImagePosts': true,
            'display.bunnymoTags': false,
            'ui.ckVectorizeButton': false,
            'ui.desPortraitBarMobile': false,
            'prompt.ckDumpsIgnore': false,
            'keys.cyrillicLeftBoundary': true,
            'pack.versionConflict': true,
            'wrapper.nsfwCollision': true,
            'ck.archiveDepth': true,
        });
        expect(env.turn.handlers.size).toBe(0);
        const lists = listsOf([book('Pack', [entry(1, { position: 4, role: 2 })])]);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(lists.globalLore[0]!.role).toBe(2);

        env.finishWizard();
        expect(rules.list().some((state) => state.waiting)).toBe(false);
        expect(env.turn.handlers.size).toBe(1);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(lists.globalLore[0]!.role).toBe(0);
    });

    it('keeps a rule the wizard switched off, and lets an explicit switch act before the wizard', async () => {
        // The wizard turns off what the user unchecked (isEnabled differs from the choice) before it finishes.
        await rules.setEnabled(DUPLICATES_RULE_ID, false);
        await rules.setEnabled(ROLE_RULE_ID, true);
        expect(rules.list().find((state) => state.id === ROLE_RULE_ID)).toMatchObject({
            explicit: true,
            waiting: false,
        });
        const lists = listsOf([book('Pack', [entry(1, { position: 4, role: 2 })])]);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(lists.globalLore[0]!.role).toBe(0);
        env.finishWizard();
        expect(rules.isEnabled(DUPLICATES_RULE_ID)).toBe(false);
        expect(rules.isEnabled('unknown.rule')).toBe(false);
    });

    it('switches through autonomy (auto by default) with a journal entry that undo reverts', async () => {
        env.finishWizard();
        await rules.setEnabled(DUPLICATES_RULE_ID, false);
        expect(rules.isEnabled(DUPLICATES_RULE_ID)).toBe(false);
        const proposal = env.autonomy.proposals.at(-1)!;
        expect(proposal).toMatchObject({ module: 'M22', kind: RULE_TOGGLE_KIND });
        const record = env.journal.records.at(-1)!;
        expect(record.changes).toEqual([
            { target: RULE_FLAG_TARGET, ref: { id: DUPLICATES_RULE_ID }, before: null, after: false },
        ]);

        await rules.setEnabled(DUPLICATES_RULE_ID, true);
        expect(env.journal.records.at(-1)!.changes[0]!.before).toBe(false);
        expect(await env.journal.undo(env.journal.records.at(-1)!.id)).toBe(true);
        expect(rules.isEnabled(DUPLICATES_RULE_ID)).toBe(false);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(rules.list().find((state) => state.id === DUPLICATES_RULE_ID)?.explicit).toBe(false);
        expect(rules.isEnabled(DUPLICATES_RULE_ID)).toBe(true);
    });

    it('switches without its own record for a caller that journals the switch itself (one line per action)', async () => {
        env.finishWizard();
        env.autonomy.levels.set(RULE_TOGGLE_KIND, 'inbox');
        await rules.setEnabled(DUPLICATES_RULE_ID, false, { journal: false });
        expect(rules.isEnabled(DUPLICATES_RULE_ID)).toBe(false);
        expect(env.autonomy.proposals).toHaveLength(0);
        expect(env.journal.records).toHaveLength(0);
        await rules.setEnabled('no.such.rule', true, { journal: false });
        expect(rules.isEnabled('no.such.rule')).toBe(false);
    });

    it('follows the autonomy level of the kind; Inbox cards apply through the registered applier', async () => {
        env.autonomy.levels.set(RULE_TOGGLE_KIND, 'inbox');
        await rules.setEnabled('display.bunnymoTags', false);
        expect(rules.isEnabled('display.bunnymoTags')).toBe(true);
        await env.inbox.appliers.get(RULE_TOGGLE_KIND)!({ id: 'display.bunnymoTags', enabled: false });
        expect(rules.isEnabled('display.bunnymoTags')).toBe(false);
        await env.inbox.appliers.get(RULE_TOGGLE_KIND)!({ bogus: true });
        await rules.setEnabled('no.such.rule', true);
        expect(env.journal.records).toHaveLength(0);
    });

    it('starts rules when their capabilities appear and stops them when they go', () => {
        env.neighbours.ck.present = false;
        void env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, 'chat-1');
        expect(env.ui.styles.has('m22-ck-vectorize-button')).toBe(false);
        const state = rules.list().find((item) => item.id === 'ui.ckVectorizeButton')!;
        expect(state).toMatchObject({ available: false, missing: ['ck.present'], running: false });

        env.neighbours.ck.present = true;
        void env.app.bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        expect(env.ui.styles.has('m22-ck-vectorize-button')).toBe(true);
    });
});

describe('registry', () => {
    it('starts registered rules, replaces duplicates and stops on unregister', () => {
        const engine = new RulesEngine(env.app, env.log);
        const stop = vi.fn();
        const rule: RuleDefinition = {
            id: 'test.rule',
            titleKey: 't',
            descriptionKey: 'd',
            owner: 'desru',
            stage: 2,
            kind: 'ui',
            defaultLevel: 'auto',
            enabledByDefault: true,
            start: () => stop,
        };
        const off = engine.register(rule);
        expect(engine.list()[0]).toMatchObject({ id: 'test.rule', running: true });
        const replacement = { ...rule, start: vi.fn() };
        const offReplacement = engine.register(replacement);
        expect(stop).toHaveBeenCalledTimes(1);
        off(); // stale disposer of the replaced definition does nothing
        expect(engine.rule('test.rule')).toBe(replacement);
        offReplacement();
        expect(engine.list()).toEqual([]);
    });

    it('does not retry a rule whose start throws until it is switched again', async () => {
        const engine = new RulesEngine(env.app, env.log);
        const start = vi.fn(() => {
            throw new Error('boom');
        });
        engine.register({
            id: 'bad.rule',
            titleKey: 't',
            descriptionKey: 'd',
            owner: 'maestro',
            stage: 1,
            kind: 'ui',
            defaultLevel: 'auto',
            enabledByDefault: true,
            start,
        });
        engine.sync();
        expect(start).toHaveBeenCalledTimes(1);
        expect(loggedErrors(env)).toHaveLength(1);
        await engine.setEnabled('bad.rule', true);
        expect(start).toHaveBeenCalledTimes(2);
        engine.dispose();
        engine.sync();
        expect(start).toHaveBeenCalledTimes(2);
    });
});

describe('WORLDINFO_ENTRIES_LOADED', () => {
    const books = () => [
        book('MBTI v1', [entry(1, { key: ['<INTJ-U>'], content: 'Architect.' })]),
        book('MBTI V2', [
            entry(1, { key: ['<intj-u>'], content: 'Architect.' }),
            entry(2, { position: 4, role: 2, content: 'Ozone filter.' }),
            entry(3, { position: 4, role: 1, content: 'User voice.' }),
        ]),
    ];

    beforeEach(async () => {
        env.finishWizard();
        await startRules(env);
    });

    it('applies the lore rules on copies without touching nested arrays', async () => {
        const source = books();
        freezeNested(source);
        const keyRefs = source.flatMap((item) => item.entries.map((wi) => wi.key));
        const lists = listsOf(source);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(loggedErrors(env)).toEqual([]);
        const [v1, v2, ozone, user] = lists.globalLore;
        expect(v1).toMatchObject({ world: 'MBTI v1', disable: true });
        expect(v2!.disable).toBeUndefined();
        expect(ozone).toMatchObject({ role: 0 });
        expect(user).toMatchObject({ role: 1 });
        expect(lists.globalLore.map((copy) => copy.key)).toEqual(keyRefs);
        // The cached entries themselves are untouched.
        expect(source[0]!.entries[0]!.disable).toBeUndefined();
        expect(source[1]!.entries[1]!.role).toBe(2);
    });

    it('gives the same result on every scan (deterministic)', async () => {
        const first = listsOf(books());
        const second = listsOf(books());
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, first);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, second);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('records the changes of the last scan per rule and the active books', async () => {
        const rules = env.modules.api<Required<RulesApi>>('rules')!;
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, listsOf(books()));
        const changes = Object.fromEntries(rules.list().map((state) => [state.id, state.lastChanges]));
        expect(changes[ROLE_RULE_ID]).toEqual([{ world: 'MBTI V2', uid: 2, field: 'role', before: 2, after: 0 }]);
        expect(changes[DUPLICATES_RULE_ID]).toEqual([
            { world: 'MBTI v1', uid: 1, field: 'disable', before: false, after: true },
        ]);
        expect(rules.activeBooks()).toEqual(['MBTI v1', 'MBTI V2']);

        await rules.setEnabled(ROLE_RULE_ID, false);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, listsOf(books()));
        expect(rules.list().find((state) => state.id === ROLE_RULE_ID)!.lastChanges).toEqual([]);
    });

    it('ignores malformed payloads and keeps going when a rule throws', async () => {
        const rules = env.modules.api<Required<RulesApi>>('rules')!;
        rules.register({
            id: 'throwing',
            titleKey: 't',
            descriptionKey: 'd',
            owner: 'maestro',
            stage: 1,
            kind: 'lore',
            defaultLevel: 'auto',
            enabledByDefault: true,
            order: 1,
            applyEntries() {
                throw new Error('bad rule');
            },
            applyScanDone() {
                throw new Error('bad scan');
            },
        });
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, null);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_SCAN_DONE!, 'nope');
        const lists = listsOf(books());
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, { ...lists, chatLore: 'x' });
        await runScan(env.mock, books(), 'nothing');
        expect(lists.globalLore[2]).toMatchObject({ role: 0 });
        expect(loggedErrors(env).length).toBeGreaterThanOrEqual(2);
    });
});

describe('simulations and compare', () => {
    const library = () => [
        book('Pack V1', [entry(1, { constant: true, content: 'Same text in both packs.' })]),
        book('Pack V2', [entry(1, { constant: true, content: 'Same text in both packs.' })]),
    ];

    it('skips rules M1 suspends and keeps the last real changes', async () => {
        env.finishWizard();
        const rules = (await startRules(env)).api;
        await runScan(env.mock, library(), '');
        const real = rules.list().find((state) => state.id === DUPLICATES_RULE_ID)!.lastChanges;
        expect(real).toHaveLength(1);

        let suspendedSeen = false;
        const lore = new FakeLoreJournal(async () => {
            suspendedSeen = rules.suspended(DUPLICATES_RULE_ID);
            return activationsOf(await runScan(env.mock, library(), ''));
        });
        env.modules.expose('loreJournal', lore);
        const record = await lore.simulate({ suspendRules: [DUPLICATES_RULE_ID] });
        expect(suspendedSeen).toBe(true);
        expect(record.activations).toHaveLength(2);
        expect(rules.suspended(DUPLICATES_RULE_ID)).toBe(false);
        expect(rules.list().find((state) => state.id === DUPLICATES_RULE_ID)!.lastChanges).toEqual(real);
        expect(rules.activeBooks()).toEqual(['Pack V1', 'Pack V2']);
    });

    it('compares before/after through M1, forcing rules that do not act', async () => {
        const rules = (await startRules(env)).api;
        // Before the wizard the rule waits (does not act on real scans); compare() still shows its effect.
        expect(rules.list().find((state) => state.id === DUPLICATES_RULE_ID)!.waiting).toBe(true);
        const lore = new FakeLoreJournal(async () => activationsOf(await runScan(env.mock, library(), '')));
        env.modules.expose('loreJournal', lore);

        const impact = await rules.compare([DUPLICATES_RULE_ID]);
        expect(lore.calls).toEqual([
            { deterministic: true, suspendRules: [DUPLICATES_RULE_ID] },
            { deterministic: true, suspendRules: [] },
        ]);
        expect(impact.before.activations).toHaveLength(2);
        expect(impact.after.activations).toHaveLength(1);
        expect(impact.removed).toEqual([
            { world: 'Pack V1', uid: 1, comment: 'Entry 1', chars: 'Same text in both packs.'.length },
        ]);
        expect(impact.added).toEqual([]);
        expect(impact.charsDelta).toBe(-'Same text in both packs.'.length);
        // Forcing ends with the comparison; a real scan does not apply the rule that is off.
        const real = await runScan(env.mock, library(), '');
        expect(real.activated.size).toBe(2);
    });

    it('needs M1 and runs one comparison at a time', async () => {
        const rules = (await startRules(env)).api;
        await expect(rules.compare([ROLE_RULE_ID])).rejects.toThrow('lore journal');
        let release: () => void = () => {};
        const lore = new FakeLoreJournal(
            () =>
                new Promise((resolve) => {
                    release = () => resolve([]);
                }),
        );
        env.modules.expose('loreJournal', lore);
        const first = rules.compare([ROLE_RULE_ID]);
        await expect(rules.compare([ROLE_RULE_ID])).rejects.toThrow('already running');
        release();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await expect(first).resolves.toMatchObject({ removed: [], added: [], charsDelta: 0 });
    });
});

describe('book caps settings', () => {
    it('stores clean caps per book and removes empty ones', async () => {
        const rules = (await startRules(env)).api;
        rules.setBookCap('Big World', { maxTokens: 1500.7, maxRecursionLevel: 1 });
        rules.setBookCap('Small', { maxTokens: 0, maxRecursionLevel: -1 });
        rules.setBookCap('', { maxTokens: 10 });
        expect(rules.bookCaps()).toEqual({ 'Big World': { maxTokens: 1500, maxRecursionLevel: 1 } });
        rules.setBookCap('Big World', null);
        expect(rules.bookCaps()).toEqual({});
        expect(rules.list().find((state) => state.id === CAP_RULE_ID)).toBeDefined();
    });

    it('offers caps and the gap limit as generic options (first-run wizard)', async () => {
        const rules = (await startRules(env)).api;
        rules.setBookCap('Big', { maxTokens: 900, maxRecursionLevel: 2 });
        rules.setBookCap('Old', { maxTokens: 300 });
        expect(rules.options('book.cap')).toEqual({ caps: { Big: 900, Old: 300 }, recursion: { Big: 2 } });
        expect(rules.options('qvink.gapGuard')).toEqual({ limit: 20 });
        expect(rules.options('role.assistantToSystem')).toBeUndefined();

        await rules.setOptions('book.cap', { caps: { Big: 1200, New: 500, Bad: 'x' } });
        expect(rules.bookCaps()).toEqual({
            Big: { maxTokens: 1200, maxRecursionLevel: 2 },
            New: { maxTokens: 500 },
        });
        await rules.setOptions('book.cap', { recursion: { New: 0 } });
        expect(rules.bookCaps()).toEqual({ Big: { maxTokens: 1200 }, New: { maxTokens: 500, maxRecursionLevel: 0 } });
        await rules.setOptions('qvink.gapGuard', { limit: 5 });
        expect(rules.options('qvink.gapGuard')).toEqual({ limit: 5 });
        await rules.setOptions('pack.duplicates', { anything: true });
        await rules.setOptions('qvink.gapGuard', { limit: 'many' });
        expect(rules.options('qvink.gapGuard')).toEqual({ limit: 5 });
    });

    it('repairs a broken settings slice', () => {
        const slice = env.settings.module<Record<string, unknown>>('rules');
        slice.enabled = 'x';
        slice.bookCaps = [];
        slice.gapGuardLimit = 'many';
        const engine = new RulesEngine(env.app, env.log);
        expect(engine.settings()).toEqual({
            enabled: {},
            bookCaps: {},
            gapGuardLimit: 20,
            packChoices: {},
            packAsked: {},
            archiveProposals: {},
        });
        engine.setGapGuardLimit(1000);
        expect(engine.settings().gapGuardLimit).toBe(200);
        engine.setGapGuardLimit(Number.NaN);
        expect(engine.settings().gapGuardLimit).toBe(20);
    });
});
