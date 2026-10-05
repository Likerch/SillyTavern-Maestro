// The bundled knowledge base (README and CHANGELOG through Vite's ?raw, the module, stack and guide catalogue) and the
// docs_search / docs_read tools.
import { describe, expect, it } from 'vitest';
import { readTools } from '../../../src/features/assistant/tools';
import { knowledgeBase, maestroVersion } from '../../../src/features/assistant/tools/knowledge';
import { searchDocs } from '../../../src/domain/assistant-docs';
import { fakeApp, runTool, toolContext } from './tools-helpers';
import type { Loose } from './tools-helpers';

const MODULE_KEYS = [
    'loreJournal',
    'inspector',
    'medic',
    'guardian',
    'doctor',
    'rules',
    'scenarios',
    'sheets',
    'wizard',
    'bookRoles',
    'canon',
    'loreStudio',
    'places',
    'world',
    'relations',
    'dossier',
    'bunnymoMode',
    'signals',
    'contradictions',
    'revision',
    'livingCanon',
    'chronicle',
    'metrics',
    'presetStudio',
    'quality',
    'architect',
    'treasurer',
    'director',
    'voices',
    'offscreen',
    'calendar',
    'knowledge',
    'wardrobe',
    'lorePassports',
    'backgrounds',
    'mechanics',
    'theme',
    'dock',
    'assistant',
];

describe('knowledge base', () => {
    const topics = knowledgeBase();

    it('has unique ids, both languages for the catalogue, and README/CHANGELOG sections', () => {
        const ids = topics.map((topic) => topic.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const topic of topics.filter((item) => ['module', 'stack', 'guide'].includes(item.kind))) {
            expect(topic.title.en && topic.title.ru, topic.id).toBeTruthy();
            expect(topic.body.en && topic.body.ru, topic.id).toBeTruthy();
        }
        expect(ids).toEqual(expect.arrayContaining(MODULE_KEYS.map((key) => `module.${key}`)));
        expect(ids).toEqual(
            expect.arrayContaining([
                'stack.sillytavern',
                'stack.des',
                'stack.desru',
                'stack.carrotkernel',
                'stack.bunnymo',
                'stack.qvink',
                'stack.naistudio',
                'stack.localizer',
                'readme.intro',
                'readme.trebovaniya',
                'changelog.1.8.0',
                'changelog.0.1.0',
                'guide.lore-miss',
                'guide.expensive-turn',
                'guide.regex',
            ]),
        );
        expect(maestroVersion()).toMatch(/^\d+\.\d+\.\d+$/);
        expect(knowledgeBase()).toBe(topics);
    });

    it('answers the plan questions with the right guide first', () => {
        const first = (query: string, locale: 'en' | 'ru' = 'ru') => searchDocs(topics, query, { locale })[0]?.id;
        expect(first('почему героиня не узнала сестру?')).toBe('guide.lore-miss');
        expect(first('почему этот ход дорогой?')).toBe('guide.expensive-turn');
        expect(first('что делает этот регекс?')).toBe('guide.regex');
        expect(first('why was this turn so expensive', 'en')).toBe('guide.expensive-turn');
        expect(first('what does this regex do', 'en')).toBe('guide.regex');
    });

    it('finds modules and neighbours by their names in both languages', () => {
        const ids = (query: string, locale: 'en' | 'ru' = 'ru') =>
            searchDocs(topics, query, { locale, limit: 3 }).map((hit) => hit.id);
        expect(ids('режиссёр сцены')).toContain('module.director');
        expect(ids('гардероб наряды')).toContain('module.wardrobe');
        expect(ids('Qvink memory summaries', 'en')).toContain('stack.qvink');
        expect(ids('CarrotKernel archives', 'en')).toContain('stack.carrotkernel');
        expect(ids('условные блоки флаги')).toContain('guide.conditional-blocks');
        expect(ids('механики мана кубики')).toContain('module.mechanics');
    });
});

describe('docs_search and docs_read', () => {
    it('searches and reads topics in the user language', async () => {
        const fake = fakeApp();
        const tools = readTools(fake.app);
        const search = await runTool(
            tools,
            'docs_search',
            { query: 'казначей расходы' },
            toolContext(fake, { locale: 'ru' }),
        );
        const hits = (search.data as { hits: { id: string; title: string }[] }).hits;
        expect(hits[0]).toMatchObject({ id: 'module.treasurer', title: 'Казначей (M21)' });
        expect(search.summary).toMatch(/^Документация: тем — \d$/);
        expect(search.untrusted).toBeUndefined();
        const read = await runTool(tools, 'docs_read', { topic: 'treasurer' }, toolContext(fake));
        const data = read.data as Loose;
        expect(data).toMatchObject({
            id: 'module.treasurer',
            kind: 'module',
            title: 'Treasurer (M21)',
            language: 'en',
        });
        expect(data.text).toContain('cost_turn');
        expect(data.related.length).toBeGreaterThan(0);
        expect(read.summary).toBe('Docs: Treasurer (M21)');
    });

    it('reads a Russian-only topic for an English user and filters by kind', async () => {
        const fake = fakeApp();
        const tools = readTools(fake.app);
        const read = await runTool(tools, 'docs_read', { topic: 'changelog.1.7.0' }, toolContext(fake));
        expect(read.data).toMatchObject({ kind: 'changelog', language: 'ru' });
        expect((read.data as { text: string }).text).toContain('механик');
        const kind = await runTool(
            tools,
            'docs_search',
            { query: 'механики', kind: 'changelog', limit: 2 },
            toolContext(fake),
        );
        const hits = (kind.data as { hits: { id: string }[] }).hits;
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((hit) => hit.id.startsWith('changelog.'))).toBe(true);
    });

    it('lists the index and suggests topics for an unknown one', async () => {
        const fake = fakeApp();
        const tools = readTools(fake.app);
        const index = await runTool(tools, 'docs_read', { topic: 'index' }, toolContext(fake, { locale: 'ru' }));
        const groups = (index.data as { index: Record<string, { id: string; title: string }[]> }).index;
        expect(Object.keys(groups).sort()).toEqual(['changelog', 'guide', 'module', 'readme', 'stack']);
        expect(groups.module!.find((item) => item.id === 'module.director')?.title).toBe('Режиссёр сцены (M13, M14)');
        const unknown = await runTool(tools, 'docs_read', { topic: 'zzzz qqqq' }, toolContext(fake));
        expect(unknown.summary).toBe('No topic «zzzz qqqq».');
        const empty = await runTool(tools, 'docs_search', { query: '   ' }, toolContext(fake));
        expect(empty.summary).toBe('Give a query.');
        expect((await runTool(tools, 'docs_read', {}, toolContext(fake))).summary).toBe('Give a topic.');
    });
});
