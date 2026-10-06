// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DossierApi } from '../../../src/features/dossier/api';
import type { Dossier } from '../../../src/features/dossier/api';
import { spreadTargets } from '../../../src/features/dossier/view';
import type { Outfit, WardrobeApi, Wearing } from '../../../src/features/wardrobe/api';
import { WARDROBE_STRINGS } from '../../../src/features/wardrobe/strings';
import type { PultTab } from '../../../src/shared/contracts';
import { LYRA_ID, lyraScene } from './fixtures';
import { FakeWorldModel, createDossierEnv, settle, startDossier, wi } from './helpers';
import type { DossierEnv } from './helpers';

let env: DossierEnv;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;
let api: DossierApi;

function tab(): PultTab {
    return env.ui.tabs.find((item) => item.id === 'dossier')!;
}

function buttons(root: ParentNode = container): HTMLButtonElement[] {
    return [...root.querySelectorAll<HTMLButtonElement>('button')];
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = buttons(root).find((node) => node.textContent?.trim() === text);
    if (!found)
        throw new Error(
            `no button «${text}»: ${buttons(root)
                .map((node) => node.textContent)
                .join(' | ')}`,
        );
    return found;
}

function sectionByKind(kind: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`.maestro-m7-section[data-kind="${kind}"]`);
    if (!found) throw new Error(`no section ${kind}`);
    return found;
}

async function render(): Promise<void> {
    unmount = tab().render(container);
    await settle();
}

beforeEach(async () => {
    env = createDossierEnv();
    lyraScene(env);
    env.modules.expose('loreStore', {});
    const started = await startDossier(env);
    stop = () => started.stop();
    api = env.modules.api<DossierApi>('dossier')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    await stop();
});

