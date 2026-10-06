// @vitest-environment happy-dom
// M38 «Проверка промпта», the report view: what was checked, the buttons (the AI check shows its estimate first), the
// conflicts by importance with both quotes and owners, the fix as before/after with the scope switch, «Исправить»,
// «Пропустить», «Не считать конфликтом», ticked conflicts fixed together and «Проверить ещё раз».
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { M38_STRINGS } from '../../../src/features/promptAudit';
import { createAuditEnv, flush, realCaseMessages, realCaseSlots } from '../../helpers/prompt-audit-env';
import type { AuditEnv } from '../../helpers/prompt-audit-env';

type Dict = Record<string, unknown>;

let a: AuditEnv;
let root: HTMLElement;

const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
const settle = async () => {
    for (let i = 0; i < 5; i++) await flush();
};

beforeEach(async () => {
    document.body.replaceChildren();
    a = await createAuditEnv();
    root = a.api.renderReport();
    document.body.append(root);
    await settle();
});

afterEach(async () => {
    await a.stop();
});

async function realTurn(): Promise<void> {
    (a.env.mock.context as unknown as Dict).extensionPrompts = realCaseSlots();
    await a.generate(realCaseMessages());
    await settle();
}

describe('the report view', () => {
    it('says there is nothing to check before the first turn', () => {
        expect(root.textContent).toContain('There was no turn in this chat yet.');
        expect(q<HTMLButtonElement>('.maestro-m38-check')?.disabled).toBe(true);
        expect(q<HTMLButtonElement>('.maestro-m38-dry')?.disabled).toBe(true);
    });

    it('shows the conflicts by importance with owners, quotes, why, risk and the fix as before → after', async () => {
        await realTurn();
        expect(root.textContent).toContain('Last turn');
        expect(root.textContent).toContain('preset «Marinara»');
        q('.maestro-m38-check')!.click();
        await settle();
        expect(qa('.maestro-m38-group').map((node) => node.dataset.severity)).toEqual(['high', 'low']);
        expect(qa('.maestro-m38-conflict[data-severity="low"]')).toHaveLength(2);
        const card = q('.maestro-m38-conflict[data-severity="high"]')!;
        expect(card.querySelector('strong')?.textContent).toBe('The reply cannot hold everything');
        expect([...card.querySelectorAll('.maestro-m38-owner')].map((node) => node.textContent)).toEqual([
            'Preset «Marinara», block «Task»',
            'DES tracker: instructions',
        ]);
        expect(card.querySelector('.maestro-m38-also')?.textContent).toContain('NAI Studio picture rules');
        expect(card.querySelector('.maestro-m38-fix-target')?.textContent).toBe(
            'What to change: Preset «Marinara», block «Task»',
        );
        expect(card.querySelector('.maestro-diff ins')?.textContent).toContain('the limit is for the story text only');
        const scope = card.querySelector<HTMLSelectElement>('.maestro-m38-scope')!;
        expect([...scope.options].map((option) => option.textContent)).toEqual([
            'Everywhere',
            'This character',
            'This chat',
        ]);
        const role = q('.maestro-m38-conflict[data-severity="low"]')!;
        expect(role.querySelector('.maestro-m38-risk')?.textContent).toContain(
            'What it risks: On deepseek/deepseek-v4-flash',
        );
        expect(role.querySelector('.maestro-m38-advice')?.textContent).toContain('This is a Maestro insert.');
        expect(role.querySelector('.maestro-m38-fix-one')).toBeNull();
        expect(root.textContent).toContain('Serious: 1 · medium: 0 · minor: 2');
    });

    it('fixes one conflict in the chosen scope, then offers the check again', async () => {
        await realTurn();
        await a.api.check();
        await settle();
        const card = q('.maestro-m38-conflict[data-severity="high"]')!;
        const scope = card.querySelector<HTMLSelectElement>('.maestro-m38-scope')!;
        scope.value = 'chat';
        scope.dispatchEvent(new Event('change'));
        card.querySelector<HTMLButtonElement>('.maestro-m38-fix-one')!.click();
        await settle();
        expect(a.recorded.at(-1)).toMatchObject({ scope: 'chat' });
        expect(q('.maestro-m38-fixed')?.textContent).toBe('fixed');
        q('.maestro-m38-recheck')!.click();
        await settle();
        expect(qa('.maestro-m38-conflict').some((node) => node.dataset.severity === 'high')).toBe(false);
    });

    it('skips, hides as not a conflict and shows the hidden ones again', async () => {
        await realTurn();
        await a.api.check();
        await settle();
        q('.maestro-m38-conflict[data-severity="low"] .maestro-m38-skip')!.click();
        await settle();
        q('.maestro-m38-conflict[data-severity="low"] .maestro-m38-skip')!.click();
        await settle();
        expect(qa('.maestro-m38-conflict')).toHaveLength(1);
        q('.maestro-m38-conflict .maestro-m38-ignore')!.click();
        await settle();
        expect(root.textContent).toContain('Marked as not a conflict: 1');
        expect(root.textContent).toContain('No conflicts found.');
        q('.maestro-m38-restore')!.click();
        await settle();
        expect(qa('.maestro-m38-conflict[data-severity="high"]')).toHaveLength(1);
    });

    it('fixes the ticked conflicts together', async () => {
        await realTurn();
        await a.api.check();
        await settle();
        const box = q<HTMLInputElement>('.maestro-m38-conflict[data-severity="high"] .maestro-m38-select')!;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        await settle();
        const button = q<HTMLButtonElement>('.maestro-m38-fix-selected')!;
        expect(button.textContent).toBe('Fix the ticked ones (1)');
        button.click();
        await settle();
        expect(a.recorded).toHaveLength(1);
        expect(a.env.ui.notices.at(-1)?.text).toBe('Fixed everywhere: Preset «Marinara», block «Task».');
    });

    it('asks before the AI check with its estimate', async () => {
        await realTurn();
        await a.api.check();
        await settle();
        expect(q('.maestro-m38-estimate')?.textContent).toMatch(/^AI check: about \d+ tokens, roughly/);
        a.env.ui.confirmAnswer = false;
        q('.maestro-m38-ai')!.click();
        await settle();
        expect(a.env.ui.confirms.at(-1)?.title).toBe('Check the prompt with AI?');
        expect(String(a.env.ui.confirms.at(-1)?.body)).toContain('no lore and no chat history');
        expect(a.env.llm.request).not.toHaveBeenCalled();
    });

    it('stops redrawing once it left the page', async () => {
        root.remove();
        await realTurn();
        const before = root.innerHTML;
        await a.api.check();
        await settle();
        expect(root.innerHTML).toBe(before);
    });
});

