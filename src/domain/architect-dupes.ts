// M20 «Архитектор промпта», pure duplicate-fact detection (plan M20 п. 4): the same fact sent several times in one
// prompt — a lore entry, a canon override, a Qvink memory, a CK archive or RAG chunk, a DES block — found by word
// shingles of sentences. Two sentences are one fact when their 3-word shingle sets overlap enough (Jaccard), so
// small rewordings ("Anna has a scar" / "Anna has an old scar") still match. Read-only: it reports; dropping a copy
// happens elsewhere, by the user's consent.
// Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';
import { estimateText, isProtectedSegment, normalizeSentence, splitSentenceSegments } from './architect-text';
import type { TokenCounter } from './architect-text';

export interface DupeSourceText {
    /** Who owns the text: 'lore', 'canon', 'ckArchive', 'qvink', 'ck', 'des', … */
    owner: string;
    /** Exact source: `${world}#${uid}` for lore, the extension prompt key for injections. */
    ref: string;
    text: string;
    /**
     * Sources of one group never count as duplicates of each other (lore: the book, injections: the owner);
     * defaults to the owner.
     */
    group?: string;
}

export interface DupeMember {
    owner: string;
    ref: string;
    /** The sentence as written in this source. */
    sentence: string;
    /** sentenceKey() of it. */
    key: string;
    tokens: number;
}

export interface DupeGroup {
    /** Stable over turns while the same sentences repeat: hash of the smallest member key. */
    id: string;
    /** The sentence of the first source (prompt order). */
    text: string;
    /** One member per source (its first matching sentence). */
    members: DupeMember[];
    /** Keys of every matching sentence of every source (consent matches on any of them). */
    keys: string[];
}

export interface DupeOptions {
    /** Shorter sentences are never facts worth reporting. */
    minWords?: number;
    /** Jaccard similarity of shingle sets that makes two sentences one fact. */
    threshold?: number;
    /** Most groups returned (largest first). */
    limit?: number;
    count?: TokenCounter;
}

interface Sentence {
    source: number;
    text: string;
    key: string;
    shingles: Set<string>;
}

const SHINGLE = 3;
/** Shingles present in more sentences than this are boilerplate and do not link sentences. */
const MAX_POSTINGS = 64;

function shinglesOf(words: readonly string[]): Set<string> {
    const result = new Set<string>();
    for (let i = 0; i + SHINGLE <= words.length; i++) result.add(words.slice(i, i + SHINGLE).join(' '));
    return result;
}

class DisjointSet {
    private readonly parent: number[] = [];
    add(): number {
        this.parent.push(this.parent.length);
        return this.parent.length - 1;
    }
    find(x: number): number {
        let root = x;
        while (this.parent[root] !== root) root = this.parent[root] as number;
        let node = x;
        while (this.parent[node] !== root) {
            const next = this.parent[node] as number;
            this.parent[node] = root;
            node = next;
        }
        return root;
    }
    union(a: number, b: number): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
}

/** Sentences found in two or more sources of different groups, biggest repeats first. */
export function findDuplicateFacts(sources: readonly DupeSourceText[], options: DupeOptions = {}): DupeGroup[] {
    const minWords = Math.max(SHINGLE, options.minWords ?? 6);
    const threshold = options.threshold ?? 0.6;
    const limit = options.limit ?? 20;
    const count = options.count ?? estimateText;
    const sentences: Sentence[] = [];
    const sets = new DisjointSet();
    const postings = new Map<string, number[]>();
    const groupOf = (index: number) => {
        const source = sources[index] as DupeSourceText;
        return source.group ?? source.owner;
    };

    sources.forEach((source, sourceIndex) => {
        if (!source.text) return;
        const seenKeys = new Set<string>();
        for (const segment of splitSentenceSegments(source.text)) {
            if (isProtectedSegment(segment)) continue;
            const normalized = normalizeSentence(segment);
            const words = normalized ? normalized.split(' ') : [];
            if (words.length < minWords) continue;
            const key = stableHash(normalized);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            const sentence: Sentence = { source: sourceIndex, text: segment.trim(), key, shingles: shinglesOf(words) };
            const id = sets.add();
            sentences.push(sentence);
            // Candidates: earlier sentences sharing shingles, counted once per shared shingle.
            const shared = new Map<number, number>();
            for (const shingle of sentence.shingles) {
                const list = postings.get(shingle);
                if (!list) {
                    postings.set(shingle, [id]);
                    continue;
                }
                if (list.length <= MAX_POSTINGS) {
                    for (const other of list) shared.set(other, (shared.get(other) ?? 0) + 1);
                    list.push(id);
                }
            }
            for (const [other, common] of shared) {
                const candidate = sentences[other] as Sentence;
                if (groupOf(candidate.source) === groupOf(sourceIndex)) continue;
                const union = candidate.shingles.size + sentence.shingles.size - common;
                if (union > 0 && common / union >= threshold) sets.union(id, other);
            }
        }
    });

    const byRoot = new Map<number, number[]>();
    sentences.forEach((_, index) => {
        const root = sets.find(index);
        const list = byRoot.get(root);
        if (list) list.push(index);
        else byRoot.set(root, [index]);
    });

    const groups: { group: DupeGroup; weight: number }[] = [];
    for (const indexes of byRoot.values()) {
        if (indexes.length < 2) continue;
        const members: DupeMember[] = [];
        const seenSources = new Set<number>();
        const ordered = [...indexes].sort(
            (a, b) => (sentences[a] as Sentence).source - (sentences[b] as Sentence).source || a - b,
        );
        for (const index of ordered) {
            const sentence = sentences[index] as Sentence;
            if (seenSources.has(sentence.source)) continue;
            seenSources.add(sentence.source);
            const source = sources[sentence.source] as DupeSourceText;
            members.push({
                owner: source.owner,
                ref: source.ref,
                sentence: sentence.text,
                key: sentence.key,
                tokens: count(sentence.text),
            });
        }
        const groupsSeen = new Set([...seenSources].map(groupOf));
        if (members.length < 2 || groupsSeen.size < 2) continue;
        const keys = [...new Set(ordered.map((index) => (sentences[index] as Sentence).key))].sort();
        groups.push({
            group: {
                id: `d${stableHash(keys[0] as string)}`,
                text: (members[0] as DupeMember).sentence,
                members,
                keys,
            },
            weight: members.reduce((sum, member) => sum + member.tokens, 0),
        });
    }
    return groups
        .sort((a, b) => b.weight - a.weight || (a.group.id < b.group.id ? -1 : 1))
        .slice(0, limit)
        .map((item) => item.group);
}
