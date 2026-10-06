// Inbox tab: proposals waiting for a decision (plan §4.7, §7, M8 «Входящие»). Cards are grouped by entity; each shows
// its source message (a jump into the chat), the model's evidence and confidence, the change in plain words
// (plan-2 §3: target and field labels from the modules' TargetSpecs, «было → стало») and, collapsed under
// «Подробнее», everything technical (kind, ref locators, raw values, the module's notes). The actions: accept, edit
// the value inline and accept it as edited, reject, put off until tomorrow, «always» (the kind becomes 'auto' unless
// it may never be). Accepting re-validates the card in core; a stale card is reported instead of applied. Deferred
// cards of the revision (M8) wait in their own section. No popups.
//
// Card payload convention (read when present, optional for every module): `entityName` groups the card, `value`
// with `editable: true` enables «Edit» (accept passes `{...payload, value}` as the edited payload), `evidence` is a
// quote from the chat, `confidence` is 0..1. The revision's strings (`m8.inbox.*`) come with its module; English
// fallbacks keep the view whole without it.
import { kindLabel as humanKind } from '../../core/labels';
import { deferredStage } from '../../domain/revision-plan';
import type { InboxCard, PultTab, Unsubscribe } from '../../shared/contracts';
import { badge, card, emptyState, section } from '../components/card';
import { changeView, detailsView, humanChangeView } from '../components/diff';
import { append, button, clear, el } from '../components/dom';
import { coalesce, formatTime, moduleTitle, tOr } from './format';
import type { ViewEnv } from './types';

export const INBOX_TAB = 'inbox';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** The revision's public API as the view needs it (ui cannot import features: structural type). */
interface DeferredLike {
    id: string;
    target: string;
    entityName: string;
    value: string;
    /** The change in one Russian sentence (the value is English then and goes to the details). */
    russian?: string;
    evidence: string;
    sourceMessage: number;
    at: number;
}

interface RevisionLike {
    deferred(): DeferredLike[];
    dismissDeferred?(id: string): Promise<void>;
    onChange?(listener: () => void): Unsubscribe;
}

const REVISION_KEY = 'revision';

/** English fallbacks of the revision's `m8.inbox.*` strings. */
const FALLBACK: Record<string, string> = {
    'm8.inbox.edit': 'Edit',
    'm8.inbox.editLabel': 'New value',
    'm8.inbox.save': 'Save and accept',
    'm8.inbox.cancel': 'Cancel',
    'm8.inbox.editFailed': '“{title}” was not applied: check the value (details are in the log).',
    'm8.inbox.always': 'Always',
    'm8.inbox.always.hint': 'Accept and do such changes by itself from now on',
    'm8.inbox.always.done': '“{kind}” is now done by itself. You can change it in Settings.',
    'm8.inbox.snooze.hint': 'Put off until tomorrow',
    'm8.inbox.confidence': 'confidence {value}%',
    'm8.inbox.other': 'Other',
    'm8.inbox.deferred.title': 'Deferred',
    'm8.inbox.deferred.hint': 'Changes for modules of later stages; they wait here until those modules arrive.',
    'm8.inbox.deferred.stage': 'Deferred until stage {stage}',
    'm8.inbox.deferred.dismiss': 'Remove',
};

const INBOX_CSS = `
.maestro-inbox-group { display: flex; flex-direction: column; gap: var(--maestro-gap-sm, 6px); }
.maestro-inbox-group + .maestro-inbox-group { margin-top: var(--maestro-gap, 10px); }
.maestro-inbox-group-head { display: flex; align-items: center; gap: 6px; font-weight: 600; overflow-wrap: anywhere; }
.maestro-inbox-evidence { margin: 0; padding: 2px 8px; border-left: 3px solid var(--maestro-border);
    color: var(--maestro-muted); font-style: italic; white-space: pre-wrap; overflow-wrap: anywhere; }
.maestro-inbox-edit { display: flex; flex-direction: column; gap: 6px; }
.maestro-inbox-edit textarea { width: 100%; min-height: 4em; box-sizing: border-box; resize: vertical; }
`;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CardMeta {
    entityName: string;
    value?: string;
    editable: boolean;
    evidence?: string;
    confidence?: number;
}

/** What the payload says about the card (see the convention above). */
export function cardMeta(item: InboxCard): CardMeta {
    const payload = isDict(item.payload) ? item.payload : {};
    const meta: CardMeta = {
        entityName: typeof payload.entityName === 'string' ? payload.entityName.trim() : '',
        editable: false,
    };
    if (typeof payload.value === 'string') {
        meta.value = payload.value;
        meta.editable = payload.editable === true;
    }
    if (typeof payload.evidence === 'string' && payload.evidence.trim()) meta.evidence = payload.evidence.trim();
    if (typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)) {
        meta.confidence = Math.min(1, Math.max(0, payload.confidence));
    }
    return meta;
}

