import { describe, expect, it } from 'vitest';
import { archiveTags, isCharacterArchive } from '../../src/domain/bunnymo';
import type { BunnyMoEntryLike } from '../../src/domain/bunnymo';
import { parseSheet } from '../../src/domain/bunnymo-mode-sheet';
import {
    ARCHIVE_ENTRY_FIELDS,
    FREE_CATEGORIES,
    MAX_ARCHIVE_TAGS,
    archiveEntry,
    archiveKeys,
    archiveSchema,
    archiveTitle,
    archiveVocabularyOf,
    buildArchiveContent,
    buildArchiveMessages,
    formatArchiveTags,
    isEmptyVocabulary,
    parseArchiveAnswer,
    readJsonObject,
    vocabularyLines,
} from '../../src/domain/dossier-archive';
import type { ArchiveDictionaryTag, ArchiveVocabulary } from '../../src/domain/dossier-archive';
import { archiveName } from '../../src/domain/sheet-context';

const pull = [{ kind: 'pull' }];
const info = [{ kind: 'info' }];

function tag(category: string, value: string | null, entries: { kind: string }[] = pull): ArchiveDictionaryTag {
    return { tag: value === null ? `<${category}>` : `<${category}:${value}>`, category, value, entries };
}

const DICTIONARY = {
    tags: [
        tag('SPECIES', 'HUMAN'),
        tag('SPECIES', 'ELF'),
        tag('DERE', 'KUUDERE'),
        tag('DERE', 'TSUNDERE'),
        tag('TRAIT', 'STOIC'),
        tag('TRAIT', 'LOYAL'),
        tag('GENRE', 'FANTASY'),
        tag('LING', 'BLUNT'),
        tag('BSM', 'PTSD'),
        tag('DOMAIN', 'FIRE'),
        tag('MBTI', 'INFP-H'),
        tag('MBTI', 'INTJ-U'),
        tag('MBTI', 'ENFP-U', info),
        tag('PTSD', null),
        tag('SECTION', 'SPECIES', pull),
        tag('GENDER', 'FEMALE', []),
        tag('GENDER', 'bad value', []),
        tag('KINK', 'ANY', []),
        tag('TRAIT', 'SHY', info),
        tag('bad key', 'X'),
    ],
};

function vocabulary(): ArchiveVocabulary {
    return archiveVocabularyOf(DICTIONARY);
}

describe('archive vocabulary', () => {
    it('keeps values with a loaded pack entry, MBTI archetypes and the informational categories', () => {
        const vocab = vocabulary();
        expect([...vocab.strict.keys()]).toEqual(['BSM', 'DERE', 'DOMAIN', 'GENRE', 'LING', 'SPECIES', 'TRAIT']);
        expect(vocab.strict.get('SPECIES')).toEqual(['ELF', 'HUMAN']);
        expect(vocab.strict.get('TRAIT')).toEqual(['LOYAL', 'STOIC']);
        expect(vocab.mbti).toEqual(['INFP-H', 'INTJ-U']);
        expect(vocab.free.get('GENDER')).toEqual(['FEMALE']);
        expect(vocab.free.has('KINK')).toBe(false);
        expect([...vocab.free.keys()]).toEqual(FREE_CATEGORIES.filter((category) => category !== 'KINK'));
        expect(isEmptyVocabulary(vocab)).toBe(false);
    });

    it('turns an informational category into a strict one when a pack pulls lore on it', () => {
        const vocab = archiveVocabularyOf({ tags: [tag('GENDER', 'MALE')] });
        expect(vocab.strict.get('GENDER')).toEqual(['MALE']);
        expect(vocab.free.has('GENDER')).toBe(false);
    });

    it('is empty without packs', () => {
        const vocab = archiveVocabularyOf({ tags: [tag('GENDER', 'FEMALE', [])] });
        expect(isEmptyVocabulary(vocab)).toBe(true);
    });
});

