// «Твой слой» of the Preset Studio (M34 п.5–6, stage 5): the user's blocks and edits kept apart from the base preset
// (Maestro file per base preset name) and laid over it in OAI_PRESET_CHANGED_BEFORE (research/parity-preset.md
// §10.4 б). A new base (e.g. a Marinara update) is installed and the layer goes on top; text edits carry the base
// fingerprint, so a changed base gives a three-version conflict instead of a silent overwrite. Transfer to another
// preset by anchors; import of a foreign preset into blocks. Exposed as app.modules.api<PresetLayerApi>('presetLayer').
//
// Scopes (plan-2 «Области действия», release 1.13): the layer of a base has three parts laid over it in this order —
// «везде» ('global', the layer files above), «этот персонаж» ('character', a Maestro file per card avatar) and «этот
// чат» ('chat', a per-chat document). An op of a scope is made on (and takes its base fingerprint from) the base with
// the lower scopes applied (`below()`). On a chat switch the character/chat ops of the chat left are stripped from the
// working copy and those of the chat opened are laid on (the preset does not become «unsaved»); they never reach the
// preset FILE: every save of the file (the studio's, ST's own «Обновить пресет» and «Сохранить как», another
// extension's) is written without them. A whole preset can also be bound to the card or the chat (`bind()`): opening
// that chat selects it, leaving it brings back the preset that was active before. Existing layer files are the global
// scope as they are (no rewrite).
//
// For the second wave (assistant tools, prompt audit): read `get(base)` (ops tagged with their scope),
// `below(base, scope)` (what an op of that scope is made on), `context()`, `bindings()`; write with
// `record(base, op, scope)`, `moveOp(base, index, scope)`, `remove(base, index)`, `bind(scope, preset)`. Every write
// is journaled with undo.
import type { Unsubscribe } from '../../shared/contracts';
import type { PresetBody, PresetPrompt } from './store-api';

/** Where an edit lives: everywhere, in every chat of this card, or in this chat only. */
export type LayerScope = 'global' | 'character' | 'chat';

/** The scopes in the order they are laid over the base. */
export const LAYER_SCOPES: readonly LayerScope[] = ['global', 'character', 'chat'];

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

/** An op as `get()` gives it: with the scope it lives in and the owner of that scope (card avatar or chat id). */
export type ScopedLayerOp = LayerOp & { scope: LayerScope; owner?: string };

export interface Layer {
    /** Base preset name the layer belongs to. */
    base: string;
    /** Global ops first, then the card's, then the chat's (the order they are laid over the base). */
    ops: ScopedLayerOp[];
    updatedAt: number;
}

export interface LayerConflict {
    identifier: string;
    /** Base text the edit was made on, the new base text, the user's text. */
    oldBase: string;
    newBase: string;
    mine: string;
    /** The scope of the op in conflict (absent = global). */
    scope?: LayerScope;
}

export interface LayerApplyReport {
    applied: number;
    conflicts: LayerConflict[];
    /** Ops whose anchor or block was not found in this base (tagged with their scope when known). */
    orphaned: LayerOp[];
    /** Migration only: base blocks the edited preset no longer had (the layer switches them off instead). */
    removed?: string[];
}

/** The card and the chat the character and chat scopes point at now (the ones laid over the working copy). */
export interface LayerScopeInfo {
    /** null: no card (a group chat, the welcome screen) — the character scope is not available. */
    character: { avatar: string; name: string } | null;
    /** null: no chat open (or a group chat). */
    chat: { id: string } | null;
}

/** Presets bound to the card and the chat open now (null = none). */
export interface PresetBindings {
    character: string | null;
    chat: string | null;
    /** The binding that wins now (the chat's over the card's), null when none. */
    active: { scope: 'character' | 'chat'; preset: string } | null;
    context: LayerScopeInfo;
}

/** What changed, for `onChange` listeners: ops, the chat context (scopes switched), or a binding. */
export type LayerChange = 'ops' | 'context' | 'binding';

export interface PresetLayerApi {
    /**
     * The ops laid over `base` for the chat open now: global, then the card's, then the chat's, each tagged with its
     * scope. `options.scope` gives one scope only. Null when there are none. Indexes of `ops` (without
     * `options.scope`) are what `remove()` and `moveOp()` take.
     */
    get(base: string, options?: { scope?: LayerScope }): Layer | null;
    /**
     * Records an edit into the layer of a scope (default 'global'; the studio routes user edits here). A character or
     * chat scope needs that card / chat open (throws otherwise). An edit op without `baseHash` takes it from
     * `below(base, scope)`.
     */
    record(base: string, op: LayerOp, scope?: LayerScope): Promise<void>;
    /** Removes the op at an index of `get(base).ops`. */
    remove(base: string, index: number): Promise<void>;
    /** Pure application of every scope for the chat open now (used in OAI_PRESET_CHANGED_BEFORE and previews). */
    apply(base: string, body: PresetBody): { body: PresetBody; report: LayerApplyReport };
    /** The body without the layer (for «Сохранить базу»); `scopes` strips only those (default: all three). */
    strip(base: string, body: PresetBody, scopes?: readonly LayerScope[]): PresetBody;
    resolveConflict(
        base: string,
        identifier: string,
        choice: 'mine' | 'newBase' | { text: string },
        scope?: LayerScope,
    ): Promise<void>;
    /**
     * Migration (Q23): differences between `edited` and a reference base become ops of `scope` (default 'global').
     * For a scope, pass `reference = below(base, scope)` and `edited` without the scopes above it (`strip()`).
     */
    migrateFrom(base: string, reference: PresetBody, edited: PresetBody, scope?: LayerScope): Promise<LayerApplyReport>;
    /** Copies the global layer onto another base by anchors; returns what did not fit. */
    transfer(fromBase: string, toBase: string): Promise<LayerApplyReport>;
    /** Splits a foreign preset into blocks for picking (п.6). */
    importForeign(body: PresetBody): PresetPrompt[];
    /** Last report of the layer applied to the current preset (conflicts shown in the studio). */
    lastReport(): LayerApplyReport | null;
    onChange(listener: (change?: LayerChange) => void): Unsubscribe;
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
     * layer (the working copy becomes the plain base); 'saveMerged' saves base + global layer as a normal preset
     * (`name`, default «<base> (со слоем)») through the preset store and selects it. Resolves to the preset now
     * selected.
     */
    prepareDisable?(mode: 'reselectBase' | 'saveMerged', name?: string): Promise<string | null>;

    /* ---------------------------------------------------------------- scopes (release 1.13) */

    /** The card and the chat the scopes point at now. */
    context?(): LayerScopeInfo;
    /** Resolves when the scopes of the chat open now are loaded and laid over the working copy. */
    whenContext?(): Promise<LayerScopeInfo>;
    /** The saved base with the ops of the scopes below `scope` applied (null when the base is unknown). */
    below?(base: string, scope: LayerScope): PresetBody | null;
    /** Moves the op at an index of `get(base).ops` into another scope (its base values are taken anew there). */
    moveOp?(base: string, index: number, scope: LayerScope): Promise<void>;
    /** Presets bound to the card and the chat open now. */
    bindings?(): PresetBindings;
    /**
     * Binds a whole preset to the card or the chat open now (null unbinds). Journaled with undo. It does not switch
     * the preset itself: the studio's binder does that, through the unsaved-changes guard.
     */
    bind?(scope: 'character' | 'chat', preset: string | null): Promise<void>;
}