/** Cards grouped by entity, the newest group first; cards without an entity form the last group (''). */
export function groupByEntity(cards: readonly InboxCard[]): { entity: string; cards: InboxCard[] }[] {
    const groups = new Map<string, InboxCard[]>();
    for (const item of cards) {
        const entity = cardMeta(item).entityName;
        const list = groups.get(entity);
        if (list) list.push(item);
        else groups.set(entity, [item]);
    }
    const newest = (list: InboxCard[]) => Math.max(...list.map((item) => item.createdAt));
    return [...groups.entries()]
        .map(([entity, list]) => ({ entity, cards: list }))
        .sort((a, b) => Number(a.entity === '') - Number(b.entity === '') || newest(b.cards) - newest(a.cards));
}

export function inboxTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);
    /** A revision string with its English fallback (the module may be absent). */
    const tx = (key: string, params?: Record<string, string | number>): string => {
        let fallback = FALLBACK[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {}))
            fallback = fallback.split(`{${name}}`).join(String(value));
        return tOr(i18n, key, fallback, params);
    };
    /** The kind's human name; '' when its module did not name it (the raw kind then shows under «Подробнее»). */
    const kindName = (kind: string): string => humanKind(i18n, kind) ?? '';
    const revision = (): RevisionLike | undefined => {
        const api = env.modules.api<RevisionLike>(REVISION_KEY);
        return api && typeof api.deferred === 'function' ? api : undefined;
    };

    /** Cards whose value is being edited, with the draft text (kept across re-renders). */
    const drafts = new Map<string, string>();

    const accept = async (item: InboxCard): Promise<boolean> => {
        const ok = await env.inbox.accept(item.id);
        if (!ok) shell.notice(t('ui.inbox.stale', { title: item.title }), { level: 'warn' });
        return ok;
    };

    const acceptEdited = async (item: InboxCard, value: string): Promise<void> => {
        const payload = isDict(item.payload) ? item.payload : {};
        const ok = await env.inbox.accept(item.id, { ...payload, value });
        if (ok) drafts.delete(item.id);
        else shell.notice(tx('m8.inbox.editFailed', { title: item.title }), { level: 'warn' });
    };

    /** The kind is not 'auto' yet and may become it (never for kinds registered with neverAuto). */
    const canPromote = (kind: string): boolean => {
        const { autonomy } = env;
        try {
            if (autonomy.level(kind, 'inbox') === 'auto') return false;
            if (autonomy.isNeverAuto) return !autonomy.isNeverAuto(kind);
            // Without isNeverAuto: try 'auto' for a moment — level() refuses it for such kinds (core/autonomy.ts).
            const stored = env.settings.core().autonomy;
            const previous = stored[kind];
            stored[kind] = 'auto';
            const allowed = autonomy.level(kind, 'inbox') === 'auto';
            if (previous) stored[kind] = previous;
            else delete stored[kind];
            return allowed;
        } catch {
            return false;
        }
    };

    /** «Always»: the kind becomes 'auto' (as the trust offer does, core/autonomy.ts), then this card is accepted. */
    const always = async (item: InboxCard): Promise<void> => {
        if (env.autonomy.setLevel) {
            if (!env.autonomy.setLevel(item.kind, 'auto')) return;
        } else {
            env.settings.core().autonomy[item.kind] = 'auto';
            env.settings.save();
            env.settings.notify(`core.autonomy.${item.kind}`);
        }
        shell.notice(tx('m8.inbox.always.done', { kind: kindName(item.kind) || item.title }), {
            importance: 'urgent',
        });
        await accept(item);
    };

    /** Everything technical about a card: kind and module ids, the module's notes, raw changes with locators. */
    const technical = (item: InboxCard): HTMLElement | null =>
        detailsView(i18n, env.settings.core().showTechnical === true, [
            el('div', { class: 'maestro-muted', text: t('ui.inbox.detailsKind', { kind: item.kind }) }),
            el('div', { class: 'maestro-muted', text: t('ui.inbox.detailsModule', { module: item.module }) }),
            item.details ? el('div', { class: 'maestro-details-notes', text: item.details }) : null,
            ...item.changes.map((change) => changeView(change, t)),
        ]);

    const sourceButton = (index: number | undefined): HTMLButtonElement | null =>
        index !== undefined
            ? button({
                  label: t('ui.inbox.source', { index }),
                  icon: 'fa-message',
                  kind: 'ghost',
                  onClick: () => shell.scrollToMessage(index),
              })
            : null;

    const editor = (item: InboxCard, redraw: () => void): HTMLElement => {
        const area = el('textarea', {
            class: 'text_pole',
            attrs: { 'aria-label': tx('m8.inbox.editLabel'), rows: 3 },
        });
        area.value = drafts.get(item.id) ?? '';
        area.addEventListener('input', () => drafts.set(item.id, area.value));
        return el('div', { class: 'maestro-inbox-edit' }, [
            el('div', { class: 'maestro-muted', text: tx('m8.inbox.editLabel') }),
            area,
            el('div', { class: 'maestro-row' }, [
                button({
                    label: tx('m8.inbox.cancel'),
                    kind: 'ghost',
                    onClick: () => {
                        drafts.delete(item.id);
                        redraw();
                    },
                }),
                button({
                    label: tx('m8.inbox.save'),
                    icon: 'fa-floppy-disk',
                    disabled: false,
                    onClick: () => acceptEdited(item, area.value.trim()),
                }),
            ]),
        ]);
    };

    const cardView = (item: InboxCard, redraw: () => void): HTMLElement => {
        const meta = cardMeta(item);
        const head = [
            moduleTitle(env.modules, i18n, item.module),
            kindName(item.kind),
            formatTime(item.createdAt, i18n),
        ];
        const subtitle: (HTMLElement | string)[] = [
            el('span', { class: 'maestro-muted', text: head.filter(Boolean).join(' · ') }),
        ];
        if (meta.confidence !== undefined) {
            subtitle.push(badge(tx('m8.inbox.confidence', { value: Math.round(meta.confidence * 100) }), 'muted'));
        }
        if (item.deferred) subtitle.push(badge(t('ui.inbox.deferred'), 'muted'));
        if (item.expiresAt)
            subtitle.push(badge(t('ui.inbox.expires', { time: formatTime(item.expiresAt, i18n) }), 'muted'));
        const editing = drafts.has(item.id);
        const editable = meta.editable && meta.value !== undefined && !item.deferred;
        return card({
            title: item.title,
            subtitle,
            className: 'maestro-inbox-card',
            body: [
                item.description ? el('div', { class: 'maestro-card-text', text: item.description }) : null,
                meta.evidence ? el('blockquote', { class: 'maestro-inbox-evidence', text: meta.evidence }) : null,
                ...item.changes.map((change) => humanChangeView(change, env.labels, i18n)),
                editing ? editor(item, redraw) : null,
                technical(item),
            ],
            actions: [
                sourceButton(item.sourceMessage),
                el('span', { class: 'maestro-grow' }),
                button({
                    label: t('ui.inbox.snooze'),
                    title: tx('m8.inbox.snooze.hint'),
                    icon: 'fa-clock',
                    kind: 'ghost',
                    onClick: () => env.inbox.snooze(item.id, SNOOZE_MS),
                }),
                button({
                    label: item.rejectLabel ?? t('ui.inbox.reject'),
                    icon: 'fa-xmark',
                    kind: 'danger',
                    onClick: () => env.inbox.reject(item.id),
                }),
                editable && !editing
                    ? button({
                          label: tx('m8.inbox.edit'),
                          icon: 'fa-pen',
                          onClick: () => {
                              drafts.set(item.id, meta.value ?? '');
                              redraw();
                          },
                      })
                    : null,
                !item.deferred && canPromote(item.kind)
                    ? button({
                          label: tx('m8.inbox.always'),
                          title: tx('m8.inbox.always.hint'),
                          icon: 'fa-forward-fast',
                          onClick: () => always(item),
                      })
                    : null,
                button({
                    label: item.acceptLabel ?? t('ui.inbox.accept'),
                    icon: 'fa-check',
                    kind: 'primary',
                    disabled: item.deferred === true,
                    title: item.deferred ? t('ui.inbox.deferredHint') : undefined,
                    onClick: async () => {
                        await accept(item);
                    },
                }),
            ],
        });
    };

    const groupsView = (cards: InboxCard[], redraw: () => void): HTMLElement => {
        const groups = groupByEntity(cards);
        if (groups.length === 1 && groups[0]?.entity === '') {
            return el(
                'div',
                { class: 'maestro-cards' },
                cards.map((item) => cardView(item, redraw)),
            );
        }
        return el(
            'div',
            { class: 'maestro-inbox-groups' },
            groups.map((group) =>
                el('div', { class: 'maestro-inbox-group', data: { entity: group.entity } }, [
                    el('div', { class: 'maestro-inbox-group-head' }, [
                        el('span', { text: group.entity || tx('m8.inbox.other') }),
                        badge(group.cards.length, 'muted'),
                    ]),
                    el(
                        'div',
                        { class: 'maestro-cards' },
                        group.cards.map((item) => cardView(item, redraw)),
                    ),
                ]),
            ),
        );
    };

    const deferredView = (api: RevisionLike, list: DeferredLike[]): HTMLElement =>
        section(tx('m8.inbox.deferred.title'), [
            el('div', { class: 'maestro-hint', text: tx('m8.inbox.deferred.hint') }),
            el(
                'div',
                { class: 'maestro-cards' },
                list.map((item) =>
                    card({
                        title: `${item.entityName}: ${tOr(i18n, `m8.target.${item.target}`, item.target)}`,
                        subtitle: [
                            badge(tx('m8.inbox.deferred.stage', { stage: deferredStage(item.target) }), 'muted'),
                            el('span', { class: 'maestro-muted', text: formatTime(item.at, i18n) }),
                        ],
                        className: 'maestro-inbox-deferred',
                        level: 'muted',
                        body: [
                            el('div', { class: 'maestro-card-text', text: item.russian || item.value }),
                            item.evidence
                                ? el('blockquote', { class: 'maestro-inbox-evidence', text: item.evidence })
                                : null,
                            item.russian
                                ? detailsView(i18n, env.settings.core().showTechnical === true, [
                                      el('div', { class: 'maestro-details-notes', text: item.value }),
                                  ])
                                : null,
                        ],
                        actions: [
                            sourceButton(item.sourceMessage),
                            el('span', { class: 'maestro-grow' }),
                            api.dismissDeferred
                                ? button({
                                      label: tx('m8.inbox.deferred.dismiss'),
                                      icon: 'fa-trash-can',
                                      kind: 'ghost',
                                      onClick: async () => {
                                          await api.dismissDeferred?.(item.id);
                                      },
                                  })
                                : null,
                        ],
                    }),
                ),
            ),
        ]);

    return {
        id: INBOX_TAB,
        titleKey: 'ui.tab.inbox',
        icon: 'fa-inbox',
        order: 30,
        badge: () => env.inbox.count(),
        render(container) {
            const draw = () => {
                clear(container);
                const cards = [...env.inbox.list()].sort((a, b) => b.createdAt - a.createdAt);
                for (const id of [...drafts.keys()]) if (!cards.some((item) => item.id === id)) drafts.delete(id);
                const actionable = cards.filter((item) => !item.deferred);
                const acceptAll = button({
                    label: t('ui.inbox.acceptAll', { count: actionable.length }),
                    icon: 'fa-check-double',
                    disabled: actionable.length === 0,
                    onClick: async () => {
                        let failed = 0;
                        for (const item of actionable) {
                            try {
                                if (!(await env.inbox.accept(item.id))) failed++;
                            } catch (error) {
                                failed++;
                                shell.log.error('accept failed', item.id, error);
                            }
                        }
                        const accepted = actionable.length - failed;
                        shell.notice(
                            failed
                                ? t('ui.inbox.acceptAllPartial', { accepted, failed })
                                : t('ui.inbox.acceptAllDone', { accepted }),
                            { level: failed ? 'warn' : 'info' },
                        );
                    },
                });
                const api = revision();
                let deferred: DeferredLike[] = [];
                try {
                    deferred = api?.deferred() ?? [];
                } catch (error) {
                    shell.log.warn('deferred cards are not readable', error);
                }
                const view = el('div', { class: 'maestro-view maestro-inbox' }, [
                    el('style', { text: INBOX_CSS }),
                    section(
                        t('ui.inbox.title'),
                        cards.length ? groupsView(cards, draw) : emptyState(t('ui.inbox.empty')),
                        cards.length ? acceptAll : undefined,
                    ),
                ]);
                if (api && deferred.length) append(view, deferredView(api, deferred));
                container.append(view);
            };
            draw();
            const later = coalesce(draw, 50);
            const unsubscribers: Unsubscribe[] = [env.inbox.onChange(later)];
            try {
                const off = revision()?.onChange?.(later);
                if (off) unsubscribers.push(off);
            } catch (error) {
                shell.log.debug('revision changes are not observable', error);
            }
            return () => {
                later.cancel();
                for (const off of unsubscribers) off();
            };
        },
    };
}
