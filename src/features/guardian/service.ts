// M4's GuardianApi and its drift workflow (plan M4 пп. 1–3, §8 "Дрейф настроек и восстановление эталона —
// Входящие"): the baseline file, drift against live settings, one Inbox card per distinct drift (leader tab only),
// restore with journal and undo, and acknowledge() for changes other modules make on purpose (audit A17).
import {
    acknowledgePaths,
    diffTracked,
    driftHash,
    groupOf,
    pathMatches,
    valuesEqual,
} from '../../domain/settings-diff';
import type { DriftEntry, TrackedPart } from '../../domain/settings-diff';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { DriftItem, GuardianApi } from './api';
import { BaselineStore } from './baseline';
import type { BaselineFile } from './baseline';
import type { TabGuard } from './tab-guard';
import { collectTracked, fullValue, isPresetBodyPath, isRestorable, writeTracked } from './tracked';

export const DRIFT_KIND = 'guardian.drift';
export const RESTORE_KIND = 'guardian.restore';
export const SETTING_TARGET = 'guardian-setting';
/** Version changes are shown in the Pult but never become Inbox cards (updates are expected). */
const PULT_ONLY = ['extensions.versions'];
const DESCRIBE_LIMIT = 12;
const VALUE_CHARS = 40;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface DriftPayload {
    hash: string;
    baselineAt: number;
    /** Paths written back to their baseline values. */
    restore: string[];
    /** Report-only paths: accepting the card takes their current values into the baseline. */
    adopt: string[];
}

export interface DriftDetail {
    baseline: BaselineFile | null;
    current: TrackedPart;
    entries: DriftEntry[];
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDriftPayload(value: unknown): value is DriftPayload {
    return (
        isDict(value) &&
        typeof value.hash === 'string' &&
        typeof value.baselineAt === 'number' &&
        Array.isArray(value.restore) &&
        Array.isArray(value.adopt)
    );
}

/** Restore order: the whole preset first (it reloads everything), then its name, then the rest. */
function restoreRank(path: string): number {
    if (isPresetBodyPath(path)) return 0;
    if (path === 'preset.name') return 1;
    return groupOf(path) === 'preset' ? 2 : 3;
}

export class GuardianService implements GuardianApi {
    readonly store: BaselineStore;
    guard: TabGuard | null = null;
    private readonly listeners = new Set<() => void>();
    /** Inbox cards proposed this page: id → drift. A card that vanishes unapplied counts as dismissed. */
    private readonly cards = new Map<string, { chatId: string; hash: string; applied: boolean }>();
    /** Drift hash proposed per chat this page (no duplicate cards while the Inbox is loading). */
    private readonly proposed = new Map<string, string>();
    private driftRunning: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly t: Translate,
    ) {
        this.store = new BaselineStore(app.files, log.scope('baseline'));
    }

    /* ---------------------------------------------------------------- GuardianApi */

    hasBaseline(): boolean {
        return this.store.current() !== null;
    }

    async takeBaseline(reason: string): Promise<void> {
        const snapshot = await collectTracked(this.app, this.log);
        await this.store.save({
            schema: 1,
            takenAt: Date.now(),
            reason,
            values: snapshot.values,
            restore: snapshot.restore,
            dismissed: [],
        });
        this.proposed.clear();
        this.emit();
    }

    async drift(): Promise<DriftItem[]> {
        const detail = await this.detail();
        const baseline = detail.baseline;
        if (!baseline) return [];
        return detail.entries.map((entry) => ({
            path: entry.path,
            group: groupOf(entry.path),
            baseline: entry.baseline,
            current: entry.current,
            kind: entry.kind,
            restorable: isRestorable(entry, baseline),
        }));
    }

    async acknowledge(paths: string[]): Promise<void> {
        if (!paths.length) return;
        const current = await collectTracked(this.app, this.log);
        const file = await this.store.update((baseline) => acknowledgePaths(baseline, current, paths).length > 0);
        if (file) this.emit();
    }

    tabState(): 'fresh' | 'stale' | 'checking' | 'unknown' {
        return this.guard?.state() ?? 'unknown';
    }

