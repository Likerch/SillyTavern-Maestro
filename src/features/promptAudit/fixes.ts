// M38 «Проверка промпта»: fixes routed to whoever owns the text (plan-2 §2 п. 5; domain/prompt-audit-fix.ts decides
// the route). Preset blocks → the user's layer of the current preset in the chosen scope (`presetLayer.record`, which
// journals with undo) and the working copy for this session (`presetStore`), like the studio's own edits; neighbours'
// texts → `neighbourPrompts.setGlobal` («везде») or `setScoped` (a copy for the character or the chat), journaled
// there; Maestro's own injections → its module setting, journaled here with undo. The rest is advice. Several fixes
// at once become one more journal record that undoes the whole batch.
import { checkSettingPath, writePath } from '../../domain/assistant-safety';
import { stableHash } from '../../domain/hash';
import { applyText, fixRisk, neighbourNeedles, routeOf, routeScopes } from '../../domain/prompt-audit-fix';
import type { FixRoute } from '../../domain/prompt-audit-fix';
import type { AuditCapture, AuditItem } from '../../domain/prompt-audit-map';
import type { AuditFix, FixScope } from '../../domain/prompt-audit-rules';
import { promptText } from '../../domain/preset-ui-blocks';
import type { App, JournalChange, JournalRecord, Logger } from '../../shared/contracts';
import type { NeighbourPrompt, NeighbourPromptsApi } from '../neighbourPrompts/api';
import type { LayerOp, LayerScope, PresetLayerApi } from '../presetStudio/layer-api';
import type { PresetBody, PresetPrompt, PresetStore } from '../presetStudio/store-api';
import type { AuditConflict, FixPlan } from './api';
import { adviceText, changeText, ownerLabel, reasonText } from './labels';

export const MODULE_ID = 'M38';
/** Journal kinds and targets of this module. */
export const SETTING_TARGET = 'prompt-audit.setting';
export const BATCH_TARGET = 'prompt-audit.batch';
export const AUDIT_JOURNAL_KINDS = ['promptAudit.setting', 'promptAudit.batch'] as const;

type Dict = Record<string, unknown>;

/** A fix that cannot be done now, with a sentence for the user. */
export class FixError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FixError';
    }
}

/** The layer's text fingerprint (the studio's baseHashOf: line ends normalised). */
function baseHashOf(text: string): string {
    return stableHash(text.replace(/\r\n/g, '\n'));
}

function scopeOk(app: App, scope: FixScope): boolean {
    if (scope === 'global') return true;
    if (app.host.isGroupChat()) return false;
    if (scope === 'chat') return !!app.host.chatId();
    const ctx = app.host.ctx();
    return ctx.characterId !== undefined && ctx.characterId !== '';
}

export class FixRouter {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private item(capture: AuditCapture | null, ref: string): AuditItem | undefined {
        return capture?.items.find((entry) => entry.ref === ref);
    }

    private quirks(capture: AuditCapture | null): string[] {
        return capture?.connection?.quirks ?? [];
    }

    route(conflict: AuditConflict, capture: AuditCapture | null): FixRoute | null {
        const fix = conflict.fix;
        if (!fix) return null;
        return routeOf(this.item(capture, fix.target), fix, this.quirks(capture));
    }

    /* ---------------------------------------------------------------- plan */

    plan(conflict: AuditConflict, capture: AuditCapture | null, scope?: FixScope): FixPlan | null {
        const fix = conflict.fix;
        if (!fix) return null;
        const item = this.item(capture, fix.target);
        const route = routeOf(item, fix, this.quirks(capture));
        const target = ownerLabel(this.app, item, capture?.preset);
        const otherRef = fix.target === conflict.a.ref ? conflict.b?.ref : conflict.a.ref;
        const other = otherRef ? ownerLabel(this.app, this.item(capture, otherRef), capture?.preset) : '';
        const side: 'a' | 'b' = fix.target === conflict.b?.ref ? 'b' : 'a';
        const { before, after } = this.display(fix, item);
        const plan: FixPlan = {
            conflictId: conflict.id,
            route: route.route,
            side,
            kind: fix.kind,
            target,
            before,
            after,
            scopes: this.scopes(route, fix).filter((value) => scopeOk(this.app, value)),
        };
        const reason = reasonText(this.app, fix, target, other);
        if (reason) plan.reason = reason;
        const risk = fixRisk(fix, item, this.quirks(capture));
        if (risk) {
            plan.warning = this.t(`m38.risk.${risk}`, {
                model: capture?.connection?.model || this.t('m38.model.this'),
            });
        }
        if (route.route === 'advice') {
            plan.advice = adviceText(this.app, route.reason, fix, item, { target, risk: plan.warning });
            plan.scopes = [];
        }
        if (scope && !plan.scopes.includes(scope) && plan.scopes.length) {
            plan.warning = [plan.warning, this.t('m38.fix.scopeUnavailable')].filter(Boolean).join(' ');
        }
        return plan;
    }

