// The neighbour skins of the unified look (M32, part B): one per neighbour, each a stylesheet scoped to
// `html.maestro-theme.maestro-theme-<id>`, plus their strings. The theme module injects the CSS and lists the parts
// whose neighbour is present.
import type { NeighbourId, NeighbourSkin } from '../api';
import { CK_SKIN } from './ck';
import { DES_SKIN } from './des';
import { DESRU_SKIN } from './desru';
import { LOCALIZER_SKIN } from './localizer';
import { NAI_SKIN } from './nai';
import { QVINK_SKIN } from './qvink';

export { NEIGHBOUR_STRINGS } from './strings';
export { CK_PROBES, CK_SKIN } from './ck';
export { DES_PROBES, DES_SKIN } from './des';
export { DESRU_PROBES, DESRU_SKIN } from './desru';
export { LOCALIZER_PROBES, LOCALIZER_SKIN } from './localizer';
export { NAI_PROBES, NAI_SKIN } from './nai';
export { QVINK_PROBES, QVINK_SKIN } from './qvink';
export { skinScope } from './common';

/** Every neighbour skin, in the order of the parts in the settings. */
export const NEIGHBOUR_SKINS: NeighbourSkin[] = [DES_SKIN, CK_SKIN, NAI_SKIN, DESRU_SKIN, QVINK_SKIN, LOCALIZER_SKIN];

/** The skin of one neighbour. */
export function neighbourSkin(id: NeighbourId): NeighbourSkin | undefined {
    return NEIGHBOUR_SKINS.find((skin) => skin.id === id);
}
