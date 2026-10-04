// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorModule } from '../../../src/features/doctor';
import type { DoctorApi, Finding } from '../../../src/features/doctor';
import { message } from '../../helpers/st-mock';
import { clearScripts } from '../../helpers/adapters-host';
import { archive, packEntries, storedBook } from '../../helpers/doctor-entries';
import { FakeRules, createDoctorStand, flush } from '../../helpers/doctor-app';
import type { DoctorStand } from '../../helpers/doctor-app';

let s: DoctorStand;
let stop: () => Promise<void>;

const RU = 'Анна посмотрела на Флоренс и тихо рассмеялась, вспоминая вчерашний бал.';

function setupStack(): void {
    const { stand } = s;
    // MBTI v1 and V2: one identical entry, one rewritten Analyst.
    stand.books.set(
        'MBTI v1 (Retired)',
        storedBook(
            ...packEntries('MBTI'),
            { key: ['<INTJ-H>'], comment: 'Mastermind', content: 'Same mastermind text' },
            { key: ['<INTJ-U>'], comment: 'The Schemer', content: 'Schemer text' },
        ),
    );
    stand.books.set(
        'MBTI V2',
        storedBook(
            ...packEntries('MBTI2'),
            { key: ['<INTJ-H>'], comment: 'Mastermind', content: 'Same mastermind text' },
            { key: ['<INTJ-U>'], comment: 'The Cynic', content: 'Cynic text' },
        ),
    );
    stand.books.set(
        'CarrotCast Limited',
        storedBook(...packEntries('GENRE'), { key: ['<NSFW>'], comment: 'Erotic', content: 'Erotic genre' }),
    );
    stand.books.set(
        'Архив',
        storedBook(archive('Анна', {}, '\n<NSFW>secret</NSFW>'), {
            ...archive('Флоренс', { scanDepth: null, role: 0 }),
            extensions: {
                lorebook_localizer: {
                    version: 1,
                    languages: {
                        ru: {
                            language: 'Russian',
                            sources: ['Флоренс'],
                            added: { key: ['/Фло\\-ренс/iu'], keysecondary: [] },
                        },
                    },
                },
            },
        }),
    );
    stand.books.set(
        'Flora',
        storedBook(
            { key: ['ballroom'], comment: 'Ballroom', content: 'The ballroom of the manor.' },
            { key: ['manor'], comment: 'Manor', content: 'The manor has a garden.' },
            { key: ['garden'], comment: 'Garden', content: 'The garden has a maze.' },
            { key: ['maze'], comment: 'Maze', content: 'The maze hides a fountain.' },
            { key: ['fountain'], comment: 'Fountain', content: 'Water.' },
        ),
    );
    stand.worldInfo.selected_world_info = ['MBTI v1 (Retired)', 'MBTI V2', 'CarrotCast Limited', 'Архив', 'Flora'];
    stand.mock.chat = Array.from({ length: 12 }, (_, i) => message(RU, { is_user: i % 2 === 0 }));
    stand.setCtx('chatCompletionSettings', { openai_max_context: 1_000_000, prompts: [], prompt_order: [] });
    (globalThis as Record<string, unknown>).CarrotKernel = {};
    stand.mock.extensionSettings.CarrotKernel = { characterRepoBooks: [] };
    s.regex.global.push(
        {
            id: 'clean',
            scriptName: 'Clean HTML (From Outgoing Prompt)',
            findRegex: '/\\s?<(?!\\!--)(?:"[^"]*"|\'[^\']*\'|[^\'">])*>/g',
            replaceString: '',
            placement: [2],
            promptOnly: true,
        },
        { id: 'quotes', scriptName: 'Fix Double Quotations', findRegex: '/[“”]/g', replaceString: '"', placement: [2] },
        {
            id: 'think',
            scriptName: 'Format thinking',
            findRegex: '/<thinking>/',
            replaceString: '',
            placement: [2],
            markdownOnly: true,
        },
    );
    s.regex.preset.push({ id: 'p1', scriptName: 'Preset regex', findRegex: '/x/', placement: [2] });
}