describe('archive prompt and schema', () => {
    it('lists the allowed tags for the model', () => {
        const lines = vocabularyLines(vocabulary());
        expect(lines).toContain('SPECIES: ELF, HUMAN');
        expect(lines).toContain('GENDER (any value): e.g. FEMALE');
        expect(lines).toContain('AGE (any value)');
        expect(lines.at(-1)).toBe('mbti: INFP-H, INTJ-U');
        const messages = buildArchiveMessages(
            { name: 'Мира', aliases: ['Мира', 'Mira'], known: 'Scene tracker appearance: silver hair' },
            vocabulary(),
        );
        expect(messages[0]?.role).toBe('system');
        expect(messages[0]?.content).toContain('never write Russian');
        expect(messages[1]?.content).toContain('Character: Мира (also: Mira)');
        expect(messages[1]?.content).toContain('silver hair');
        expect(messages[1]?.content).toContain('SPECIES: ELF, HUMAN');
        const bare = buildArchiveMessages({ name: 'Мира', aliases: [], known: '  ' }, vocabulary());
        expect(bare[1]?.content).toContain('Character: Мира\n');
        expect(bare[1]?.content).toContain('(only the name)');
    });

    it('lists categories with their values in a strict schema while it is small', () => {
        const schema = archiveSchema(vocabulary()) as { properties: Record<string, Record<string, unknown>> };
        const items = schema.properties.tags?.items as { anyOf: { properties: Record<string, unknown> }[] };
        expect(items.anyOf[0]?.properties).toEqual({
            category: { type: 'string', enum: ['BSM'] },
            value: { type: 'string', enum: ['PTSD'] },
        });
        expect(items.anyOf.some((item) => JSON.stringify(item).includes('"GENDER"'))).toBe(true);
        expect(schema.properties.mbti).toEqual({ type: 'string', enum: ['', 'INFP-H', 'INTJ-U'] });
        expect(schema.properties.tags?.maxItems).toBe(MAX_ARCHIVE_TAGS);
    });

    it('keeps only the categories in the schema when the values are too many', () => {
        const schema = archiveSchema(vocabulary(), 3) as { properties: Record<string, Record<string, unknown>> };
        const items = schema.properties.tags?.items as { properties: Record<string, { enum?: string[] }> };
        expect(items.properties.category?.enum).toContain('SPECIES');
        expect(items.properties.category?.enum).toContain('GENDER');
        expect(items.properties.value?.enum).toBeUndefined();
        const empty = archiveSchema({ strict: new Map(), free: new Map(), mbti: [] }) as {
            properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }> } }>;
        };
        expect(empty.properties.tags?.items?.properties.category?.enum).toEqual(['']);
    });
});

