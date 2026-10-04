import { describe, expect, it } from 'vitest';
import {
    SPEECH_ASPECTS,
    archiveVoiceFromSheet,
    archiveVoiceOf,
    cleanLinguistics,
    compactSentence,
    linguisticsDigest,
    lingInProse,
    mbtiText,
    quotedWords,
    speechText,
    splitSentences,
    tagLabel,
} from '../../src/domain/voices-speech';

/** A Baby Bunny archive: tag block with the PERSONALITY wrapper, then the Linguistics prose (research §2.2). */
const ANNA = [
    '<BunnymoTags><Name:Anna>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:ELF>, <GENDER:FEMALE> </PHYSICAL>',
    '<PERSONALITY><Dere:Kuudere>, <INFP-H>, <TRAIT:STOIC>, <LING:BLUNT>, <LING:SOFT_SPOKEN> </PERSONALITY></BunnymoTags>',
    '<Linguistics> Character uses <LING:FORMAL> speech with an archaic register. She often trails off mid-sentence when',
    'nervous. Speaks with a faint northern lilt. Calls Kai "little fox" and says "hmph" when annoyed.</linguistics>',
].join('\n');

describe('tag labels and LING tags', () => {
    it('turns tag values into readable labels', () => {
        expect(tagLabel('SOFT_SPOKEN')).toBe('soft spoken');
        expect(tagLabel('  Old-Fashioned ')).toBe('old-fashioned');
    });

    it('finds LING tags used inside prose', () => {
        expect(lingInProse('Uses <LING:COMMANDING> and <ling:Blunt> words, <TRAIT:STOIC>, <LING:COMMANDING>.')).toEqual(
            ['commanding', 'blunt'],
        );
    });

    it('cleans the Linguistics prose: tags to labels, markdown, headers and bullets away', () => {
        const prose = '## Speech\n- **Uses** <LING:FORMAL> words\n- Pauses <b>often</b>\n* `Dry` humour';
        expect(cleanLinguistics(prose)).toBe('Speech. Uses formal words. Pauses often. Dry humour');
        expect(cleanLinguistics('')).toBe('');
    });
});

describe('archive voice', () => {
    it('reads LING tags (block first, then prose), the Linguistics block and MBTI with its variant', () => {
        const voice = archiveVoiceOf(ANNA);
        expect(voice).not.toBeNull();
        expect(voice?.ling).toEqual(['blunt', 'soft spoken', 'formal']);
        expect(voice?.mbti).toEqual({ type: 'INFP', variant: 'H' });
        expect(voice?.linguistics).toContain('Character uses formal speech with an archaic register.');
        expect(voice?.linguistics).not.toContain('<');
    });

    it('takes MBTI from a `<MBTI:…>` tag, with or without the variant, and keeps an unhealthy one', () => {
        expect(archiveVoiceOf('<BunnymoTags><Name:Corvin>, <MBTI:ENTJ-U>, <LING:COMMANDING></BunnymoTags>')).toEqual({
            ling: ['commanding'],
            linguistics: '',
            mbti: { type: 'ENTJ', variant: 'U' },
        });
        expect(archiveVoiceOf('<BunnymoTags><Name:Mira>, <MBTI:istp></BunnymoTags>')?.mbti).toEqual({
            type: 'ISTP',
            variant: null,
        });
        expect(archiveVoiceOf('<BunnymoTags><Name:Mira>, <ESFP-U></BunnymoTags>')?.mbti).toEqual({
            type: 'ESFP',
            variant: 'U',
        });
    });

    it('is null without a tag block', () => {
        expect(archiveVoiceOf('Just a description.')).toBeNull();
        expect(archiveVoiceOf(undefined)).toBeNull();
    });

    it('reads a parsed sheet of M35 (bare archetype wins over a MBTI tag)', () => {
        const voice = archiveVoiceFromSheet({
            tags: [
                { key: 'Ling', value: 'CASUAL' },
                { key: 'MBTI', value: 'ISTJ-U' },
                { key: 'SPEECH', value: 'Mumbles' },
            ],
            mbti: { type: 'enfp', variant: 'H' },
            linguistics: 'Mostly <LING:CASUAL> and <LING:SLANGY>.',
        });
        expect(voice).toEqual({
            ling: ['casual', 'mumbles', 'slangy'],
            linguistics: 'Mostly casual and slangy.',
            mbti: { type: 'ENFP', variant: 'H' },
        });
        expect(archiveVoiceFromSheet({ tags: [{ key: 'MBTI', value: 'ISTJ-U' }] }).mbti).toEqual({
            type: 'ISTJ',
            variant: 'U',
        });
    });
});

