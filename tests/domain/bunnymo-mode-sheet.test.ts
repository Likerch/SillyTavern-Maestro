import { describe, expect, it } from 'vitest';
import { groupOfCategory, parseSheet, rebuildSheet, sheetDraftOf } from '../../src/domain/bunnymo-mode-sheet';
import type { SheetDraft } from '../../src/domain/bunnymo-mode-sheet';
import { ATSU_CONTENT, MIRA_CONTENT } from '../features/bunnymoMode/fixtures';

/** The fullsheet layout: prose sections inside the block (BunnyMo core #2 TAG SYNTHESIS). */
const FULLSHEET =
    '<BunnymoTags><Name:Lyra>, <GENRE:ROMANCE> <PHYSICAL> <SPECIES:HUMAN>, <AGE:25>,</PHYSICAL> <PERSONALITY><Dere:Dandere>, <INFP-H>, <TRAIT:SHY>, </PERSONALITY> <HEALTH><BSM:GAD>,</HEALTH> \n\n<Genre> This story uses <GENRE:ROMANCE> first. </Genre>\n<MentalHealth> Lyra carries <BSM:GAD> since school. </MentalHealth>\n<Linguistics> Lyra uses <LING:SOFT>. </linguistics> \n\n</BunnymoTags>';

/** CK's tag wrapper around an archive (index.js wrapLorebookEntries). */
const WRAPPED = `<BunnymoTags:Atsu Character Archive>\n${ATSU_CONTENT}\n</BunnymoTags:Atsu Character Archive>`;

function draftOf(content: string): SheetDraft {
    return sheetDraftOf(parseSheet(content));
}

function rebuilt(
    content: string,
    change: (draft: SheetDraft & { tags: { key: string; value: string }[] }) => void,
): string {
    const draft = draftOf(content) as SheetDraft & { tags: { key: string; value: string }[] };
    change(draft);
    const result = rebuildSheet(content, draft);
    if (!result.ok) throw new Error(result.error);
    return result.content;
}