    private display(fix: AuditFix, item: AuditItem | undefined): { before: string; after: string } {
        switch (fix.kind) {
            case 'edit':
            case 'remove':
                return { before: fix.before ?? '', after: fix.after ?? '' };
            case 'toggle':
                return { before: this.t('m38.state.on'), after: this.t('m38.state.off') };
            case 'role':
                return {
                    before: this.t(`m38.role.${item?.role ?? 'system'}`),
                    after: this.t(`m38.role.${fix.role ?? 'user'}`),
                };
            case 'move':
                return {
                    before: item?.depth !== undefined ? String(item.depth) : '—',
                    after: String(fix.depth ?? 0),
                };
            default:
                return { before: '', after: changeText(this.app, fix) };
        }
    }

    /** Scopes a fix can be written to now (a neighbour's entry narrows them: editable → везде, copyable → копии). */
    private scopes(route: FixRoute, fix: AuditFix): FixScope[] {
        // Without the user's layer a preset block changes in the working copy only: «везде» for this session.
        if (route.route === 'preset' && !this.app.modules.api<PresetLayerApi>('presetLayer')) return ['global'];
        if (route.route !== 'neighbour') return routeScopes(route);
        const entry = this.neighbourEntry(route.candidates, fix);
        if (!entry) return [];
        const scopes: FixScope[] = [];
        if (entry.entry.editable) scopes.push('global');
        if (entry.entry.scopable) scopes.push('character', 'chat');
        return scopes;
    }

    /* ---------------------------------------------------------------- apply */

    /** Applies a fix; resolves to a sentence for the user. Throws FixError with a sentence when it cannot. */
    async apply(conflict: AuditConflict, capture: AuditCapture | null, scope: FixScope = 'global'): Promise<string> {
        const fix = conflict.fix;
        if (!fix) throw new FixError(this.t('m38.fix.none'));
        const item = this.item(capture, fix.target);
        const route = routeOf(item, fix, this.quirks(capture));
        const target = ownerLabel(this.app, item, capture?.preset);
        if (!scopeOk(this.app, scope)) throw new FixError(this.t(`m38.fix.noScope.${scope}`));
        switch (route.route) {
            case 'preset':
                await this.applyPreset(route.identifier, fix, scope, target);
                return this.t(`m38.fix.done.${scope}`, { target });
            case 'neighbour':
                await this.applyNeighbour(route.candidates, fix, scope, target);
                return this.t(`m38.fix.done.${scope}`, { target });
            case 'maestro':
                if (scope !== 'global') throw new FixError(this.t('m38.fix.globalOnly', { target }));
                await this.applySetting(route.module, route.path, route.value, target);
                return this.t('m38.fix.done.global', { target });
            default:
                throw new FixError(adviceText(this.app, route.reason, fix, item, { target }));
        }
    }

    private async applyPreset(identifier: string, fix: AuditFix, scope: FixScope, target: string): Promise<void> {
        const store = this.app.modules.api<PresetStore>('presetStore');
        if (!store) throw new FixError(this.t('m38.fix.noPreset'));
        const layer = this.app.modules.api<PresetLayerApi>('presetLayer') ?? null;
        if (scope !== 'global' && !layer) throw new FixError(this.t('m38.fix.noLayer'));
        const base = store.current();
        const prompt = (store.working().prompts ?? []).find((entry) => entry.identifier === identifier);
        if (!prompt) throw new FixError(this.t('m38.fix.gone', { target }));
        let patch: Partial<PresetPrompt> | null = null;
        let op: LayerOp | null = null;
        switch (fix.kind) {
            case 'edit':
            case 'remove': {
                const next = applyText(promptText(prompt), fix.before ?? '', fix.after ?? '');
                if (next === null) throw new FixError(this.t('m38.fix.changed', { target }));
                patch = { content: next };
                break;
            }
            case 'role':
                if (!fix.role) throw new FixError(this.t('m38.fix.none'));
                patch = { role: fix.role };
                break;
            case 'move':
                if (fix.depth === undefined) throw new FixError(this.t('m38.fix.none'));
                patch = { injection_depth: fix.depth };
                break;
            case 'toggle':
                op = { op: 'toggle', identifier, enabled: fix.enabled === true };
                break;
            default:
                throw new FixError(this.t('m38.fix.none'));
        }
        if (patch) {
            const baseText = layer ? this.baseText(store, layer, base, identifier, scope) : '';
            op = { op: 'edit', identifier, patch, baseHash: baseHashOf(baseText), baseText };
        }
        // The layer first (it is what survives a new base), then the working copy for this session.
        if (layer && op) await layer.record(base, op, scope as LayerScope);
        if (patch) await store.updatePrompt(identifier, patch);
        else await store.setEnabled([identifier], fix.enabled === true);
    }

