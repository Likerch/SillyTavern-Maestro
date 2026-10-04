// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bunnymoModeModule } from '../../../src/features/bunnymoMode';
import type { BunnyMoModeApi } from '../../../src/features/bunnymoMode/api';
import type { PackGroupInfo, RuleState, RulesApi } from '../../../src/features/rules/api';
import type { SheetsApi } from '../../../src/features/sheets/api';
import { ARCHIVES, ATSU_CONTENT, CORE, MBTI_V1, MBTI_V2, SPECIES } from './fixtures';
import { bunnySaves, bunnySnapshot, createBunnyEnv, loadFixtures, settle, startModule } from './helpers';
import type { BunnyEnv } from './helpers';

let env: BunnyEnv;
let api: Required<BunnyMoModeApi>;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;
let before: string;

beforeEach(async () => {
    env = createBunnyEnv();
    loadFixtures(env);
    env.ck.repos = [ARCHIVES];
    env.neighbours.active = [CORE, MBTI_V2, SPECIES];
    before = bunnySnapshot(env);
    const started = await startModule(env, bunnymoModeModule);
    stop = () => started.stop();
    api = env.modules.api<Required<BunnyMoModeApi>>('bunnymoMode')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
    env.ui.openPult = () => render();
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    expect(bunnySnapshot(env)).toBe(before);
    expect(bunnySaves(env)).toEqual([]);
    await stop();
});

function render(): void {
    if (typeof unmount === 'function') unmount();
    container.replaceChildren();
    unmount = env.ui.tabs.find((tab) => tab.id === 'bunnymo')!.render(container);
}

/**
 * Lets async renders finish: mostly microtasks (book loads are promise chains), plus a few timer turns for the chat
 * metadata save (happy-dom timers cost ~15 ms each on Windows, so they are kept few).
 */
async function ready(timers = 2): Promise<void> {
    for (let turn = 0; turn <= timers; turn++) {
        for (let i = 0; i < 200; i++) await Promise.resolve();
        if (turn < timers) await settle(1);
    }
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) {
        throw new Error(
            `no button ${text}: ${[...root.querySelectorAll('button')].map((n) => n.textContent).join(' | ')}`,
        );
    }
    return found;
}

function section(name: string): Promise<void> {
    buttonByText(name).click();
    return ready();
}

