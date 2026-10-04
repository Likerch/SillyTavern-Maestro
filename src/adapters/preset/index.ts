// The Chat Completion preset (Prompt Manager), Marinara's Spaghetti Recipe in the reference stack (plan §2).
// Not an extension: present when the main API is Chat Completion and ST's live `oai_settings`
// (`ctx.chatCompletionSettings`) holds a Prompt Manager prompt list. Read-only: presets are saved only by the
// user's explicit action (plan §10.16).
//
// Capabilities:
// - `preset.cc`       Chat Completion is the main API and the Prompt Manager has prompts and an order;
// - `preset.marinara` the active preset looks like Marinara's Spaghetti Recipe. Heuristic (no Marinara file is
//   checked into this repo): the preset name mentions "Marinara" or "Spaghetti", or the prompts use Marinara's
//   section tags — some prompt content opens `<instructions>` and some opens `<output_format>`.
import { NeighbourBase, extras, isDict } from '../base';
import type { AdapterDeps, Dict } from '../base';

export interface PresetPromptInfo {
    identifier: string;
    name: string;
    role: string;
    /** Built-in markers (chatHistory, worldInfoBefore, …) have no content of their own. */
    marker: boolean;
}

const MARINARA_NAME_RE = /marinara|spaghetti/i;
const MARINARA_SECTION_TAGS = ['<instructions>', '<output_format>'] as const;

export class PresetAdapter extends NeighbourBase<'preset'> {
    readonly id = 'preset' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('preset.cc', () => this.present());
        this.capability('preset.marinara', () => this.present() && this.isMarinara());
    }

    present(): boolean {
        const settings = this.settings();
        return (
            this.host.isChatCompletion() &&
            settings !== null &&
            Array.isArray(settings.prompts) &&
            settings.prompts.length > 0 &&
            Array.isArray(settings.prompt_order)
        );
    }

    /** No manifest: the preset is part of ST. */
    override version(): string | undefined {
        return undefined;
    }

    protected async connect(): Promise<boolean> {
        return true;
    }

    /** ST's live Chat Completion settings (`oai_settings`); read-only for Maestro. */
    settings(): Dict | null {
        const settings = extras(this.host).chatCompletionSettings;
        return isDict(settings) ? settings : null;
    }

    /** Name of the active Chat Completion preset. */
    presetName(): string | undefined {
        const name = this.settings()?.preset_settings_openai;
        return typeof name === 'string' && name ? name : undefined;
    }

    /** Prompt Manager prompts of the live settings (identity fields only). */
    prompts(): PresetPromptInfo[] {
        const prompts = this.settings()?.prompts;
        if (!Array.isArray(prompts)) return [];
        return prompts.filter(isDict).map((prompt) => ({
            identifier: typeof prompt.identifier === 'string' ? prompt.identifier : '',
            name: typeof prompt.name === 'string' ? prompt.name : '',
            role: typeof prompt.role === 'string' ? prompt.role : 'system',
            marker: prompt.marker === true,
        }));
    }

    /** See `preset.marinara` above. */
    isMarinara(): boolean {
        if (MARINARA_NAME_RE.test(this.presetName() ?? '')) return true;
        const prompts = this.settings()?.prompts;
        if (!Array.isArray(prompts)) return false;
        const contents = prompts
            .filter(isDict)
            .map((prompt) => (typeof prompt.content === 'string' ? prompt.content : ''));
        return MARINARA_SECTION_TAGS.every((tag) => contents.some((content) => content.includes(tag)));
    }
}