async function installDes(): Promise<void> {
    const name = 'third-party/Dooms-Enhancement-Suite';
    s.stand.install(
        name,
        { display_name: "Doom's Enhancement Suite", version: '2.6.0', js: 'index.js' },
        { loaded: true },
    );
    s.stand.mock.extensionSettings[name] = { enabled: true, generationMode: 'together' };
    await s.adapters.des.ready();
}

beforeEach(async () => {
    document.body.innerHTML = '';
    s = createDoctorStand('ru');
    setupStack();
    stop = await s.start(doctorModule);
});

afterEach(async () => {
    await stop();
    clearScripts();
    delete (globalThis as Record<string, unknown>).CarrotKernel;
});

const api = (): DoctorApi => s.modules.api<DoctorApi>('doctor')!;
const kinds = (findings: Finding[]) => [...new Set(findings.map((finding) => finding.kind))].sort();

describe('M5 scan', () => {
    it('finds the stack problems in lorebooks and regexes', async () => {
        await installDes();
        const findings = await api().scan();
        expect(kinds(findings)).toEqual(
            [
                'budget.overflow',
                'ck.archiveNotRepo',
                'ck.archiveScanDepth',
                'keys.localizerBroken',
                'keys.noRussian',
                'pack.duplicate',
                'pack.versionConflict',
                'recursion.chain',
                'regex.breaksJson',
                'regex.dead',
                'regex.stripsTags',
                'role.assistantAtDepth',
                'wrapper.collision',
            ].sort(),
        );
        const byKind = (kind: string) => findings.filter((finding) => finding.kind === kind);
        expect(byKind('pack.duplicate')[0]).toMatchObject({ fixRule: 'pack.duplicates', fileFix: false });
        expect(byKind('pack.versionConflict')[0]?.params).toMatchObject({ newer: 'MBTI V2' });
        expect(byKind('role.assistantAtDepth')[0]?.target).toMatchObject({ book: 'Архив' });
        expect(byKind('regex.breaksJson')[0]?.severity).toBe('error');
        // Clean HTML and the display regex find nothing in this chat (no tags in it).
        expect(
            byKind('regex.dead')
                .map((finding) => finding.messageKey)
                .sort(),
        ).toEqual(['m5.f.regexDead', 'm5.f.regexDead', 'm5.f.regexNotAllowed.preset']);
        expect(byKind('keys.noRussian')[0]?.params?.book).toBe('Flora');
        expect(byKind('recursion.chain').map((finding) => finding.messageKey)).toContain('m5.f.recursionChain');
        // Severity order: errors first.
        expect(findings[0]?.severity).toBe('error');
        // Stable ids across scans.
        const again = await api().scan();
        expect(again.map((finding) => finding.id)).toEqual(findings.map((finding) => finding.id));
        expect(api().findings()).toEqual(again);
        expect(api().lastScanAt?.()).toBeGreaterThan(0);
        const flora = api()
            .bookStats?.()
            .find((book) => book.book === 'Flora');
        expect(flora).toMatchObject({ entries: 5, maxDepth: 4, bunnymo: null });
        expect(
            api()
                .bookStats?.()
                .find((book) => book.book === 'MBTI V2')?.bunnymo,
        ).toBe('pack');
    });

    it('builds the regex inventory with owners and allowed state', async () => {
        const before = await api().regexInventory();
        expect(before.map((item) => [item.name, item.type, item.owner, item.allowed])).toEqual([
            ['Clean HTML (From Outgoing Prompt)', 'global', 'des', true],
            ['Fix Double Quotations', 'global', 'marinara', true],
            ['Format thinking', 'global', 'user', true],
            ['Preset regex', 'preset', 'unknown', false],
        ]);
        await api().scan();
        expect(await api().regexInventory()).toHaveLength(4);
    });

    it('reads scripts from settings when the engine is unavailable and notes missing pieces', async () => {
        s.caps.ok.delete('st.regex');
        s.stand.mock.extensionSettings.regex = [{ id: 'g', scriptName: 'Mine', findRegex: '/a/', placement: [1] }];
        s.stand.worldInfo.selected_world_info = [];
        s.stand.host.modules.worldInfo = async () => {
            throw new Error('no world-info.js');
        };
        const findings = await api().scan();
        expect(findings).toEqual([]);
        expect((await api().regexInventory()).map((item) => item.name)).toEqual(['Mine']);
        expect(await api().testRegex?.('global:g', 'a')).toBeNull();
    });

    it('marks findings stale when the chat changes', async () => {
        await api().scan();
        const tab = s.ui.tabs[0]!;
        const container = document.createElement('div');
        const dispose = tab.render(container);
        expect(tab.badge?.()).toBe(1);
        await s.stand.mock.eventSource.emit('chat_id_changed', 'chat-2');
        expect(container.textContent).toContain('После проверки сменился чат');
        expect(tab.badge?.()).toBe(0);
        if (typeof dispose === 'function') dispose();
    });
});

