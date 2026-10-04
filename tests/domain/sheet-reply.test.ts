import { describe, expect, it } from 'vitest';
import {
    compareSheetTags,
    looksLikeSheet,
    normalizeTag,
    sheetTagBlocks,
    stripTrackerBlocks,
    trimSheetReply,
} from '../../src/domain/sheet-reply';
import { analyseRequest, buildReply, sheetText } from '../../tools/mock-llm/scenarios.mjs';

const TRACKER =
    '```json\n{\n  "quests": {"main": {"title": "Найти печать"}},\n  "infoBox": {"location": {"value": "Порт"}},\n  "characters": [{"name": "Вера"}]\n}\n```';

const PROSE = [
    'Серебряная Гавань встречает их запахом соли и мокрого камня. Вера поднимает взгляд от карты.',
    '«Если выйдем сейчас, успеем до прилива», — говорит Вера вполголоса.',
].join('\n\n');

const FULLSHEET = [
    '# 🛡️ **Character Title: The Quiet Captain** 🛡️',
    '━━━━━━━━━━━━━━━━━━━━',
    '## SECTION 1/14: 🆔 **Core Identity & Context**',
    '',
    '- **Name:** Вера',
    '- **Age:** 30',
    '',
    'Вера выросла в портовом квартале и рано научилась молчать.',
    '',
    '## SECTION 2/14: 🎭 **Genre & Archetypes**',
    '- **Genre:** fantasy',
    '',
    '# 🎯**TAG SYNTHESIS**🎯',
    '',
    '<BunnymoTags><Name:Вера>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:HUMAN>, <HAIRCOLOR:DARK_BROWN>, </PHYSICAL>',
    '<PERSONALITY><Dere:KUUDERE>, <INTJ-H>, <TRAIT:STOIC>, </PERSONALITY>',
    '<Linguistics> Character uses <LING:BLUNT> as their primary mode of speech,',
    'short and dry, with a habit of whispering when upset. </linguistics>',
    '</BunnymoTags>',
    '',
    '---',
    '',
    '## ✨**ANALYSIS COMPLETE**✨',
    '**🎭 Full Psychological Profile Generated with Advanced Tag Integration**',
    '',
    '*This comprehensive analysis provides deep insight into Вера.*',
    '',
    '---',
].join('\n');

describe('trimSheetReply on the bench mock', () => {
    it('cuts the scene and the tracker the mock adds after !fullsheet', () => {
        const ctx = analyseRequest({
            messages: [
                { role: 'system', content: 'BunnyMo !fullsheet instructions' },
                { role: 'user', content: '!fullsheet Вера' },
            ],
        });
        expect(ctx.wantsSheet).toBe(true);
        const reply = buildReply(ctx).content;
        expect(reply).toContain('```json');
        const result = trimSheetReply(reply);
        expect(result.changed).toBe(true);
        expect(result.isSheet).toBe(true);
        expect(result.trackerBlocks).toBe(1);
        expect(result.text).toBe(sheetText('Вера', ctx));
        expect(result.tail.length).toBeGreaterThan(20);
        expect(result.tail).not.toContain('BunnymoTags');
    });

    it('also handles the mock reply without a tracker', () => {
        const ctx = analyseRequest({ messages: [{ role: 'user', content: '!fullsheet Мартин\n[mock:nojson]' }] });
        const result = trimSheetReply(buildReply(ctx).content);
        expect(result.trackerBlocks).toBe(0);
        expect(result.text).toBe(sheetText('Мартин', ctx));
    });
});

describe('trimSheetReply', () => {
    it('removes a DES tracker block at the start (together mode)', () => {
        const result = trimSheetReply(`${TRACKER}\n\n${FULLSHEET}`);
        expect(result.text).toBe(FULLSHEET);
        expect(result.trackerBlocks).toBe(1);
        expect(result.tail).toBe('');
        const bare = trimSheetReply(`{"infoBox": {"location": {"value": "Порт"}}}\n\n${FULLSHEET}`);
        expect(bare).toMatchObject({ text: FULLSHEET, trackerBlocks: 1, changed: true });
    });

    it('keeps the completion banner, its note and multi-line blocks, and cuts the prose after them', () => {
        const result = trimSheetReply(`${FULLSHEET}\n\n${PROSE}\n\n${TRACKER}`);
        expect(result.text).toBe(FULLSHEET);
        expect(result.tail).toBe(PROSE);
        expect(result.isSheet).toBe(true);
    });

    it('keeps the italic note under a banner when the closing rule is missing', () => {
        const sheet = FULLSHEET.replace(/\n\n---$/, '');
        expect(trimSheetReply(`${sheet}\n\n${PROSE}`).text).toBe(sheet);
    });

    it('cuts after a memsheet banner without a tag block', () => {
        const memsheet = [
            '# 📖 **MEMORY ENTRY: The Harbor Night** 📖',
            '## 🕰️ TEMPORAL DATA',
            '- **When:** late evening',
            '',
            '**✓ MEMORY CATALOGUED - ARCHIVED FOR CONTINUITY**',
            '',
            '*This memory will inform character consistency.*',
        ].join('\n');
        const result = trimSheetReply(`${memsheet}\n\n${PROSE}`);
        expect(result.text).toBe(memsheet);
    });

    it('keeps details blocks and dialogue lines that look like lists', () => {
        const update = [
            '# 🔄 **PSYCHOLOGICAL TAG UPDATE ASSESSMENT** 🔄',
            '<details>',
            '<summary><b>📈 STRENGTHENING</b></summary>',
            '',
            'Tags becoming more prominent: none really',
            '',
            '</details>',
            '**✓ ASSESSMENT COMPLETE - PSYCHOLOGICAL PROFILE UPDATED**',
        ].join('\n');
        const dialogue = '- Ну что, идём? - спросила Вера.';
        const result = trimSheetReply(`${update}\n\n${dialogue}`);
        expect(result.changed).toBe(false);
        expect(result.text).toBe(`${update}\n\n${dialogue}`);
    });

    it('keeps a CK dump and NAI images found after the cut', () => {
        const dump = '<BunnyMoTags>\nВера:\n• TRAIT: stoic\n</BunnyMoTags>';
        const result = trimSheetReply(`${FULLSHEET}\n\n${PROSE}\n[nai:img:42]\n\n${dump}`);
        expect(result.text).toBe(`${FULLSHEET}\n\n[nai:img:42]\n\n${dump}`);
        expect(result.tail).toContain('Серебряная Гавань');
    });

    it('leaves replies that are not sheets alone', () => {
        const result = trimSheetReply(`Вера кивает.\n\n${PROSE}`);
        expect(result).toEqual({
            text: `Вера кивает.\n\n${PROSE}`,
            changed: false,
            isSheet: false,
            trackerBlocks: 0,
            tail: '',
        });
        expect(trimSheetReply(PROSE).changed).toBe(false);
        expect(trimSheetReply('').text).toBe('');
    });

    it('leaves the sheet as is when nothing follows it', () => {
        const result = trimSheetReply(FULLSHEET);
        expect(result).toMatchObject({ text: FULLSHEET, changed: false, isSheet: true });
    });
});

