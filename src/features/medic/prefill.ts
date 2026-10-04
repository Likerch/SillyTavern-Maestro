// Assistant "prefill" at the end of the active Chat Completion preset (plan M3, M22, dev-plan 1.12): detection and
// the fix "switch that prompt's role to user". The fix is level 'ask' (and never 'auto', plan §8: preset changes):
// after confirmation it changes the live settings (oai_settings) and the saved preset file — only that prompt's
// role, read from ST's cached copy of the file (openai.js `openai_settings`), saved through the preset manager
// (preset-manager.js savePreset). Journaled with an undo; the guardian (M4) acknowledges the change.
import { activePromptOrder, findAssistantPrefill, promptIndex } from '../../domain/medic-prefill';
import type { PrefillHit } from '../../domain/medic-prefill';
import type { App, JournalChange, Logger, Proposal } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';

export const PREFILL_KIND = 'medic.prefillRole';
export const PREFILL_TARGET = 'preset-prompt-role';

type Dict = Record<string, unknown>;
type Translate = (key: string, params?: Record<string, string | number>) => string;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PrefillPayload {
    preset: string;
    identifier: string;
    from: string;
    to: string;
}

/** Live Chat Completion settings (oai_settings) or null. */
function liveSettings(app: App): Dict | null {
    const settings = (app.host.ctx() as unknown as { chatCompletionSettings?: unknown }).chatCompletionSettings;
    return isDict(settings) ? settings : null;
}

/** The assistant prompt that ends the request with the active preset, if any. */
export function detectPrefill(app: App): PrefillHit | null {
    if (!app.host.isChatCompletion()) return null;
    const settings = liveSettings(app);
    if (!settings) return null;
    return findAssistantPrefill(settings.prompts, activePromptOrder(settings.prompt_order));
}

export class PrefillFix {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly t: Translate,
    ) {}

    /** Proposes the fix for the detected prompt (autonomy level 'ask'). */
    async propose(hit: PrefillHit): Promise<boolean> {
        const settings = liveSettings(this.app);
        const preset = typeof settings?.preset_settings_openai === 'string' ? settings.preset_settings_openai : '';
        const payload: PrefillPayload = { preset, identifier: hit.identifier, from: 'assistant', to: 'user' };
        const change: JournalChange = {
            target: PREFILL_TARGET,
            ref: { preset, identifier: hit.identifier },
            before: 'assistant',
            after: 'user',
        };
        const proposal: Proposal<PrefillPayload> = {
            module: 'M3',
            kind: PREFILL_KIND,
            title: this.t('m3.prefill.title', { name: hit.name, preset }),
            description: this.t('m3.prefill.description', { name: hit.name }),
            changes: [change],
            payload,
            apply: (value) => this.setRole(value.preset, value.identifier, value.to),
            stillValid: async () => this.roleOf(hit.identifier) === 'assistant',
        };
        const decision = await this.app.autonomy.decide(proposal, 'ask');
        return decision === 'applied';
    }

    /** Undo handler of PREFILL_TARGET. */
    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref as { preset?: unknown; identifier?: unknown };
        if (typeof ref.identifier !== 'string' || typeof change.before !== 'string') return false;
        if (this.roleOf(ref.identifier) !== change.after) return false;
        await this.setRole(typeof ref.preset === 'string' ? ref.preset : '', ref.identifier, change.before);
        return true;
    }

    private roleOf(identifier: string): string | undefined {
        const prompts = liveSettings(this.app)?.prompts;
        const index = promptIndex(prompts, identifier);
        const prompt = Array.isArray(prompts) && index >= 0 ? (prompts[index] as Dict) : undefined;
        return prompt ? (typeof prompt.role === 'string' ? prompt.role : 'system') : undefined;
    }

    /** Sets the role in the live settings and in the saved preset file, then saves settings and re-renders. */
    async setRole(preset: string, identifier: string, role: string): Promise<void> {
        const settings = liveSettings(this.app);
        const prompts = settings?.prompts;
        const index = promptIndex(prompts, identifier);
        if (!settings || !Array.isArray(prompts) || index < 0) throw new Error(`prompt ${identifier} not found`);
        (prompts[index] as Dict).role = role;
        if (preset) await this.writePresetFile(preset, identifier, role);
        await this.rerender();
        this.app.host.ctx().saveSettingsDebounced();
        const guardian = this.app.modules.api<GuardianApi>('guardian');
        if (guardian) await guardian.acknowledge(['preset.roles', 'preset.body', 'preset.contents']);
    }

    private async writePresetFile(preset: string, identifier: string, role: string): Promise<void> {
        const caps = this.app.host.caps;
        if (!caps.has('st.oai.promptManager') || !caps.has('st.presetManager')) {
            this.log.warn('preset file not updated: ST preset modules unavailable');
            return;
        }
        const openai = await this.app.host.modules.openai();
        const names = openai.openai_setting_names;
        const list = openai.openai_settings;
        const slot = isDict(names) ? names[preset] : undefined;
        const stored = Array.isArray(list) && typeof slot === 'number' ? list[slot] : undefined;
        if (!isDict(stored)) {
            this.log.warn(`preset ${preset} is not in ST's preset list; only the live settings changed`);
            return;
        }
        const body = structuredClone(stored);
        const index = promptIndex(body.prompts, identifier);
        if (index < 0 || !Array.isArray(body.prompts)) return;
        (body.prompts[index] as Dict).role = role;
        const managerModule = await this.app.host.modules.presetManager();
        const getManager = managerModule.getPresetManager as ((apiId: string) => unknown) | undefined;
        const manager = typeof getManager === 'function' ? getManager('openai') : null;
        const save = isDict(manager) ? manager.savePreset : undefined;
        if (typeof save !== 'function') {
            this.log.warn('preset manager has no savePreset; only the live settings changed');
            return;
        }
        // skipUpdate: updateList() would re-select the preset and load the file over the live settings, dropping
        // the user's unsaved edits. ST's cached copy is updated by hand instead (what updateList does first).
        await (save as (name: string, settings: unknown, options: unknown) => Promise<void>).call(
            manager,
            preset,
            body,
            { skipUpdate: true },
        );
        if (Array.isArray(list) && typeof slot === 'number') list[slot] = body;
    }

    private async rerender(): Promise<void> {
        if (!this.app.host.caps.has('st.oai.promptManager')) return;
        try {
            const openai = await this.app.host.modules.openai();
            const manager = openai.promptManager;
            const render = isDict(manager) ? manager.render : undefined;
            if (typeof render === 'function') (render as (after?: boolean) => void).call(manager, false);
        } catch (error) {
            this.log.debug('prompt manager render failed', error);
        }
    }
}