describe('M5 tab', () => {
    async function openTab(): Promise<{ container: HTMLElement; dispose: () => void }> {
        const tab = s.ui.tabs.find((item) => item.id === 'doctor')!;
        expect(tab).toMatchObject({ titleKey: 'm5.tab', order: 65 });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const result = tab.render(container);
        await flush(20);
        return { container, dispose: typeof result === 'function' ? result : () => {} };
    }
    const buttonNamed = (root: ParentNode, text: string) =>
        [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);

    it('scans on first open and shows findings grouped by severity and kind', async () => {
        const { container, dispose } = await openTab();
        expect(api().lastScanAt?.()).toBeGreaterThan(0);
        const titles = [...container.querySelectorAll('.maestro-m5-severity-title')].map((node) => node.textContent);
        expect(titles).toEqual(['Ошибки', 'Предупреждения', 'Заметки']);
        expect(container.textContent).toContain('Дубли записей паков');
        expect(container.textContent).toContain('В «MBTI v1 (Retired)» и «MBTI V2» есть одинаковые записи: 1');
        expect(container.textContent).toContain('Clean HTML (From Outgoing Prompt)');
        expect(s.ui.tabs[0]?.badge?.()).toBe(1);
        dispose();
    });

    it('offers «Включить правило» and enables the rule through autonomy, with undo', async () => {
        const rules = new FakeRules([{ id: 'role.assistantToSystem' }, { id: 'pack.duplicates' }]);
        s.modules.expose('rules', rules);
        s.i18n.register({ en: {}, ru: { 'rule.role.assistantToSystem': 'Роль assistant → system' } });
        const { container, dispose } = await openTab();
        const finding = container.querySelector<HTMLElement>(
            `[data-finding="${
                api()
                    .findings()
                    .find((item) => item.kind === 'role.assistantAtDepth')!.id
            }"]`,
        )!;
        const enable = buttonNamed(finding, 'Включить правило')!;
        expect(enable.title).toBe('Правило: Роль assistant → system');
        enable.click();
        await flush();
        expect(rules.isEnabled('role.assistantToSystem')).toBe(true);
        expect(s.journal.records[0]).toMatchObject({ module: 'M5', kind: 'doctor.enableRule' });
        expect(s.ui.notices.at(-1)?.text).toBe('Правило «Роль assistant → system» включено.');
        expect(container.querySelector(`[data-finding="${finding.dataset.finding}"]`)?.textContent).toContain(
            'Исправляется правилом на лету',
        );
        expect(await s.journal.undo(s.journal.records[0]!.id)).toBe(true);
        expect(rules.isEnabled('role.assistantToSystem')).toBe(false);
        // Rules that do not exist yet and findings without a rule.
        expect(container.textContent).toContain('Правило появится на следующих этапах');
        dispose();
    });

    it('queues the proposal when the level is "inbox" and explains a missing rules module', async () => {
        const { container: bare, dispose: closeBare } = await openTab();
        expect(bare.textContent).toContain('Модуль «Правила» выключен');
        closeBare();
        const rules = new FakeRules([{ id: 'role.assistantToSystem' }]);
        s.modules.expose('rules', rules);
        s.levels['doctor.enableRule'] = 'inbox';
        const { container, dispose } = await openTab();
        buttonNamed(container, 'Включить правило')!.click();
        await flush();
        expect(rules.isEnabled('role.assistantToSystem')).toBe(false);
        expect(s.inbox.added).toHaveLength(1);
        expect(s.ui.notices.at(-1)?.text).toContain('ждёт во «Входящих»');
        // The Inbox applier works from the stored payload.
        const applier = s.inbox.appliers.get('doctor.enableRule')!;
        expect(await applier.valid?.({ rule: 'role.assistantToSystem' })).toBe(true);
        await applier.apply({ rule: 'role.assistantToSystem' });
        expect(rules.isEnabled('role.assistantToSystem')).toBe(true);
        await expect(applier.apply({})).rejects.toThrow();
        dispose();
    });

    it('opens the book of a finding and closes the pult', async () => {
        const { container, dispose } = await openTab();
        buttonNamed(container, 'Открыть «Flora»')!.click();
        await flush();
        expect(s.opened).toEqual(['Flora']);
        expect(s.ui.closed).toBe(1);
        dispose();
    });

    it('shows the regex inventory and runs the bench on chat messages and on custom text', async () => {
        s.stand.mock.chat.push(message('Она сказала “привет”.'));
        const { container, dispose } = await openTab();
        const rows = [...container.querySelectorAll('[data-regex-id]')].map((node) => node.textContent);
        expect(rows).toEqual([
            'Clean HTML (From Outgoing Prompt)',
            'Fix Double Quotations',
            'Format thinking',
            'Preset regex',
        ]);
        const quotesRow = container.querySelector('[data-regex-id="global:quotes"]')!.closest('tr')!;
        buttonNamed(quotesRow, 'Испытать')!.click();
        await flush();
        const bench = container.querySelector<HTMLElement>('.maestro-m5-bench')!;
        expect(bench.querySelector<HTMLSelectElement>('select')!.value).toBe('global:quotes');
        buttonNamed(bench, 'Испытать')!.click();
        await flush();
        const output = container.querySelector<HTMLElement>('.maestro-m5-bench-output')!;
        expect(output.querySelectorAll('.maestro-m5-sample')).toHaveLength(3);
        expect(output.querySelector('ins')?.textContent).toContain('"');
        expect(output.textContent).toContain('Без изменений');
        // Custom text.
        const custom = container.querySelector<HTMLButtonElement>('.maestro-segment[data-value="custom"]')!;
        custom.click();
        const textarea = container.querySelector<HTMLTextAreaElement>('.maestro-m5-custom')!;
        textarea.value = 'Он ответил: “да”';
        textarea.dispatchEvent(new Event('input'));
        buttonNamed(container.querySelector('.maestro-m5-bench')!, 'Испытать')!.click();
        await flush();
        expect(container.querySelector('.maestro-m5-bench-output')?.textContent).toContain('Твой текст');
        expect(await api().testRegex?.('global:missing', 'x')).toBeNull();
        dispose();
    });

    it('turns the bench off without the regex engine and notes the disabled Regex extension', async () => {
        s.caps.ok.delete('st.regex');
        (s.stand.mock.extensionSettings.disabledExtensions as string[]).push('regex');
        const { container, dispose } = await openTab();
        expect(container.textContent).toContain('Движок регексов ST недоступен');
        expect(container.textContent).toContain('Расширение Regex выключено в ST');
        expect(container.textContent).not.toContain('Регексы, вырезающие теги BunnyMo');
        dispose();
    });
});

describe('M5 lifecycle', () => {
    it('removes its tab, style and API on disable', async () => {
        expect(s.ui.tabs).toHaveLength(1);
        expect(s.ui.styles.has('m5-doctor')).toBe(true);
        expect(s.modules.api('doctor')).toBeDefined();
        expect(s.app.i18n.t('kind.doctor.enableRule')).toBe('Включение правил из «Доктора»');
        await stop();
        stop = async () => {};
        expect(s.ui.tabs).toHaveLength(0);
        expect(s.ui.styles.has('m5-doctor')).toBe(false);
        expect(s.modules.api('doctor')).toBeUndefined();
    });

    it('has every string in both languages', () => {
        const en = Object.keys(doctorModule.i18n!.en).sort();
        expect(Object.keys(doctorModule.i18n!.ru).sort()).toEqual(en);
        for (const key of en) expect(doctorModule.i18n!.ru[key]?.trim()).toBeTruthy();
    });
});
