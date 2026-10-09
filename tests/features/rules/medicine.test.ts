// M22 rule 'bunnymo.medicineQuiet' (release 1.17): BunnyMo's «Medicine Check» leaves the scan while Dramatis claims it
// and owns the dependence of every character of the scene whose CK archive carries MED/REC tags; otherwise it stays.
// The pack file is never touched: only the scan copy is switched off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEDICINE_RULE_ID } from '../../../src/features/rules/builtin';
import type { EntryLists } from '../../../src/features/rules/api';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import type { StartedRules } from '../../helpers/rules-module';
import { book, entry, listsOf } from '../../helpers/rules-wi';
import type { WiBook } from '../../helpers/rules-wi';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { FakeWorld, tick, trackerReply, userMessage } from '../voices/helpers';

const CORE = '✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V3.0';
const ARCHIVES = 'Story Archives';

function coreBook(): WiBook {
    return book(CORE, [
        entry(2, { comment: 'Master - Fullsheet', key: ['!fullsheet'] }),
        entry(12, { comment: 'Master - Archetypes' }),
        entry(46, { comment: 'AUTO-TRIGGER: Jealousy Detection' }),
        entry(41, {
            comment: '💉 Master - Medicine Check',
            key: ['/^/'],
            constant: true,
            content: '<BunnymoTags:Master - Medicine Check>\n## 💊 MEDICINE CHECK — Active Behavioral Modifier',
        }),
    ]);
}

function archiveBook(): WiBook {
    return book(ARCHIVES, [
        entry(1, { comment: 'Ilva Character Archive', content: '<BunnymoTags><Name:Ilva>, <MED:SSRI></BunnymoTags>' }),
        entry(2, {
            comment: 'Bram Character Archive',
            content: '<BunnymoTags><Name:Bram>, <REC:ALCOHOL></BunnymoTags>',
        }),
        entry(3, { comment: 'Kai Character Archive', content: '<BunnymoTags><Name:Kai>, <TRAIT:CALM></BunnymoTags>' }),
        entry(4, {
            comment: 'Corvin Character Archive',
            content: '<BunnymoTags><Name:Corvin>, <TRAIT:CRUEL></BunnymoTags>',
        }),
    ]);
}

let env: RulesTestApp;
let rules: StartedRules;
let dramatis: InstalledDramatis;
let world: FakeWorld;
let loads: string[];

beforeEach(async () => {
    env = createRulesTestApp({ firstRunDone: true });
    env.mock.context.name1 = 'Kai';
    env.mock.chat = [
        userMessage('Evening.'),
        trackerReply([{ name: 'Ильва' }, { name: 'Bram' }, { name: 'Corvin' }, { name: 'Kai' }]),
        userMessage('A drink?'),
    ];
    world = new FakeWorld([
        { name: 'Kai', kind: 'persona', archive: `${ARCHIVES}#3` },
        { name: 'Ilva', aliases: ['Ильва'], archive: `${ARCHIVES}#1` },
        { name: 'Bram', archive: `${ARCHIVES}#2` },
        { name: 'Corvin', archive: `${ARCHIVES}#4` },
    ]);
    env.modules.apis.set('world', world);
    loads = [];
    const stored = Object.fromEntries(archiveBook().entries.map((item) => [String(item.uid), item]));
    (env.mock.context as unknown as Record<string, unknown>).loadWorldInfo = async (name: string) => {
        loads.push(name);
        return name === ARCHIVES ? { entries: structuredClone(stored) } : null;
    };
    dramatis = installDramatis(env.app);
    rules = await startRules(env);
});

afterEach(async () => {
    await rules.stop();
    dramatis.remove();
});

async function scan(books: WiBook[] = [coreBook(), archiveBook()]): Promise<EntryLists> {
    const lists = listsOf(books);
    await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
    return lists;
}

function medicine(lists: EntryLists) {
    return lists.globalLore.find((item) => item.world === CORE && item.uid === 41);
}

function state(): Record<string, unknown> | undefined {
    return rules.api.options(MEDICINE_RULE_ID);
}