describe('dossier tab', () => {
    it('is registered as tab 44 and shows the picker with the persona first', async () => {
        expect(tab()).toMatchObject({ titleKey: 'm7.tab', order: 44 });
        await render();
        const chips = [...container.querySelectorAll('.maestro-m7-chip')].map((node) => node.textContent?.trim());
        expect(chips).toEqual(['Алекс', 'Лира']);
        expect(container.querySelector('.maestro-m7-present')?.textContent?.trim()).toBe('Лира');
        expect(container.textContent).toContain('The world model is off');
        const search = container.querySelector<HTMLInputElement>('.maestro-m7-search')!;
        search.value = 'лисич';
        search.dispatchEvent(new Event('input'));
        expect([...container.querySelectorAll('.maestro-m7-chip')].map((node) => node.textContent?.trim())).toEqual([
            'Лира',
        ]);
        search.value = 'zzz';
        search.dispatchEvent(new Event('input'));
        expect(container.textContent).toContain('Nobody matches this search.');
    });

    it('opens a dossier with findings, sections and the open links', async () => {
        await render();
        buttonByText('Лира').click();
        await settle();
        expect(container.querySelector('.maestro-m7-name')?.textContent).toBe('Лира');
        expect(container.textContent).toContain('on scene');
        expect(container.textContent).toContain('Checks (2)');
        expect(
            [...container.querySelectorAll('.maestro-m7-finding')].map((node) => (node as HTMLElement).dataset.kind),
        ).toEqual(['aliasNotKey', 'formsMissing']);
        const des = sectionByKind('des');
        expect(des.querySelector('summary')?.textContent).toContain('DES: Лира');
        expect([...des.querySelectorAll('dt')].map((node) => node.textContent)).toContain('Health');
        expect([...des.querySelectorAll('dt')].map((node) => node.textContent)).toContain('Relationship now');
        const naiLabels = [...sectionByKind('nai').querySelectorAll('dt')].map((node) => node.textContent);
        expect(naiLabels).toContain('Hair');
        expect(naiLabels).toContain('Hair on the card');
        expect(naiLabels).toContain('Edit in');
        expect(sectionByKind('nai').querySelector('button')).toBeNull();

        buttonByText('Open', sectionByKind('lore')).click();
        await settle();
        expect(env.slashRuns).toEqual(['/maestro-lore World']);
        buttonByText('Open', sectionByKind('qvink')).click();
        await settle();
        expect(env.slashRuns.at(-1)).toBe('/chat-jump 3');
        expect(sectionByKind('forms').querySelector('button')).toBeNull();
    });

    it('proposes a fix from a finding', async () => {
        api.open(LYRA_ID);
        await render();
        const finding = container.querySelector<HTMLElement>('.maestro-m7-finding[data-kind="aliasNotKey"]')!;
        buttonByText('Add the name «Лисичка» to the entry', finding).click();
        await settle();
        expect(env.autonomy.proposals.at(-1)?.kind).toBe('dossier.fixFile');
        expect(env.ui.notices.at(-1)).toMatchObject({ text: 'Sent to the Inbox.', options: { urgent: true } });
    });

    it('runs the AI comparison from the button and shows its estimate and cost', async () => {
        api.open(LYRA_ID);
        await render();
        expect(container.textContent).toMatch(/7 sources, ≈ \d+ tokens/);
        expect(container.textContent).toContain('Background spend today');
        const run = buttonByText('Compare with AI');
        expect(run.disabled).toBe(false);
        run.click();
        await settle();
        expect(env.tasks.queued.map((task) => task.kind)).toEqual(['dossier.compare']);
        await env.tasks.runLatest('dossier.compare');
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('AI found no contradictions.');
        expect(container.textContent).toContain('0 found, cost $0.0012');
    });

    it('disables the comparison when this tab cannot run it', async () => {
        env.leader.value = false;
        api.open(LYRA_ID);
        await render();
        expect(buttonByText('Compare with AI').disabled).toBe(true);
        expect(container.textContent).toContain('Background work runs in another tab');
    });

    it('spreads an edit to the checked targets', async () => {
        api.open(LYRA_ID);
        await render();
        const spread = container.querySelector<HTMLElement>('.maestro-m7-spread')!;
        const labels = [...spread.querySelectorAll('label')].map((node) => node.textContent);
        expect(labels).toEqual(['DES: Лира', 'lore entry: Lyra', 'looks for pictures: Лира']);
        buttonByText('Spread', spread).click();
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('Enter a value and tick at least one source.');
        spread.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Лиса';
        spread.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked = false;
        buttonByText('Spread', spread).click();
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('Edits prepared: 2.');
        expect(env.inbox2.added.map((card) => card.kind)).toEqual(['dossier.note']);
        const field = spread.querySelector<HTMLSelectElement>('select')!;
        field.value = 'description';
        field.dispatchEvent(new Event('change'));
        expect([...spread.querySelectorAll('label')].map((node) => node.textContent)).toEqual(['lore entry: Lyra']);
        spread.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Healer.';
        buttonByText('Spread', spread).click();
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('It is already like that everywhere — nothing to change.');
    });

    it('expands long texts, goes back to the list and shows errors', async () => {
        env.world.book('World', [wi(1, { comment: 'Lyra', key: ['Лира'], content: 'long '.repeat(400) })]);
        api.open(LYRA_ID);
        await render();
        const lore = sectionByKind('lore');
        expect(lore.querySelector('.maestro-m7-text span')?.textContent?.endsWith('…')).toBe(true);
        buttonByText('Show all', lore).click();
        expect(lore.querySelector('.maestro-m7-text span')?.textContent?.endsWith('…')).toBe(false);
        buttonByText('Collapse', lore).click();
        buttonByText('Refresh').click();
        await settle();
        buttonByText('All').click();
        await settle();
        expect(container.querySelector('.maestro-m7-search')).not.toBeNull();
        api.open('character:никто');
        await settle();
        expect(container.textContent).toContain(
            'I do not know who this is: there is no such character or place in this chat.',
        );
        buttonByText('All').click();
        await settle();
        expect(container.querySelector('.maestro-m7-search')).not.toBeNull();
    });

    it('refreshes the picker when the world model changes', async () => {
        const world = new FakeWorldModel([
            { id: 'character:мара', kind: 'character', name: 'Мара', aliases: [], forms: [], sources: [] },
        ]);
        env.modules.expose('world', world);
        await render();
        expect(container.textContent).not.toContain('The world model is off');
        world.list.push({ id: 'item:меч', kind: 'item', name: 'Меч', aliases: [], forms: [], sources: [] });
        for (const listener of world.listeners) listener();
        expect([...container.querySelectorAll('.maestro-m7-chip')].map((node) => node.textContent?.trim())).toEqual([
            'Мара',
            'Меч',
        ]);
    });
});