describe('BunnyMo tab', () => {
    it('opens on the tag dictionary with search and the category filter', async () => {
        render();
        await ready();
        const body = container.querySelector<HTMLElement>('.maestro-m35b-body')!;
        expect(body.dataset.section).toBe('dictionary');
        expect(container.textContent).toMatch(/\d+ tags in \d+ categories · conflicts: \d+ · without a pack: \d+/);
        const search = container.querySelector<HTMLInputElement>('.maestro-m35b-search')!;
        search.value = 'kuudere';
        search.dispatchEvent(new Event('input'));
        const tags = [...container.querySelectorAll<HTMLElement>('.maestro-m35b-tag')].map((node) => node.dataset.tag);
        // Tags of the matching entry (by title) come along.
        expect(tags).toEqual(['<COLD_DERE>', '<DERE:KUUDERE>', '<KUU>', '<KUUDERE>']);
        // The tag card opens on demand with its pulls and archives.
        const details = container.querySelector<HTMLDetailsElement>('[data-tag="<DERE:KUUDERE>"]')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        expect(details.textContent).toContain('❄️😐 Kuudere — The Ice Mage');
        expect(details.textContent).toContain('Мира');
        search.value = '';
        search.dispatchEvent(new Event('input'));
        const select = container.querySelector<HTMLSelectElement>('.maestro-m35b-controls select')!;
        select.value = 'MBTI';
        select.dispatchEvent(new Event('change'));
        const mbti = [...container.querySelectorAll<HTMLElement>('.maestro-m35b-tag')].map((node) => node.dataset.tag);
        expect(mbti).toEqual(['<ENTJ-U>', '<INTJ-H>', '<INTJ-U>', '<ISTJ-H>']);
        expect(container.querySelector('[data-tag="<INTJ-U>"]')?.textContent).toContain('version conflict');
        select.value = '\u0000flags';
        select.dispatchEvent(new Event('change'));
        expect(
            [...container.querySelectorAll<HTMLElement>('.maestro-m35b-tag')].every(
                (node) => !node.dataset.tag?.includes(':'),
            ),
        ).toBe(true);
    });

    it('opens on a tag from the API, and on an archive from the tag card', async () => {
        api.open({ tag: 'species:elf' });
        await ready();
        const open = container.querySelector<HTMLDetailsElement>('.maestro-m35b-tag[open]');
        expect(open?.dataset.tag).toBe('<SPECIES:ELF>');
        expect(open?.textContent).toContain('duplicate');
        buttonByText('Мира', open!).click();
        await ready();
        expect(container.querySelector<HTMLElement>('.maestro-m35b-body')?.dataset.section).toBe('sheets');
        expect(container.querySelector('.maestro-m35b-name')?.textContent).toBe('Мира');
    });

    it('opens a pack and the archive list from a book target', async () => {
        api.open({ book: MBTI_V1 });
        await ready();
        expect(container.querySelector<HTMLElement>('.maestro-m35b-body')?.dataset.section).toBe('packs');
        expect(container.querySelector('.maestro-m35b-focus')?.getAttribute('data-book')).toBe(MBTI_V1);
        api.open({ book: ARCHIVES });
        await ready();
        expect(container.querySelector<HTMLElement>('.maestro-m35b-body')?.dataset.section).toBe('sheets');
        expect(container.querySelectorAll('.maestro-m35b-archive')).toHaveLength(2);
    });

    it('runs the command on a character name', async () => {
        await env.commands[0]!.callback({}, 'Atsu');
        await ready();
        expect(container.querySelector('.maestro-m35b-name')?.textContent).toBe('Atsu_Ibn_Oba_Al-Masri');
    });
});

describe('packs view', () => {
    it('lists packs and switches the per-chat selection', async () => {
        render();
        await ready();
        await section('Packs');
        expect(container.textContent).toContain(`Core «${CORE}» · V3.0`);
        const cards = [...container.querySelectorAll<HTMLElement>('.maestro-m35b-pack')];
        expect(cards.slice(0, 2).map((card) => card.dataset.book)).toEqual([MBTI_V2, SPECIES]);
        const all = container.querySelector<HTMLInputElement>('.maestro-m35b-selection input[type=checkbox]')!;
        expect(all.checked).toBe(true);
        all.checked = false;
        all.dispatchEvent(new Event('change'));
        await ready();
        expect(api.selection()).toEqual({ mode: 'only', books: [MBTI_V2, SPECIES].sort() });
        const species = [...container.querySelectorAll<HTMLElement>('.maestro-m35b-pack')].find(
            (card) => card.dataset.book === SPECIES,
        )!;
        const inChat = species.querySelector<HTMLInputElement>('input[type=checkbox]')!;
        expect(inChat.disabled).toBe(false);
        inChat.checked = false;
        inChat.dispatchEvent(new Event('change'));
        await ready();
        expect(api.selection()).toEqual({ mode: 'only', books: [MBTI_V2] });
    });

    it('compares a pack with a file and shows the version conflicts M22 asks about', async () => {
        const group: PackGroupInfo = {
            id: 'g',
            books: [MBTI_V1, MBTI_V2],
            newest: MBTI_V2,
            count: 3,
            sample: [],
            choice: MBTI_V2,
            asked: true,
        };
        env.modules.expose('rules', { options: () => ({ groups: [group] }) } satisfies Partial<RulesApi>);
        render();
        await ready();
        await section('Packs');
        expect(container.textContent).toContain(`${MBTI_V1} · ${MBTI_V2}: «${MBTI_V2}» stays`);
        const card = [...container.querySelectorAll<HTMLElement>('.maestro-m35b-pack')].find(
            (node) => node.dataset.book === MBTI_V1,
        )!;
        const input = card.querySelector<HTMLInputElement>('input[type=file]')!;
        const data = JSON.stringify(env.world.books.get(MBTI_V2));
        Object.defineProperty(input, 'files', { value: [new File([data], 'v2.json')] });
        input.dispatchEvent(new Event('change'));
        await ready(4);
        expect(container.textContent).toContain(`«${MBTI_V1}» compared with «v2.json»`);
        expect(container.textContent).toContain('Changed (3)');
        buttonByText('Close the comparison').click();
        await ready();
        expect(container.textContent).not.toContain('compared with');
    });
});

