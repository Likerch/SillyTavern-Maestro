// Public API of M4 «Страж настроек и вкладок» (app.modules.api<GuardianApi>('guardian')).

export interface DriftItem {
    path: string;
    /** Group shown in the UI: preset, regex, qvink, ck, nai, des, worldInfo, profiles, extensions. */
    group: string;
    baseline: unknown;
    current: unknown;
    /** 'added' = not in the baseline, 'removed' = gone now, 'changed' = different value. */
    kind?: 'added' | 'removed' | 'changed';
    /** Maestro can put the baseline value back (otherwise the item is report-only). */
    restorable?: boolean;
}

export interface GuardianApi {
    hasBaseline(): boolean;
    /** Takes (or replaces) the baseline snapshot of tracked settings and the active preset. */
    takeBaseline(reason: string): Promise<void>;
    drift(): Promise<DriftItem[]>;
    /**
     * Changes applied through Maestro update the baseline without being reported as drift. A path also covers
     * everything under it ('preset' acknowledges 'preset.order', 'preset.body', …).
     */
    acknowledge(paths: string[]): Promise<void>;
    /** 'fresh' = this tab's settings match the server; 'stale' = another tab/device saved later. */
    tabState(): 'fresh' | 'stale' | 'checking' | 'unknown';
    /** Saves the tab guard holds now and the ones it vetoed, by kind (metrics). */
    guardInfo?(): { held: Record<string, number>; vetoed: Record<string, number> } | undefined;
}