describe('dossier outfits (M27 п.4)', () => {
    /** The wardrobe's API over a list: outfits of «Лира» only, wear() switches «active» and tells the listeners. */
    function fakeWardrobe(list: Outfit[], options: { failWear?: string; now?: Wearing[] } = {}) {
        const listeners = new Set<() => void>();
        const worn: [string, string][] = [];
        const asked: (string | undefined)[] = [];
        const now = options.now;
        const wardrobe: WardrobeApi = {
            ...(now ? { current: (character?: string) => now.filter((item) => item.name === character) } : {}),
            outfits(character) {
                asked.push(character);
                return character === 'Лира' ? list.map((outfit) => ({ ...outfit })) : [];
            },
            changes: () => [],
            async wear(passportId, outfit) {
                if (options.failWear) throw new Error(options.failWear);
                worn.push([passportId, outfit]);
                for (const item of list) item.active = item.name === outfit;
                for (const listener of listeners) listener();
            },
            onChange(listener) {
                listeners.add(listener);
                return () => void listeners.delete(listener);
            },
        };
        env.modules.expose('wardrobe', wardrobe);
        return { list, listeners, worn, asked, now };
    }

    const outfit = (name: string, tags: string, active = false): Outfit => ({
        passportId: 'p-lyra',
        character: 'Лира',
        name,
        tags,
        seenAs: [],
        firstSeen: 1,
        lastSeen: 1,
        active,
    });

    const box = () => container.querySelector<HTMLElement>('.maestro-m7-wardrobe');
    const rows = () => [...container.querySelectorAll<HTMLElement>('.maestro-m7-outfit')];

    it('lists the character’s outfits with tags, the worn one marked, and puts one on', async () => {
        const wardrobe = fakeWardrobe([
            outfit('travel cloak', 'grey travel cloak, leather boots', true),
            outfit('ballgown', 'white ball gown, long gloves'),
        ]);
        api.open(LYRA_ID);
        await render();
        expect(wardrobe.asked).toContain('Лира');
        expect(box()!.hidden).toBe(false);
        const title = (node: Element | undefined) => node?.querySelector('.maestro-section-title')?.textContent;
        expect(title(box()!)).toBe('Outfits (2)');
        expect(rows().map((row) => row.dataset.outfit)).toEqual(['travel cloak', 'ballgown']);
        expect(rows()[0]!.textContent).toContain('worn');
        expect(rows()[0]!.textContent).toContain('grey travel cloak, leather boots');
        expect(rows()[0]!.querySelector('button')).toBeNull();
        expect(rows()[1]!.textContent).not.toContain('worn');
        // The block sits between the checks and the sections.
        const blocks = [...container.querySelectorAll('.maestro-m7 > *')];
        const at = blocks.indexOf(box()!);
        expect(title(blocks[at - 1])).toBe('Checks (2)');
        expect(title(blocks[at + 1])).toMatch(/^What is known \(\d+\)$/);

        buttonByText('Put on', rows()[1]!).click();
        await settle();
        expect(wardrobe.worn).toEqual([['p-lyra', 'ballgown']]);
        expect(env.ui.notices.at(-1)?.text).toBe('«ballgown» is on now.');
        expect(rows()[1]!.textContent).toContain('worn');
        expect(rows()[1]!.querySelector('button')).toBeNull();
        expect(rows()[0]!.querySelector('button')).not.toBeNull();
    });

    it('stays hidden without outfits, shows up when the wardrobe learns one, and reports a failed «put on»', async () => {
        const wardrobe = fakeWardrobe([], { failWear: 'The passport is no longer in this chat.' });
        api.open(LYRA_ID);
        await render();
        expect(box()!.hidden).toBe(true);
        expect(rows()).toEqual([]);
        // A page edit survives the refresh: only the outfit block is redrawn.
        const value = container.querySelector<HTMLTextAreaElement>('.maestro-m7-spread textarea')!;
        value.value = 'draft';
        wardrobe.list.push(outfit('ballgown', 'white ball gown'));
        for (const listener of wardrobe.listeners) listener();
        expect(box()!.hidden).toBe(false);
        expect(rows().map((row) => row.dataset.outfit)).toEqual(['ballgown']);
        expect(container.querySelector<HTMLTextAreaElement>('.maestro-m7-spread textarea')!.value).toBe('draft');
        buttonByText('Put on', rows()[0]!).click();
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('The passport is no longer in this chat.');
        expect(wardrobe.worn).toEqual([]);
    });

    it('says in the header what the character wears now (release 1.11)', async () => {
        env.app.i18n.register(WARDROBE_STRINGS);
        const item: Wearing = {
            key: 'p-lyra',
            name: 'Лира',
            persona: false,
            passportId: 'p-lyra',
            wording: 'в сером дорожном плаще',
            tags: 'grey travel cloak',
            undress: '',
            outfit: 'travel cloak',
            since: 4,
            seen: 6,
            turns: 2,
            present: true,
            source: 'appearance',
        };
        const wardrobe = fakeWardrobe([outfit('travel cloak', 'grey travel cloak', true)], { now: [item] });
        api.open(LYRA_ID);
        await render();
        const now = () => container.querySelector<HTMLElement>('.maestro-m7-now')!;
        expect(now().hidden).toBe(false);
        expect(now().textContent).toBe('Wearing: в сером дорожном плащеOutfit: «travel cloak» · since message #4');
        // The wardrobe learns other clothing: the header follows without a reload.
        Object.assign(item, { wording: 'в белой рубахе', outfit: null, since: 8 });
        for (const listener of wardrobe.listeners) listener();
        expect(now().textContent).toBe(
            'Wearing: в белой рубахеNew — remembered if it stays one more turn · since message #8',
        );
        Object.assign(item, { outfit: '', passportId: '' });
        for (const listener of wardrobe.listeners) listener();
        expect(now().querySelector('.maestro-m7-now-meta')!.textContent).toBe('since message #8');
        wardrobe.now!.length = 0;
        for (const listener of wardrobe.listeners) listener();
        expect(now().hidden).toBe(true);
    });

    it('is not there without the wardrobe module, and hidden for someone without outfits', async () => {
        api.open(LYRA_ID);
        await render();
        expect(box()).toBeNull();
        expect(container.querySelector('.maestro-m7-name')?.textContent).toBe('Лира');
        if (typeof unmount === 'function') unmount();
        unmount = undefined;
        fakeWardrobe([outfit('ballgown', 'white ball gown')]);
        container.replaceChildren();
        await render();
        buttonByText('All').click();
        await settle();
        buttonByText('Алекс').click();
        await settle();
        expect(container.querySelector('.maestro-m7-name')?.textContent).toBe('Алекс');
        expect(box()?.hidden ?? true).toBe(true);
        expect(rows()).toEqual([]);
    });
});