describe('BunnyMo Medicine Check quiet mode', () => {
    it('is a lore rule on by default that needs Dramatis’s API', () => {
        const rule = rules.api.list().find((item) => item.id === MEDICINE_RULE_ID);
        expect(rule).toMatchObject({ enabled: true, waiting: false, available: true });
        dramatis.remove();
        expect(rules.api.list().find((item) => item.id === MEDICINE_RULE_ID)?.missing).toEqual(['dramatis.api']);
    });

    it('leaves the entry while Dramatis does not claim it', async () => {
        dramatis.api.owned = ['Ilva', 'Bram'];
        const lists = await scan();
        expect(medicine(lists)?.disable).toBeUndefined();
        expect(state()).toMatchObject({ verdict: 'off' });
    });

    it('switches the scan copy off when Dramatis owns every tagged character of the scene', async () => {
        dramatis.adapter.quiet('bunnymo.medicineCheck', 'dramatis');
        dramatis.api.owned = ['Ильва', 'Bram'];
        const lists = await scan();
        expect(medicine(lists)?.disable).toBe(true);
        expect(state()).toEqual({ verdict: 'dropped', tagged: ['Ilva', 'Bram'], notOwned: [] });
        const changes = rules.api.list().find((item) => item.id === MEDICINE_RULE_ID)?.lastChanges;
        expect(changes).toEqual([{ world: CORE, uid: 41, field: 'disable', before: false, after: true }]);
        // The cached entry (the pack) is untouched; other core entries stay.
        expect(lists.globalLore.filter((item) => item.disable === true)).toHaveLength(1);
    });

    it('keeps the entry while one tagged character is not Dramatis’s', async () => {
        dramatis.adapter.quiet('bunnymo.medicineCheck', 'dramatis');
        dramatis.api.owned = ['Ilva'];
        const lists = await scan();
        expect(medicine(lists)?.disable).toBeUndefined();
        expect(state()).toEqual({ verdict: 'notOwned', tagged: ['Ilva', 'Bram'], notOwned: ['Bram'] });
    });

    it('keeps it when nobody in the scene is tagged, and counts the persona as one of the scene', async () => {
        dramatis.adapter.quiet('bunnymo.medicineCheck', 'dramatis');
        env.mock.chat[1] = trackerReply([{ name: 'Corvin' }, { name: 'Bram', present: false }]);
        let lists = await scan();
        expect(medicine(lists)?.disable).toBeUndefined();
        expect(state()).toMatchObject({ verdict: 'none' });

        const books = [coreBook(), archiveBook()];
        books[1]!.entries[2]!.content = '<BunnymoTags><Name:Kai>, <MED:STIMULANT></BunnymoTags>';
        lists = await scan(books);
        expect(medicine(lists)?.disable).toBeUndefined();
        expect(state()).toEqual({ verdict: 'notOwned', tagged: ['Kai'], notOwned: ['Kai'] });
        dramatis.api.owned = ['Kai'];
        lists = await scan(books);
        expect(medicine(lists)?.disable).toBe(true);
    });

    it('reads archives outside the scan in the background and decides on the next scan', async () => {
        const context = env.mock.context as unknown as Record<string, unknown>;
        const read = context.loadWorldInfo as (name: string) => Promise<unknown>;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        context.loadWorldInfo = async (name: string) => {
            await gate;
            return read(name);
        };
        dramatis.api.owned = ['Ilva', 'Bram'];
        // The claim warms the archives of the scene; the scan does not wait for them (P15).
        dramatis.adapter.quiet('bunnymo.medicineCheck', 'dramatis');
        let lists = await scan([coreBook()]);
        expect(state()).toMatchObject({ verdict: 'loading' });
        expect(medicine(lists)?.disable).toBeUndefined();
        release();
        await tick();
        expect(loads).toEqual([ARCHIVES]);
        lists = await scan([coreBook()]);
        expect(medicine(lists)?.disable).toBe(true);
    });

    it('touches only the BunnyMo core’s entry and nothing while the rule is off', async () => {
        dramatis.adapter.quiet('bunnymo.medicineCheck', 'dramatis');
        dramatis.api.owned = ['Ilva', 'Bram'];
        const copy = book('My notes', [
            entry(7, { comment: 'Master - Medicine Check (my copy)', key: ['/^/'], constant: true }),
        ]);
        let lists = await scan([coreBook(), archiveBook(), copy]);
        expect(lists.globalLore.find((item) => item.world === 'My notes')?.disable).toBeUndefined();
        expect(medicine(lists)?.disable).toBe(true);

        await rules.api.setEnabled(MEDICINE_RULE_ID, false, { journal: false });
        lists = await scan();
        expect(medicine(lists)?.disable).toBeUndefined();
    });
});
