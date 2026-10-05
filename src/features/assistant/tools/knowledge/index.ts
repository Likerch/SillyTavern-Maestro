// The assistant's bundled knowledge base (M33): README.md and CHANGELOG.md of the repository (imported as raw strings
// at build time by Vite's `?raw`, split by their `##` sections) plus the hand-written module, stack and guide topics.
// Built once, lazily (the first docs_* call), and shared by every tool instance.
import changelog from '../../../../../CHANGELOG.md?raw';
import readme from '../../../../../README.md?raw';
import { splitMarkdown } from '../../../../domain/assistant-docs';
import type { DocTopic } from '../../../../domain/assistant-docs';
import { GUIDE_TOPICS } from './guides';
import { MODULE_TOPICS } from './modules';
import { STACK_TOPICS } from './stack';

let cache: DocTopic[] | null = null;

/** Every topic: guides, modules, stack, README sections, CHANGELOG versions. */
export function knowledgeBase(): DocTopic[] {
    cache ??= [
        ...GUIDE_TOPICS,
        ...MODULE_TOPICS,
        ...STACK_TOPICS,
        ...splitMarkdown(readme, { prefix: 'readme', kind: 'readme', lang: 'ru' }),
        ...splitMarkdown(changelog, { prefix: 'changelog', kind: 'changelog', lang: 'ru' }),
    ];
    return cache;
}

/** Maestro's version: the newest `## x.y.z` heading of the changelog (null when it cannot be read). */
export function maestroVersion(): string | null {
    const match = /^##\s+(\d+\.\d+\.\d+)/m.exec(changelog);
    return match?.[1] ?? null;
}

export { GUIDE_TOPICS, MODULE_TOPICS, STACK_TOPICS };
