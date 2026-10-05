import { describe, expect, it } from 'vitest';
import {
    findTopic,
    localText,
    normalizeText,
    plainMarkdown,
    scoreTopic,
    searchDocs,
    slugify,
    snippetOf,
    splitMarkdown,
    stem,
    stems,
    tokenize,
} from '../../src/domain/assistant-docs';
import type { DocTopic } from '../../src/domain/assistant-docs';

const TOPICS: DocTopic[] = [
    {
        id: 'module.director',
        kind: 'module',
        title: { en: 'Scene director', ru: 'Режиссёр сцены' },
        keywords: ['scene type', 'тип сцены', 'flags'],
        body: {
            en: 'Decides the scene type after each turn. Sets one-shot flags for conditional preset blocks.',
            ru: 'Определяет тип сцены после каждого хода. Ставит одноразовые флаги для условных блоков пресета.',
        },
    },
    {
        id: 'module.treasurer',
        kind: 'module',
        title: { en: 'Treasurer', ru: 'Казначей' },
        keywords: ['cost', 'расходы', 'expensive', 'дорогой'],
        body: {
            en: 'What the game costs per turn, session and day, by source.',
            ru: 'Сколько стоит игра: ход, сессия, день — по источникам.',
        },
    },
    {
        id: 'guide.regex',
        kind: 'guide',
        title: { en: 'What does this regex do', ru: 'Что делает этот регекс' },
        keywords: ['regex', 'регекс', 'регулярка'],
        body: {
            en: 'Use regex_list, regex_explain and regex_test.',
            ru: 'Используй regex_list, regex_explain и regex_test. Регексы выполняются по порядку.',
        },
    },
    {
        id: 'changelog.1.4.0',
        kind: 'changelog',
        title: { ru: '1.4.0 — режиссура' },
        body: { ru: 'Режиссёр сцены определяет тип сцены и ставит флаги.' },
    },
];

describe('text helpers', () => {
    it('normalises case and ё', () => {
        expect(normalizeText('ЁЖИК Ёлка')).toBe('ежик елка');
    });

    it('stems Russian and English endings, never below three letters', () => {
        expect(stem('героиня')).toBe(stem('героини'));
        expect(stem('сестра')).toBe(stem('сестру'));
        expect(stem('регексы')).toBe(stem('регексов'));
        expect(stem('regexes')).toBe('regex');
        expect(stem('settings')).toBe(stem('setting'));
        expect(stem('stories')).toBe('story');
        expect(stem('cases')).toBe('case');
        expect(stem('boxes')).toBe('box');
        expect(stem('glass')).toBe('glass');
        expect(stem('classes')).toBe('class');
        expect(stem('ось')).toBe('ось');
        expect(stem('мир')).toBe('мир');
    });

    it('tokenizes letters and digits of any alphabet, drops stop words, keeps dotted runs', () => {
        expect(tokenize('Почему это DES-RU не видит версию 1.8.0?')).toEqual(['des', 'ru', 'видит', 'версию', '1.8.0']);
        expect(stems('the regexes')).toEqual(['regex']);
    });

    it('slugifies headings with transliteration', () => {
        expect(slugify('Что умеет сейчас')).toBe('chto-umeet-seychas');
        expect(slugify('Требования')).toBe('trebovaniya');
        expect(slugify('!!!')).toBe('section');
        expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48);
    });

    it('picks the wanted language, else the other one', () => {
        expect(localText({ en: 'a', ru: 'б' }, 'ru')).toBe('б');
        expect(localText({ ru: 'б' }, 'en')).toBe('б');
        expect(localText({ en: 'a' }, 'ru')).toBe('a');
        expect(localText({}, 'en')).toBe('');
    });

    it('reduces markdown links and emphasis', () => {
        expect(plainMarkdown('See [the plan](docs/plan.md) and **bold** __x__\r\n\n\n\nend')).toBe(
            'See the plan and bold x\n\nend',
        );
    });
});

describe('splitMarkdown', () => {
    const md =
        '# Maestro\n\nIntro text.\n\n## Что умеет сейчас\n\n- one\n\n## 1.8.0 — интерфейс (2026)\n\nNew.\n\n## Что умеет сейчас\n\nAgain.';

    it('makes an intro topic and one topic per ## section', () => {
        const topics = splitMarkdown(md, { prefix: 'readme', kind: 'readme', lang: 'ru' });
        expect(topics.map((topic) => topic.id)).toEqual([
            'readme.intro',
            'readme.chto-umeet-seychas',
            'readme.1.8.0',
            'readme.chto-umeet-seychas-2',
        ]);
        expect(topics[0]!.title.ru).toBe('Maestro');
        expect(topics[0]!.body.ru).toBe('Intro text.');
        expect(topics[2]!.title.ru).toBe('1.8.0 — интерфейс (2026)');
        expect(topics[2]!.kind).toBe('readme');
    });

    it('skips an empty intro', () => {
        const topics = splitMarkdown('## A\n\ntext', { prefix: 'x', kind: 'changelog', lang: 'en' });
        expect(topics).toEqual([{ id: 'x.a', kind: 'changelog', title: { en: 'A' }, body: { en: 'text' } }]);
    });
});

