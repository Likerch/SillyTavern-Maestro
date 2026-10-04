// «Твой слой» of the Preset Studio (M34 п.5–6, stage 5): the user's blocks and edits kept apart from the base preset
// (Maestro file per base preset name) and laid over it in OAI_PRESET_CHANGED_BEFORE (research/parity-preset.md
// §10.4 б). A new base (e.g. a Marinara update) is installed and the layer goes on top; text edits carry the base
// fingerprint, so a changed base gives a three-version conflict instead of a silent overwrite. Transfer to another
// preset by anchors; import of a foreign preset into blocks. Exposed as app.modules.api<PresetLayerApi>('presetLayer').
import type { Unsubscribe } from '../../shared/contracts';
import type { PresetBody, PresetPrompt } from './store-api';

export type LayerOp =
    /** A block of the user's own, placed after an anchor (an identifier, or a text anchor like `</task>`). */
    | { op: 'add'; prompt: PresetPrompt; anchor: LayerAnchor; enabled: boolean }
    /** A changed text/field of a base block; `baseHash` is the base text it was made on. */
    | {
          op: 'edit';
          identifier: string;
          patch: Partial<PresetPrompt>;
          baseHash: string;
          baseText?: string;
          /** Base values of the patched fields other than `content` (filled by record(), used by strip()). */
          baseFields?: Partial<PresetPrompt>;
          /** Patched fields the base block did not have (strip() deletes them). */
          baseMissing?: string[];
      }
    | {
          op: 'toggle';
          identifier: string;
          enabled: boolean;
          /** Base state (filled by record()). */ baseEnabled?: boolean;
      }
    | {
          op: 'move';
          identifier: string;
          anchor: LayerAnchor;
          /** Base place (filled by record()); null = the block was outside the base order. */
          baseAnchor?: LayerAnchor | null;
      }
    /** A body key override (preset key names: `temperature`, not `temp_openai`). */
    | {
          op: 'key';
          key: string;
          value: unknown;
          /** Base value (filled by record()). */
          baseValue?: unknown;
          /** The base had no such key (strip() deletes it). */
          baseUnset?: boolean;
      };

export type LayerAnchor =
    | { kind: 'after'; identifier: string }
    | { kind: 'before'; identifier: string }
    /** After the block whose content contains this text (portable between presets). */
    | { kind: 'afterText'; text: string }
    | { kind: 'start' }
    | { kind: 'end' };

export interface Layer {
    /** Base preset name the layer belongs to. */
    base: string;
    ops: LayerOp[];
    updatedAt: number;
}

export interface LayerConflict {
    identifier: string;
    /** Base text the edit was made on, the new base text, the user's text. */
    oldBase: string;
    newBase: string;
    mine: string;
}

export interface LayerApplyReport {
    applied: number;
    conflicts: LayerConflict[];
    /** Ops whose anchor or block was not found in this base. */
    orphaned: LayerOp[];
    /** Migration only: base blocks the edited preset no longer had (the layer switches them off instead). */
    removed?: string[];
}

export interface PresetLayerApi {
    get(base: string): Layer | null;
    /** Records a studio edit into the layer (the studio routes user edits here by default). */
    record(base: string, op: LayerOp): Promise<void>;
    remove(base: string, index: number): Promise<void>;
    /** Pure application (used in OAI_PRESET_CHANGED_BEFORE and for previews). */
    apply(base: string, body: PresetBody): { body: PresetBody; report: LayerApplyReport };
    /** The base body without the layer (for «Сохранить базу»). */
    strip(base: string, body: PresetBody): PresetBody;
    resolveConflict(base: string, identifier: string, choice: 'mine' | 'newBase' | { text: string }): Promise<void>;
    /** Migration (Q23): differences between the current working preset and a reference base become layer ops. */
    migrateFrom(base: string, reference: PresetBody, edited: PresetBody): Promise<LayerApplyReport>;
    /** Copies the layer onto another base by anchors; returns what did not fit. */
    transfer(fromBase: string, toBase: string): Promise<LayerApplyReport>;
    /** Splits a foreign preset into blocks for picking (п.6). */
    importForeign(body: PresetBody): PresetPrompt[];
    /** Last report of the layer applied to the current preset (conflicts shown in the studio). */
    lastReport(): LayerApplyReport | null;
    onChange(listener: () => void): Unsubscribe;
    /** Resolves when the stored layers are loaded (install() starts loading). */
    ready?(): Promise<void>;
    /** Writes pending (debounced) layer changes now. */
    flush?(): Promise<void>;
    /** Preview of migrateFrom without saving: the ops and the report of applying them to the reference. */
    planMigration?(reference: PresetBody, edited: PresetBody): { ops: LayerOp[]; report: LayerApplyReport };
    /**
     * Reselects a preset (default: the current one) through ST, so OAI_PRESET_CHANGED_BEFORE lays the layer over it.
     * Unsaved changes of the working copy are replaced (the caller warns). Resolves to the name, or null.
     */
    reselect?(name?: string): Promise<string | null>;
    /**
     * «Подготовить к отключению» (plan §4.9, P11): 'reselectBase' reselects the current preset once without the
     * layer (the working copy becomes the plain base); 'saveMerged' saves base + layer as a normal preset (`name`,
     * default «<base> (со слоем)») through the preset store and selects it. Resolves to the preset now selected.
     */
    prepareDisable?(mode: 'reselectBase' | 'saveMerged', name?: string): Promise<string | null>;
}
