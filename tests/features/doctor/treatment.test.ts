// @vitest-environment happy-dom
// M5 stage 2 (dev-plan 2.5): «Исправить в файле» for the user's books (never BunnyMo packs), regex treatment, and
// findings handled by an enabled M22 rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorModule } from '../../../src/features/doctor';
import type { DoctorApi, Finding } from '../../../src/features/doctor';
import { FILE_FIX_KIND, fileFixOffered, fixInFile, planFileFix } from '../../../src/features/doctor/fixes';
import { PRESET_REGEX_KIND, REGEX_FIX_KIND, regexAction } from '../../../src/features/doctor/regex-fix';
import type { RegexScriptInfo } from '../../../src/domain/doctor-regex';
import { LEFT_BOUNDARY } from '../../../src/domain/rules-keys';
import { packGroupId } from '../../../src/domain/rules-packs';
import type { Proposal } from '../../../src/shared/contracts';
import { clearScripts } from '../../helpers/adapters-host';
import { FakeRules, createDoctorStand, flush } from '../../helpers/doctor-app';
import type { DoctorStand } from '../../helpers/doctor-app';
import { archive, packEntries, storedBook } from '../../helpers/doctor-entries';
import { message } from '../../helpers/st-mock';

type Book = { entries: Record<string, Record<string, unknown>> };

let s: DoctorStand;
let stop: () => Promise<void>;
let saves: { name: string; immediately: unknown }[];
let reloads: string[];
let proposals: { proposal: Proposal; fallback: string }[];
let acknowledged: string[][];
let savedTypes: number[];

const RU = 'Анна посмотрела на Флоренс и тихо рассмеялась, вспоминая вчерашний бал.';
const marker = {
    version: 1,
    languages: {
        ru: {
            language: 'Russian',
            sources: ['Florence'],
            added: { key: ['/Фло\\-ренс/iu', '/ок/iu'], keysecondary: [] },
        },
    },
};

function setup(): void {
    const { stand } = s;
    stand.books.set(
        'Архив',
        storedBook(archive('Анна'), {
            ...archive('Флоренс', { scanDepth: null, role: 0 }),
            key: ['Флоренс', '/Фло\\-ренс/iu', '/ок/iu'],
            extensions: { lorebook_localizer: marker },
        }),
    );
    stand.books.set(
        'Flora',
        storedBook(
            { key: ['Аня', 'ballroom'], comment: 'Аня', content: 'Аня танцует.', matchWholeWords: true },
            { key: ['manor'], comment: 'Manor', content: 'The manor.', position: 4, role: 2, depth: 1 },
        ),
    );
    stand.books.set(
        'Species',
        storedBook(...packEntries('SPECIES'), {
            key: ['Эльф'],
            comment: 'Elf',
            content: 'elf',
            matchWholeWords: true,
            position: 4,
            role: 2,
            scanDepth: 1,
        }),
    );
    stand.worldInfo.selected_world_info = ['Архив', 'Flora', 'Species'];
    stand.mock.chat = Array.from({ length: 12 }, (_, i) => message(RU, { is_user: i % 2 === 0 }));
    saves = [];
    reloads = [];
    stand.setCtx('saveWorldInfo', async (name: string, data: Book, immediately: unknown) => {
        saves.push({ name, immediately });
        stand.books.set(name, structuredClone(data));
    });
    stand.setCtx('reloadWorldInfoEditor', (name: string) => reloads.push(name));
}

async function patchEngine(): Promise<void> {
    savedTypes = [];
    const engine = await s.stand.host.modules.regexEngine();
    const types = { 0: 'global', 1: 'scoped', 2: 'preset' } as const;
    Object.assign(engine, {
        saveScriptsByType: async (list: Record<string, unknown>[], code: 0 | 1 | 2) => {
            savedTypes.push(code);
            const target = s.regex[types[code]];
            target.splice(0, target.length, ...list);
        },
        getCurrentPresetName: () => 'Marinara',
    });
}

