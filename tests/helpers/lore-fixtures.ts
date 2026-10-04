// World Info fixtures for M1/M2 tests: entry copies as ST passes them in scan events, WORLDINFO_SCAN_DONE
// payloads (world-info.js:5150-5186) and a scripted scan that emits them like checkWorldInfo does.

export type WiEntry = Record<string, unknown> & { uid: number; world: string };

/** A scanned entry copy `{uid, world, ...entry}` with 1.19 defaults. */
export function wiEntry(world: string, uid: number, fields: Record<string, unknown> = {}): WiEntry {
    return {
        uid,
        world,
        key: [],
        keysecondary: [],
        comment: `Entry ${uid}`,
        content: '',
        constant: false,
        selective: true,
        selectiveLogic: 0,
        position: 0,
        depth: 4,
        role: 0,
        order: 100,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        preventRecursion: false,
        disable: false,
        useProbability: true,
        probability: 100,
        ...fields,
    };
}

export interface LoopSpec {
    /** scan_state: 1 initial, 2 recursion, 3 min activations. */
    current?: number;
    /** Entries that became active in this loop. */
    activated?: WiEntry[];
    /** Entries that passed but were cut by the budget. */
    cut?: WiEntry[];
    budget?: number;
    overflowed?: boolean;
}

/** WORLDINFO_SCAN_DONE payloads for a scan: the activated Map is cumulative, like ST's. */
export function scanPayloads(loops: LoopSpec[], options: { lastNext?: number } = {}): Record<string, unknown>[] {
    const map = new Map<string, WiEntry>();
    return loops.map((loop, index) => {
        for (const entry of loop.activated ?? []) map.set(`${entry.world}.${entry.uid}`, entry);
        const successful = [...(loop.activated ?? []), ...(loop.cut ?? [])];
        const last = index === loops.length - 1;
        return {
            state: {
                current: loop.current ?? (index === 0 ? 1 : 2),
                next: last ? (options.lastNext ?? 0) : 2,
                loopCount: index + 1,
            },
            new: { all: successful, successful },
            activated: { entries: new Map(map), text: '' },
            sortedEntries: [],
            recursionDelay: { availableLevels: [], currentLevel: 0 },
            budget: { current: loop.budget ?? 1000, overflowed: loop.overflowed ?? false },
            timedEffects: {},
        };
    });
}

/** Every entry activated over the loops (the WORLD_INFO_ACTIVATED list). */
export function finalList(loops: LoopSpec[]): WiEntry[] {
    return loops.flatMap((loop) => loop.activated ?? []);
}

/** Emits a scan through an emitter the way checkWorldInfo + getWorldInfoPrompt do (non-dry). */
export async function emitScan(
    emit: (event: string, ...args: unknown[]) => Promise<void>,
    events: { scanDone: string; activated: string },
    loops: LoopSpec[],
    options: { dryRun?: boolean } = {},
): Promise<void> {
    for (const payload of scanPayloads(loops)) await emit(events.scanDone, payload);
    const list = finalList(loops);
    if (!options.dryRun && list.length) await emit(events.activated, list);
}