describe('searchDocs', () => {
    it('ranks a title match first, in either language', () => {
        expect(searchDocs(TOPICS, 'scene director', { locale: 'en' })[0]!.id).toBe('module.director');
        expect(searchDocs(TOPICS, 'режиссёр сцены', { locale: 'ru' })[0]!.id).toBe('module.director');
        expect(searchDocs(TOPICS, 'почему ход дорогой', { locale: 'ru' })[0]!.id).toBe('module.treasurer');
    });

    it('matches other word forms through stems and prefixes', () => {
        const hits = searchDocs(TOPICS, 'регексом', { locale: 'ru' });
        expect(hits[0]!.id).toBe('guide.regex');
        expect(hits[0]!.title).toBe('Что делает этот регекс');
        expect(searchDocs(TOPICS, 'regexes', { locale: 'en' })[0]!.id).toBe('guide.regex');
    });

    it('prefers guides and modules to changelog entries on equal relevance and filters by kind', () => {
        const hits = searchDocs(TOPICS, 'тип сцены', { locale: 'ru', limit: 3 });
        expect(hits[0]!.id).toBe('module.director');
        expect(hits.map((hit) => hit.id)).toContain('changelog.1.4.0');
        const changelog = searchDocs(TOPICS, 'тип сцены', { locale: 'ru', kinds: ['changelog'] });
        expect(changelog.map((hit) => hit.id)).toEqual(['changelog.1.4.0']);
    });

    it('gives a snippet in the wanted language and nothing for empty or unknown queries', () => {
        const [hit] = searchDocs(TOPICS, 'флаги', { locale: 'ru', snippetChars: 60 });
        expect(hit!.snippet).toContain('флаги');
        expect(hit!.snippet.length).toBeLessThanOrEqual(60);
        expect(searchDocs(TOPICS, 'the and', { locale: 'en' })).toEqual([]);
        expect(searchDocs(TOPICS, 'zebra', { locale: 'en' })).toEqual([]);
    });

    it('scores coverage and phrases', () => {
        const director = TOPICS[0]!;
        const both = scoreTopic(director, stems('scene flags'), 'scene flags');
        const one = scoreTopic(director, stems('scene zebra'), 'scene zebra');
        expect(both).toBeGreaterThan(one);
        expect(scoreTopic(director, [], '')).toBe(0);
        const phrase = scoreTopic(director, stems('conditional preset'), 'conditional preset');
        const words = scoreTopic(director, stems('preset conditional'), 'preset conditional');
        expect(phrase).toBeGreaterThan(words);
    });
});

describe('findTopic', () => {
    it('finds by id, short id, title, or a clear search hit', () => {
        expect(findTopic(TOPICS, 'module.director', 'en')?.id).toBe('module.director');
        expect(findTopic(TOPICS, 'MODULE.TREASURER', 'en')?.id).toBe('module.treasurer');
        expect(findTopic(TOPICS, 'director', 'en')?.id).toBe('module.director');
        expect(findTopic(TOPICS, 'Казначей', 'ru')?.id).toBe('module.treasurer');
        expect(findTopic(TOPICS, 'what does this regex do', 'en')?.id).toBe('guide.regex');
        expect(findTopic(TOPICS, 'дорогой ход', 'ru')?.id).toBe('module.treasurer');
    });

    it('gives null for nothing relevant', () => {
        expect(findTopic(TOPICS, '', 'en')).toBeNull();
        expect(findTopic(TOPICS, 'zebra', 'en')).toBeNull();
    });
});

describe('snippetOf', () => {
    it('picks the sentence with most terms and cuts it', () => {
        const text = 'First sentence here. The regex runs in order. Last one.';
        expect(snippetOf(text, stems('regex order'))).toBe('The regex runs in order.');
        expect(snippetOf('- item about regex', stems('regex'))).toBe('item about regex');
        expect(snippetOf('word '.repeat(100), stems('word'), 20).length).toBeLessThanOrEqual(20);
        expect(snippetOf('', [])).toBe('');
    });
});
