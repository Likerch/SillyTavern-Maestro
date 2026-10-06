// The analysis of M37 «Подготовить к игре» (plan-2 §7 п. 2): the sources packed into parts, one background request per
// part (task 'prepare', the strict schema of prepare-extract), the answers merged. Runs inside the user job the service
// started: progress after every part, «Stop» between parts (and inside the request through the job's signal); what was
// read before a stop is kept as a partial plan.
import { mergeItems } from '../../domain/prepare-merge';
import {
    PREPARE_TASK,
    buildPrepareMessages,
    parsePrepareAnswer,
    prepareSchema,
    requestOverheadChars,
} from '../../domain/prepare-extract';
import type { PrepareRequestInput } from '../../domain/prepare-extract';
import type { AnyPrepareItem } from '../../domain/prepare-plan';
import { chunkSources, estimateChunks } from '../../domain/prepare-sources';
import type { ChunkResult, PrepareEstimate, PrepareSource } from '../../domain/prepare-sources';
import type { App, Logger } from '../../shared/contracts';
import type { Collected } from './collect';
import type { PrepareSettings } from './settings';

/** Expected answer size of a part (the estimate; the request may use up to settings.maxTokens). */
const EXPECTED_ANSWER_SHARE = 0.5;

export interface ExtractProgress {
    done: number;
    total: number;
}

export interface ExtractOutcome {
    items: AnyPrepareItem[];
    chunks: number;
    failedChunks: number;
    costUsd: number;
    /** Stopped before every part was read. */
    partial: boolean;
    /** Source ids left out by the budget. */
    skipped: string[];
    /** Errors of failed parts (log, the job's message when all failed). */
    errors: string[];
}

/** The fixed parts of every request (card line, known names, templates, vocabulary). */
export function requestBase(collected: Collected): Omit<PrepareRequestInput, 'sources' | 'part'> {
    const snapshot = collected.snapshot;
    return {
        cardName: collected.view.name,
        personaName: collected.personaName,
        context: collected.context,
        known: {
            canon: snapshot.canon.map((entry) => entry.title),
            places: snapshot.places.map((place) => place.name),
            passports: snapshot.passports.map((passport) => passport.name),
        },
        templates: collected.templates,
        mechanics: collected.mechanics,
        vocabulary: collected.vocabulary,
    };
}

/** The parts of a run over `sources` (all of the collected ones, or the changed ones on reuse). */
export function partsOf(sources: readonly PrepareSource[], settings: PrepareSettings): ChunkResult {
    return chunkSources(sources, { chunkChars: settings.chunkChars, maxChunks: settings.maxChunks });
}

export function estimateRun(collected: Collected, parts: ChunkResult, settings: PrepareSettings): PrepareEstimate {
    return estimateChunks(parts, {
        overheadChars: requestOverheadChars(requestBase(collected)),
        outputTokens: settings.maxTokens * EXPECTED_ANSWER_SHARE,
    });
}

export async function runExtraction(
    app: App,
    log: Logger,
    input: {
        collected: Collected;
        sources: readonly PrepareSource[];
        settings: PrepareSettings;
        signal: AbortSignal;
        onProgress(progress: ExtractProgress): void;
    },
): Promise<ExtractOutcome> {
    const { collected, settings, signal } = input;
    const parts = partsOf(input.sources, settings);
    const byId = new Map(input.sources.map((item) => [item.id, item]));
    const base = requestBase(collected);
    const lists: AnyPrepareItem[][] = [];
    const errors: string[] = [];
    let failedChunks = 0;
    let costUsd = 0;
    let partial = false;
    input.onProgress({ done: 0, total: parts.chunks.length });
    for (const chunk of parts.chunks) {
        if (signal.aborted) {
            partial = true;
            break;
        }
        const refs = new Map<string, string>();
        const sources = chunk.sourceIds.flatMap((id, index) => {
            const item = byId.get(id);
            if (!item) return [];
            const ref = `S${index + 1}`;
            refs.set(ref, id);
            return [{ ref, label: item.label, text: item.text }];
        });
        const messages = buildPrepareMessages({
            ...base,
            sources,
            part: { index: chunk.index, total: parts.chunks.length, core: chunk.core },
        });
        let result;
        try {
            result = await app.llm.request({
                task: PREPARE_TASK,
                messages,
                maxTokens: settings.maxTokens,
                temperature: 0.2,
                schema: prepareSchema(),
                signal,
            });
        } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (typeof result.costUsd === 'number') costUsd += result.costUsd;
        if (signal.aborted) {
            partial = true;
            break;
        }
        const parsed = result.ok ? parsePrepareAnswer(result.data, { refs }) : null;
        if (!parsed) {
            failedChunks++;
            errors.push(result.error ?? (result.refusal ? 'refusal' : 'unreadable answer'));
            log.warn(`prepare: part ${chunk.index + 1} of ${parts.chunks.length} failed`, result.error ?? '');
        } else {
            if (parsed.rejected.length) log.debug('prepare: dropped items', parsed.rejected);
            lists.push(parsed.items);
        }
        input.onProgress({ done: chunk.index + 1, total: parts.chunks.length });
    }
    return {
        items: mergeItems(lists),
        chunks: parts.chunks.length,
        failedChunks,
        costUsd,
        partial,
        skipped: parts.skipped,
        errors,
    };
}
