// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { RulesApi } from '../../../src/features/rules/api';
import { createRulesTestApp, FakeLoreJournal } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import { activationsOf, book, entry, runScan } from '../../helpers/rules-wi';

let env: RulesTestApp;
let rules: Required<RulesApi>;
let container: HTMLElement;
let unmount: (() => void) | void;

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function card(title: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('.maestro-rules-card')].find(
        (node) => node.querySelector('.maestro-card-title')?.textContent === title,
    );
    if (!found) throw new Error(`no card ${title}`);
    return found;
}

beforeEach(async () => {
    env = createRulesTestApp();
    rules = (await startRules(env)).api;
    container = document.createElement('div');
    document.body.replaceChildren(container);
    unmount = env.ui.tabs.find((tab) => tab.id === 'rules')!.render(container);
});

describe('rules tab', () => {
    it('lists every rule with its meta, description and switch', () => {
        expect(container.querySelectorAll('.maestro-rules-card')).toHaveLength(14);
        const role = card('Assistant role → system');
        expect(role.textContent).toContain('Maestro · stage 1 · lore · default · waits for the first-run wizard');
        expect(role.textContent).toContain('BunnyMo #64');
        expect(role.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
        expect(container.textContent).toContain('switch on after the first-run wizard');
        expect(card('Show BunnyMo tags').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    });

    it('switches a rule from its card', async () => {
        const input = card('Byte-identical pack duplicates').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        input.checked = false;
        input.dispatchEvent(new Event('change'));
        await settle();
        expect(rules.isEnabled('pack.duplicates')).toBe(false);
        const text = card('Byte-identical pack duplicates').textContent;
        expect(text).toContain('set by you');
        expect(text).not.toContain('waits for');
    });

    it('tells when autonomy did not apply a switch', async () => {
        env.autonomy.levels.set('rules.toggle', 'off');
        const input = card('Show BunnyMo tags').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        input.checked = false;
        input.dispatchEvent(new Event('change'));
        await settle();
        expect(rules.isEnabled('display.bunnymoTags')).toBe(true);
        // In words, with the rule's name — not the raw decision.
        expect(env.ui.notices.at(-1)).toBe(
            'The rule «Show BunnyMo tags» was not switched: such changes are off or out of date.',
        );
    });

    it('shows unavailable rules and the changes of the last scan', async () => {
        env.neighbours.ck.present = false;
        env.finishWizard();
        await runScan(env.mock, [book('Pack', [entry(1, { position: 4, role: 2, constant: true })])], '');
        await settle();
        container.querySelector<HTMLButtonElement>('.maestro-section-actions button')!.click();
        expect(card('CarrotKernel vectorize button').textContent).toContain('Unavailable now: ck.present');
        const role = card('Assistant role → system');
        expect(role.textContent).toContain('Last scan: 1 changes');
        expect(role.querySelector('details td')?.textContent).toBe('Pack');
        expect(card('Byte-identical pack duplicates').textContent).toContain('No changes on the last scan');
    });

    it('compares before/after through the lore journal', async () => {
        const library = [
            book('Pack V1', [entry(1, { constant: true, comment: 'Twin', content: 'Same text.' })]),
            book('Pack V2', [entry(1, { constant: true, comment: 'Twin', content: 'Same text.' })]),
        ];
        env.modules.expose(
            'loreJournal',
            new FakeLoreJournal(async () => activationsOf(await runScan(env.mock, library, ''))),
        );
        container.querySelector<HTMLButtonElement>('.maestro-section-actions button')!.click();
        const compare = [...card('Byte-identical pack duplicates').querySelectorAll('button')].find((node) =>
            node.textContent?.includes('Compare'),
        )!;
        compare.click();
        await settle();
        const text = card('Byte-identical pack duplicates').textContent ?? '';
        expect(text).toContain('Removed: 1 · added: 0 · characters: -10');
        expect(text).toContain('Pack V1');
    });

    it('reports a failed comparison and disables it without the lore journal', async () => {
        const compare = [...card('Assistant role → system').querySelectorAll('button')].find((node) =>
            node.textContent?.includes('Compare'),
        )!;
        expect(compare.disabled).toBe(true);
        env.modules.expose('loreJournal', {
            simulating: () => false,
            suspendedRules: () => [],
            simulate: async () => {
                throw new Error('dry run failed');
            },
            summary: () => {
                throw new Error('no summary');
            },
        });
        container.querySelector<HTMLButtonElement>('.maestro-section-actions button')!.click();
        const enabled = [...card('Assistant role → system').querySelectorAll('button')].find((node) =>
            node.textContent?.includes('Compare'),
        )!;
        enabled.click();
        await settle();
        expect(card('Assistant role → system').textContent).toContain('Comparison failed: dry run failed');
    });

    it('edits book caps of the active books with hints from the lore journal', async () => {
        env.modules.expose('loreJournal', new FakeLoreJournal(async () => []));
        await runScan(env.mock, [book('Big World', [entry(1)]), book('Small', [entry(2)])], '');
        container.querySelector<HTMLButtonElement>('.maestro-section-actions button')!.click();
        expect(container.textContent).toContain('Heaviest books in the lore journal: Big World (18,000)');
        expect(container.textContent).toContain('about 18,000 characters per turn, 12 activations');
        expect(container.textContent).toContain('switch on after');

        const big = [...container.querySelectorAll<HTMLElement>('.maestro-card')].find(
            (node) => node.querySelector('.maestro-card-title')?.textContent === 'Big World',
        )!;
        const tokens = big.querySelector<HTMLInputElement>('input[type="number"]')!;
        tokens.value = '1200';
        tokens.dispatchEvent(new Event('change'));
        const level = big.querySelector<HTMLSelectElement>('select')!;
        level.value = '1';
        level.dispatchEvent(new Event('change'));
        expect(rules.bookCaps()).toEqual({ 'Big World': { maxTokens: 1200, maxRecursionLevel: 1 } });
        await settle();
        const again = [...container.querySelectorAll<HTMLElement>('.maestro-card')].find(
            (node) => node.querySelector('.maestro-card-title')?.textContent === 'Big World',
        )!;
        const select = again.querySelector<HTMLSelectElement>('select')!;
        select.value = '';
        select.dispatchEvent(new Event('change'));
        expect(rules.bookCaps()).toEqual({ 'Big World': { maxTokens: 1200 } });
    });

    it('shows an empty state without books, edits the gap limit and stops redrawing after unmount', async () => {
        expect(container.textContent).toContain('No active books yet');
        const gap = card('Qvink: no gaps').querySelector<HTMLInputElement>('input[type="number"]')!;
        gap.value = '7';
        gap.dispatchEvent(new Event('change'));
        expect(env.settings.module<{ gapGuardLimit: number }>('rules').gapGuardLimit).toBe(7);
        if (typeof unmount === 'function') unmount();
        const before = container.innerHTML;
        rules.setBookCap('Late', { maxTokens: 5 });
        await settle();
        expect(container.innerHTML).toBe(before);
    });
});