beforeEach(async () => {
    document.body.innerHTML = '';
    s = createDoctorStand('ru');
    setup();
    await patchEngine();
    proposals = [];
    acknowledged = [];
    const decide = s.app.autonomy.decide.bind(s.app.autonomy);
    s.app.autonomy.decide = async <T>(proposal: Proposal<T>, fallback: Parameters<typeof decide>[1]) => {
        proposals.push({ proposal: proposal as Proposal, fallback });
        return decide(proposal, fallback);
    };
    s.modules.expose('guardian', {
        acknowledge: async (paths: string[]) => {
            acknowledged.push(paths);
        },
    });
    stop = await s.start(doctorModule);
});

afterEach(async () => {
    await stop();
    clearScripts();
});

const api = (): DoctorApi => s.modules.api<DoctorApi>('doctor')!;
const find = (findings: Finding[], kind: string, book?: string) =>
    findings.find((finding) => finding.kind === kind && (book === undefined || finding.target.book === book));
const facts = () => ({ bunny: new Set(['Species']), archive: new Set(['Архив']) });
const entryOf = (book: string, uid: number) => s.stand.books.get(book)!.entries[String(uid)]!;

async function openTab(): Promise<{ container: HTMLElement; dispose: () => void }> {
    const tab = s.ui.tabs.find((item) => item.id === 'doctor')!;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const result = tab.render(container);
    await flush(20);
    return { container, dispose: typeof result === 'function' ? result : () => {} };
}

const buttons = (root: ParentNode, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent?.trim() === text);