describe('the model answer', () => {
    it('reads JSON from objects, fenced text and chatter', () => {
        expect(readJsonObject({ a: 1 })).toEqual({ a: 1 });
        expect(readJsonObject('Sure!\n```json\n{"tags": []}\n```')).toEqual({ tags: [] });
        expect(readJsonObject('no json')).toBeNull();
        expect(readJsonObject('{broken')).toBeNull();
        expect(readJsonObject('{"a": }')).toBeNull();
        expect(readJsonObject(42)).toBeNull();
        expect(readJsonObject(['x'])).toBeNull();
    });

    it('keeps dictionary tags and rejects everything else with a reason', () => {
        const answer = parseArchiveAnswer(
            {
                tags: [
                    { category: 'species', value: 'elf' },
                    { category: 'SPECIES', value: 'DRAGON' },
                    { category: 'TRAIT', value: 'стойкий' },
                    { category: 'SPECIES', value: 'BLANK' },
                    { category: 'TRAIT', value: 'STOIC → WARM' },
                    { category: 'TRAIT', value: '40%' },
                    { category: 'FOO', value: 'BAR' },
                    { category: 'GENDER', value: 'female' },
                    { category: 'GENDER', value: 'male' },
                    { category: 'AGE', value: 'very old!!' },
                    { category: 'SPE CIES', value: 'ELF' },
                    { category: 'TRAIT', value: '' },
                    '<TRAIT:STOIC>',
                    '<TRAIT:STOIC>',
                    'DERE: kuudere',
                    { category: 'DERE', value: 'TSUNDERE' },
                    '<INFP-H>',
                    'hello',
                    { category: 'MBTI', value: 'INTJ-U' },
                    { category: 'MBTI', value: 'XXXX' },
                    { category: 'mbti', value: 'ENFP-U' },
                    7,
                ],
                mbti: 'ISTJ-H',
                linguistics: ' Speaks <softly>,\n  in short sentences. ',
            },
            vocabulary(),
        );
        expect(answer).not.toBeNull();
        expect(answer?.tags).toEqual([
            { category: 'SPECIES', value: 'ELF' },
            { category: 'GENDER', value: 'FEMALE' },
            { category: 'TRAIT', value: 'STOIC' },
            { category: 'DERE', value: 'KUUDERE' },
        ]);
        expect(answer?.mbti).toEqual({ type: 'INFP', variant: 'H' });
        expect(answer?.linguistics).toBe('Speaks softly, in short sentences.');
        expect(answer?.rejected).toEqual([
            { tag: '<SPECIES:DRAGON>', reason: 'unknownValue' },
            { tag: '<TRAIT:стойкий>', reason: 'cyrillic' },
            { tag: '<SPECIES:BLANK>', reason: 'placeholder' },
            { tag: '<TRAIT:STOIC → WARM>', reason: 'transitional' },
            { tag: '<TRAIT:40%>', reason: 'transitional' },
            { tag: '<FOO:BAR>', reason: 'unknownCategory' },
            { tag: '<GENDER:male>', reason: 'duplicate' },
            { tag: '<AGE:very old!!>', reason: 'malformed' },
            { tag: '<SPE CIES:ELF>', reason: 'malformed' },
            { tag: '<TRAIT:>', reason: 'malformed' },
            { tag: '<TRAIT:STOIC>', reason: 'duplicate' },
            { tag: '<DERE:TSUNDERE>', reason: 'duplicate' },
            { tag: 'hello', reason: 'malformed' },
            { tag: '<MBTI:INTJ-U>', reason: 'duplicate' },
            { tag: '<MBTI:XXXX>', reason: 'malformed' },
            { tag: '<mbti:ENFP-U>', reason: 'unknownValue' },
            { tag: 'ISTJ-H', reason: 'unknownValue' },
        ]);
    });

    it('takes MBTI from the field, drops Russian prose and caps the tags', () => {
        const many = Array.from({ length: MAX_ARCHIVE_TAGS + 2 }, (_, index) => ({
            category: 'STYLE',
            value: `S${index}`,
        }));
        const answer = parseArchiveAnswer(
            JSON.stringify({ tags: many, mbti: 'intj-u', linguistics: 'Говорит тихо.' }),
            vocabulary(),
        );
        expect(answer?.tags).toHaveLength(MAX_ARCHIVE_TAGS);
        expect(answer?.rejected.map((item) => item.reason)).toEqual(['duplicate', 'duplicate']);
        expect(answer?.mbti).toEqual({ type: 'INTJ', variant: 'U' });
        expect(answer?.linguistics).toBe('');
        expect(parseArchiveAnswer('nothing', vocabulary())).toBeNull();
        expect(parseArchiveAnswer({ tags: 'x' }, vocabulary())).toEqual({
            tags: [],
            mbti: null,
            linguistics: '',
            rejected: [],
        });
    });

    it('formats tags the way an archive writes them', () => {
        expect(
            formatArchiveTags(
                [
                    { category: 'SPECIES', value: 'ELF' },
                    { category: 'TRAIT', value: 'STOIC' },
                ],
                { type: 'INFP', variant: 'H' },
            ),
        ).toEqual(['<SPECIES:ELF>', '<TRAIT:STOIC>', '<INFP-H>']);
        expect(formatArchiveTags([], null)).toEqual([]);
    });
});

