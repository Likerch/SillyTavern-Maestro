// «Промпты соседей» tab of the Preset Studio (plan-2 §2 п. 5, «Области действия» п. 3): the instruction texts other
// extensions put into the prompt (M36 neighbourPrompts/api.ts), grouped by extension. Each entry shows what goes to the
// model in this chat and lets you change it everywhere (the extension's own setting), keep a copy for this character
// or this chat (Maestro puts it in at generation time), or bring back what was there («Вернуть как было»).
import { banner, emptyState } from '../../ui/components/card';
import { button, el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { NeighbourOwner, NeighbourPrompt, NeighbourPromptsApi, NeighbourScope } from '../neighbourPrompts/api';

export type NeighbourEditScope = 'global' | NeighbourScope;

export interface NeighboursPanelDeps {
    api: NeighbourPromptsApi | null;
    /** Which entry is open for editing and where its text goes (kept by the studio across re-renders). */
    state: { open: string | null; scope: NeighbourEditScope };
    /** Runs an action with the studio's error handling. */
    run<T>(action: () => Promise<T>): Promise<T | undefined>;
    confirm(title: string, body: string): Promise<boolean>;
    rerender(): void;
}

const OWNERS: readonly NeighbourOwner[] = ['des', 'nai', 'qvink', 'desru', 'ck', 'maestro'];

/** The scopes an entry can be written to now. */
export function entryScopes(entry: NeighbourPrompt): NeighbourEditScope[] {
    const scopes: NeighbourEditScope[] = [];
    if (entry.editable) scopes.push('global');
    if (entry.scopable) scopes.push('character', 'chat');
    return scopes;
}

/** The text an editor opens with for a scope: the copy there, else what goes to the model now. */
function startText(entry: NeighbourPrompt, scope: NeighbourEditScope): string {
    if (scope === 'global') return entry.globalText;
    return entry.scoped[scope] ?? entry.text;
}

export function renderNeighboursPanel(app: App, deps: NeighboursPanelDeps): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-neighbours' });
    if (!deps.api) {
        root.append(banner(t('m34.neighbours.unavailable'), 'info', 'fa-circle-info'));
        return root;
    }
    const api: NeighbourPromptsApi = deps.api;
    root.append(el('p', { class: 'maestro-field-hint', text: t('m34.neighbours.intro') }));
    const report = api.lastReport();
    if (report && (report.replaced.length || report.notFound.length)) {
        const name = (id: string) => api.get(id)?.label ?? id;
        root.append(
            el('div', {
                class: report.notFound.length ? 'maestro-warn-text' : 'maestro-muted',
                text: [
                    report.replaced.length
                        ? t('m34.neighbours.replaced', { names: report.replaced.map(name).join(', ') })
                        : '',
                    report.notFound.length
                        ? t('m34.neighbours.notFound', { names: report.notFound.map(name).join(', ') })
                        : '',
                ]
                    .filter(Boolean)
                    .join(' '),
            }),
        );
    }
    const entries = api.list();
    const visible = entries.filter((entry) => entry.present);
    if (!visible.length) {
        root.append(emptyState(t('m34.neighbours.none'), 'fa-puzzle-piece'));
        return root;
    }
    for (const owner of OWNERS) {
        const items = visible.filter((entry) => entry.owner === owner);
        if (!items.length) continue;
        root.append(
            el('section', { class: 'maestro-m34-neighbour-group', data: { owner } }, [
                el('h4', { class: 'maestro-m34-h', text: t(`m34.neighbours.owner.${owner}`) }),
                ...items.map((entry) => renderEntry(entry)),
            ]),
        );
    }
    return root;

    function badges(entry: NeighbourPrompt): HTMLElement {
        const list: string[] = [];
        if (entry.scoped.chat !== undefined) list.push(t('m34.neighbours.badge.chat'));
        if (entry.scoped.character !== undefined) list.push(t('m34.neighbours.badge.character'));
        if (!entry.editable && !entry.scopable) list.push(t('m34.neighbours.badge.readOnly'));
        if (entry.usedIn === 'background') list.push(t('m34.neighbours.badge.background'));
        return el(
            'span',
            { class: 'maestro-m34-neighbour-badges' },
            list.map((text) => el('span', { class: 'maestro-m34-badge maestro-m34-badge-layer', text })),
        );
    }

    function renderEntry(entry: NeighbourPrompt): HTMLElement {
        const open = deps.state.open === entry.id;
        const scopes = entryScopes(entry);
        const node = el('div', { class: 'maestro-m34-neighbour', data: { id: entry.id } }, [
            el('div', { class: 'maestro-m34-neighbour-head' }, [el('strong', { text: entry.label }), badges(entry)]),
            el('div', { class: 'maestro-muted', text: entry.description }),
            entry.note ? el('div', { class: 'maestro-field-hint', text: entry.note }) : null,
        ]);
        const preview = el('details', { class: 'maestro-m34-neighbour-text' }, [
            el('summary', {
                text: entry.text.trim() ? t('m34.neighbours.showText') : t('m34.neighbours.emptyText'),
            }),
            el('div', { class: 'maestro-m34-text', text: entry.text }),
        ]);
        node.append(preview);
        if (!scopes.length) return node;
        if (!open) {
            node.append(
                el('div', { class: 'maestro-row' }, [
                    button({
                        icon: 'fa-pen',
                        label: t('m34.neighbours.edit'),
                        className: 'maestro-m34-neighbour-edit',
                        onClick: () => {
                            deps.state.open = entry.id;
                            deps.state.scope = scopes[0] ?? 'global';
                            deps.rerender();
                        },
                    }),
                    ...resetButtons(entry),
                ]),
            );
            return node;
        }
        const scope = scopes.includes(deps.state.scope) ? deps.state.scope : (scopes[0] ?? 'global');
        const select = el('select', {
            class: 'text_pole maestro-m34-neighbour-scope',
            attrs: { 'aria-label': t('m34.scope.where') },
        });
        for (const item of scopes) {
            select.append(el('option', { text: t(`m34.neighbours.scope.${item}`), attrs: { value: item } }));
        }
        select.value = scope;
        const area = el('textarea', {
            class: 'text_pole maestro-m34-neighbour-area',
            attrs: { rows: 10, spellcheck: 'false' },
        });
        area.value = startText(entry, scope);
        select.addEventListener('change', () => {
            deps.state.scope = select.value as NeighbourEditScope;
            area.value = startText(entry, deps.state.scope);
        });
        node.append(
            el('div', { class: 'maestro-m34-neighbour-editor' }, [
                el('label', { class: 'maestro-m34-label', text: t('m34.scope.where') }, [select]),
                el('div', { class: 'maestro-field-hint', text: t('m34.neighbours.scopeHint') }),
                area,
                el('div', { class: 'maestro-row' }, [
                    button({
                        icon: 'fa-floppy-disk',
                        label: t('m34.neighbours.save'),
                        kind: 'primary',
                        className: 'maestro-m34-neighbour-save',
                        onClick: async () => {
                            const target = select.value as NeighbourEditScope;
                            const text = area.value;
                            const done = await deps.run(async () => {
                                if (target === 'global') await api.setGlobal(entry.id, text);
                                else await api.setScoped(entry.id, target, text);
                                return true;
                            });
                            if (!done) return;
                            deps.state.open = null;
                            app.ui.notice(t(`m34.neighbours.saved.${target}`, { name: entry.label }), { urgent: true });
                            deps.rerender();
                        },
                    }),
                    button({
                        label: t('m34.neighbours.cancel'),
                        kind: 'ghost',
                        className: 'maestro-m34-neighbour-cancel',
                        onClick: () => {
                            deps.state.open = null;
                            deps.rerender();
                        },
                    }),
                ]),
            ]),
        );
        return node;
    }

    /** «Вернуть как было»: the extension's own text everywhere, or no copy for this character / chat. */
    function resetButtons(entry: NeighbourPrompt): HTMLElement[] {
        const out: HTMLElement[] = [];
        const reset = (scope: NeighbourEditScope, label: string) =>
            button({
                icon: 'fa-arrow-rotate-left',
                label,
                className: `maestro-m34-neighbour-reset maestro-m34-neighbour-reset-${scope}`,
                onClick: async () => {
                    const body = t(`m34.neighbours.resetBody.${scope}`, { name: entry.label });
                    if (!(await deps.confirm(t('m34.neighbours.resetTitle'), body))) return;
                    const done = await deps.run(async () => {
                        if (scope === 'global') await api.setGlobal(entry.id, '');
                        else await api.setScoped(entry.id, scope, null);
                        return true;
                    });
                    if (done) deps.rerender();
                },
            });
        if (entry.scoped.chat !== undefined) out.push(reset('chat', t('m34.neighbours.reset.chat')));
        if (entry.scoped.character !== undefined) out.push(reset('character', t('m34.neighbours.reset.character')));
        if (entry.editable && entry.setting) out.push(reset('global', t('m34.neighbours.reset.global')));
        return out;
    }
}
