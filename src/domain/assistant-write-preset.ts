// Preset blocks written by the assistant (M33 «флаги и блоки пресета», M34 п.5 and п.8): a new block of the user's
// layer goes to a place in the prompt list (start, end, after or before a block, or into the chat at a depth), a
// condition wraps a block's text in `{{if .flag}}…{{/if}}` (domain/preset-conditional-check.ts applyCondition), and
// a flag must be one Maestro sets (its catalogue) or a valid `maestro_*` name. Pure: no DOM, no SillyTavern.
import { ArgError } from './assistant-write-args';
import { applyCondition } from './preset-conditional-check';
import type { ConditionChoice } from './preset-conditional-check';
import { isFlagName, isMaestroFlag } from './preset-conditional-syntax';

export const BLOCK_PLACES = ['start', 'end', 'after', 'before'] as const;
export type BlockPlace = (typeof BLOCK_PLACES)[number];

export const CONDITION_MODES = ['only', 'except', 'always'] as const;
export type ConditionMode = (typeof CONDITION_MODES)[number];

/** The layer's anchor (structural copy of features/presetStudio/layer-api.ts LayerAnchor; domain cannot import it). */
export type BlockAnchor =
    | { kind: 'after'; identifier: string }
    | { kind: 'before'; identifier: string }
    | { kind: 'start' }
    | { kind: 'end' };

export function anchorOf(place: BlockPlace, block: string | null): BlockAnchor {
    if (place === 'after' || place === 'before') {
        if (!block) throw new ArgError('presetNeedAnchor', { place });
        return { kind: place, identifier: block };
    }
    return { kind: place };
}

/**
 * The block to insert after in the working copy's order (the preset store's `addPrompt(prompt, after)`; undefined
 * puts the block first): the last one for 'end', the anchor for 'after', the one before the anchor for 'before'.
 */
export function storeAfterOf(order: readonly string[], anchor: BlockAnchor): string | undefined {
    switch (anchor.kind) {
        case 'start':
            return undefined;
        case 'end':
            return order[order.length - 1];
        case 'after':
            return anchor.identifier;
        case 'before': {
            const index = order.indexOf(anchor.identifier);
            return index > 0 ? order[index - 1] : undefined;
        }
    }
}

/** The condition choice of the studio's editor for a mode. */
export function conditionChoice(mode: ConditionMode, flag: string | null): ConditionChoice {
    if (mode === 'always') return { mode: 'always' };
    if (!flag) throw new ArgError('presetFlagNeeded', { mode });
    return { mode: mode === 'only' ? 'when' : 'unless', flag };
}

/** Where a flag comes from: Maestro's catalogue, or only a valid `maestro_*` name nobody announced. */
export type FlagStanding = 'catalogue' | 'maestro';

/** Checks a flag; throws when it is not a name `{{if .name}}` takes, or neither catalogued nor `maestro_*`. */
export function flagStanding(flag: string, catalogue: readonly string[]): FlagStanding {
    if (!isFlagName(flag)) throw new ArgError('presetFlagInvalid', { flag });
    if (catalogue.includes(flag)) return 'catalogue';
    if (isMaestroFlag(flag)) return 'maestro';
    throw new ArgError('presetFlagUnknown', { flag, list: catalogue.join(', ') });
}

/** The block text with the condition; throws when the text has stray tags the new ones would pair with. */
export function conditionedText(content: string, choice: ConditionChoice): string {
    const result = applyCondition(content, choice);
    if (result.ok) return result.text;
    if (result.reason === 'flag')
        throw new ArgError('presetFlagInvalid', { flag: 'flag' in choice ? choice.flag : '' });
    throw new ArgError('presetBlocked');
}