describe('file fixes', () => {
    it('offers «Исправить в файле» for the user’s books only, never for BunnyMo packs', async () => {
        const findings = await api().scan();
        const offered = findings.filter((finding) => fileFixOffered(finding, facts()));
        expect(offered.map((finding) => [finding.kind, finding.target.book]).sort()).toEqual(
            [
                ['ck.archiveScanDepth', 'Архив'],
                ['keys.cyrillicWholeWord', 'Flora'],
                ['keys.localizerBroken', 'Архив'],
                ['role.assistantAtDepth', 'Архив'],
            ].sort(),
        );
        // The assistant role of a world book may be intended: no file fix there.
        expect(fileFixOffered(find(findings, 'role.assistantAtDepth', 'Flora')!, facts())).toBe(false);
        // The pack's own findings never get one.
        expect(find(findings, 'role.assistantAtDepth', 'Species')?.fileFix).toBe(false);
        expect(find(findings, 'keys.cyrillicWholeWord', 'Species')?.fileFix).toBe(false);

        const { container, dispose } = await openTab();
        expect(buttons(container, 'Исправить в файле')).toHaveLength(4);
        for (const finding of findings.filter((item) => item.target.book === 'Species')) {
            const node = container.querySelector(`[data-finding="${finding.id}"]`);
            expect(node?.textContent).not.toContain('Исправить в файле');
        }
        dispose();
    });

    it('fixes an archive’s scan depth after asking, saves at once, journals and undoes', async () => {
        const findings = await api().scan();
        const finding = find(findings, 'ck.archiveScanDepth', 'Архив')!;
        expect(await api().fixInFile?.(finding.id)).toBe('applied');
        const { proposal, fallback } = proposals.find((item) => item.proposal.kind === FILE_FIX_KIND)!;
        expect(fallback).toBe('ask');
        expect(proposal.title).toBe('Общая глубина сканирования для листа характера в «Архив»');
        // The question names the entries; uids and field names go under «Подробнее».
        expect(proposal.description).toContain('Поменяю записи в книге лора «Архив»: 1.');
        expect(proposal.description).toContain('Записи: «Анна Character Archive - Generated by Baby Bunny Mode»');
        expect(proposal.description).not.toContain('scanDepth');
        expect(proposal.details).toContain(
            '#0 «Анна Character Archive - Generated by Baby Bunny Mode»: scanDepth: 1 → общая',
        );
        expect(saves).toEqual([{ name: 'Архив', immediately: true }]);
        expect(reloads).toEqual(['Архив']);
        expect(entryOf('Архив', 0).scanDepth).toBeNull();
        const record = s.journal.records.find((item) => item.kind === FILE_FIX_KIND)!;
        expect(record.changes).toEqual([
            {
                target: 'lore-entry',
                ref: { book: 'Архив', uid: 0 },
                before: { scanDepth: 1 },
                after: { scanDepth: null },
            },
        ]);
        // The scan ran again: the finding is gone.
        expect(find(api().findings(), 'ck.archiveScanDepth', 'Архив')).toBeUndefined();
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(entryOf('Архив', 0).scanDepth).toBe(1);
        // A second undo finds the entry changed and refuses.
        record.undone = false;
        expect(await s.journal.undo(record.id)).toBe(false);
    });

    it('turns the assistant role of an archive into system and repairs Localizer keys', async () => {
        const findings = await api().scan();
        expect(await api().fixInFile?.(find(findings, 'role.assistantAtDepth', 'Архив')!.id)).toBe('applied');
        expect(entryOf('Архив', 0).role).toBe(0);
        const localizer = find(api().findings(), 'keys.localizerBroken', 'Архив')!;
        expect(await api().fixInFile?.(localizer.id)).toBe('applied');
        const florence = entryOf('Архив', 1);
        expect(florence.key).toEqual(['Флоренс', '/ок/iu']);
        expect(florence.extensions).toEqual({
            lorebook_localizer: {
                ...marker,
                languages: { ru: { ...marker.languages.ru, added: { key: ['/ок/iu'], keysecondary: [] } } },
            },
        });
        expect(find(api().findings(), 'keys.localizerBroken')).toBeUndefined();
    });

    it('writes left-boundary keys for Cyrillic whole-word keys of a user book', async () => {
        const findings = await api().scan();
        const finding = find(findings, 'keys.cyrillicWholeWord', 'Flora')!;
        expect(finding.fixRule).toBe('keys.cyrillicLeftBoundary');
        expect(await api().fixInFile?.(finding.id)).toBe('applied');
        expect(entryOf('Flora', 0).key).toEqual([`/${LEFT_BOUNDARY}Аня/iu`, 'ballroom']);
        expect(find(api().findings(), 'keys.cyrillicWholeWord', 'Flora')).toBeUndefined();
    });

    it('never writes a BunnyMo book: by content, by M35 role, and not even through undo', async () => {
        const packFinding: Finding = {
            id: 'x',
            kind: 'ck.archiveScanDepth',
            severity: 'warn',
            messageKey: 'm5.f.archiveScanDepth',
            target: { book: 'Species', uid: 3 },
            fileFix: true,
        };
        const before = JSON.stringify(s.stand.books.get('Species'));
        expect(await fixInFile(s.app, packFinding)).toEqual({ status: 'protected', book: 'Species' });
        expect(await planFileFix(s.app, packFinding)).toBe('protected');

        // Flora becomes a read-only book in M35: findings lose the file fix and a direct call is refused.
        s.modules.expose('bookRoles', {
            roleOf: (book: string) => (book === 'Flora' ? { book, role: 'bunnymo.pack', readOnly: true } : undefined),
            all: () => [],
        });
        const findings = await api().scan();
        const flora = find(findings, 'keys.cyrillicWholeWord', 'Flora')!;
        expect(flora.fileFix).toBe(false);
        expect(await api().fixInFile?.(flora.id)).toBe('skipped');
        expect(await fixInFile(s.app, { ...flora, fileFix: true })).toMatchObject({ status: 'protected' });
        const undo = s.journal.handlers.get('lore-entry')!;
        expect(
            await undo({
                target: 'lore-entry',
                ref: { book: 'Flora', uid: 0 },
                before: { key: ['x'] },
                after: { key: ['Аня', 'ballroom'] },
            }),
        ).toBe(false);
        expect(saves).toEqual([]);
        expect(JSON.stringify(s.stand.books.get('Species'))).toBe(before);
    });

    it('queues the fix in the Inbox when asked to, and the stored card applies once', async () => {
        s.levels[FILE_FIX_KIND] = 'inbox';
        const findings = await api().scan();
        expect(await api().fixInFile?.(find(findings, 'ck.archiveScanDepth', 'Архив')!.id)).toBe('queued');
        expect(saves).toEqual([]);
        const card = s.inbox.added[0]!;
        const applier = s.inbox.appliers.get(FILE_FIX_KIND)!;
        expect(await applier.valid?.(card.payload)).toBe(true);
        await applier.apply(card.payload);
        expect(entryOf('Архив', 0).scanDepth).toBeNull();
        expect(await applier.valid?.(card.payload)).toBe(false);
        await expect(applier.apply(card.payload)).rejects.toThrow('изменилась');
        await expect(applier.apply({ bad: true })).rejects.toThrow();
    });

    it('tells when nothing is left to fix', async () => {
        const findings = await api().scan();
        const finding = find(findings, 'ck.archiveScanDepth', 'Архив')!;
        entryOf('Архив', 0).scanDepth = 2;
        expect(await fixInFile(s.app, finding)).toEqual({ status: 'nothing', book: 'Архив' });
        const { container, dispose } = await openTab();
        const node = container.querySelector<HTMLElement>(`[data-finding="${finding.id}"]`)!;
        buttons(node, 'Исправить в файле')[0]!.click();
        await flush();
        expect(s.ui.notices.at(-1)).toEqual({
            text: 'В книге «Архив» уже нечего исправлять — запусти проверку заново.',
            options: { urgent: true },
        });
        dispose();
    });
});