describe('integrity and runtime fixes', () => {
    it('lists integrity findings', async () => {
        env.neighbours.active = [MBTI_V2];
        render();
        await ready();
        await section('Integrity');
        expect(container.querySelectorAll('.maestro-m35b-finding')).toHaveLength(1);
        expect(container.textContent).toContain('the core');
        env.neighbours.active = [CORE, MBTI_V2];
        buttonByText('Refresh').click();
        await ready();
        expect(container.textContent).toContain('Everything is in order.');
    });

    it('shows rule changes to BunnyMo books with switches, and the per-chat suppression', async () => {
        const toggled: [string, boolean][] = [];
        const state: RuleState = {
            id: 'role.assistantToSystem',
            enabled: true,
            lastChanges: [{ world: CORE, uid: 64, field: 'role', before: 2, after: 0 }],
            definition: {
                id: 'role.assistantToSystem',
                titleKey: 'm22.rule.role.assistantToSystem.title',
                descriptionKey: '',
                owner: 'maestro',
                stage: 1,
                kind: 'lore',
                defaultLevel: 'auto',
                enabledByDefault: true,
            },
        };
        env.modules.expose('rules', {
            list: () => [state],
            setEnabled: async (id: string, enabled: boolean) => {
                toggled.push([id, enabled]);
                state.enabled = enabled;
            },
        } satisfies Partial<RulesApi>);
        env.desru.present = true;
        env.desru.bunnymo = true;
        await api.setSelection({ mode: 'only', books: [MBTI_V2] });
        render();
        await ready();
        await section('Runtime fixes');
        expect(container.textContent).toContain('changes in the last scan: 1');
        expect(container.textContent).toContain(`«${CORE}» · #64 · role: 2 → 0`);
        expect(container.textContent).toContain('DES-RU (module 5)');
        const rule = container.querySelector<HTMLInputElement>(
            '[data-rule="role.assistantToSystem"] input[type=checkbox]',
        )!;
        rule.checked = false;
        rule.dispatchEvent(new Event('change'));
        await ready();
        expect(toggled).toEqual([['role.assistantToSystem', false]]);
        buttonByText('Use every pack again').click();
        await ready();
        expect(api.selection()).toEqual({ mode: 'all' });
    });

    it('says when the rules module is off', async () => {
        render();
        await ready();
        await section('Runtime fixes');
        expect(container.textContent).toContain('The «Rules» module is off');
    });
});