describe('stripTrackerBlocks', () => {
    it('removes only DES tracker blocks and tidies the gap', () => {
        const other = '```json\n{"foo": 1}\n```';
        const code = '```python\nprint({"characters": 1})\n```';
        const text = `Начало\n\n${TRACKER}\n\n\n${TRACKER}\n\n${other}\n\n${code}\n\nКонец`;
        const result = stripTrackerBlocks(text);
        expect(result.removed).toBe(2);
        expect(result.text).toBe(`Начало\n\n${other}\n\n${code}\n\nКонец`);
        expect(stripTrackerBlocks('без блоков')).toEqual({ text: 'без блоков', removed: 0 });
    });
});

describe('looksLikeSheet', () => {
    it('recognises sheets by tag block, banner, numbered sections or tags', () => {
        expect(looksLikeSheet('<BunnymoTags><Name:A>, <TRAIT:X></BunnymoTags>')).toBe(true);
        expect(looksLikeSheet('**✓ PHYSICAL PROFILE COMPLETE**')).toBe(true);
        expect(looksLikeSheet('✓ ПРОФИЛЬ ЗАВЕРШЁН')).toBe(true);
        expect(looksLikeSheet('## SECTION 1/3: a\n## SECTION 2/3: b')).toBe(true);
        expect(looksLikeSheet('<A:1> <B:2> <C:3>')).toBe(true);
        expect(looksLikeSheet('<BunnyMoTags>\nВера:\n• TRAIT: x\n</BunnyMoTags>')).toBe(false);
        expect(looksLikeSheet('Обычный ответ.')).toBe(false);
    });
});

describe('tags', () => {
    it('normalises tags the way CK compares them', () => {
        expect(normalizeTag(' hairColor ', 'dark_brown  hair')).toBe('HAIRCOLOR:DARK BROWN HAIR');
    });

    it('lists tag blocks without CK dumps', () => {
        const text = '<BunnymoTags><Name:A>, <TRAIT:X></BunnymoTags>\n<BunnyMoTags>\nA:\n• TRAIT: x\n</BunnyMoTags>';
        expect(sheetTagBlocks(text)).toEqual(['<Name:A>, <TRAIT:X>']);
        expect(sheetTagBlocks('<BunnymoTags><ENTJ-U></BunnymoTags>')).toEqual(['<ENTJ-U>']);
    });

    it('reports tags lost between the reply and the archive', () => {
        const reply = [
            '**🏷️ MED TAGS:** <MED:ZOLOFT>',
            '<BunnymoTags><Name:Вера>, <SPECIES:HUMAN>, <HAIRCOLOR:DARK_BROWN>, <SKINCOLOR,FAIR>, <INTJ-H>,',
            '<BOUNDARIES:POROUS (WITH Кай)>, <TRAIT:STOIC>, <GENRE:BLANK></BunnymoTags>',
        ].join('\n');
        const archive =
            '<BunnymoTags><Name:Вера>, <SPECIES:HUMAN>, <HAIRCOLOR:Dark Brown>, <INTJ-H>, <TRAIT:LOYAL></BunnymoTags>';
        const report = compareSheetTags(reply, archive);
        expect(report.name).toBe('Вера');
        expect(report.archiveName).toBe('Вера');
        expect(report.reply).toEqual([
            'SPECIES:HUMAN',
            'HAIRCOLOR:DARK BROWN',
            'BOUNDARIES:POROUS (WITH КАЙ)',
            'TRAIT:STOIC',
            'INTJ-H',
        ]);
        expect(report.missing).toEqual(['BOUNDARIES:POROUS (WITH КАЙ)', 'TRAIT:STOIC']);
        expect(report.added).toEqual(['TRAIT:LOYAL']);
        expect(report.outside).toEqual(['MED:ZOLOFT']);
        expect(report.malformed).toEqual(['<SKINCOLOR,FAIR>', '<BOUNDARIES:POROUS (WITH Кай)>']);
        expect(report.ckInvisible).toEqual(['INTJ-H']);
    });

    it('works with an empty archive', () => {
        const report = compareSheetTags('<BunnymoTags><Name:A>, <TRAIT:X></BunnymoTags>', '');
        expect(report.missing).toEqual(['TRAIT:X']);
        expect(report.archiveName).toBeNull();
    });
});