    /* ---------------------------------------------------------------- views */

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('guardian listener failed', error);
            }
        }
    }

    /** Baseline, live snapshot and their difference. */
    async detail(fresh = false): Promise<DriftDetail> {
        const baseline = await this.store.load(fresh);
        const current = await collectTracked(this.app, this.log);
        return { baseline, current, entries: baseline ? diffTracked(baseline.values, current.values) : [] };
    }

    /** Loads the baseline; takes the first one when there is none yet. */
    async start(): Promise<void> {
        const baseline = await this.store.load(true);
        if (!baseline) await this.takeBaseline('first-start');
        else this.emit();
    }

    /* ---------------------------------------------------------------- restore */

    /**
     * Writes the baseline values of `paths` back (restorable ones only). The whole-preset restore asks first
     * when `confirmPreset`. Returns the applied changes (before = live value, after = baseline value).
     */
    async restore(paths: readonly string[], confirmPreset: boolean): Promise<JournalChange[]> {
        const detail = await this.detail(true);
        const baseline = detail.baseline;
        if (!baseline) return [];
        let entries = detail.entries.filter((entry) => paths.includes(entry.path) && isRestorable(entry, baseline));
        if (confirmPreset && entries.some((entry) => isPresetBodyPath(entry.path))) {
            const value = baseline.restore['preset.body'];
            const name = isDict(value) && typeof value.name === 'string' ? value.name : '';
            const yes = await this.app.ui.confirm(
                this.t('m4.confirm.presetTitle'),
                this.t('m4.confirm.presetBody', { name }),
            );
            if (!yes) entries = entries.filter((entry) => !isPresetBodyPath(entry.path));
        }
        entries.sort((a, b) => restoreRank(a.path) - restoreRank(b.path) || a.path.localeCompare(b.path));
        const changes: JournalChange[] = [];
        let bodyWritten: boolean | null = null;
        for (const entry of entries) {
            const before = fullValue(detail.current, entry.path);
            const after = fullValue(baseline, entry.path);
            let ok: boolean;
            if (isPresetBodyPath(entry.path) && bodyWritten !== null) ok = bodyWritten;
            else ok = await writeTracked(this.app, this.log, entry.path, after);
            if (isPresetBodyPath(entry.path)) bodyWritten = ok;
            if (!ok) {
                this.log.warn(`${entry.path} was not restored`);
                continue;
            }
            changes.push(settingChange(entry.path, before, after));
        }
        if (changes.length) this.app.host.ctx().saveSettingsDebounced();
        this.emit();
        return changes;
    }

    /** Pult "Вернуть": the user's own action, applied at once and journaled. */
    async restoreNow(paths: readonly string[]): Promise<number> {
        const changes = await this.restore(paths, true);
        if (changes.length) {
            await this.app.journal.record({
                module: 'M4',
                kind: RESTORE_KIND,
                summary: this.t('m4.journal.restore', { count: changes.length }),
                changes,
            });
        }
        return changes.length;
    }

    /** Undo handler of SETTING_TARGET: puts the value that was live before the restore back. */
    async undoChange(change: JournalChange): Promise<boolean> {
        const ref = change.ref as { path?: unknown; absentBefore?: unknown; absentAfter?: unknown };
        if (typeof ref.path !== 'string') return false;
        const path = ref.path;
        const target = ref.absentBefore === true ? undefined : change.before;
        if (!isPresetBodyPath(path)) {
            const now = fullValue(await collectTracked(this.app, this.log), path);
            if (valuesEqual(now ?? null, target ?? null)) return true;
            const after = ref.absentAfter === true ? undefined : change.after;
            if (!valuesEqual(now ?? null, after ?? null)) {
                this.log.warn(`${path} changed after the restore; not undone`);
                return false;
            }
        }
        const ok = await writeTracked(this.app, this.log, path, target);
        if (ok) {
            this.app.host.ctx().saveSettingsDebounced();
            this.emit();
        }
        return ok;
    }

    /* ---------------------------------------------------------------- drift → Inbox */

    /** One Inbox card per distinct drift (leader tab of a chat only). */
    checkDrift(): Promise<void> {
        if (this.driftRunning) return this.driftRunning;
        const run = this.proposeDrift()
            .catch((error: unknown) => this.log.warn('drift check failed', error))
            .finally(() => {
                if (this.driftRunning === run) this.driftRunning = null;
            });
        this.driftRunning = run;
        return run;
    }

    private async proposeDrift(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.app.host.isGroupChat() || !this.app.leader.isLeader()) return;
        const detail = await this.detail(true);
        const baseline = detail.baseline;
        if (!baseline) return;
        const entries = proposable(detail.entries);
        if (!entries.length) return;
        const hash = driftHash(entries);
        if (baseline.dismissed.includes(hash) || this.proposed.get(chatId) === hash) return;
        await loadInbox(this.app);
        if (this.findCard(hash)) {
            this.proposed.set(chatId, hash);
            return;
        }
        const restore = entries.filter((entry) => isRestorable(entry, baseline));
        const adopt = entries.filter((entry) => !isRestorable(entry, baseline)).map((entry) => entry.path);
        const payload: DriftPayload = {
            hash,
            baselineAt: baseline.takenAt,
            restore: restore.map((entry) => entry.path),
            adopt,
        };
        const proposal: Proposal<DriftPayload> = {
            module: 'M4',
            kind: DRIFT_KIND,
            title: this.t('m4.card.title', { count: entries.length }),
            description: this.describe(entries, baseline),
            changes: restore.map((entry) =>
                settingChange(entry.path, fullValue(detail.current, entry.path), fullValue(baseline, entry.path)),
            ),
            payload,
            apply: (value) => this.applyCard(value),
            stillValid: () => this.cardValid(payload),
        };
        this.proposed.set(chatId, hash);
        const decision = await this.app.autonomy.decide(proposal, 'inbox');
        if (decision === 'queued') {
            const card = this.findCard(hash);
            if (card) this.cards.set(card, { chatId, hash, applied: false });
        }
    }

    private findCard(hash: string): string | undefined {
        return this.app.inbox
            .list()
            .find((card) => card.kind === DRIFT_KIND && isDict(card.payload) && card.payload.hash === hash)?.id;
    }

    /** Inbox applier: restores what can be restored and takes the rest as the new baseline. */
    async applyCard(payload: unknown): Promise<void> {
        if (!isDriftPayload(payload)) throw new Error('not a drift card');
        for (const card of this.cards.values()) if (card.hash === payload.hash) card.applied = true;
        // The same drift may come back later (a neighbour resets its setting): propose it again then.
        this.proposed.clear();
        await this.restore(payload.restore, true);
        if (payload.adopt.length) await this.acknowledge(payload.adopt);
    }

    /** The card still describes the current drift against the same baseline. */
    async cardValid(payload: unknown): Promise<boolean> {
        if (!isDriftPayload(payload)) return false;
        const detail = await this.detail(true);
        if (!detail.baseline || detail.baseline.takenAt !== payload.baselineAt) return false;
        return driftHash(proposable(detail.entries)) === payload.hash;
    }

    /** A card of ours left the Inbox without being applied: the user dismissed this drift. */
    async onInboxChange(): Promise<void> {
        const chatId = this.app.host.chatId();
        const mine = [...this.cards].filter(([, card]) => card.chatId === chatId);
        if (!mine.length) return;
        await loadInbox(this.app);
        if (this.app.host.chatId() !== chatId) return;
        const present = new Set(this.app.inbox.list().map((card) => card.id));
        for (const [id, card] of mine) {
            if (present.has(id) || !this.cards.has(id)) continue;
            this.cards.delete(id);
            if (this.proposed.get(card.chatId) === card.hash) this.proposed.delete(card.chatId);
            if (!card.applied) await this.store.dismiss(card.hash);
        }
    }

    /** Chat switched: the Inbox now shows another chat's cards. */
    forgetCards(): void {
        this.cards.clear();
    }

    /** Short human-readable list for the card. */
    describe(entries: readonly DriftEntry[], baseline: TrackedPart): string {
        const lines = entries
            .slice(0, DESCRIBE_LIMIT)
            .map((entry) => `• ${this.label(entry)}: ${this.change(entry, baseline)}`);
        if (entries.length > DESCRIBE_LIMIT)
            lines.push(this.t('m4.card.more', { count: entries.length - DESCRIBE_LIMIT }));
        return [this.t('m4.card.intro'), ...lines].join('\n');
    }

    /** "Регекс · Clean HTML", "Qvink · auto_summarize". */
    label(entry: { path: string; baseline?: unknown; current?: unknown }): string {
        const group = groupOf(entry.path);
        const rest = entry.path.slice(group.length + 1);
        const key = `m4.group.${group}`;
        const title = this.t(key);
        let name = rest;
        if (group === 'regex') {
            const value = isDict(entry.current) ? entry.current : isDict(entry.baseline) ? entry.baseline : null;
            if (value && typeof value.name === 'string' && value.name) name = value.name;
        } else if (group === 'preset') {
            const known = this.t(`m4.preset.${rest}`);
            if (known !== `m4.preset.${rest}`) name = known;
        }
        return `${title === key ? group : title}${name ? ` · ${name}` : ''}`;
    }

    /** "было 25 → стало 40", "изменено", "добавлено", "удалено". */
    change(entry: DriftEntry, baseline: TrackedPart): string {
        if (entry.kind === 'added') return this.t('m4.value.added');
        if (entry.kind === 'removed') return this.t('m4.value.removed');
        const short = (value: unknown): string | null => {
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (typeof value === 'string' && value.length <= VALUE_CHARS) return `«${value}»`;
            return null;
        };
        const before = Object.hasOwn(baseline.restore, entry.path) ? null : short(entry.baseline);
        const after = Object.hasOwn(baseline.restore, entry.path) ? null : short(entry.current);
        return before !== null && after !== null
            ? this.t('m4.value.changed', { before, after })
            : this.t('m4.value.changedOpaque');
    }
}

function proposable(entries: readonly DriftEntry[]): DriftEntry[] {
    return entries.filter((entry) => !pathMatches(entry.path, PULT_ONLY));
}

function settingChange(path: string, before: unknown, after: unknown): JournalChange {
    return {
        target: SETTING_TARGET,
        ref: { path, absentBefore: before === undefined, absentAfter: after === undefined },
        before: before ?? null,
        after: after ?? null,
    };
}

/** The core Inbox loads per chat lazily; wait for it before looking for existing cards. */
async function loadInbox(app: App): Promise<void> {
    const service = app.inbox as Partial<{ load(): Promise<void> }>;
    if (typeof service.load === 'function') {
        try {
            await service.load.call(app.inbox);
        } catch {
            // list() still answers with what is loaded
        }
    }
}