    /** The text an edit of `scope` is made on: the base with the lower scopes, else the saved base. */
    private baseText(
        store: PresetStore,
        layer: PresetLayerApi,
        base: string,
        identifier: string,
        scope: FixScope,
    ): string {
        let body: PresetBody | null = null;
        if (scope !== 'global') body = layer.below?.(base, scope) ?? null;
        if (!body) body = store.saved(base);
        if (!body) {
            try {
                body = layer.strip(base, store.working());
            } catch {
                body = null;
            }
        }
        const prompt = (body?.prompts ?? []).find((entry) => entry.identifier === identifier);
        return prompt ? promptText(prompt) : '';
    }

    /** The neighbour entry whose text holds the fix's quote, with the text form that matched. */
    private neighbourEntry(
        candidates: readonly string[],
        fix: AuditFix,
        scope: FixScope = 'global',
    ): { entry: NeighbourPrompt; next: string } | null {
        const api = this.app.modules.api<NeighbourPromptsApi>('neighbourPrompts');
        if (!api) return null;
        const name = this.app.host.ctx().name1 || 'User';
        for (const id of candidates) {
            const entry = api.get(id);
            if (!entry?.present) continue;
            const source = scope === 'global' ? entry.globalText : (entry.scoped[scope] ?? entry.text);
            for (const needle of neighbourNeedles(fix.before ?? '', name)) {
                const after =
                    needle === fix.before ? (fix.after ?? '') : (fix.after ?? '').split(name).join('{userName}');
                const next = applyText(source, needle, after);
                if (next !== null) return { entry, next };
            }
        }
        return null;
    }

    private async applyNeighbour(
        candidates: readonly string[],
        fix: AuditFix,
        scope: FixScope,
        target: string,
    ): Promise<void> {
        const api = this.app.modules.api<NeighbourPromptsApi>('neighbourPrompts');
        if (!api) throw new FixError(this.t('m38.fix.noNeighbours'));
        await api.ready();
        const found = this.neighbourEntry(candidates, fix, scope);
        if (!found) throw new FixError(this.t('m38.fix.changed', { target }));
        if (scope === 'global') {
            if (!found.entry.editable) throw new FixError(this.t('m38.fix.notEditable', { target }));
            await api.setGlobal(found.entry.id, found.next);
        } else {
            if (!found.entry.scopable) throw new FixError(this.t('m38.fix.notScopable', { target }));
            await api.setScoped(found.entry.id, scope, found.next);
        }
    }

    private async applySetting(module: string, path: string, value: unknown, target: string): Promise<void> {
        const slice = this.app.settings.module<Dict>(module);
        const check = checkSettingPath(slice, path);
        if (!check.ok) throw new FixError(this.t('m38.fix.gone', { target }));
        const before = check.current;
        if (before === value) return;
        writePath(slice, check.segments, value);
        this.app.settings.save();
        this.app.settings.notify(`modules.${module}.${path}`);
        try {
            await this.app.journal.record({
                module: MODULE_ID,
                kind: 'promptAudit.setting',
                summary: this.t('m38.journal.setting', { target }),
                changes: [{ target: SETTING_TARGET, ref: { module, path }, before, after: value }],
            });
        } catch (error) {
            this.log.warn('the prompt audit setting change was not journaled', error);
        }
    }

    /* ---------------------------------------------------------------- batches */

    /** Ids of the journal records of the chat open now. */
    journalIds(): Set<string> {
        return new Set(this.app.journal.list().map((record) => record.id));
    }

    /** One record whose undo undoes the batch's own records, newest first. */
    async recordBatch(ids: readonly string[], count: number): Promise<void> {
        if (!ids.length) return;
        try {
            await this.app.journal.record({
                module: MODULE_ID,
                kind: 'promptAudit.batch',
                summary: this.t('m38.journal.batch', { count }),
                changes: [{ target: BATCH_TARGET, ref: { records: [...ids] }, before: null, after: count }],
            });
        } catch (error) {
            this.log.warn('the prompt audit batch was not journaled', error);
        }
    }

    /* ---------------------------------------------------------------- undo */

    registerUndo(): void {
        this.app.journal.registerUndo(SETTING_TARGET, async (change) => this.undoSetting(change));
        this.app.journal.registerUndo(BATCH_TARGET, async (change) => this.undoBatch(change));
    }

    private async undoSetting(change: JournalChange): Promise<boolean> {
        const module = change.ref.module;
        const path = change.ref.path;
        if (typeof module !== 'string' || typeof path !== 'string') return false;
        const slice = this.app.settings.module<Dict>(module);
        const check = checkSettingPath(slice, path);
        if (!check.ok || check.current !== change.after) return false;
        writePath(slice, check.segments, change.before);
        this.app.settings.save();
        this.app.settings.notify(`modules.${module}.${path}`);
        return true;
    }

    private async undoBatch(change: JournalChange): Promise<boolean> {
        const ids = Array.isArray(change.ref.records)
            ? change.ref.records.filter((id): id is string => typeof id === 'string')
            : [];
        const records = new Map<string, JournalRecord>(this.app.journal.list().map((record) => [record.id, record]));
        let ok = true;
        for (const id of [...ids].reverse()) {
            const record = records.get(id);
            if (record?.undone) continue;
            if (!(await this.app.journal.undo(id))) ok = false;
        }
        return ok;
    }
}
