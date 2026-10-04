// Pult tab «Сигналы» (S4): signals waiting for the revision, grouped by kind, each with a link to its message, and
// the last compared turn. Read-only: the revision (M8) consumes the signals.
import type { App, PultTab, Signal } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { SignalBatch, SignalKind } from './api';
import type { SignalsService } from './service';

export const SIGNALS_TAB = 'signals';

/** Order of kinds in the tab. */
export const KIND_ORDER: readonly SignalKind[] = [
    'scene.ended',
    'location.changed',
    'time.skipped',
    'relationship.changed',
    'appearance.changed',
    'character.appeared',
    'character.left',
    'quest.added',
    'quest.removed',
    'alias.added',
    'memory.long',
    'memory.added',
    'name.new',
    'fact.new',
];

export const SIGNALS_CSS = `
.maestro-s4-kind { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.maestro-s4-kind-head { display: flex; gap: 6px; align-items: center; font-weight: 600; }
.maestro-s4-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm); padding: 2px 6px; }
.maestro-s4-text { flex: 1 1 200px; overflow-wrap: anywhere; }
.maestro-s4-row .maestro-btn { min-height: 28px; padding: 0 8px; }
`;

type Translate = (key: string, params?: Record<string, string | number>) => string;

function str(value: unknown): string {
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** One line describing a signal (kind title shown separately). */
export function describeSignal(signal: Signal, t: Translate): string {
    const data = signal.data ?? {};
    const none = t('s4.none');
    let text: string;
    switch (signal.kind) {
        case 'relationship.changed':
            text = t('s4.text.change', { name: str(data.name), from: str(data.from) || none, to: str(data.to) });
            break;
        case 'appearance.changed': {
            const changes = Array.isArray(data.changes) ? (data.changes as Record<string, unknown>[]) : [];
            const fields = changes.map((change) => {
                const aspect = str(change.aspect);
                return aspect ? `${str(change.field)} (${t(`s4.aspect.${aspect}`)})` : str(change.field);
            });
            text = t('s4.text.appearance', { name: str(data.name), fields: fields.join(', ') || none });
            break;
        }
        case 'location.changed':
            text = t('s4.text.move', { from: str(data.from) || none, to: str(data.to) });
            break;
        case 'time.skipped': {
            const from = str(data.fromDate) || str(data.fromTime) || none;
            const to = str(data.toDate) || str(data.toTime) || none;
            text =
                typeof data.hours === 'number'
                    ? t('s4.text.hours', { from, to, hours: data.hours })
                    : t('s4.text.move', { from, to });
            break;
        }
        case 'scene.ended': {
            const reasons = Array.isArray(data.reasons)
                ? data.reasons.map((reason) => t(`s4.reason.${str(reason)}`))
                : [];
            text = t('s4.text.scene', { reasons: reasons.join(', ') || none });
            break;
        }
        case 'quest.added':
        case 'quest.removed':
            text = data.main === true ? t('s4.text.main', { title: str(data.title) }) : str(data.title);
            break;
        case 'character.appeared':
        case 'character.left':
            text = data.first === true ? t('s4.text.first', { name: str(data.name) }) : str(data.name);
            break;
        case 'alias.added':
            text = t('s4.text.aliases', {
                name: str(data.name),
                aliases: Array.isArray(data.aliases) ? data.aliases.map(str).join(', ') : none,
            });
            break;
        case 'memory.long':
        case 'memory.added': {
            const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
            text = t('s4.text.memory', { indices: items.map((item) => `#${str(item.index)}`).join(', ') || none });
            break;
        }
        case 'name.new':
            text = data.quoted === true ? `«${str(data.name)}»` : str(data.name);
            break;
        default:
            text = str(data.text) || str(data.name) || str(data.title) || signal.entity || none;
    }
    const folded = typeof data.folded === 'number' && data.folded > 0 ? data.folded + 1 : 0;
    return folded ? `${text} ${t('s4.folded', { count: folded })}` : text;
}

/** Jumps to a message (`/chat-jump` loads older messages first) after closing the pult. */
async function jump(app: App, index: number): Promise<void> {
    app.ui.closePult?.();
    const ctx = app.host.ctx();
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return;
    try {
        await ctx.executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true });
    } catch (error) {
        app.log.debug('chat-jump failed', error);
    }
}

export function signalsTab(app: App, service: SignalsService): PultTab {
    const t: Translate = app.i18n.t.bind(app.i18n);

    const row = (signal: Signal): HTMLElement =>
        el('div', { class: 'maestro-s4-row' }, [
            el('span', { class: 'maestro-s4-text', text: describeSignal(signal, t) }),
            typeof signal.messageIndex === 'number'
                ? button({
                      label: `#${signal.messageIndex}`,
                      kind: 'ghost',
                      title: t('s4.jump', { index: signal.messageIndex }),
                      onClick: () => jump(app, signal.messageIndex as number),
                  })
                : null,
        ]);

    const grouped = (signals: readonly Signal[]): HTMLElement[] => {
        const kinds = [...new Set(signals.map((signal) => signal.kind))].sort((a, b) => {
            const rank = (kind: string) => {
                const index = KIND_ORDER.indexOf(kind as SignalKind);
                return index < 0 ? KIND_ORDER.length : index;
            };
            return rank(a) - rank(b) || a.localeCompare(b);
        });
        return kinds.map((kind) => {
            const list = signals.filter((signal) => signal.kind === kind);
            const title = t(`s4.kind.${kind}`);
            return el('div', { class: 'maestro-s4-kind', data: { kind } }, [
                el('div', { class: 'maestro-s4-kind-head' }, [
                    el('span', { text: title === `s4.kind.${kind}` ? kind : title }),
                    badge(list.length, 'muted'),
                ]),
                ...list.map(row),
            ]);
        });
    };

    const lastView = (batch: SignalBatch | null): HTMLElement => {
        if (!batch) return section(t('s4.last.none'), []);
        const body: HTMLElement[] = [];
        if (batch.late) body.push(el('div', { class: 'maestro-muted', text: t('s4.late') }));
        if (batch.folded > 0)
            body.push(el('div', { class: 'maestro-muted', text: t('s4.last.folded', { count: batch.folded }) }));
        body.push(
            ...(batch.signals.length
                ? grouped(batch.signals)
                : [el('div', { class: 'maestro-muted', text: t('s4.last.empty') })]),
        );
        return section(t('s4.last', { index: batch.messageIndex }), body);
    };

    return {
        id: SIGNALS_TAB,
        titleKey: 's4.tab',
        icon: 'fa-signal',
        order: 48,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-s4' });
            container.appendChild(root);

            const draw = () => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('s4.noChat'), 'fa-comment-slash'));
                    return;
                }
                const head: HTMLElement[] = [el('div', { class: 'maestro-hint', text: t('s4.hint') })];
                if (!app.leader.isLeader()) head.push(el('div', { class: 'maestro-muted', text: t('s4.notLeader') }));
                if (!service.loaded()) {
                    head.push(el('div', { class: 'maestro-muted', text: t('s4.loading') }));
                    root.appendChild(section(t('s4.title'), head));
                    return;
                }
                const pending = service.pending();
                head.push(
                    el('div', {
                        text: t('s4.stats', { count: pending.length, since: service.messagesSinceRevision() }),
                    }),
                );
                root.appendChild(section(t('s4.title'), head));
                root.appendChild(
                    section(
                        t('s4.pending'),
                        pending.length ? grouped(pending) : [emptyState(t('s4.pending.empty'), 'fa-signal')],
                    ),
                );
                root.appendChild(lastView(service.last()));
            };

            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => alive && redraw());
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
