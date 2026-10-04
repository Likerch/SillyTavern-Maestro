// Entry form of the Lore Studio (M23 stage 2): implements the RenderEntryForm contract of ../form-api.ts.
import type { RenderEntryForm } from '../form-api';
import { mountEntryForm } from './form';

export { ENTRY_FORM_STRINGS } from './strings';
export { ENTRY_FORM_CSS } from './style';
export { EntryForm, mountEntryForm } from './form';

/**
 * Renders the full entry editor into `container` and returns its disposer (removes the DOM, the stylesheet when no
 * other form uses it, the store/canon subscriptions and every timer). Registers its i18n strings on first use.
 */
export const renderEntryForm: RenderEntryForm = (container, ctx) => mountEntryForm(container, ctx).dispose;
