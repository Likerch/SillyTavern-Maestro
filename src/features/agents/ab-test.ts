// «Сравнение вслепую» of the illustrator (plan §3.19 п. 6, release 1.33). For up to 20 replies of the open chat that the
// main model illustrated (NAI Studio keeps their markers), the illustrator writes its own marker for the same reply in a
// test run (nothing is applied), and BOTH markers are drawn again by the same NAI Studio path (`drawPicture`, free only),
// so neither picture has an advantage. The pairs are shown in random order, without saying which is whose; the user
// picks the better one or «одинаково». Until the illustrator is not worse, it stays out of the sets.
import { adaptersOf } from '../../adapters';
import type { AgentDef } from '../../domain/agents/types';
import type { App, Logger } from '../../shared/contracts';
import { ILLUSTRATE_KIND } from './image-receivers';
import type { AgentRunner } from './runner';

export const AB_MAX_REPLIES = 20;
export const AB_JOB_KEY = 'agents:ab-illustrator';

export interface AbPicture {
    path: string;
    prompt: string;
}

export interface AbPair {
    messageIndex: number;
    main: AbPicture;
    agent: AbPicture;
    /** The agent's picture is shown on the left. */
    agentLeft: boolean;
    /** The user's choice. */
    choice?: 'agent' | 'main' | 'same';
}

export interface AbSummary {
    at: number;
    agentName: string;
    total: number;
    agent: number;
    main: number;
    same: number;
}

/** The illustrator is not worse: it won at least as often as the main model. */
export function abVerdict(summary: Pick<AbSummary, 'agent' | 'main'>): 'agent' | 'main' | 'tie' {
    if (summary.agent > summary.main) return 'agent';
    if (summary.agent < summary.main) return 'main';
    return 'tie';
}

export function summarize(pairs: readonly AbPair[], agentName: string, at: number): AbSummary {
    const chosen = pairs.filter((pair) => pair.choice);
    return {
        at,
        agentName,
        total: chosen.length,
        agent: chosen.filter((pair) => pair.choice === 'agent').length,
        main: chosen.filter((pair) => pair.choice === 'main').length,
        same: chosen.filter((pair) => pair.choice === 'same').length,
    };
}

/** Replies of the chat with a marker of the main model (not the illustrator's), newest first, at most `max`. */
export function candidateReplies(app: App, max = AB_MAX_REPLIES): { index: number; marker: Record<string, unknown> }[] {
    const nai = adaptersOf(app).nai;
    const chat = app.host.ctx().chat ?? [];
    const out: { index: number; marker: Record<string, unknown> }[] = [];
    for (let i = chat.length - 1; i >= 0 && out.length < max; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const first = nai
            .messageMarkers(i)
            .find((item) => item.by !== 'illustrator' && typeof item.marker.prompt === 'string');
        if (first) out.push({ index: i, marker: first.marker });
    }
    return out;
}

export interface AbProgress {
    done: number;
    total: number;
}

export interface AbBuild {
    pairs: AbPair[];
    /** Why replies gave no pair (NAI Studio's error codes, «no-picture» when the illustrator drew nothing), distinct. */
    failures: string[];
}

/**
 * Builds the pairs: the illustrator's marker for each reply (a test run), then both pictures drawn free only. A reply
 * the illustrator answers without a picture, or a picture that fails, is skipped. Stops on the signal.
 */
export async function buildPairs(
    app: App,
    log: Logger,
    runner: AgentRunner,
    def: AgentDef,
    options: { signal: AbortSignal; onProgress(progress: AbProgress): void; random?: () => number },
): Promise<AbBuild> {
    const nai = adaptersOf(app).nai;
    const random = options.random ?? Math.random;
    const candidates = candidateReplies(app);
    const pairs: AbPair[] = [];
    const failures = new Set<string>();
    let done = 0;
    options.onProgress({ done, total: candidates.length });
    for (const candidate of candidates) {
        if (options.signal.aborted) break;
        try {
            const outcome = await runner.run({
                def,
                phase: 'manual',
                reason: 'ab',
                focusIndex: candidate.index,
                test: true,
                signal: options.signal,
            });
            const output = outcome.output;
            const item =
                output?.type === 'proposals'
                    ? output.items.find(
                          (entry) =>
                              entry.kind === ILLUSTRATE_KIND &&
                              typeof (entry.data.marker as Record<string, unknown> | undefined)?.prompt === 'string',
                      )
                    : undefined;
            const marker = item?.data.marker as Record<string, unknown> | undefined;
            if (!marker && !options.signal.aborted) failures.add(outcome.run.ok ? 'no-picture' : 'agent');
            if (marker && !options.signal.aborted) {
                const main = await nai.drawPicture({
                    marker: candidate.marker,
                    freeOnly: true,
                    name: 'ab',
                    signal: options.signal,
                });
                const agent = main.ok
                    ? await nai.drawPicture({ marker, freeOnly: true, name: 'ab', signal: options.signal })
                    : main;
                if (main.ok && main.path && agent.ok && agent.path) {
                    pairs.push({
                        messageIndex: candidate.index,
                        main: { path: main.path, prompt: String(candidate.marker.prompt) },
                        agent: { path: agent.path, prompt: String(marker.prompt) },
                        agentLeft: random() < 0.5,
                    });
                } else {
                    const error = (main.ok ? agent.error : main.error) ?? 'failed';
                    failures.add(error);
                    log.info(`blind comparison: reply ${candidate.index} not drawn (${error})`);
                }
            }
        } catch (error) {
            failures.add('failed');
            log.warn(`blind comparison: reply ${candidate.index} failed`, error);
        }
        done += 1;
        options.onProgress({ done, total: candidates.length });
    }
    return { pairs, failures: [...failures] };
}