describe('spreadTargets', () => {
    const dossier: Dossier = {
        entityId: LYRA_ID,
        name: 'Лира',
        kind: 'character',
        builtAt: 0,
        findings: [],
        sections: [
            {
                kind: 'lore',
                title: 'a',
                text: '',
                source: { kind: 'lore.entry', ref: 'W#1', label: 'a', world: 'W', uid: 1 },
            },
            {
                kind: 'lore',
                title: 'a',
                text: '',
                source: { kind: 'lore.entry', ref: 'W#1', label: 'a', world: 'W', uid: 1 },
            },
            {
                kind: 'lore',
                title: 'p',
                text: '',
                fields: { protected: 'yes' },
                source: { kind: 'lore.entry', ref: 'P#1', label: 'p', world: 'P', uid: 1 },
            },
            {
                kind: 'nai',
                title: 'n',
                text: '',
                source: { kind: 'nai.passport', ref: 'a#p', label: 'n', avatar: 'a' },
            },
            { kind: 'des', title: 'd', text: '', source: { kind: 'des.character', ref: 'Лира', label: 'Лира' } },
            { kind: 'forms', title: 'f', text: '' },
        ],
    };

    it('keeps the stores that can take a field', () => {
        const options = { naiWrites: true, worldOn: true, chatAliasLabel: 'chat' };
        expect(spreadTargets(dossier, 'alias', options).map((source) => source.kind)).toEqual([
            'lore.entry',
            'nai.passport',
            'des.character',
            'chat.alias',
        ]);
        expect(spreadTargets(dossier, 'description', options).map((source) => source.kind)).toEqual(['lore.entry']);
        expect(
            spreadTargets(dossier, 'appearance', { ...options, naiWrites: false }).map((source) => source.kind),
        ).toEqual(['lore.entry']);
        expect(
            spreadTargets({ ...dossier, kind: 'place' }, 'alias', options).map((source) => source.kind),
        ).not.toContain('chat.alias');
    });
});