describe('parseSheet', () => {
    it('reads the Baby Bunny layout: name, tags, MBTI, groups, Linguistics after the block', () => {
        const parsed = parseSheet(ATSU_CONTENT);
        expect(parsed.name).toBe('Atsu_Ibn_Oba_Al-Masri');
        expect(parsed.blocks).toBe(1);
        expect(parsed.tags.map((tag) => `${tag.key}:${tag.value}`)).toEqual([
            'GENRE:FANTASY',
            'SPECIES:HUMAN',
            'GENDER:MALE',
            'BUILD:Muscular',
            'BUILD:Tall',
            'SKIN:FAIR',
            'HAIR:BLACK',
            'STYLE:ANCIENT_EGYPTIAN_ROYALTY',
            'Dere:Sadodere',
            'Dere:Oujidere',
            'TRAIT:CRUEL',
            'TRAIT:INTELLIGENT',
            'TRAIT:POWERFUL',
            'ATTACHMENT:FEARFUL_AVOIDANT',
            'CONFLICT:COMPETITIVE',
            'BOUNDARIES:RIGID',
            'FLIRTING:AGGRESSIVE',
            'ORIENTATION:PANSEXUAL',
            'POWER:DOMINANT',
            'CHEMISTRY:ANTAGONISTIC',
            'JEALOUSY:POSSESSIVE',
        ]);
        expect(parsed.mbti.map((item) => `${item.type}-${item.variant}`)).toEqual(['ENTJ-U']);
        expect(parsed.groups.map((group) => [group.name, group.close !== null])).toEqual([
            ['PHYSICAL', true],
            ['PERSONALITY', true],
            ['NSFW', true],
        ]);
        expect(parsed.linguistics?.text).toBe(
            ' Character uses <LING:COMMANDING> as his primary mode of speech, asserting authority and control. ',
        );
        expect(parsed.linguistics?.inBlock).toBe(false);
        expect(parsed.sections).toEqual([]);
    });

    it('keeps untitled prose and Cyrillic names', () => {
        const parsed = parseSheet(MIRA_CONTENT);
        expect(parsed.name).toBe('Мира');
        expect(parsed.sections.map((section) => [section.title, section.text])).toEqual([
            ['', 'She keeps a diary in Elvish.'],
        ]);
    });

    it('reads the fullsheet layout with prose inside the block', () => {
        const parsed = parseSheet(FULLSHEET);
        expect(parsed.tags.map((tag) => `${tag.key}:${tag.value}`)).toEqual([
            'GENRE:ROMANCE',
            'SPECIES:HUMAN',
            'AGE:25',
            'Dere:Dandere',
            'TRAIT:SHY',
            'BSM:GAD',
        ]);
        expect(parsed.sections.map((section) => [section.title, section.inBlock])).toEqual([
            ['Genre', true],
            ['MentalHealth', true],
        ]);
        expect(parsed.linguistics?.inBlock).toBe(true);
        expect(parsed.mbti[0]).toMatchObject({ type: 'INFP', variant: 'H' });
    });

    it('ignores CK entry wrappers and reports several blocks', () => {
        const parsed = parseSheet(WRAPPED);
        expect(parsed.name).toBe('Atsu_Ibn_Oba_Al-Masri');
        expect(parsed.sections).toEqual([]);
        const two = parseSheet(`${ATSU_CONTENT}\n<BunnymoTags><Name:Other>, <TRAIT:KIND></BunnymoTags>`);
        expect(two.blocks).toBe(2);
        expect(two.sections).toEqual([]);
        expect(parseSheet('plain text').block).toBeNull();
        expect(parseSheet('').sections).toEqual([]);
    });

    it('maps categories to their group wrappers', () => {
        expect(groupOfCategory('kink')).toBe('NSFW');
        expect(groupOfCategory('MBTI')).toBe('PERSONALITY');
        expect(groupOfCategory('GENRE')).toBeUndefined();
    });
});