describe('the archive entry', () => {
    it('writes one Baby Bunny block with groups, MBTI after DERE and LING in the Linguistics block', () => {
        const content = buildArchiveContent({
            name: 'Мира <Волкова>',
            tags: [
                { category: 'TRAIT', value: 'STOIC' },
                { category: 'GENDER', value: 'FEMALE' },
                { category: 'SPECIES', value: 'HUMAN' },
                { category: 'GENRE', value: 'FANTASY' },
                { category: 'DERE', value: 'KUUDERE' },
                { category: 'ORIENTATION', value: 'BISEXUAL' },
                { category: 'BSM', value: 'PTSD' },
                { category: 'DOMAIN', value: 'FIRE' },
                { category: 'LING', value: 'BLUNT' },
            ],
            mbti: { type: 'INTJ', variant: 'U' },
            linguistics: 'Short, clipped sentences.',
        });
        expect(content).toBe(
            '<BunnymoTags><Name:Мира Волкова>, <GENRE:FANTASY> <PHYSICAL><SPECIES:HUMAN>, <GENDER:FEMALE></PHYSICAL> ' +
                '<PERSONALITY><DERE:KUUDERE>, <INTJ-U>, <TRAIT:STOIC></PERSONALITY> <NSFW><ORIENTATION:BISEXUAL></NSFW> ' +
                '<HEALTH><BSM:PTSD></HEALTH> <DOMAIN:FIRE></BunnymoTags>\n' +
                '<Linguistics>Character uses <LING:BLUNT>. Short, clipped sentences.</Linguistics>',
        );
        const parsed = parseSheet(content);
        expect(parsed.blocks).toBe(1);
        expect(parsed.name).toBe('Мира Волкова');
        expect(parsed.mbti[0]).toMatchObject({ type: 'INTJ', variant: 'U' });
        expect(parsed.linguistics?.text).toContain('<LING:BLUNT>');
        expect(parsed.groups.map((group) => group.name)).toEqual(['PHYSICAL', 'PERSONALITY', 'NSFW', 'HEALTH']);
        const tags = archiveTags({ content });
        expect(tags.name).toBe('Мира Волкова');
        expect(tags.tags).toContain('<INTJ-U>');
        expect(tags.tags).toContain('<SPECIES:HUMAN>');
    });

    it('leaves out empty groups and the Linguistics block when there is nothing for them', () => {
        expect(buildArchiveContent({ name: 'Мира', tags: [], mbti: { type: 'INFP', variant: 'H' } })).toBe(
            '<BunnymoTags><Name:Мира> <PERSONALITY><INFP-H></PERSONALITY></BunnymoTags>',
        );
        expect(
            buildArchiveContent({
                name: 'Мира',
                tags: [{ category: 'GENRE', value: 'NOIR' }],
                mbti: null,
                linguistics: 'Quiet.',
            }),
        ).toBe('<BunnymoTags><Name:Мира>, <GENRE:NOIR></BunnymoTags>\n<Linguistics>Quiet.</Linguistics>');
    });

    it('builds a complete entry with the Baby Bunny flags and system role', () => {
        const content = buildArchiveContent({
            name: 'Мира',
            tags: [{ category: 'SPECIES', value: 'HUMAN' }],
            mbti: null,
        });
        const entry = archiveEntry(3, { name: 'Мира', keys: archiveKeys('Мира', ['Мира', 'Mira', '/мир/i']), content });
        expect(entry).toMatchObject({
            uid: 3,
            key: ['Мира', 'Mira'],
            keysecondary: [],
            comment: 'Мира Character Archive',
            content,
            position: 4,
            depth: 2,
            role: 0,
            order: 550,
            excludeRecursion: true,
            preventRecursion: false,
            ignoreBudget: true,
            probability: 100,
            useProbability: true,
            scanDepth: null,
            matchWholeWords: null,
            constant: false,
            selective: true,
            disable: false,
        });
        expect(entry.vectorized).toBe(false);
        expect(ARCHIVE_ENTRY_FIELDS.role).toBe(0);
        expect(archiveTitle(' Мира ')).toBe('Мира Character Archive');
        const like: BunnyMoEntryLike = { key: entry.key, comment: entry.comment, content: entry.content };
        expect(isCharacterArchive(like)).toBe(true);
        expect(archiveName(like)).toBe('Мира');
    });
});