describe('rules on the fly', () => {
    it('marks findings an enabled rule handles and waits for the wizard otherwise', async () => {
        const rules = new FakeRules([{ id: 'keys.cyrillicLeftBoundary' }, { id: 'role.assistantToSystem' }]);
        s.modules.expose('rules', rules);
        await rules.setEnabled('keys.cyrillicLeftBoundary', true);
        await rules.setEnabled('role.assistantToSystem', true);
        rules.states.get('role.assistantToSystem')!.waiting = true;
        const findings = await api().scan();
        const { container, dispose } = await openTab();
        const text = (finding: Finding | undefined) =>
            container.querySelector(`[data-finding="${finding!.id}"]`)?.textContent ?? '';
        expect(text(find(findings, 'keys.cyrillicWholeWord', 'Flora'))).toContain('Исправляется правилом на лету');
        expect(text(find(findings, 'role.assistantAtDepth', 'Flora'))).toContain('заработает после мастера');
        dispose();
    });

    it('tells whether the pack version question is still open', async () => {
        s.stand.books.set(
            'MBTI v1',
            storedBook(...packEntries('MBTI'), { key: ['<INTJ-U>'], comment: 'Schemer', content: 'The Schemer' }),
        );
        s.stand.books.set(
            'MBTI V2',
            storedBook(...packEntries('MBTI2'), { key: ['<INTJ-U>'], comment: 'Cynic', content: 'The Cynic' }),
        );
        s.stand.worldInfo.selected_world_info = ['MBTI v1', 'MBTI V2'];
        const rules = new FakeRules([{ id: 'pack.versionConflict' }]);
        s.modules.expose('rules', rules);
        await rules.setEnabled('pack.versionConflict', true);
        const finding = find(await api().scan(), 'pack.versionConflict')!;
        expect(finding.fixRule).toBe('pack.versionConflict');
        const textOf = async () => {
            const { container, dispose } = await openTab();
            const text = container.querySelector(`[data-finding="${finding.id}"]`)?.textContent ?? '';
            dispose();
            return text;
        };
        expect(await textOf()).toContain('один раз спросит');
        const group = packGroupId(['MBTI v1', 'MBTI V2']);
        rules.options.mockReturnValue({ choices: { [group]: '' } });
        expect(await textOf()).toContain('оставлены обе версии');
        rules.options.mockReturnValue({ choices: { [group]: 'MBTI V2' } });
        expect(await textOf()).toContain('Исправляется правилом на лету');
    });
});

