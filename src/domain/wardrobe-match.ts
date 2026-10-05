// Is this outfit one we know? (plan M27 п.1 «при повторном появлении — узнаётся и рисуется так же», §4.4 noise
// suppression): DES describes the same clothes in other words every turn, in Russian or English, while a passport
// outfit is a list of English tags. A wording matches an outfit by the wordings it was recognised from before (same
// language: word sets) or by concepts (any language: garments first, colours must not contradict). No AI. Pure.
import { jaccard, normalizeText, tokenSet } from './signals-tokens';
import { outfitConcepts } from './wardrobe-tags';
import type { OutfitConcepts } from './wardrobe-tags';

export interface OutfitLike {
    /** '' = the passport's clothing slot (no named outfit). */
    name: string;
    tags: string;
    /** DES wordings this outfit was recognised from (any language). */
    seenAs?: readonly string[];
}

export interface OutfitMatch {
    name: string;
    score: number;
    via: 'seen' | 'tags';
}

/** Below this an outfit is not the same one. */
export const MATCH_THRESHOLD = 0.55;

/** Half containment (the shorter list inside the longer), half Jaccard: DES often names fewer items than the tags. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const item of a) if (b.has(item)) common++;
    return 0.5 * (common / Math.min(a.size, b.size)) + 0.5 * jaccard(a, b);
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    for (const item of a) if (b.has(item)) return false;
    return true;
}

/** Similarity of two outfit concept sets, 0..1: no common garment → 0; contradicting colours halve it. */
export function conceptScore(a: OutfitConcepts, b: OutfitConcepts): number {
    if (!a.all.size || !b.all.size) return 0;
    const all = overlap(a.all, b.all);
    let score: number;
    if (a.garments.size && b.garments.size) {
        const garments = overlap(a.garments, b.garments);
        if (garments === 0) return 0;
        score = 0.6 * garments + 0.4 * all;
    } else {
        score = 0.8 * all;
    }
    if (a.colours.size && b.colours.size && disjoint(a.colours, b.colours)) score *= 0.5;
    return Math.min(1, score);
}

/** Two wordings of one outfit: equal text, close word sets, or close concepts. */
export function wordingScore(a: string, b: string): number {
    if (normalizeText(a) === normalizeText(b)) return 1;
    const words = jaccard(tokenSet(a), tokenSet(b));
    return Math.max(words, conceptScore(outfitConcepts(a), outfitConcepts(b)));
}

/** How well a wording fits an outfit and by what. */
export function outfitScore(text: string, outfit: OutfitLike): { score: number; via: 'seen' | 'tags' } {
    let seen = 0;
    for (const wording of outfit.seenAs ?? []) seen = Math.max(seen, wordingScore(text, wording));
    const described = [outfit.tags, outfit.name].filter((part) => part.trim()).join(', ');
    const tags = described ? conceptScore(outfitConcepts(text), outfitConcepts(described)) : 0;
    return seen >= tags ? { score: seen, via: 'seen' } : { score: tags, via: 'tags' };
}

/**
 * The known outfit a wording describes: the best score at or above the threshold; ties keep the earlier outfit
 * (callers list the most recent first). Null when none fits.
 */
export function matchOutfit(
    text: string,
    outfits: readonly OutfitLike[],
    threshold = MATCH_THRESHOLD,
): OutfitMatch | null {
    let best: OutfitMatch | null = null;
    for (const outfit of outfits) {
        const { score, via } = outfitScore(text, outfit);
        if (score < threshold || (best && score <= best.score)) continue;
        best = { name: outfit.name, score, via };
    }
    return best;
}
