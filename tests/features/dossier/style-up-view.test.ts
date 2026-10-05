// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTagDictionary, checkTags, entriesWithUid, tagVocabulary } from '../../../src/domain/bunnymo-mode-tags';
import { canonModule } from '../../../src/features/canon';
import type { CanonApi } from '../../../src/features/canon/api';
import type { DossierApi } from '../../../src/features/dossier/api';
import { STYLE_UP_KIND } from '../../../src/features/dossier/style-up';
import type { StyleUpPayload } from '../../../src/features/dossier/style-up';
import type { Proposal, PultTab } from '../../../src/shared/contracts';
import { LYRA_ID, MIRA_ID, STYLE_UP_PACK, miraScene } from './fixtures';
import { createDossierEnv, passport, settle, startDossier, startModule } from './helpers';
import type { Dict, DossierEnv } from './helpers';

let env: DossierEnv;
let stops: (() => Promise<void>)[];
let container: HTMLElement;
let unmount: (() => void) | void;
let api: DossierApi;

function tab(): PultTab {
    return env.ui.tabs.find((item) => item.id === 'dossier')!;
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button «${text}»`);
    return found;
}

async function render(): Promise<void> {
    unmount = tab().render(container);
    await settle();
}

beforeEach(async () => {
    env = createDossierEnv();
    stops = [];
    miraScene(env);
    const canon = await startModule(env, canonModule);
    stops.push(() => canon.stop());
    env.world.book('Pack', STYLE_UP_PACK);
    const dict = buildTagDictionary({
        books: [{ name: 'Pack', core: false, entries: entriesWithUid(env.world.books.get('Pack')) }],
        archives: [],
        builtAt: 1,
    });
    env.modules.expose('bunnymoMode', {
        dictionary: async () => dict,
        validateTags: async (tags: string[]) => checkTags(tags, tagVocabulary(dict)),
    });
    Object.assign(env.app.adapters.nai as unknown as Dict, {
        generatePassport: async (input: Dict) =>
            passport({ id: 'main', name: String(input.name), slots: { hair: 'red braid' } }),
    });
    env.llm.result = {
        ok: true,
        data: {
            tags: [
                { category: 'SPECIES', value: 'HUMAN' },
                { category: 'SPECIES', value: 'DRAGON' },
            ],
            mbti: '',
            linguistics: '',
        },
        costUsd: 0.0007,
    };
    const started = await startDossier(env);
    stops.push(() => started.stop());
    api = env.modules.api<DossierApi>('dossier')!;
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    for (const stop of stops.reverse()) await stop();
});

describe('«Оформить» in the dossier tab', () => {
    it('shows the button only when stores are missing', async () => {
        api.open(LYRA_ID);
        await render();
        expect(container.querySelector('.maestro-m7-styleup-start')).toBeNull();
        expect(container.querySelector('.maestro-m7-missing')).toBeNull();
        api.open(MIRA_ID);
        await settle();
        expect(container.querySelector('.maestro-m7-missing')?.textContent).toBe(
            'Missing: Canon entry, CK archive, NAI passport.',
        );
        expect(buttonByText('Style up').title).toContain('canon entry with Russian keys');
    });

    it('previews the plan, sends the kept parts as one card and shows the status', async () => {
        api.open(MIRA_ID);
        await render();
        buttonByText('Style up').click();
        await settle();
        const dialog = container.querySelector<HTMLElement>('.maestro-m7-styleup')!;
        expect(dialog.getAttribute('role')).toBe('dialog');
        const parts = [...dialog.querySelectorAll<HTMLElement>('.maestro-m7-part')];
        expect(parts.map((node) => node.dataset.part)).toEqual(['canon', 'archive', 'passport']);
        expect(parts[1]?.textContent).toContain('CarrotKernel archive in «Archives» (1 tags)');
        expect(parts[1]?.textContent).toContain('Dropped: <SPECIES:DRAGON> (unknownValue)');
        expect(parts[1]?.querySelector('pre')?.textContent).toBe(
            '<BunnymoTags><Name:Мира> <PHYSICAL><SPECIES:HUMAN></PHYSICAL></BunnymoTags>',
        );
        expect(parts[0]?.textContent).toContain('Now: none');
        expect(dialog.textContent).toContain('Planning cost $0.0007.');

        const passportBox = parts[2]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        passportBox.checked = false;
        passportBox.dispatchEvent(new Event('change'));
        buttonByText('Style up', dialog).click();
        await settle();
        const proposal = env.autonomy.proposals.at(-1) as Proposal<StyleUpPayload>;
        expect(proposal.kind).toBe(STYLE_UP_KIND);
        expect(proposal.payload.parts.map((part) => part.part)).toEqual(['canon', 'archive']);
        expect(env.ui.notices.at(-1)?.text).toBe('Sent to the Inbox.');
        expect(container.querySelector('.maestro-m7-styleup')).toBeNull();
        expect(container.querySelector('.maestro-m7-status')?.textContent).toContain(
            'The plan for Мира is in the Inbox.',
        );
    });

    it('shows what was written when the plan is applied at once', async () => {
        env.autonomy.levels.set(STYLE_UP_KIND, 'auto');
        api.open(MIRA_ID);
        await render();
        buttonByText('Style up').click();
        await settle();
        buttonByText('Style up', container.querySelector('.maestro-m7-styleup')!).click();
        await settle(30);
        expect(env.ui.notices.at(-1)?.text).toBe('Done.');
        const status = container.querySelector<HTMLElement>('.maestro-m7-status')!;
        expect([...status.querySelectorAll<HTMLElement>('[data-part]')].map((node) => node.textContent)).toEqual([
            '✓ Canon entry',
            '✓ CK archive',
            '✓ NAI passport',
        ]);
        expect(container.querySelector('.maestro-m7-styleup-start')).toBeNull();
    });

    it('closes the preview and explains an empty plan', async () => {
        env.mock.chatId = undefined as unknown as string;
        api.open(MIRA_ID);
        await render();
        expect(container.querySelector('.maestro-m7-missing')?.textContent).toBe('Missing: CK archive, NAI passport.');
        buttonByText('Style up').click();
        await settle();
        const empty = container.querySelector<HTMLElement>('.maestro-m7-styleup')!;
        expect(empty.textContent).toContain('Nothing can be created right now.');
        expect(empty.textContent).toContain('Open a chat');
        buttonByText('Close', empty).click();
        expect(container.querySelector('.maestro-m7-styleup')).toBeNull();

        env.mock.chatId = 'Alice - 2026-10-04@12h00m00s';
        env.n.naiPresent = false;
        env.n.ckPresent = false;
        buttonByText('Refresh').click();
        await settle();
        buttonByText('Style up').click();
        await settle();
        expect(
            [...container.querySelectorAll<HTMLElement>('.maestro-m7-part')].map((node) => node.dataset.part),
        ).toEqual(['canon']);
        const box = container.querySelector<HTMLInputElement>('.maestro-m7-part input[type="checkbox"]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        buttonByText('Style up', container.querySelector('.maestro-m7-styleup')!).click();
        await settle();
        expect(env.ui.notices.at(-1)?.text).toBe('Tick at least one part.');
        buttonByText('Cancel').click();
        expect(container.querySelector('.maestro-m7-styleup')).toBeNull();
        env.modules.apis.delete('canon');
        buttonByText('Refresh').click();
        await settle();
        expect(container.querySelector('.maestro-m7-styleup-start')).toBeNull();
    });

    it('promotes a canon addition to the card’s lorebook from its section', async () => {
        const lyra = (env.mock.context as unknown as { characters: STCharacter[] }).characters[0]!;
        lyra.data = { extensions: { world: 'World' } };
        const canon = env.modules.api<CanonApi>('canon')!;
        await canon.put({
            entry: { comment: 'Мира', key: ['Мира'], content: 'Character: Мира' },
            meta: { kind: 'addition', status: 'active', origin: 'entity', type: 'character' },
        });
        api.open(MIRA_ID);
        await render();
        const section = container.querySelector<HTMLElement>('.maestro-m7-section[data-kind="canon"]')!;
        const promote = buttonByText('To the card’s lorebook', section);
        expect(promote.title).toContain('«World»');
        promote.click();
        await settle(30);
        expect(env.autonomy.proposals.at(-1)?.kind).toBe('dossier.promoteToCard');
        expect(Object.values(env.world.entries('World')).some((entry) => entry.comment === 'Мира')).toBe(true);
        expect(env.ui.notices.at(-1)?.text).toBe('Done.');
    });
});