describe('regex treatment', () => {
    const script = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        scriptName: id,
        findRegex: '/x/g',
        replaceString: '',
        placement: [2],
        ...fields,
    });

    /** An inventory item of a global script (as the scan would list it). */
    function globalScript(id: string, index: number): RegexScriptInfo {
        return {
            id: `global:${id}`,
            scriptId: id,
            name: id,
            type: 'global',
            index,
            find: '/x/g',
            replace: '',
            trimStrings: [],
            placement: [2],
            disabled: false,
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: false,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
            allowed: true,
        };
    }

    it('disables a regex that strips BunnyMo tags, acknowledges it to the guardian and undoes', async () => {
        s.regex.global.push(
            script('clean', {
                scriptName: 'Clean HTML (From Outgoing Prompt)',
                findRegex: '/\\s?<(?!\\!--)(?:"[^"]*"|\'[^\']*\'|[^\'">])*>/g',
                promptOnly: true,
            }),
        );
        const findings = await api().scan();
        const finding = find(findings, 'regex.stripsTags')!;
        const { container, dispose } = await openTab();
        const node = container.querySelector<HTMLElement>(`[data-finding="${finding.id}"]`)!;
        buttons(node, 'Выключить')[0]!.click();
        await flush(20);
        expect(s.regex.global[0]!.disabled).toBe(true);
        expect(savedTypes).toEqual([0]);
        expect(acknowledged).toEqual([['regex']]);
        const { proposal, fallback } = proposals.find((item) => item.proposal.kind === REGEX_FIX_KIND)!;
        expect(fallback).toBe('auto');
        expect(proposal.title).toBe('Выключение регекса «Clean HTML (From Outgoing Prompt)» (глобальный)');
        // 'auto': autonomy announces it (with undo) — the tab adds no second notice.
        expect(proposal.appliedNotice?.text).toBe('Выключил регекс «Clean HTML (From Outgoing Prompt)».');
        expect(s.ui.notices.some((item) => item.text.includes('Clean HTML'))).toBe(false);
        const record = s.journal.records.find((item) => item.kind === REGEX_FIX_KIND)!;
        expect(record.changes[0]).toMatchObject({ target: 'doctor-regex', after: { disabled: true } });
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(s.regex.global[0]!.disabled).toBe(false);
        // Switched again elsewhere since: a second undo leaves it alone.
        record.undone = false;
        expect(await s.journal.undo(record.id)).toBe(false);
        dispose();
    });

    it('deletes a duplicate copy only after asking, and undo puts it back in its place', async () => {
        s.regex.global.push(
            script('quotes', { scriptName: 'Fix quotes', findRegex: '/[“”]/g', replaceString: '"' }),
            script('other'),
            script('quotes2', { scriptName: 'Fix quotes copy', findRegex: '/[“”]/g', replaceString: '"' }),
        );
        const findings = await api().scan();
        const finding = find(findings, 'regex.duplicate')!;
        const { container, dispose } = await openTab();
        const node = container.querySelector<HTMLElement>(`[data-finding="${finding.id}"]`)!;
        buttons(node, 'Удалить копию «Fix quotes copy»')[0]!.click();
        await flush(20);
        expect(proposals.find((item) => item.proposal.kind === REGEX_FIX_KIND)?.fallback).toBe('ask');
        expect(s.regex.global.map((item) => item.id)).toEqual(['quotes', 'other']);
        // Not 'auto' (asked first): the tab answers his click itself.
        expect(s.ui.notices.at(-1)).toEqual({ text: 'Удалил регекс «Fix quotes copy».', options: { urgent: true } });
        const record = s.journal.records.find((item) => item.kind === REGEX_FIX_KIND)!;
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(s.regex.global.map((item) => item.id)).toEqual(['quotes', 'other', 'quotes2']);
        dispose();
    });

    it('only disables a dead regex, with a note, and enables it again from the list', async () => {
        s.regex.global.push(
            script('think', { scriptName: 'Format thinking', findRegex: '/<thinking>/', markdownOnly: true }),
        );
        const findings = await api().scan();
        const finding = find(findings, 'regex.dead')!;
        expect(finding.messageKey).toBe('m5.f.regexDead');
        const { container, dispose } = await openTab();
        const node = container.querySelector<HTMLElement>(`[data-finding="${finding.id}"]`)!;
        expect(node.textContent).toContain('только выключение, без удаления');
        expect(node.textContent).not.toContain('Удалить');
        buttons(node, 'Выключить')[0]!.click();
        await flush(20);
        expect(s.regex.global[0]!.disabled).toBe(true);
        expect(proposals[0]!.proposal.description).toContain('только выключение, без удаления');
        const row = container.querySelector('[data-regex-id="global:think"]')!.closest('tr')!;
        buttons(row, 'Включить')[0]!.click();
        await flush(20);
        expect(s.regex.global[0]!.disabled).toBe(false);
        dispose();
    });

    it('asks before writing a preset’s regex, queues it, and refuses another preset later', async () => {
        s.allowed.add('preset');
        s.regex.preset.push(script('p1', { scriptName: 'Preset regex' }));
        s.levels[PRESET_REGEX_KIND] = 'inbox';
        await api().scan();
        expect(await api().regexAction?.('preset:p1', 'disable')).toBe('queued');
        expect(proposals.at(-1)).toMatchObject({ fallback: 'ask' });
        expect(proposals.at(-1)?.proposal.description).toContain('сохранится файл пресета');
        const card = s.inbox.added[0]!;
        expect(card.payload).toMatchObject({ type: 'preset', owner: 'Marinara', action: 'disable' });
        const applier = s.inbox.appliers.get(PRESET_REGEX_KIND)!;
        expect(await applier.valid?.(card.payload)).toBe(true);
        await applier.apply(card.payload);
        expect(s.regex.preset[0]!.disabled).toBe(true);
        expect(savedTypes).toEqual([2]);
        expect(acknowledged.at(-1)).toEqual(['regex', 'preset.body']);
        // Another preset is active now: the same card no longer belongs here.
        const engine = await s.stand.host.modules.regexEngine();
        Object.assign(engine, { getCurrentPresetName: () => 'Other' });
        expect(await applier.valid?.({ ...(card.payload as object), action: 'enable' })).toBe(false);
        await expect(applier.apply({ ...(card.payload as object), action: 'enable' })).rejects.toThrow();
    });

    it('writes a character’s regexes through the card without the engine, for that character only', async () => {
        s.caps.ok.delete('st.regex');
        const writes: [unknown, string, unknown][] = [];
        const ctx = s.stand.mock.context as unknown as Record<string, unknown>;
        ctx.characters = [{ avatar: 'anna.png', data: { extensions: { regex_scripts: [script('s1')] } } }];
        ctx.characterId = 0;
        ctx.writeExtensionField = async (id: unknown, key: string, value: unknown) => {
            writes.push([id, key, structuredClone(value)]);
        };
        s.stand.mock.extensionSettings.character_allowed_regex = ['anna.png'];
        await api().scan();
        expect(await api().regexAction?.('scoped:s1', 'disable')).toBe('applied');
        expect(writes).toEqual([[0, 'regex_scripts', [{ ...script('s1'), disabled: true }]]]);
        const record = s.journal.records.at(-1)!;
        expect(record.changes[0]?.ref).toMatchObject({ type: 'scoped', owner: 'anna.png' });
        ctx.characters = [{ avatar: 'boris.png', data: { extensions: { regex_scripts: [script('s1')] } } }];
        expect(await s.journal.undo(record.id)).toBe(false);
        // Global scripts without the engine go to the settings.
        s.stand.mock.extensionSettings.regex = [script('g1')];
        const saved = vi.fn();
        ctx.saveSettingsDebounced = saved;
        expect(await regexAction(s.app, globalScript('g1', 0), 'disable')).toBe('applied');
        expect((s.stand.mock.extensionSettings.regex as Record<string, unknown>[])[0]?.disabled).toBe(true);
        expect(saved).toHaveBeenCalled();
    });

    it('reports a script that is gone', async () => {
        s.regex.global.push(script('gone'));
        await api().scan();
        s.regex.global.splice(0);
        expect(await api().regexAction?.('global:gone', 'disable')).toBe('skipped');
        expect(s.ui.notices.at(-1)?.text).toContain('больше нет');
        expect(await api().regexAction?.('global:unknown', 'disable')).toBe('skipped');
    });
});
