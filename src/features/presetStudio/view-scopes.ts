// «Области действия» in the Preset Studio (plan-2: везде / этот персонаж / этот чат): the scope switch for where new
// edits go (block editor, «Слой» tab), scope names for the layer's op list, and the preset bound to the card or the
// chat in the header. Strings: scope-strings.ts.
import { el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { LayerScope, LayerScopeInfo, PresetBindings } from './layer-api';

/** «Везде» / «Персонаж Алиса» / «Этот чат». */
export function scopeLabel(app: App, scope: LayerScope, context: LayerScopeInfo | null): string {
    if (scope === 'character') {
        const name = context?.character?.name;
        return name ? app.i18n.t('m34.scope.characterNamed', { name }) : app.i18n.t('m34.scope.character');
    }
    return app.i18n.t(`m34.scope.${scope}`);
}

/** The scopes this context offers: global always, the card's and the chat's when they are open. */
export function availableScopes(context: LayerScopeInfo | null): LayerScope[] {
    const scopes: LayerScope[] = ['global'];
    if (context?.character) scopes.push('character');
    if (context?.chat) scopes.push('chat');
    return scopes;
}

export interface ScopeSelectOptions {
    value: LayerScope;
    context: LayerScopeInfo | null;
    onChange(scope: LayerScope): void;
    className?: string;
    label?: string;
}

/** A select of the scopes the chat open now offers (a scope it lacks shows as «Везде»). */
export function scopeSelect(app: App, options: ScopeSelectOptions): HTMLSelectElement {
    const scopes = availableScopes(options.context);
    const select = el('select', {
        class: ['text_pole', 'maestro-m34-scope', options.className],
        attrs: { 'aria-label': options.label ?? app.i18n.t('m34.scope.where') },
    });
    for (const scope of scopes) {
        select.append(el('option', { text: scopeLabel(app, scope, options.context), attrs: { value: scope } }));
    }
    select.value = scopes.includes(options.value) ? options.value : 'global';
    select.disabled = scopes.length < 2;
    select.addEventListener('change', () => options.onChange(select.value as LayerScope));
    return select;
}

/** The labelled scope switch of the block editor and the «Слой» tab. */
export function scopeField(app: App, options: ScopeSelectOptions & { hint?: boolean }): HTMLElement {
    const select = scopeSelect(app, options);
    return el('div', { class: 'maestro-m34-field maestro-m34-scope-field' }, [
        el('label', { class: 'maestro-m34-label', text: options.label ?? app.i18n.t('m34.scope.where') }, [select]),
        options.hint === false ? null : el('div', { class: 'maestro-field-hint', text: app.i18n.t('m34.scope.hint') }),
    ]);
}

/** «Пресет этого чата» / «Пресет персонажа Алиса» for the header and the launcher, or null without a binding. */
export function bindingText(app: App, bindings: PresetBindings | null): string | null {
    const active = bindings?.active;
    if (!active) return null;
    if (active.scope === 'chat') return app.i18n.t('m34.binding.activeChat', { name: active.preset });
    const who = bindings.context.character?.name ?? '';
    return app.i18n.t('m34.binding.activeCharacter', { name: active.preset, character: who });
}