describe('Linguistics digest', () => {
    const prose = cleanLinguistics(
        'Character uses <LING:FORMAL> speech with an archaic register. She has a habit of humming. ' +
            'Her eyes are green. Speaks with a faint northern lilt; never shouts. Calls Kai "little fox" and says "hmph".',
    );

    it('splits sentences on ends and semicolons', () => {
        expect(splitSentences('One. Two! Three? Four; five… six')).toEqual([
            'One',
            'Two!',
            'Three?',
            'Four',
            'five…',
            'six',
        ]);
    });

    it('drops the subject phrase of a sentence', () => {
        expect(compactSentence('Character uses commanding speech')).toBe('commanding speech');
        expect(compactSentence('She speaks with a faint northern lilt')).toBe('a faint northern lilt');
        expect(compactSentence('Anna uses Old Speech', ['', 'Anna'])).toBe('old Speech');
        expect(compactSentence('Speaks in riddles')).toBe('riddles');
        expect(compactSentence('She often trails off')).toBe('often trails off');
        expect(compactSentence('She')).toBe('She');
        expect(compactSentence('Anna has a lisp', ['Anna'])).toBe('a lisp');
        expect(compactSentence('NPC jargon everywhere')).toBe('NPC jargon everywhere');
        expect(compactSentence('Kai is called pup')).toBe('Kai is called pup');
    });

    it('finds quoted words in any quote style', () => {
        expect(quotedWords('Says "pup", “dear” and «котик», "pup" again.')).toEqual(['pup', 'dear', 'котик']);
    });

    it('picks one sentence per aspect in the prose order and adds quoted pet words not shown yet', () => {
        const digest = linguisticsDigest(prose, 400, ['Anna']);
        expect(digest).toBe(
            'formal speech with an archaic register; a habit of humming; a faint northern lilt; ' +
                'Calls Kai "little fox" and says "hmph"',
        );
        expect(digest).not.toContain('green');
    });

    it('falls back to the first sentence, adds quotes, and cuts to the limit', () => {
        expect(linguisticsDigest('Her voice is like velvet. Nothing else.', 400)).toBe('Her voice is like velvet');
        expect(linguisticsDigest('Her voice is like velvet. Loves the word "indeed".', 400)).toBe(
            'Her voice is like velvet; says "indeed"',
        );
        expect(linguisticsDigest('Her voice is like velvet. Favourite word: "indeed".', 400)).toBe(
            'Favourite word: "indeed"',
        );
        const short = linguisticsDigest(prose, 40);
        expect(short.length).toBeLessThanOrEqual(41);
        expect(short.endsWith('…')).toBe(true);
        expect(linguisticsDigest(prose, 0)).toBe('');
        expect(linguisticsDigest('   ', 100)).toBe('');
    });

    it('knows Russian aspect words', () => {
        expect(SPEECH_ASPECTS.find((aspect) => aspect.id === 'dialect')?.re.test('Говорит с южным акцентом')).toBe(
            true,
        );
        expect(linguisticsDigest('Она очень вежлива. Говорит с южным акцентом. Любит чай.', 400)).toBe(
            'Она очень вежлива; Говорит с южным акцентом',
        );
    });
});

describe('speech and MBTI text', () => {
    const voice = { ling: ['blunt', 'soft spoken', 'formal', 'curt'], linguistics: 'She often trails off.' };

    it('joins LING labels and the digest; labels only at 0 characters; at most N labels', () => {
        expect(speechText(voice, { proseChars: 200 })).toBe('blunt, soft spoken, formal, curt; often trails off');
        expect(speechText(voice, { proseChars: 0 })).toBe('blunt, soft spoken, formal, curt');
        expect(speechText(voice, { proseChars: 0, maxTags: 2 })).toBe('blunt, soft spoken');
        expect(speechText({ ling: [], linguistics: 'She often trails off.' }, { proseChars: 200 })).toBe(
            'often trails off',
        );
        expect(speechText(null, { proseChars: 200 })).toBe('');
    });

    it('writes the archetype with its variant and the state now', () => {
        expect(mbtiText({ type: 'INFP', variant: 'H' }, 'guarded')).toBe('INFP-H (healthy; now: guarded)');
        expect(mbtiText({ type: 'ENTJ', variant: 'U' })).toBe('ENTJ-U (unhealthy)');
        expect(mbtiText({ type: 'ISTP', variant: null }, '  tense  ')).toBe('ISTP (now: tense)');
        expect(mbtiText({ type: 'ISTP', variant: null })).toBe('ISTP');
        expect(mbtiText({ type: 'ISTP', variant: 'H' }, 'a'.repeat(100), 10)).toBe(
            `ISTP-H (healthy; now: ${'a'.repeat(10)}…)`,
        );
        expect(mbtiText({ type: 'ISTP', variant: 'H' }, 'tense', 0)).toBe('ISTP-H (healthy)');
        expect(mbtiText(null, 'tense')).toBe('');
    });
});
