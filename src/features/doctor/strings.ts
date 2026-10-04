// Strings of M5 «Доктор» (`m5.*`). Russian is the primary UI language; the user is addressed as «ты».
import type { I18nParts } from '../../shared/contracts';

export const DOCTOR_STRINGS: I18nParts = {
    en: {
        'm5.title': 'Doctor',
        'm5.tab': 'Doctor',
        'kind.doctor.enableRule': 'Enabling rules from the Doctor',
        'kind.doctor.fileFix': 'Lorebook file fixes from the Doctor',
        'kind.doctor.regexFix': 'Regex changes from the Doctor',
        'kind.doctor.presetRegexFix': 'Preset regex changes from the Doctor',

        'm5.scan': 'Check',
        'm5.rescan': 'Check again',
        'm5.scanning': 'Checking lorebooks and regexes…',
        'm5.neverScanned':
            'No check yet. The Doctor reads the active lorebooks and every regex script and changes nothing.',
        'm5.lastScan': 'Checked at {time}: books {books}, entries {entries}, regexes {scripts}.',
        'm5.staleChat': 'The chat has changed since the check: the findings belong to the previous chat.',
        'm5.summary.error': 'Errors: {count}',
        'm5.summary.warn': 'Warnings: {count}',
        'm5.summary.info': 'Notes: {count}',
        'm5.severity.error': 'Errors',
        'm5.severity.warn': 'Warnings',
        'm5.severity.info': 'Notes',
        'm5.findings': 'Findings',
        'm5.noFindings': 'Nothing found.',
        'm5.notes.noBooks': 'No active lorebooks in this chat.',
        'm5.notes.noWorldInfo': 'Global World Info settings are unavailable: recursion and budget were not checked.',

        'm5.kind.pack.duplicate': 'Duplicate pack entries',
        'm5.kind.pack.versionConflict': 'Pack version conflicts',
        'm5.kind.recursion.chain': 'Recursion chains',
        'm5.kind.recursion.vacuum': 'Entries that pull in many others',
        'm5.kind.role.assistantAtDepth': 'Assistant role at depth',
        'm5.kind.ck.archiveScanDepth': 'Archives with scan depth 1',
        'm5.kind.ck.archiveMultiBlock': 'Archives with several blocks',
        'm5.kind.ck.archivePlaceholder': 'Placeholders in archives',
        'm5.kind.ck.archiveTagCase': 'Archive block spelling',
        'm5.kind.ck.archiveNotRepo': 'Archives CarrotKernel does not see',
        'm5.kind.wrapper.collision': 'Wrapper collisions',
        'm5.kind.keys.noRussian': 'English-only keys',
        'm5.kind.keys.cyrillicWholeWord': 'Cyrillic keys and whole words',
        'm5.kind.keys.localizerBroken': 'Broken Localizer keys',
        'm5.kind.budget.overflow': 'Lore budget',
        'm5.kind.budget.strategy': 'Budget strategy',
        'm5.kind.regex.breaksJson': 'Regexes that break JSON',
        'm5.kind.regex.breaksMarkers': 'Regexes that damage NAI markers',
        'm5.kind.regex.stripsTags': 'Regexes that strip BunnyMo tags',
        'm5.kind.regex.duplicate': 'Duplicate regexes',
        'm5.kind.regex.dead': 'Regexes with nothing to do',
        'm5.kind.regex.conflict': 'Conflicting regexes',

        'm5.f.packDuplicate':
            '“{a}” and “{b}” share identical entries: {count} (about {chars} characters reach the prompt twice). For example: {sample}.',
        'm5.f.packVersionConflict':
            '“{a}” and “{b}” have entries with the same keys but different text: {count} (for example {sample}). One tag fires both texts. “{newer}” looks newer. The rule “Pack version conflicts” asks once which version to keep.',
        'm5.f.packVersionConflictUnsure':
            '“{a}” and “{b}” have entries with the same keys but different text: {count} (for example {sample}). One tag fires both texts. The rule “Pack version conflicts” asks once which version to keep.',
        'm5.f.recursionChain':
            '“{book}”: recursion chains reach {depth} steps, for example {path}. Links: {links}; entries pulling in 5 or more others: {vacuums}; one entry can pull in up to {chars} characters.',
        'm5.f.recursionVacuum':
            '“{entry}” ({book}) pulls in {count} entries directly and {reach} in total through recursion (about {chars} characters). For example: {sample}.',
        'm5.f.recursionNoLimit':
            'Recursion is on with no step limit, and chains reach {depth} steps. A limit of {suggested} steps keeps the entries that fired and their nearest links.',
        'm5.f.recursionHighLimit':
            'The recursion step limit is {limit}, and chains reach {depth} steps. A limit of {suggested} keeps the entries that fired and their nearest links.',
        'm5.f.assistantAtDepth':
            '“{entry}” ({book}) goes in at depth {depth} with the assistant role: for DeepSeek V4 that is a fake model reply.',
        'm5.f.archiveScanDepth':
            'Archive “{entry}” ({book}) has scan depth 1: it fires only when the name is in the very last message.',
        'm5.f.archiveMultiBlock':
            'Archive “{entry}” ({book}) holds {count} <BunnymoTags> blocks, and CarrotKernel reads only the first. One character per entry.',
        'm5.f.archiveTagCase':
            'Archive “{entry}” ({book}) opens its block as {found}; CarrotKernel reliably reads only <BunnymoTags> spelled exactly so.',
        'm5.f.archivePlaceholder': 'Archive “{entry}” ({book}) still has template placeholders: {tags}.',
        'm5.f.archiveNotRepo':
            '“{book}” holds character archives ({count}: {sample}) but is not marked as a Character Repo in CarrotKernel, so CK does not see these characters.',
        'm5.f.wrapperCollision':
            'Archives wrap text in {tag}…{closing} ({count}: {archives}); through recursion this fires “{target}” from “{targetBook}”.',
        'm5.f.bareTagCollision':
            'Archives contain the bare tag {tag} ({count}: {archives}); it fires “{target}” from “{targetBook}”. Fine if intended.',
        'm5.f.noRussian':
            '“{book}”: entries with English-only keys: {count} (for example {sample}). The chat is in Russian, so they fire only through tags or recursion.',
        'm5.f.cyrillicWholeWord':
            '“{book}”: Cyrillic keys with “match whole words”: {count} (for example {sample}). In ST this option does not work for Cyrillic (\\W knows only Latin letters), so these keys match as substrings: “аня” fires inside “Таня”. The rule “Cyrillic keys and whole words” adds a left-only boundary that keeps case endings working; the same can be written to the file.',
        'm5.f.localizerBroken.flags':
            '“{entry}” ({book}): keys added by Lorebook Localizer have unknown regex flags and never fire ({count}), for example {key}.',
        'm5.f.localizerBroken.slash':
            '“{entry}” ({book}): keys added by Lorebook Localizer have an unescaped “/” inside and never fire ({count}), for example {key}.',
        'm5.f.localizerBroken.syntax':
            '“{entry}” ({book}): keys added by Lorebook Localizer are invalid regexes (e.g. “\\-” in u mode) and never fire ({count}), for example {key}.',
        'm5.f.localizerBroken.braces':
            '“{entry}” ({book}): keys added by Lorebook Localizer use “\\{” or “\\}”, which the ST macro engine turns into bare braces, so the key changes meaning ({count}), for example {key}.',
        'm5.f.budgetUnlimited':
            'The World Info budget is effectively unlimited: {percent}% of {context} tokens is {budget} tokens, with no cap. Large books go into the prompt whole.',
        'm5.f.budgetConstants':
            'Constant entries alone take about {constants} tokens, more than the whole budget ({budget}).',
        'm5.f.budgetOverflowed': 'Lore hit the budget in {count} of the last {turns} turns; entries cut: {cut}.',
        'm5.f.budgetOverflowedSilent':
            'Lore hit the budget in {count} of the last {turns} turns; entries cut: {cut}. The overflow alert is off, so ST said nothing.',
        'm5.f.budgetIgnored':
            'Entries outside the budget (“ignore budget”): {count}, {chars} characters. They go in even when the budget is spent.',
        'm5.f.budgetStrategy.evenly':
            'Insertion strategy “sorted evenly”: when the budget ({budget} tokens) runs out, the entries with the lowest order are cut, whatever book they come from.',
        'm5.f.budgetStrategy.characterFirst':
            'Insertion strategy “character lore first”: when the budget ({budget} tokens) runs out, global books, BunnyMo packs among them, are cut first.',
        'm5.f.budgetStrategy.globalFirst':
            'Insertion strategy “global lore first”: when the budget ({budget} tokens) runs out, character books are cut first.',
        'm5.f.stripsTagsPrompt':
            'Regex “{name}” ({type}) strips BunnyMo tags like <SPECIES:ELF> from the outgoing prompt: tags written in the chat reach neither the model nor the lore scan, so packs do not fire from them.',
        'm5.f.stripsTagsStored':
            'Regex “{name}” ({type}) strips BunnyMo tags like <SPECIES:ELF> from messages before they are saved: the tags are lost for good.',
        'm5.f.breaksJson':
            'Regex “{name}” ({type}) edits AI replies before they are saved and breaks JSON such as the DES tracker block: {example}',
        'm5.f.removesJson': 'Regex “{name}” ({type}) removes the DES tracker JSON from AI replies before DES reads it.',
        'm5.f.breaksMarkers':
            'Regex “{name}” ({type}) edits AI replies before they are saved and damages NAI Studio picture markers.',
        'm5.f.regexDuplicate':
            'Regexes “{a}” and “{b}” have the same pattern and replacement (copies: {count}): the same work is done twice.',
        'm5.f.regexConflict':
            'Regexes “{a}” and “{b}” look for the same pattern but replace it differently (scripts: {count}): “{a}” runs first and leaves nothing for “{b}”.',
        'm5.f.regexDead':
            'Regex “{name}” ({type}) did not fire in this chat (messages checked: {count}). Other chats may still need it.',
        'm5.f.regexInvalid': 'Regex “{name}” ({type}) has a pattern that does not compile, so it never runs.',
        'm5.f.regexNotAllowed.preset':
            'The preset’s regexes are not allowed in ST and do not run ({count}: {sample}). Allow them in the Regex extension if they are needed.',
        'm5.f.regexNotAllowed.scoped':
            'The character’s regexes are not allowed in ST and do not run ({count}: {sample}). Allow them in the Regex extension if they are needed.',
        'm5.f.regexNotAllowed.global': 'Global regexes do not run ({count}: {sample}).',
        'm5.f.regexWorldInfoNotPrompt':
            'Regex “{name}” ({type}) is set to World Info without “prompt only”: ST applies only prompt-only regexes to lore, so it does nothing there.',

        'm5.enableRule': 'Enable rule',
        'm5.ruleHandles': 'Fixed on the fly by a rule',
        'm5.ruleWaits': 'The rule is on and starts after the first-run wizard',
        'm5.ruleUnavailable': 'The rule is on but cannot work now: {missing}',
        'm5.rulePackPending': 'The rule asks once which version to keep; until then both work',
        'm5.rulePackKeepsAll': 'Both versions kept by your choice (change it on the Rules tab)',
        'm5.ruleTitle': 'Rule: {rule}',
        'm5.ruleMissing': 'The Rules module is off: rules cannot be switched on from findings.',
        'm5.ruleLater': 'The rule arrives in a later stage',
        'm5.enableRuleTitle': 'Enable the rule “{rule}”',
        'm5.enableRuleDescription': 'Suggested by the Doctor: {finding}',
        'm5.enableRuleDone': 'Rule “{rule}” is on.',
        'm5.enableRuleQueued': 'The proposal to enable “{rule}” is waiting in the Inbox.',
        'm5.bunnyBook': 'BunnyMo book: its file is never edited',
        'm5.openBook': 'Open “{book}”',
        'm5.showRegex': 'Show in the list',
        'm5.fixFile': 'Fix in the file',
        'm5.fixFile.hint': 'Shows the changes and asks first; the previous values stay in the journal.',
        'm5.fixFile.title.role': 'Assistant role → system in “{book}”',
        'm5.fixFile.title.scanDepth': 'Global scan depth for an archive in “{book}”',
        'm5.fixFile.title.localizer': 'Repair Localizer keys in “{book}”',
        'm5.fixFile.title.cyrillic': 'Left-boundary Cyrillic keys in “{book}”',
        'm5.fixFile.title.other': 'Fix “{book}”',
        'm5.fixFile.description':
            'Entries to change in “{book}”: {count}. The book is saved right away; the previous values stay in the journal, and undo puts them back.',
        'm5.fixFile.more': '…and {count} more',
        'm5.fixFile.globalDepth': 'global',
        'm5.fixFile.marker': 'Localizer marker',
        'm5.fixFile.done': 'Fixed in “{book}”: {count}.',
        'm5.fixFile.queued': 'The fix of “{book}” is waiting in the Inbox.',
        'm5.fixFile.none': 'Nothing is left to fix in “{book}”: check again.',
        'm5.fixFile.unavailable': 'This SillyTavern cannot save lorebooks from extensions.',
        'm5.fixFile.failed.missing': 'The book “{book}” or its entry is gone.',
        'm5.fixFile.failed.stale': 'The entry in “{book}” changed after the check: check again.',
        'm5.fixFile.failed.protected': '“{book}” is a BunnyMo book: its file is never edited.',
        'm5.regexFix.enable': 'Enable',
        'm5.regexFix.disable': 'Disable',
        'm5.regexFix.delete': 'Delete',
        'm5.regexFix.disableNamed': 'Disable “{name}”',
        'm5.regexFix.deleteCopy': 'Delete the copy “{name}”',
        'm5.regexFix.deadNote': 'Other chats may need it, so it is only disabled, never deleted.',
        'm5.regexFix.title.enable': 'Enable regex “{name}” ({type})',
        'm5.regexFix.title.disable': 'Disable regex “{name}” ({type})',
        'm5.regexFix.title.delete': 'Delete regex “{name}” ({type})',
        'm5.regexFix.description.enable': 'Regex “{name}” starts working again.',
        'm5.regexFix.description.disable':
            'Regex “{name}” stops working; it stays in the list and can be enabled again.',
        'm5.regexFix.description.delete':
            'Regex “{name}” is removed from the list. The journal keeps a copy, and undo puts it back in its place.',
        'm5.regexFix.presetFile': 'This regex lives in the preset: the preset file is saved.',
        'm5.regexFix.done.enable': 'Regex “{name}” is on.',
        'm5.regexFix.done.disable': 'Regex “{name}” is off.',
        'm5.regexFix.done.delete': 'Regex “{name}” is deleted.',
        'm5.regexFix.queued': 'The change of regex “{name}” is waiting in the Inbox.',
        'm5.regexFix.notFound': 'Regex “{name}” is not there any more (or belongs to another character or preset).',

        'm5.books.title': 'Active books',
        'm5.books.book': 'Book',
        'm5.books.entries': 'Entries',
        'm5.books.chars': 'Characters',
        'm5.books.links': 'Links',
        'm5.books.depth': 'Longest chain',
        'm5.books.role': 'Role',
        'm5.books.core': 'BunnyMo core',
        'm5.books.pack': 'BunnyMo pack',

        'm5.regex.title': 'Regex scripts',
        'm5.regex.empty': 'No regex scripts.',
        'm5.regex.extensionOff': 'The Regex extension is disabled in ST: no script runs.',
        'm5.regex.name': 'Name',
        'm5.regex.type': 'Scope',
        'm5.regex.owner': 'Owner',
        'm5.regex.where': 'Applies to',
        'm5.regex.mode': 'Mode',
        'm5.regex.depth': 'Depth',
        'm5.regex.state': 'State',
        'm5.regex.actions': 'Actions',
        'm5.regex.unnamed': '(no name)',
        'm5.regexType.global': 'global',
        'm5.regexType.scoped': 'character',
        'm5.regexType.preset': 'preset',
        'm5.place.0': 'Display (old)',
        'm5.place.1': 'User input',
        'm5.place.2': 'AI output',
        'm5.place.3': 'Slash commands',
        'm5.place.5': 'World Info',
        'm5.place.6': 'Reasoning',
        'm5.mode.display': 'Display only',
        'm5.mode.prompt': 'Prompt only',
        'm5.mode.displayAndPrompt': 'Display and prompt',
        'm5.mode.edit': 'Saved text',
        'm5.state.on': 'On',
        'm5.state.off': 'Off',
        'm5.state.notAllowed': 'Not allowed',
        'm5.owner.des': 'DES',
        'm5.owner.marinara': 'Marinara',
        'm5.owner.rpgCompanion': 'RPG Companion',
        'm5.owner.horae': 'Horae',
        'm5.owner.rm': '[RM] pack',
        'm5.owner.user': 'Yours',
        'm5.owner.unknown': 'Unknown',
        'm5.depthAny': 'any',

        'm5.bench.title': 'Test bench',
        'm5.bench.hint':
            'Runs the chosen regex through ST’s engine on a sample, even when it is off. Nothing is saved.',
        'm5.bench.script': 'Regex',
        'm5.bench.pick': 'Choose a regex',
        'm5.bench.source': 'Sample',
        'm5.bench.last': 'Last messages',
        'm5.bench.custom': 'My text',
        'm5.bench.count': 'Messages',
        'm5.bench.placeholder': 'Paste the text to test…',
        'm5.bench.run': 'Run',
        'm5.bench.try': 'Test',
        'm5.bench.noEngine': 'ST’s regex engine is not available, so the bench is off.',
        'm5.bench.noMessages': 'No suitable messages in this chat.',
        'm5.bench.message': 'Message #{index}',
        'm5.bench.customLabel': 'Your text',
        'm5.bench.unchanged': 'Unchanged: the regex found nothing.',
        'm5.bench.failed': 'The regex could not run on this sample.',
    },
    ru: {
        'm5.title': 'Доктор',
        'm5.tab': 'Доктор',
        'kind.doctor.enableRule': 'Включение правил из «Доктора»',
        'kind.doctor.fileFix': 'Исправления лорбуков из «Доктора»',
        'kind.doctor.regexFix': 'Правка регексов из «Доктора»',
        'kind.doctor.presetRegexFix': 'Правка регексов пресета из «Доктора»',

        'm5.scan': 'Проверить',
        'm5.rescan': 'Проверить заново',
        'm5.scanning': 'Проверяю лорбуки и регексы…',
        'm5.neverScanned': 'Проверки ещё не было. Доктор читает активные лорбуки и все регексы и ничего не меняет.',
        'm5.lastScan': 'Проверено в {time}: книг — {books}, записей — {entries}, регексов — {scripts}.',
        'm5.staleChat': 'После проверки сменился чат — находки относятся к прошлому чату.',
        'm5.summary.error': 'Ошибок: {count}',
        'm5.summary.warn': 'Предупреждений: {count}',
        'm5.summary.info': 'Заметок: {count}',
        'm5.severity.error': 'Ошибки',
        'm5.severity.warn': 'Предупреждения',
        'm5.severity.info': 'Заметки',
        'm5.findings': 'Находки',
        'm5.noFindings': 'Ничего не найдено.',
        'm5.notes.noBooks': 'В этом чате нет активных лорбуков.',
        'm5.notes.noWorldInfo': 'Глобальные настройки лора недоступны — рекурсия и бюджет не проверены.',

        'm5.kind.pack.duplicate': 'Дубли записей паков',
        'm5.kind.pack.versionConflict': 'Конфликты версий паков',
        'm5.kind.recursion.chain': 'Цепочки рекурсии',
        'm5.kind.recursion.vacuum': 'Записи-«пылесосы»',
        'm5.kind.role.assistantAtDepth': 'Роль assistant на глубине',
        'm5.kind.ck.archiveScanDepth': 'Архивы с глубиной сканирования 1',
        'm5.kind.ck.archiveMultiBlock': 'Архивы с несколькими блоками',
        'm5.kind.ck.archivePlaceholder': 'Заготовки в архивах',
        'm5.kind.ck.archiveTagCase': 'Написание блока архива',
        'm5.kind.ck.archiveNotRepo': 'Архивы, которых не видит CarrotKernel',
        'm5.kind.wrapper.collision': 'Конфликты обёрток',
        'm5.kind.keys.noRussian': 'Ключи только на английском',
        'm5.kind.keys.cyrillicWholeWord': 'Кириллица и «целые слова»',
        'm5.kind.keys.localizerBroken': 'Испорченные ключи Localizer',
        'm5.kind.budget.overflow': 'Бюджет лора',
        'm5.kind.budget.strategy': 'Стратегия бюджета',
        'm5.kind.regex.breaksJson': 'Регексы, ломающие JSON',
        'm5.kind.regex.breaksMarkers': 'Регексы, портящие маркеры NAI',
        'm5.kind.regex.stripsTags': 'Регексы, вырезающие теги BunnyMo',
        'm5.kind.regex.duplicate': 'Дубли регексов',
        'm5.kind.regex.dead': 'Регексы без дела',
        'm5.kind.regex.conflict': 'Конфликтующие регексы',

        'm5.f.packDuplicate':
            'В «{a}» и «{b}» есть одинаковые записи: {count} (около {chars} символов уходят в промпт дважды). Например: {sample}.',
        'm5.f.packVersionConflict':
            'В «{a}» и «{b}» есть записи с одинаковыми ключами, но разным текстом: {count} (например, {sample}). На один тег срабатывают оба текста. Похоже, новее «{newer}». Правило «Конфликт версий паков» один раз спросит, какую версию оставить.',
        'm5.f.packVersionConflictUnsure':
            'В «{a}» и «{b}» есть записи с одинаковыми ключами, но разным текстом: {count} (например, {sample}). На один тег срабатывают оба текста. Правило «Конфликт версий паков» один раз спросит, какую версию оставить.',
        'm5.f.recursionChain':
            '«{book}»: цепочки рекурсии доходят до {depth} шагов, например {path}. Связей: {links}; записей, которые тянут за собой 5 и больше других: {vacuums}; одна запись может подтянуть до {chars} символов.',
        'm5.f.recursionVacuum':
            'Запись «{entry}» («{book}») напрямую тянет за собой записей: {count}, а через рекурсию всего — {reach} (около {chars} символов). Например: {sample}.',
        'm5.f.recursionNoLimit':
            'Рекурсия включена без лимита шагов, а цепочки доходят до {depth} шагов. Лимит {suggested} оставит сработавшие записи и их ближайшие связи.',
        'm5.f.recursionHighLimit':
            'Лимит шагов рекурсии — {limit}, а цепочки доходят до {depth} шагов. Лимит {suggested} оставит сработавшие записи и их ближайшие связи.',
        'm5.f.assistantAtDepth':
            'Запись «{entry}» («{book}») вставляется на глубину {depth} с ролью assistant — для DeepSeek V4 это поддельная реплика модели.',
        'm5.f.archiveScanDepth':
            'Архив «{entry}» («{book}»): глубина сканирования 1 — он срабатывает, только если имя есть в самом последнем сообщении.',
        'm5.f.archiveMultiBlock':
            'В архиве «{entry}» («{book}») блоков <BunnymoTags>: {count}, а CarrotKernel читает только первый. Один персонаж — одна запись.',
        'm5.f.archiveTagCase':
            'Архив «{entry}» («{book}») открывает блок как {found}, а CarrotKernel надёжно читает только <BunnymoTags> именно в таком написании.',
        'm5.f.archivePlaceholder': 'В архиве «{entry}» («{book}») остались заготовки из шаблона: {tags}.',
        'm5.f.archiveNotRepo':
            'В «{book}» есть архивы персонажей ({count}: {sample}), но в CarrotKernel книга не отмечена как Character Repo — CK этих персонажей не видит.',
        'm5.f.wrapperCollision':
            'Архивы оборачивают текст в {tag}…{closing} ({count}: {archives}) — через рекурсию это включает «{target}» из «{targetBook}».',
        'm5.f.bareTagCollision':
            'В архивах есть голый тег {tag} ({count}: {archives}) — он включает «{target}» из «{targetBook}». Если так и задумано, всё в порядке.',
        'm5.f.noRussian':
            '«{book}»: записей с ключами только на английском — {count} (например, {sample}). Чат идёт на русском, поэтому они срабатывают разве что по тегам или через рекурсию.',
        'm5.f.cyrillicWholeWord':
            '«{book}»: кириллических ключей с «только целыми словами» — {count} (например, {sample}). В ST эта опция не работает для кириллицы (\\W знает только латиницу), поэтому такие ключи ищутся как подстрока: «аня» срабатывает внутри «Таня». Правило «Кириллица и «целые слова»» ставит границу только слева — падежные окончания при этом продолжают работать; то же можно записать и в файл.',
        'm5.f.localizerBroken.flags':
            '«{entry}» («{book}»): у ключей от Lorebook Localizer неверные флаги регулярки, они никогда не сработают ({count}), например {key}.',
        'm5.f.localizerBroken.slash':
            '«{entry}» («{book}»): в ключах от Lorebook Localizer неэкранированный «/», они никогда не сработают ({count}), например {key}.',
        'm5.f.localizerBroken.syntax':
            '«{entry}» («{book}»): ключи от Lorebook Localizer — неверные регулярки (например, «\\-» в режиме u), они никогда не сработают ({count}), например {key}.',
        'm5.f.localizerBroken.braces':
            '«{entry}» («{book}»): в ключах от Lorebook Localizer есть «\\{» или «\\}» — движок макросов ST превращает их в обычные скобки, и ключ меняет смысл ({count}), например {key}.',
        'm5.f.budgetUnlimited':
            'Бюджет лора фактически не ограничен: {percent}% от {context} токенов — это {budget} токенов, а потолка нет. Большие книги уходят в промпт целиком.',
        'm5.f.budgetConstants':
            'Одни только постоянные записи занимают около {constants} токенов — больше всего бюджета ({budget}).',
        'm5.f.budgetOverflowed': 'Лор упирался в бюджет в {count} из последних {turns} ходов; срезано записей: {cut}.',
        'm5.f.budgetOverflowedSilent':
            'Лор упирался в бюджет в {count} из последних {turns} ходов; срезано записей: {cut}. Предупреждение о переполнении выключено, поэтому ST молчал.',
        'm5.f.budgetIgnored':
            'Записей вне бюджета («игнорировать бюджет»): {count}, {chars} символов. Они попадают в промпт, даже когда бюджет исчерпан.',
        'm5.f.budgetStrategy.evenly':
            'Стратегия вставки «равномерно»: когда бюджет ({budget} токенов) кончается, срезаются записи с наименьшим порядком — из какой бы книги они ни были.',
        'm5.f.budgetStrategy.characterFirst':
            'Стратегия вставки «сначала лор персонажа»: когда бюджет ({budget} токенов) кончается, первыми срезаются глобальные книги, в том числе паки BunnyMo.',
        'm5.f.budgetStrategy.globalFirst':
            'Стратегия вставки «сначала глобальный лор»: когда бюджет ({budget} токенов) кончается, первыми срезаются книги персонажа.',
        'm5.f.stripsTagsPrompt':
            'Регекс «{name}» ({type}) вырезает теги BunnyMo вроде <SPECIES:ELF> из исходящего промпта: теги из чата не доходят ни до модели, ни до сканирования лора, и паки по ним не срабатывают.',
        'm5.f.stripsTagsStored':
            'Регекс «{name}» ({type}) вырезает теги BunnyMo вроде <SPECIES:ELF> из сообщений ещё до сохранения — теги пропадают насовсем.',
        'm5.f.breaksJson':
            'Регекс «{name}» ({type}) правит ответы ИИ до сохранения и ломает JSON — например, блок трекера DES: {example}',
        'm5.f.removesJson':
            'Регекс «{name}» ({type}) вырезает JSON трекера DES из ответов ИИ ещё до того, как его прочтёт DES.',
        'm5.f.breaksMarkers':
            'Регекс «{name}» ({type}) правит ответы ИИ до сохранения и портит маркеры картинок NAI Studio.',
        'm5.f.regexDuplicate':
            'У регексов «{a}» и «{b}» одинаковые шаблон и замена (копий: {count}) — одна и та же работа делается дважды.',
        'm5.f.regexConflict':
            'Регексы «{a}» и «{b}» ищут одно и то же, но заменяют по-разному (всего: {count}): «{a}» срабатывает первым, и «{b}» уже нечего найти.',
        'm5.f.regexDead':
            'Регекс «{name}» ({type}) не срабатывал в этом чате (проверено сообщений: {count}). В других чатах он может быть нужен.',
        'm5.f.regexInvalid': 'Шаблон регекса «{name}» ({type}) не компилируется, поэтому регекс не работает вовсе.',
        'm5.f.regexNotAllowed.preset':
            'Регексы пресета не разрешены в ST и не работают ({count}: {sample}). Если они нужны — разреши их в расширении Regex.',
        'm5.f.regexNotAllowed.scoped':
            'Регексы персонажа не разрешены в ST и не работают ({count}: {sample}). Если они нужны — разреши их в расширении Regex.',
        'm5.f.regexNotAllowed.global': 'Глобальные регексы не работают ({count}: {sample}).',
        'm5.f.regexWorldInfoNotPrompt':
            'Регекс «{name}» ({type}) стоит на «лор», но без флажка «только промпт»: к лору ST применяет только такие регексы, так что там он ничего не делает.',

        'm5.enableRule': 'Включить правило',
        'm5.ruleHandles': 'Исправляется правилом на лету',
        'm5.ruleWaits': 'Правило включено и заработает после мастера первого запуска',
        'm5.ruleUnavailable': 'Правило включено, но сейчас не может работать: {missing}',
        'm5.rulePackPending': 'Правило один раз спросит, какую версию оставить, а пока работают обе',
        'm5.rulePackKeepsAll': 'По твоему выбору оставлены обе версии (поменять — во вкладке «Правила»)',
        'm5.ruleTitle': 'Правило: {rule}',
        'm5.ruleMissing': 'Модуль «Правила» выключен: включить правила из находок нельзя.',
        'm5.ruleLater': 'Правило появится на следующих этапах',
        'm5.enableRuleTitle': 'Включить правило «{rule}»',
        'm5.enableRuleDescription': 'Предложение доктора: {finding}',
        'm5.enableRuleDone': 'Правило «{rule}» включено.',
        'm5.enableRuleQueued': 'Предложение включить «{rule}» ждёт во «Входящих».',
        'm5.bunnyBook': 'Книга BunnyMo: её файл не правится',
        'm5.openBook': 'Открыть «{book}»',
        'm5.showRegex': 'Показать в списке',
        'm5.fixFile': 'Исправить в файле',
        'm5.fixFile.hint': 'Сначала покажет изменения и спросит; прежние значения остаются в журнале.',
        'm5.fixFile.title.role': 'Роль assistant → system в «{book}»',
        'm5.fixFile.title.scanDepth': 'Общая глубина сканирования для архива в «{book}»',
        'm5.fixFile.title.localizer': 'Починить ключи Localizer в «{book}»',
        'm5.fixFile.title.cyrillic': 'Кириллические ключи с границей слева в «{book}»',
        'm5.fixFile.title.other': 'Исправить «{book}»',
        'm5.fixFile.description':
            'Записей к изменению в «{book}»: {count}. Книга сохраняется сразу; прежние значения остаются в журнале, и отмена возвращает их.',
        'm5.fixFile.more': '…и ещё {count}',
        'm5.fixFile.globalDepth': 'общая',
        'm5.fixFile.marker': 'отметка Localizer',
        'm5.fixFile.done': 'Исправлено в «{book}»: {count}.',
        'm5.fixFile.queued': 'Исправление «{book}» ждёт во «Входящих».',
        'm5.fixFile.none': 'В «{book}» уже нечего исправлять — проверь заново.',
        'm5.fixFile.unavailable': 'Этот SillyTavern не даёт расширениям сохранять лорбуки.',
        'm5.fixFile.failed.missing': 'Книги «{book}» или её записи больше нет.',
        'm5.fixFile.failed.stale': 'Запись в «{book}» изменилась после проверки — проверь заново.',
        'm5.fixFile.failed.protected': '«{book}» — книга BunnyMo, её файл не правится.',
        'm5.regexFix.enable': 'Включить',
        'm5.regexFix.disable': 'Выключить',
        'm5.regexFix.delete': 'Удалить',
        'm5.regexFix.disableNamed': 'Выключить «{name}»',
        'm5.regexFix.deleteCopy': 'Удалить копию «{name}»',
        'm5.regexFix.deadNote': 'В других чатах он может быть нужен — поэтому только выключение, без удаления.',
        'm5.regexFix.title.enable': 'Включить регекс «{name}» ({type})',
        'm5.regexFix.title.disable': 'Выключить регекс «{name}» ({type})',
        'm5.regexFix.title.delete': 'Удалить регекс «{name}» ({type})',
        'm5.regexFix.description.enable': 'Регекс «{name}» снова начнёт работать.',
        'm5.regexFix.description.disable':
            'Регекс «{name}» перестанет работать, но останется в списке — его можно включить снова.',
        'm5.regexFix.description.delete':
            'Регекс «{name}» уберётся из списка. В журнале остаётся копия, и отмена вернёт его на место.',
        'm5.regexFix.presetFile': 'Этот регекс хранится в пресете — сохранится файл пресета.',
        'm5.regexFix.done.enable': 'Регекс «{name}» включён.',
        'm5.regexFix.done.disable': 'Регекс «{name}» выключен.',
        'm5.regexFix.done.delete': 'Регекс «{name}» удалён.',
        'm5.regexFix.queued': 'Изменение регекса «{name}» ждёт во «Входящих».',
        'm5.regexFix.notFound': 'Регекса «{name}» больше нет (или он теперь у другого персонажа или пресета).',

        'm5.books.title': 'Активные книги',
        'm5.books.book': 'Книга',
        'm5.books.entries': 'Записей',
        'm5.books.chars': 'Символов',
        'm5.books.links': 'Связей',
        'm5.books.depth': 'Длиннейшая цепочка',
        'm5.books.role': 'Роль',
        'm5.books.core': 'ядро BunnyMo',
        'm5.books.pack': 'пак BunnyMo',

        'm5.regex.title': 'Регексы',
        'm5.regex.empty': 'Регексов нет.',
        'm5.regex.extensionOff': 'Расширение Regex выключено в ST — ни один регекс не работает.',
        'm5.regex.name': 'Название',
        'm5.regex.type': 'Где задан',
        'm5.regex.owner': 'Чей',
        'm5.regex.where': 'К чему',
        'm5.regex.mode': 'Режим',
        'm5.regex.depth': 'Глубина',
        'm5.regex.state': 'Состояние',
        'm5.regex.actions': 'Действия',
        'm5.regex.unnamed': '(без названия)',
        'm5.regexType.global': 'глобальный',
        'm5.regexType.scoped': 'персонажа',
        'm5.regexType.preset': 'из пресета',
        'm5.place.0': 'Показ (устар.)',
        'm5.place.1': 'Ввод',
        'm5.place.2': 'Ответ ИИ',
        'm5.place.3': 'Команды',
        'm5.place.5': 'Лор',
        'm5.place.6': 'Рассуждения',
        'm5.mode.display': 'Только показ',
        'm5.mode.prompt': 'Только промпт',
        'm5.mode.displayAndPrompt': 'Показ и промпт',
        'm5.mode.edit': 'Сохраняемый текст',
        'm5.state.on': 'Вкл.',
        'm5.state.off': 'Выкл.',
        'm5.state.notAllowed': 'Не разрешён',
        'm5.owner.des': 'DES',
        'm5.owner.marinara': 'Marinara',
        'm5.owner.rpgCompanion': 'RPG Companion',
        'm5.owner.horae': 'Horae',
        'm5.owner.rm': 'пакет [RM]',
        'm5.owner.user': 'Твой',
        'm5.owner.unknown': 'Неизвестно',
        'm5.depthAny': 'любая',

        'm5.bench.title': 'Испытание',
        'm5.bench.hint':
            'Прогоняет выбранный регекс через движок ST на образце — даже выключенный. Ничего не сохраняется.',
        'm5.bench.script': 'Регекс',
        'm5.bench.pick': 'Выбери регекс',
        'm5.bench.source': 'Образец',
        'm5.bench.last': 'Последние сообщения',
        'm5.bench.custom': 'Свой текст',
        'm5.bench.count': 'Сообщений',
        'm5.bench.placeholder': 'Вставь текст для проверки…',
        'm5.bench.run': 'Испытать',
        'm5.bench.try': 'Испытать',
        'm5.bench.noEngine': 'Движок регексов ST недоступен — испытание выключено.',
        'm5.bench.noMessages': 'В этом чате нет подходящих сообщений.',
        'm5.bench.message': 'Сообщение №{index}',
        'm5.bench.customLabel': 'Твой текст',
        'm5.bench.unchanged': 'Без изменений: регекс ничего не нашёл.',
        'm5.bench.failed': 'Регекс не удалось прогнать на этом образце.',
    },
};