describe('sheet editor', () => {
    beforeEach(() => {
        const sheets: SheetsApi = {
            isSheetMessage: () => false,
            sheetsFor: (name) => (name === 'Atsu_Ibn_Oba_Al-Masri' ? [{ index: 12, command: 'fullsheet' }] : []),
            checkTags: async () => null,
        };
        env.modules.expose('sheets', sheets);
    });

    async function openAtsu(): Promise<void> {
        render();
        await ready();
        await section('Sheets');
        buttonByText('Atsu_Ibn_Oba_Al-Masri · tags: 21').click();
        await ready(4);
    }

    it('edits tags, MBTI and Linguistics and saves only what changed', async () => {
        await openAtsu();
        expect(container.querySelector('.maestro-m35b-name')?.textContent).toBe('Atsu_Ibn_Oba_Al-Masri');
        expect(container.textContent).toContain('message #12 · !fullsheet');
        const chips = () => [...container.querySelectorAll<HTMLElement>('.maestro-m35b-chip')];
        expect(chips()).toHaveLength(21);
        // The tag check marks tags of packs that are not loaded and offers fixes.
        expect(container.querySelector('.maestro-m35b-problems')?.textContent).toContain('<TRAIT:CRUEL>');
        // Remove <TRAIT:INTELLIGENT>.
        const intelligent = chips().find((chip) => chip.textContent?.includes('<TRAIT:INTELLIGENT>'))!;
        intelligent.querySelector<HTMLButtonElement>('.maestro-m35b-chip-remove')!.click();
        // Replace <TRAIT:CRUEL> through the add row.
        chips()
            .find((chip) => chip.textContent?.includes('<TRAIT:CRUEL>'))!
            .querySelector<HTMLButtonElement>('.maestro-m35b-chip-text')!
            .click();
        const value = container.querySelector<HTMLInputElement>('.maestro-m35b-value')!;
        expect(value.value).toBe('CRUEL');
        value.value = 'merciful';
        value.dispatchEvent(new Event('input'));
        buttonByText('Replace').click();
        // Add a new tag.
        const category = container.querySelector<HTMLSelectElement>('.maestro-m35b-addrow select')!;
        category.value = 'KINK';
        category.dispatchEvent(new Event('change'));
        const fresh = container.querySelector<HTMLInputElement>('.maestro-m35b-value')!;
        fresh.value = 'praise';
        fresh.dispatchEvent(new Event('input'));
        fresh.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        // MBTI H/U.
        buttonByText('H — healthy').click();
        await ready();
        buttonByText('Save').click();
        await ready(4);
        const expected = ATSU_CONTENT.replace('<TRAIT:INTELLIGENT>, ', '')
            .replace('<TRAIT:CRUEL>', '<TRAIT:MERCIFUL>')
            .replace('<ENTJ-U>', '<ENTJ-H>')
            .replace('<JEALOUSY:POSSESSIVE>,</NSFW>', '<JEALOUSY:POSSESSIVE>,<KINK:PRAISE>, </NSFW>');
        expect(env.world.entry(ARCHIVES, 0)?.content).toBe(expected);
        expect(env.ui.notices.map((notice) => notice.text)).toContain('Sheet of Atsu_Ibn_Oba_Al-Masri saved.');
        // The editor reloads the saved sheet.
        expect(container.querySelectorAll('.maestro-m35b-chip')).toHaveLength(21);
    });

    it('applies a suggestion, discards changes and says when nothing changed', async () => {
        await env.world.edit(ARCHIVES, 1, {
            content: String(env.world.entry(ARCHIVES, 1)!.content).replace('<Dere:Kuudere>', '<DERE:KUDERE>'),
        });
        render();
        await ready();
        await section('Sheets');
        buttonByText('Мира · tags: 6').click();
        await ready(4);
        buttonByText('Use <DERE:KUUDERE>').click();
        await ready();
        expect(container.querySelector('.maestro-m35b-chips')?.textContent).toContain('<DERE:KUUDERE>');
        buttonByText('Discard changes').click();
        await ready(4);
        expect(container.querySelector('.maestro-m35b-chips')?.textContent).toContain('<DERE:KUDERE>');
        buttonByText('Save').click();
        await ready();
        expect(env.ui.notices.map((notice) => notice.text)).toContain('Nothing has changed.');
        expect(env.world.saves.filter((save) => save.name === ARCHIVES)).toHaveLength(1);
        buttonByText('Back to the list').click();
        await ready();
        expect(container.querySelectorAll('.maestro-m35b-archive')).toHaveLength(2);
    });

    it('blocks saving an entry with several characters', async () => {
        await env.world.edit(ARCHIVES, 1, {
            content: `${String(env.world.entry(ARCHIVES, 1)!.content)}\n<BunnymoTags><Name:Ann></BunnymoTags>`,
        });
        render();
        await ready();
        await section('Sheets');
        buttonByText('Мира · tags: 6').click();
        await ready(4);
        expect(container.textContent).toContain('holds 2 <BunnymoTags> blocks');
        expect(buttonByText('Save').disabled).toBe(true);
    });

    it('shows a save error as a notice', async () => {
        await openAtsu();
        env.mock.context.saveWorldInfo = undefined;
        buttonByText('H — healthy').click();
        buttonByText('Save').click();
        await ready(4);
        expect(env.ui.notices.some((notice) => notice.options?.level === 'error')).toBe(true);
    });
});