describe('rebuildSheet', () => {
    it('leaves the text byte-identical when nothing changed', () => {
        for (const content of [ATSU_CONTENT, MIRA_CONTENT, FULLSHEET, WRAPPED]) {
            const result = rebuildSheet(content, draftOf(content));
            expect(result).toEqual({ ok: true, content, changed: false });
        }
    });

    it('replaces a value in place and keeps everything else', () => {
        const next = rebuilt(ATSU_CONTENT, (draft) => {
            draft.tags[10] = { key: 'TRAIT', value: 'MERCIFUL' };
        });
        expect(next).toBe(ATSU_CONTENT.replace('<TRAIT:CRUEL>', '<TRAIT:MERCIFUL>'));
    });

    it('removes tags with their separator', () => {
        const next = rebuilt(ATSU_CONTENT, (draft) => {
            draft.tags = draft.tags.filter((tag) => tag.value !== 'INTELLIGENT' && tag.value !== 'AGGRESSIVE');
        });
        expect(next).toBe(ATSU_CONTENT.replace('<TRAIT:INTELLIGENT>, ', '').replace('<FLIRTING:AGGRESSIVE>, ', ''));
        const genre = rebuilt(ATSU_CONTENT, (draft) => {
            draft.tags.shift();
        });
        expect(genre).toBe(ATSU_CONTENT.replace('<GENRE:FANTASY> ', ''));
    });

    it('inserts new tags after their category, else into their group, else after the previous tag', () => {
        const next = rebuilt(ATSU_CONTENT, (draft) => {
            draft.tags.push({ key: 'TRAIT', value: 'LOYAL' });
            draft.tags.push({ key: 'KINK', value: 'PRAISE' });
            draft.tags.push({ key: 'FOO', value: 'BAR' });
        });
        expect(next).toBe(
            ATSU_CONTENT.replace('<TRAIT:POWERFUL>', '<TRAIT:POWERFUL>, <TRAIT:LOYAL>')
                .replace('<JEALOUSY:POSSESSIVE>,</NSFW>', '<JEALOUSY:POSSESSIVE>,<KINK:PRAISE>, </NSFW>')
                .replace('<JEALOUSY:POSSESSIVE>,', '<JEALOUSY:POSSESSIVE>, <FOO:BAR>,'),
        );
    });

    it('inserts into the block end when there is nothing to follow', () => {
        const content = '<BunnymoTags><Name:Solo></BunnymoTags>';
        const result = rebuildSheet(content, { name: 'Solo', tags: [{ key: 'TRAIT', value: 'KIND' }], sections: [] });
        expect(result).toEqual({
            ok: true,
            content: '<BunnymoTags><Name:Solo>, <TRAIT:KIND></BunnymoTags>',
            changed: true,
        });
        const spaced = rebuildSheet('<BunnymoTags><Name:Solo>, </BunnymoTags>', {
            name: 'Solo',
            tags: [{ key: 'TRAIT', value: 'KIND' }],
            sections: [],
        });
        expect(spaced.ok && spaced.content).toBe('<BunnymoTags><Name:Solo>, <TRAIT:KIND>, </BunnymoTags>');
        const blank = rebuildSheet('<BunnymoTags><Name:Solo> </BunnymoTags>', {
            name: 'Solo',
            tags: [{ key: 'TRAIT', value: 'KIND' }],
            sections: [],
        });
        expect(blank.ok && blank.content).toBe('<BunnymoTags><Name:Solo> <TRAIT:KIND> </BunnymoTags>');
    });

    it('switches MBTI H/U, removes it and adds it', () => {
        const healthy = rebuilt(ATSU_CONTENT, (draft) => {
            draft.mbti = { type: 'ENTJ', variant: 'H' };
        });
        expect(healthy).toBe(ATSU_CONTENT.replace('<ENTJ-U>', '<ENTJ-H>'));
        const none = rebuilt(ATSU_CONTENT, (draft) => {
            delete draft.mbti;
        });
        expect(none).toBe(ATSU_CONTENT.replace('<ENTJ-U>, ', ''));
        const added = rebuilt(none, (draft) => {
            draft.mbti = { type: 'intj', variant: 'U' };
        });
        expect(added).toBe(
            none.replace('<FLIRTING:AGGRESSIVE>, </PERSONALITY>', '<FLIRTING:AGGRESSIVE>, <INTJ-U>, </PERSONALITY>'),
        );
        const solo = rebuildSheet('<BunnymoTags><Name:Solo>, <Dere:Kuudere></BunnymoTags>', {
            name: 'Solo',
            tags: [{ key: 'Dere', value: 'Kuudere' }],
            mbti: { type: 'INTP', variant: 'H' },
            sections: [],
        });
        expect(solo.ok && solo.content).toBe('<BunnymoTags><Name:Solo>, <Dere:Kuudere>, <INTP-H></BunnymoTags>');
    });

    it('edits, removes and adds the Linguistics block', () => {
        const edited = rebuilt(ATSU_CONTENT, (draft) => {
            draft.linguistics = ' Speaks softly. ';
        });
        expect(edited).toBe(
            ATSU_CONTENT.replace(
                ' Character uses <LING:COMMANDING> as his primary mode of speech, asserting authority and control. ',
                ' Speaks softly. ',
            ),
        );
        const removed = rebuilt(ATSU_CONTENT, (draft) => {
            delete draft.linguistics;
        });
        expect(removed).toBe(
            ATSU_CONTENT.slice(0, ATSU_CONTENT.indexOf('</BunnymoTags>') + '</BunnymoTags>'.length) + '\n',
        );
        const added = rebuilt(removed, (draft) => {
            draft.linguistics = 'Uses <LING:BLUNT>.';
        });
        expect(added).toBe(
            removed.replace('</BunnymoTags>', '</BunnymoTags>\n<Linguistics>Uses <LING:BLUNT>.</Linguistics>'),
        );
    });

    it('edits prose sections in place, removes and appends them', () => {
        const edited = rebuilt(FULLSHEET, (draft) => {
            draft.sections = [
                { title: 'Genre', text: ' A slow romance. ' },
                { title: 'MentalHealth', text: '' },
                { title: 'Backstory', text: 'Grew up by the sea.' },
            ];
        });
        expect(edited).toBe(
            FULLSHEET.replace(' This story uses <GENRE:ROMANCE> first. ', ' A slow romance. ')
                .replace('\n<MentalHealth> Lyra carries <BSM:GAD> since school. </MentalHealth>', '')
                .replace('</linguistics>', '</linguistics>\n<Backstory>Grew up by the sea.</Backstory>'),
        );
        const loose = rebuilt(MIRA_CONTENT, (draft) => {
            draft.sections = [{ title: '', text: 'She burned the diary.' }];
        });
        expect(loose).toBe(MIRA_CONTENT.replace('She keeps a diary in Elvish.', 'She burned the diary.'));
        const dropped = rebuilt(MIRA_CONTENT, (draft) => {
            draft.sections = [];
        });
        expect(dropped).toBe(MIRA_CONTENT.replace('\n\nShe keeps a diary in Elvish.', '\n'));
    });

    it('keeps tag edits inside a fullsheet block clear of its prose', () => {
        const next = rebuilt(FULLSHEET, (draft) => {
            draft.tags.push({ key: 'BSM', value: 'PTSD' });
            draft.tags.push({ key: 'GENRE', value: 'DRAMA' });
        });
        expect(next).toBe(
            FULLSHEET.replace('<BSM:GAD>,</HEALTH>', '<BSM:GAD>, <BSM:PTSD>,</HEALTH>').replace(
                '<GENRE:ROMANCE> <PHYSICAL>',
                '<GENRE:ROMANCE>, <GENRE:DRAMA> <PHYSICAL>',
            ),
        );
        expect(parseSheet(next).sections.map((section) => section.text)).toEqual([
            ' This story uses <GENRE:ROMANCE> first. ',
            ' Lyra carries <BSM:GAD> since school. ',
        ]);
    });

    it('works inside CK entry wrappers', () => {
        const next = rebuilt(WRAPPED, (draft) => {
            draft.tags[0] = { key: 'GENRE', value: 'DRAMA' };
        });
        expect(next).toBe(WRAPPED.replace('<GENRE:FANTASY>', '<GENRE:DRAMA>'));
    });

    it('refuses a changed name, several blocks, no block and unwritable tags', () => {
        expect(rebuildSheet(ATSU_CONTENT, { ...draftOf(ATSU_CONTENT), name: 'Atsu' })).toEqual({
            ok: false,
            error: 'name',
        });
        const two = `${ATSU_CONTENT}\n<BunnymoTags><Name:Other></BunnymoTags>`;
        expect(rebuildSheet(two, draftOf(two))).toEqual({ ok: false, error: 'multiBlock' });
        expect(rebuildSheet('plain', { name: '', tags: [], sections: [] })).toEqual({ ok: false, error: 'noBlock' });
        const bad = (tags: { key: string; value: string }[]) =>
            rebuildSheet(ATSU_CONTENT, { ...draftOf(ATSU_CONTENT), tags });
        expect(bad([{ key: 'TRAIT', value: 'a>b' }])).toEqual({ ok: false, error: 'tag' });
        expect(bad([{ key: 'ВИД', value: 'X' }])).toEqual({ ok: false, error: 'tag' });
        expect(bad([{ key: 'TRAIT', value: '  ' }])).toEqual({ ok: false, error: 'tag' });
        expect(rebuildSheet(ATSU_CONTENT, { ...draftOf(ATSU_CONTENT), mbti: { type: 'ABCD', variant: 'H' } })).toEqual({
            ok: false,
            error: 'tag',
        });
    });

    it('aligns prepended tags and key spelling changes', () => {
        const next = rebuilt(ATSU_CONTENT, (draft) => {
            draft.tags.unshift({ key: 'GENRE', value: 'DRAMA' });
            const dere = draft.tags.find((tag) => tag.value === 'Sadodere');
            if (dere) dere.key = 'DERE';
        });
        expect(next).toBe(
            ATSU_CONTENT.replace('<GENRE:FANTASY>', '<GENRE:FANTASY>, <GENRE:DRAMA>').replace(
                '<Dere:Sadodere>',
                '<DERE:Sadodere>',
            ),
        );
    });

    it('edits only the first of several MBTI archetypes and ignores MBTI in prose', () => {
        const content = '<BunnymoTags><Name:Two>, <ENTJ-U>, <INTJ-H>, <Genre> like <ISFP-H> </Genre></BunnymoTags>';
        const parsed = parseSheet(content);
        expect(parsed.mbti.map((item) => item.type)).toEqual(['ENTJ', 'INTJ']);
        const next = rebuildSheet(content, { ...sheetDraftOf(parsed), mbti: { type: 'ENTJ', variant: 'H' } });
        expect(next.ok && next.content).toBe(content.replace('<ENTJ-U>', '<ENTJ-H>'));
    });

    it('places tags without a closed group after the previous tag', () => {
        const content = '<BunnymoTags><Name:Open>, <PHYSICAL> <SPECIES:ELF>, <TRAIT:KIND> </BunnymoTags>';
        const parsed = parseSheet(content);
        expect(parsed.groups).toEqual([{ name: 'PHYSICAL', open: expect.any(Object), close: null }]);
        const next = rebuildSheet(content, {
            ...sheetDraftOf(parsed),
            tags: [
                { key: 'SPECIES', value: 'ELF' },
                { key: 'GENDER', value: 'FEMALE' },
                { key: 'TRAIT', value: 'KIND' },
            ],
        });
        expect(next.ok && next.content).toBe(content.replace('<SPECIES:ELF>', '<SPECIES:ELF>, <GENDER:FEMALE>'));
        const stray = parseSheet('<BunnymoTags><Name:X>, </NSFW> <TRAIT:KIND></BunnymoTags>');
        expect(stray.groups).toEqual([]);
    });

    it('removes extra sections of a title and blank matched ones', () => {
        const content = '<BunnymoTags><Name:S></BunnymoTags>\n<Note>one</Note>\n<Note>two</Note>';
        const parsed = parseSheet(content);
        expect(parsed.sections.map((section) => section.text)).toEqual(['one', 'two']);
        const fewer = rebuildSheet(content, { ...sheetDraftOf(parsed), sections: [{ title: 'Note', text: 'one' }] });
        expect(fewer.ok && fewer.content).toBe('<BunnymoTags><Name:S></BunnymoTags>\n<Note>one</Note>');
        const blank = rebuildSheet(content, {
            ...sheetDraftOf(parsed),
            sections: [
                { title: 'Note', text: '  ' },
                { title: 'Note', text: 'two' },
                { title: 'Empty', text: ' ' },
            ],
        });
        expect(blank.ok && blank.content).toBe('<BunnymoTags><Name:S></BunnymoTags>\n<Note>two</Note>');
        const glued = '<BunnymoTags><Name:S></BunnymoTags><Note>x</Note>';
        const cut = rebuildSheet(glued, { name: 'S', tags: [], sections: [] });
        expect(cut.ok && cut.content).toBe('<BunnymoTags><Name:S></BunnymoTags>');
    });

    it('treats a nameless archive as name ""', () => {
        const content = '<BunnymoTags><TRAIT:KIND></BunnymoTags>';
        expect(draftOf(content).name).toBe('');
        const result = rebuildSheet(content, { name: '', tags: [{ key: 'TRAIT', value: 'BRAVE' }], sections: [] });
        expect(result.ok && result.content).toBe('<BunnymoTags><TRAIT:BRAVE></BunnymoTags>');
    });
});
