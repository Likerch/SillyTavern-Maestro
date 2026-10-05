// Read tools over the bundled knowledge base (M33: «знает документацию Maestro и стека»): search and read topics of
// the module catalogue, the stack, the guides, README and CHANGELOG — in the user's language when the topic has it.
import { findTopic, localText, searchDocs } from '../../../../domain/assistant-docs';
import type { DocKind } from '../../../../domain/assistant-docs';
import type { ToolSpec } from '../../api';
import { knowledgeBase } from '../knowledge';
import { argsOf, cut, enumArg, intArg, notice, objectSchema, prop, readTool, say, strArg } from './common';

const KINDS: readonly DocKind[] = ['guide', 'module', 'stack', 'readme', 'changelog'];

const docsSearch = (): ToolSpec =>
    readTool({
        name: 'docs_search',
        description:
            "Search Maestro's documentation: modules (what each does, where it is in the pult, its settings, common questions), the extension stack (SillyTavern, DES, DES-RU, CarrotKernel, BunnyMo, Qvink, NAI Studio, Lorebook Localizer, the preset), diagnosis guides, README and the changelog. Russian or English query. Returns topic ids with a snippet; read one with docs_read.",
        parameters: objectSchema(
            {
                query: prop.string('What to look for, in any language.'),
                kind: prop.enum('Only this kind of topic.', KINDS),
                limit: prop.integer('Hits (1-10, default 5).', { minimum: 1, maximum: 10 }),
            },
            ['query'],
        ),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const query = strArg(args, 'query', 200);
            if (!query) return notice(ctx, 'Give a query.', 'Нужен запрос.');
            const kind = enumArg(args, 'kind', KINDS);
            const hits = searchDocs(knowledgeBase(), query, {
                locale: ctx.locale,
                limit: intArg(args, 'limit', 5, 1, 10),
                ...(kind ? { kinds: [kind] } : {}),
            });
            return {
                data: { query, hits },
                summary: say(ctx, `Docs: ${hits.length} topics`, `Документация: тем — ${hits.length}`),
            };
        },
    });

const docsRead = (): ToolSpec =>
    readTool({
        name: 'docs_read',
        description:
            'Read one documentation topic by id (from docs_search, e.g. "module.director", "stack.des", "guide.lore-miss", "changelog.1.8.0"), by a short id ("director"), or by title. "index" lists every topic.',
        parameters: objectSchema({ topic: prop.string('Topic id, short id, title, or "index".') }, ['topic']),
        async run(rawArgs, ctx) {
            const topicArg = strArg(argsOf(rawArgs), 'topic', 160);
            if (!topicArg) return notice(ctx, 'Give a topic.', 'Нужна тема.');
            const topics = knowledgeBase();
            if (topicArg.toLowerCase() === 'index') {
                const index: Record<string, { id: string; title: string }[]> = {};
                for (const topic of topics) {
                    (index[topic.kind] ??= []).push({ id: topic.id, title: localText(topic.title, ctx.locale) });
                }
                return {
                    data: { index },
                    summary: say(ctx, `Docs index: ${topics.length} topics`, `Оглавление: тем — ${topics.length}`),
                };
            }
            const topic = findTopic(topics, topicArg, ctx.locale);
            if (!topic) {
                const suggestions = searchDocs(topics, topicArg, { locale: ctx.locale, limit: 5 }).map((hit) => ({
                    id: hit.id,
                    title: hit.title,
                }));
                return notice(ctx, `No topic «${topicArg}».`, `Нет темы «${topicArg}».`, { suggestions });
            }
            const title = localText(topic.title, ctx.locale);
            const related = searchDocs(topics, title, { locale: ctx.locale, limit: 4 })
                .filter((hit) => hit.id !== topic.id)
                .slice(0, 3)
                .map((hit) => hit.id);
            const hasLocale = ctx.locale === 'ru' ? !!topic.body.ru : !!topic.body.en;
            return {
                data: {
                    id: topic.id,
                    kind: topic.kind,
                    title,
                    language: hasLocale ? ctx.locale : ctx.locale === 'ru' ? 'en' : 'ru',
                    text: cut(localText(topic.body, ctx.locale), 6000),
                    related,
                },
                summary: say(ctx, `Docs: ${cut(title, 50)}`, `Документация: ${cut(title, 50)}`),
            };
        },
    });

export function docsTools(): ToolSpec[] {
    return [docsSearch(), docsRead()];
}