describe('strings', () => {
    it('have the same keys and placeholders in English and Russian', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(Object.keys(M38_STRINGS.ru).sort()).toEqual(Object.keys(M38_STRINGS.en).sort());
        for (const [key, text] of Object.entries(M38_STRINGS.en)) {
            expect(M38_STRINGS.ru[key], key).toBeTruthy();
            expect(placeholders(M38_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });
});

describe('string coverage', () => {
    it('covers every literal key and every key built at run time', async () => {
        const { readFileSync, readdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { AUDIT_TOPICS, SEVERITIES } = await import('../../../src/domain/prompt-audit-rules');
        const dir = join(__dirname, '../../../src/features/promptAudit');
        const used = new Set<string>();
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'strings.ts')) {
            for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/'(m38\.[A-Za-z0-9_.-]+)'/g)) {
                used.add(match[1]!);
            }
        }
        expect(used.size).toBeGreaterThan(60);
        const scopes = ['global', 'character', 'chat'];
        const dynamic = [
            ...['system', 'postHistory', 'depth'].map((field) => `m38.owner.card.${field}`),
            ...['des', 'nai', 'qvink', 'desru', 'ck'].map((owner) => `m38.owner.${owner}`),
            ...['en', 'ru', 'ja', 'zh', 'de', 'fr', 'es'].map((code) => `m38.lang.${code}`),
            ...[
                'first',
                'second',
                'third',
                'past',
                'present',
                'json',
                'images',
                'infobox',
                'html',
                'markdown',
                'code',
                'plain',
            ].map((code) => `m38.value.${code}`),
            ...['words', 'paragraphs', 'sentences', 'tokens', 'lines'].map((unit) => `m38.unit.${unit}`),
            ...AUDIT_TOPICS.map((topic) => `m38.topic.${topic}`),
            ...AUDIT_TOPICS.filter((topic) => !['tight', 'role', 'format'].includes(topic)).map(
                (topic) => `m38.why.${topic}`,
            ),
            ...['json', 'images', 'infobox', 'html', 'event'].map((code) => `m38.demand.${code}`),
            ...['systemMerge', 'prefillEos', 'assistantDepth'].map((quirk) => `m38.risk.${quirk}`),
            ...['system', 'user', 'assistant'].map((role) => `m38.role.${role}`),
            ...['removeSide', 'exception', 'duplicate', 'duplicateBlock', 'prefill', 'roleUser'].map(
                (reason) => `m38.reason.${reason}`,
            ),
            ...[
                'bunnymo',
                'lore',
                'card',
                'authorsNote',
                'neighbourSetting',
                'maestro',
                'risky',
                'other',
                'missing',
            ].map((reason) => `m38.advice.${reason}`),
            ...scopes.flatMap((scope) => [`m38.fix.noScope.${scope}`, `m38.fix.done.${scope}`, `m38.scope.${scope}`]),
            ...['check', 'dry', 'fix'].map((busy) => `m38.view.busy.${busy}`),
            ...SEVERITIES.map((severity) => `m38.severity.${severity}`),
            'kind.promptAudit.setting',
            'kind.promptAudit.batch',
        ];
        expect([...used, ...dynamic].filter((key) => !(key in M38_STRINGS.en))).toEqual([]);
    });
});
