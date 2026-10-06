// M25 «Механики», the play sections of the «Механики» window (plan-2 §6.А п.5 «всё целиком»), next to the values and
// rolls of the state section (widgets.ts):
// - «Бой»: start a fight (with enemies), the round and the turn order with whose turn it is, the next turn, an enemy
//   added, the fight ended — while a mechanic runs fights or one is on;
// - «Состояния и вещи»: per holder in the scene the statuses with what is left (put on from the catalogues or by name
//   for a number of turns or hours, taken off) and the inventory (given, taken, worn or in hand, bought and sold
//   against the inventory's money). Statuses and items of hidden or secret mechanics stay behind «Подсмотреть»;
// - the «История» tab: every change the player may see with «Отменить», the roll journal with «Отменить бросок» and
//   the threshold events; hidden rolls only as a count until «Подсмотреть» (asked first).
// Everything goes through MechanicsApi (journaled with undo there). Wrapping rows and stacked fields: usable in a narrow
// side panel and on a phone.
import { durationOf, formatNumber } from '../../domain/mechanics-view';
import type { Unsubscribe } from '../../shared/contracts';
import { badge, card, emptyState, section } from '../../ui/components/card';
import type { Level } from '../../ui/components/card';
import { select } from '../../ui/components/controls';
import { button, clear, el, icon } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type {
    CheckResult,
    EquipSlot,
    ItemState,
    MechanicDef,
    MechanicsApi,
    StateChange,
    StatusSpec,
    StatusState,
} from './api';
import type { PartDeps, SectionRenderer } from './parts';
import { details, eventLine, rollConsequences, rollLine } from './play-strip';
import {
    changeSegment,
    holdersOf,
    partsShown,
    personaOf,
    playerSees,
    sameName,
    statusDuration,
    translator,
} from './view-values';

export const PLAY_CSS = `
.maestro-m25-play .maestro-m25-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m25-play .maestro-m25-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.maestro-m25-play .maestro-m25-sub { font-weight: 600; margin-top: 6px; }
.maestro-m25-play .maestro-m25-input { flex: 1 1 120px; min-width: 0; box-sizing: border-box; }
.maestro-m25-play .maestro-m25-num { width: 5em; flex: none; }
.maestro-m25-play .maestro-m25-fighter-now { font-weight: 600; }
.maestro-m25-play .maestro-m25-fighter-out { text-decoration: line-through; opacity: 0.6; }
.maestro-m25-play .maestro-m25-undone { opacity: 0.6; }
`;

const HISTORY_SHOWN = 60;
const ROLLS_SHOWN = 40;
const EVENTS_SHOWN = 20;

type T = ReturnType<typeof translator>;

function safe<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

function input(label: string, placeholder?: string, type: 'text' | 'number' = 'text'): HTMLInputElement {
    return el('input', {
        class: ['text_pole', 'maestro-m25-input', type === 'number' ? 'maestro-m25-num' : null],
        attrs: {
            type,
            'aria-label': label,
            placeholder: placeholder ?? label,
            ...(type === 'number' ? { inputmode: 'numeric', min: 0, step: 'any' } : {}),
        },
    });
}

function numberOf(node: HTMLInputElement): number | undefined {
    const raw = node.value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

/** Runs an action of the user and tells him what went wrong. */
function runner(deps: PartDeps) {
    return async (job: () => Promise<unknown>): Promise<void> => {
        try {
            await job();
        } catch (error) {
            deps.app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn', urgent: true });
        }
    };
}

/** A section that redraws on every change of the mechanics (coalesced) and when the chat changes. */
function live(
    deps: PartDeps,
    api: MechanicsApi,
    className: string,
    draw: (root: HTMLElement, redraw: () => void) => void,
): SectionRenderer {
    return (container) => {
        let alive = true;
        const root = el('div', { class: ['maestro-m25-play', className] });
        container.appendChild(root);
        const paint = () => {
            if (!alive) return;
            clear(root);
            try {
                draw(root, now);
            } catch (error) {
                deps.log.error('mechanics: a window section failed', error);
            }
        };
        const later = coalesce(paint, 100);
        const now = () => {
            later.cancel();
            paint();
        };
        const offs: Unsubscribe[] = [
            api.onChange(() => alive && later()),
            deps.app.bus.on('chat:changed', () => {
                if (alive) later();
            }),
        ];
        paint();
        return () => {
            alive = false;
            later.cancel();
            for (const off of offs) off();
            root.remove();
        };
    };
}

/* ------------------------------------------------------------------ the fight */

export function combatSection(deps: PartDeps, api: MechanicsApi): SectionRenderer {
    const t = translator(deps.app.i18n);
    const run = runner(deps);
    return live(deps, api, 'maestro-m25-combat', (root) => {
        if (!deps.app.host.chatId()) return;
        const fight = safe(() => api.combat?.() ?? null, null);
        const runsFights = safe(() => api.active(), [] as MechanicDef[]).some((def) => def.combat !== undefined);
        if (!fight?.active && !runsFights) return;
        if (!fight?.active) {
            const enemies = input(t('m25.win.combat.enemies'), t('m25.win.combat.enemies.hint'));
            root.appendChild(
                section(t('m25.win.combat.title'), [
                    el('div', { class: 'maestro-muted', text: t('m25.win.combat.none') }),
                    el('div', { class: 'maestro-m25-row' }, [
                        enemies,
                        button({
                            label: t('m25.win.combat.start'),
                            icon: 'fa-khanda',
                            kind: 'primary',
                            className: 'maestro-m25-combat-start',
                            onClick: () =>
                                run(async () => {
                                    const names = enemies.value
                                        .split(',')
                                        .map((name) => name.trim())
                                        .filter(Boolean);
                                    await api.startCombat?.(names.length ? { enemies: names } : {});
                                }),
                        }),
                    ]),
                ]),
            );
            return;
        }
        const enemy = input(t('m25.win.combat.enemy'));
        const order = el(
            'ol',
            { class: 'maestro-m25-list maestro-m25-fighters' },
            fight.order.map((fighter, index) =>
                el(
                    'li',
                    {
                        class: [
                            'maestro-m25-row',
                            index === fight.current ? 'maestro-m25-fighter-now' : null,
                            fighter.out ? 'maestro-m25-fighter-out' : null,
                        ],
                        data: { holder: fighter.holder },
                    },
                    [
                        index === fight.current ? icon('fa-play') : null,
                        el('span', { text: fighter.holder }),
                        el('span', { class: 'maestro-muted', text: t('m25.win.combat.init', { value: fighter.init }) }),
                        fighter.enemy ? badge(t('m25.win.combat.foe'), 'warn') : null,
                        fighter.out ? badge(t('m25.win.combat.out'), 'muted') : null,
                    ],
                ),
            ),
        );
        root.appendChild(
            section(
                t('m25.win.combat.round', { round: fight.round }),
                [
                    order,
                    el('div', { class: 'maestro-m25-row' }, [
                        enemy,
                        button({
                            label: t('m25.win.combat.add'),
                            icon: 'fa-user-plus',
                            className: 'maestro-m25-combat-add',
                            onClick: () =>
                                run(async () => {
                                    const name = enemy.value.trim();
                                    if (!name) return;
                                    await api.addEnemy?.(name);
                                }),
                        }),
                    ]),
                ],
                [
                    button({
                        label: t('m25.win.combat.next'),
                        icon: 'fa-forward-step',
                        kind: 'primary',
                        className: 'maestro-m25-combat-next',
                        onClick: () => run(async () => api.nextTurn?.()),
                    }),
                    button({
                        label: t('m25.win.combat.end'),
                        icon: 'fa-flag-checkered',
                        className: 'maestro-m25-combat-end',
                        onClick: () =>
                            run(async () => {
                                const ok = await deps.app.ui.confirm(
                                    t('m25.win.combat.end.title'),
                                    t('m25.win.combat.end.body'),
                                );
                                if (ok) await api.endCombat?.();
                            }),
                    }),
                ],
            ),
        );
    });
}

/* ------------------------------------------------------------------ statuses and items */

/** Holders in the scene of the mechanics with statuses or an inventory (the user's character first). */
function peopleOf(api: MechanicsApi): string[] {
    const persona = personaOf(api);
    const names: string[] = [];
    for (const def of safe(() => api.active(), [] as MechanicDef[])) {
        if (def.statuses === undefined && def.inventory === undefined) continue;
        if (def.holders.kind === 'world') continue;
        for (const holder of holdersOf(api, def)) if (!names.some((name) => sameName(name, holder))) names.push(holder);
    }
    return names.sort((a, b) => Number(sameName(b, persona)) - Number(sameName(a, persona)));
}

export function peopleSection(deps: PartDeps, api: MechanicsApi): SectionRenderer {
    const t = translator(deps.app.i18n);
    const run = runner(deps);
    let peeking = false;

    const statusRow = (holder: string, status: StatusState): HTMLElement => {
        const left = statusDuration(deps.app.i18n, status);
        const mods = Object.entries(status.modifiers ?? {})
            .filter(([, value]) => value)
            .map(([key, value]) => `${key} ${value > 0 ? '+' : ''}${formatNumber(value)}`)
            .join(', ');
        return el('div', { class: 'maestro-m25-row maestro-m25-status', data: { status: status.statusId } }, [
            status.icon ? el('span', { text: status.icon }) : icon('fa-certificate'),
            el('span', { text: status.stacks > 1 ? `${status.name} ×${status.stacks}` : status.name }),
            el('span', { class: 'maestro-muted', text: left || t('m25.win.status.forever') }),
            mods ? el('span', { class: 'maestro-muted', text: mods }) : null,
            button({
                icon: 'fa-xmark',
                title: t('m25.win.status.remove', { name: status.name }),
                kind: 'ghost',
                className: 'maestro-m25-status-remove',
                onClick: () => run(async () => api.removeStatus?.(holder, status.id)),
            }),
        ]);
    };

    const statusForm = (holder: string, catalogue: { def: MechanicDef; spec: StatusSpec }[]): HTMLElement => {
        const name = input(t('m25.win.status.name'));
        const turns = input(t('m25.win.status.turns'), t('m25.win.status.turns'), 'number');
        const hours = input(t('m25.win.status.hours'), t('m25.win.status.hours'), 'number');
        let pickedIndex = '';
        const picker = catalogue.length
            ? select<string>({
                  value: '',
                  options: [
                      { value: '', label: t('m25.win.status.own') },
                      ...catalogue.map((entry, index) => ({ value: String(index), label: entry.spec.name })),
                  ],
                  label: t('m25.win.status.pick'),
                  onChange: (value) => {
                      pickedIndex = value;
                      name.hidden = value !== '';
                  },
              })
            : null;
        return el('div', { class: 'maestro-m25-row maestro-m25-status-add' }, [
            picker,
            name,
            turns,
            hours,
            button({
                label: t('m25.win.status.add'),
                icon: 'fa-plus',
                className: 'maestro-m25-status-add-button',
                onClick: () =>
                    run(async () => {
                        const entry = pickedIndex ? catalogue[Number(pickedIndex)] : undefined;
                        const duration = durationOf(numberOf(turns), numberOf(hours));
                        const spec: StatusSpec = entry
                            ? { ...entry.spec, ...(duration ? { duration } : {}) }
                            : { name: name.value.trim(), ...(duration ? { duration } : {}) };
                        if (!spec.name) return;
                        const change = await api.addStatus?.(holder, spec, entry?.def.id);
                        if (!change) deps.app.ui.notice(t('m25.win.status.none'), { level: 'warn', urgent: true });
                    }),
            }),
        ]);
    };

    const itemRow = (holder: string, item: ItemState, trade: boolean): HTMLElement =>
        el('div', { class: 'maestro-m25-row maestro-m25-item', data: { item: item.name } }, [
            el('span', { text: item.qty > 1 ? `${item.name} ×${item.qty}` : item.name }),
            item.desc ? el('span', { class: 'maestro-muted', text: item.desc }) : null,
            item.value !== undefined
                ? el('span', {
                      class: 'maestro-muted',
                      text: t('m25.win.item.price', { price: formatNumber(item.value) }),
                  })
                : null,
            select<string>({
                value: item.equipped ?? '',
                options: [
                    { value: '', label: t('m25.win.item.carried') },
                    { value: 'worn', label: t('m25.play.item.worn') },
                    { value: 'hand', label: t('m25.play.item.hand') },
                ],
                label: t('m25.win.item.where', { name: item.name }),
                onChange: (value) =>
                    run(async () => api.equipItem?.(holder, item.name, value ? (value as EquipSlot) : null)),
            }),
            button({
                label: t('m25.win.item.take'),
                kind: 'ghost',
                className: 'maestro-m25-item-take',
                onClick: () => run(async () => api.takeItem?.(holder, item.name, 1)),
            }),
            trade
                ? button({
                      label: t('m25.win.item.sell'),
                      kind: 'ghost',
                      className: 'maestro-m25-item-sell',
                      onClick: () =>
                          run(async () => {
                              const ok = await api.sell?.(holder, item.name, 1);
                              if (!ok)
                                  deps.app.ui.notice(t('m25.win.item.sellFailed'), { level: 'warn', urgent: true });
                          }),
                  })
                : null,
        ]);

    const itemForm = (holder: string, trade: boolean): HTMLElement => {
        const name = input(t('m25.win.item.name'));
        const qty = input(t('m25.win.item.qty'), '1', 'number');
        const price = input(t('m25.win.item.priceInput'), t('m25.win.item.priceInput'), 'number');
        const spec = () => {
            const value = numberOf(price);
            return { name: name.value.trim(), ...(value !== undefined ? { value } : {}) };
        };
        return el('div', { class: 'maestro-m25-row maestro-m25-item-add' }, [
            name,
            qty,
            trade ? price : null,
            button({
                label: t('m25.win.item.give'),
                icon: 'fa-plus',
                className: 'maestro-m25-item-give',
                onClick: () =>
                    run(async () => {
                        if (!spec().name) return;
                        await api.giveItem?.(holder, spec(), numberOf(qty) ?? 1);
                    }),
            }),
            trade
                ? button({
                      label: t('m25.win.item.buy'),
                      icon: 'fa-coins',
                      className: 'maestro-m25-item-buy',
                      onClick: () =>
                          run(async () => {
                              if (!spec().name) return;
                              const ok = await api.buy?.(holder, spec(), numberOf(qty) ?? 1);
                              if (!ok) deps.app.ui.notice(t('m25.win.item.buyFailed'), { level: 'warn', urgent: true });
                          }),
                  })
                : null,
        ]);
    };

    /** The money of the inventory a holder trades with («Монеты: 25»), when one is set. */
    const purse = (holder: string, defs: MechanicDef[]): string => {
        for (const def of defs) {
            const money = def.inventory?.money;
            if (!money) continue;
            const [mechanicId, attribute] = money.includes('.') ? money.split('.') : [def.id, money];
            const owner = safe(() => api.get(mechanicId ?? ''), null);
            const attr = owner?.attributes.find((item) => item.id === attribute);
            const value = safe(() => api.value(mechanicId ?? '', holder, attribute ?? ''), null);
            if (attr && typeof value === 'number') return `${attr.icon ?? attr.name} ${formatNumber(value)}`;
        }
        return '';
    };

    return live(deps, api, 'maestro-m25-people', (root, redraw) => {
        if (!deps.app.host.chatId()) return;
        const defs = safe(() => api.active(), [] as MechanicDef[]);
        const withStatuses = defs.filter((def) => def.statuses !== undefined);
        const inventories = defs.filter((def) => def.inventory !== undefined);
        if (!withStatuses.length && !inventories.length) return;
        const people = peopleOf(api);
        const catalogue = withStatuses.flatMap((def) => (def.statuses ?? []).map((spec) => ({ def, spec })));
        const trade = inventories.some((def) => !!def.inventory?.money);
        const hiddenParts = defs.some(
            (def) => (def.statuses !== undefined || def.inventory !== undefined) && !partsShown(api, def.id),
        );
        const cards = people.map((holder) => {
            const statuses = (
                safe(() => api.statuses?.(holder) ?? [], []).find((entry) => sameName(entry.holder, holder))
                    ?.statuses ?? []
            ).filter((status) => peeking || partsShown(api, status.mechanicId));
            const items =
                safe(() => api.items?.(holder) ?? [], []).find((entry) => sameName(entry.holder, holder))?.items ?? [];
            const itemsShown = peeking || inventories.some((def) => partsShown(api, def.id));
            const money = purse(holder, inventories);
            return card({
                className: 'maestro-m25-person',
                title: holder,
                subtitle: money ? el('span', { class: 'maestro-muted', text: money }) : undefined,
                body: [
                    withStatuses.length ? el('div', { class: 'maestro-m25-sub', text: t('m25.play.statuses') }) : null,
                    withStatuses.length
                        ? statuses.length
                            ? el(
                                  'div',
                                  { class: 'maestro-m25-list' },
                                  statuses.map((status) => statusRow(holder, status)),
                              )
                            : el('div', { class: 'maestro-muted', text: t('m25.win.status.empty') })
                        : null,
                    withStatuses.length ? statusForm(holder, catalogue) : null,
                    inventories.length ? el('div', { class: 'maestro-m25-sub', text: t('m25.play.items') }) : null,
                    inventories.length && itemsShown
                        ? items.length
                            ? el(
                                  'div',
                                  { class: 'maestro-m25-list' },
                                  items.map((item) => itemRow(holder, item, trade)),
                              )
                            : el('div', { class: 'maestro-muted', text: t('m25.win.item.empty') })
                        : null,
                    inventories.length && itemsShown ? itemForm(holder, trade) : null,
                ],
            });
        });
        root.appendChild(
            section(
                t('m25.win.people.title'),
                cards.length ? cards : [emptyState(t('m25.widget.noHolders'), 'fa-user-slash')],
                hiddenParts && !peeking
                    ? button({
                          label: t('m25.win.peek'),
                          icon: 'fa-eye',
                          kind: 'ghost',
                          className: 'maestro-m25-peek-parts',
                          onClick: async () => {
                              const ok = await deps.app.ui.confirm(t('m25.win.peek.title'), t('m25.win.peek.body'));
                              if (!ok) return;
                              peeking = true;
                              redraw();
                          },
                      })
                    : undefined,
            ),
        );
    });
}

/* ------------------------------------------------------------------ the history tab */

const OUTCOME_LEVEL: Record<CheckResult['outcome'], Level> = {
    critical: 'ok',
    success: 'ok',
    failure: 'error',
    fumble: 'error',
    none: 'muted',
};

/** The player may see a change at all (the window: never secret, hidden only once revealed). */
function changeVisible(api: MechanicsApi, change: StateChange): boolean {
    if (change.kind === 'combat') return true;
    if (change.kind === 'status') return partsShown(api, change.status?.mechanicId ?? change.mechanicId);
    if (change.kind === 'item') return partsShown(api, change.mechanicId);
    const def = safe(() => api.get(change.mechanicId), null);
    if (change.kind === 'reveal') return !!def && safe(() => api.visibilityOf?.(def.id)?.preset, '') !== 'secret';
    const attribute = def?.attributes.find((item) => item.id === change.attribute);
    return !!def && !!attribute && playerSees(api, def, attribute, change.holder);
}

export function logSection(deps: PartDeps, api: MechanicsApi): SectionRenderer {
    const t: T = translator(deps.app.i18n);
    const run = runner(deps);
    let filter = '';
    let peeking = false;

    const changeRow = (change: StateChange): HTMLElement | null => {
        const text = safe(() => changeSegment(deps.app.i18n, api, change, { raw: true }), null);
        if (!text) return null;
        const holder = change.holder === 'world' ? t('m25.state.holder.world') : change.holder;
        return el('div', { class: 'maestro-m25-row maestro-m25-log-change', data: { change: change.id } }, [
            el('span', { text: change.kind === 'combat' ? text : `${holder}: ${text}` }),
            badge(t(`m25.widget.source.${change.source}`), 'muted'),
            change.reason
                ? el('span', { class: 'maestro-muted', text: t('m25.widget.change.reason', { reason: change.reason }) })
                : null,
            el('span', { class: 'maestro-muted', text: formatTime(change.at, deps.app.i18n) }),
            api.undoChange
                ? button({
                      label: t('m25.play.undo'),
                      kind: 'ghost',
                      className: 'maestro-m25-log-undo',
                      onClick: () =>
                          run(async () => {
                              const ok = await api.undoChange!(change.id);
                              if (!ok) deps.app.ui.notice(t('m25.play.undo.failed'), { level: 'warn', urgent: true });
                          }),
                  })
                : null,
        ]);
    };

    const rollRow = (result: CheckResult, changes: StateChange[]): HTMLElement => {
        const consequences = rollConsequences(deps.app.i18n, api, result, changes);
        return el(
            'div',
            {
                class: ['maestro-m25-row', 'maestro-m25-log-roll', result.undone ? 'maestro-m25-undone' : null],
                data: { roll: result.id },
            },
            [
                badge(t(`m25.check.outcome.${result.outcome}`), OUTCOME_LEVEL[result.outcome] ?? 'muted'),
                el('span', { text: rollLine(deps.app.i18n, api, result) }),
                consequences.length ? el('span', { class: 'maestro-muted', text: consequences.join(' · ') }) : null,
                el('span', { class: 'maestro-muted', text: t(`m25.check.by.${result.by}`) }),
                el('span', { class: 'maestro-muted', text: formatTime(result.at, deps.app.i18n) }),
                result.hidden ? badge(t('m25.win.log.hiddenRoll'), 'muted') : null,
                result.undone ? badge(t('m25.win.log.undone'), 'muted') : null,
                !result.undone && (result.changes?.length ?? 0) > 0 && api.undoRoll
                    ? button({
                          label: t('m25.play.roll.undo'),
                          kind: 'ghost',
                          className: 'maestro-m25-log-undo-roll',
                          onClick: () =>
                              run(async () => {
                                  const ok = await api.undoRoll!(result.id);
                                  if (!ok)
                                      deps.app.ui.notice(t('m25.play.undo.failed'), { level: 'warn', urgent: true });
                              }),
                      })
                    : null,
                result.text ? details(t('m25.play.details'), result.text) : null,
            ],
        );
    };

    return live(deps, api, 'maestro-m25-log', (root, redraw) => {
        if (!deps.app.host.chatId()) {
            root.appendChild(emptyState(t('m25.widget.noChat'), 'fa-comment-slash'));
            return;
        }
        const defs = safe(() => api.list(), [] as MechanicDef[]);
        const mine = (mechanicId: string) => !filter || mechanicId === filter;
        const picker = select<string>({
            value: filter,
            options: [
                { value: '', label: t('m25.win.log.all') },
                ...defs.map((def) => ({ value: def.id, label: def.name })),
            ],
            label: t('m25.win.log.filter'),
            onChange: (value) => {
                filter = value;
                redraw();
            },
        });
        const history = safe(() => api.history(HISTORY_SHOWN * 3), [] as StateChange[]);
        const rows = history
            .filter((change) => mine(change.mechanicId) && (peeking || changeVisible(api, change)))
            .map(changeRow)
            .filter((row): row is HTMLElement => row !== null)
            .slice(0, HISTORY_SHOWN);
        const rolls = safe(() => api.checks(ROLLS_SHOWN * 2), [] as CheckResult[]).filter((result) =>
            mine(result.mechanicId),
        );
        const shownRolls = rolls.filter((result) => peeking || !result.hidden).slice(0, ROLLS_SHOWN);
        const hiddenRolls = peeking ? 0 : rolls.filter((result) => result.hidden).length;
        const events = safe(() => api.events(EVENTS_SHOWN * 2), []).filter((event) => {
            if (!mine(event.mechanicId)) return false;
            if (peeking || event.attribute === 'combat') return true;
            const def = safe(() => api.get(event.mechanicId), null);
            if (!def) return false;
            if (event.attribute === 'status') return partsShown(api, def.id);
            const attribute = def.attributes.find((item) => item.id === event.attribute);
            return !!attribute && playerSees(api, def, attribute, event.holder);
        });
        const changesNewestLast = [...history].reverse();
        const peek = peeking
            ? null
            : button({
                  label: t('m25.win.peek'),
                  icon: 'fa-eye',
                  kind: 'ghost',
                  className: 'maestro-m25-log-peek',
                  onClick: async () => {
                      const ok = await deps.app.ui.confirm(t('m25.win.peek.title'), t('m25.win.peek.body'));
                      if (!ok) return;
                      peeking = true;
                      redraw();
                  },
              });
        root.append(
            el('div', { class: 'maestro-m25-row' }, [picker, peek]),
            section(t('m25.win.log.changes'), [
                rows.length
                    ? el('div', { class: 'maestro-m25-list' }, rows)
                    : el('div', { class: 'maestro-muted', text: t('m25.widget.recent.none') }),
            ]),
            section(t('m25.win.log.rolls'), [
                shownRolls.length
                    ? el(
                          'div',
                          { class: 'maestro-m25-list' },
                          shownRolls.map((result) => rollRow(result, changesNewestLast)),
                      )
                    : el('div', { class: 'maestro-muted', text: t('m25.widget.results.none') }),
                hiddenRolls
                    ? el('div', {
                          class: 'maestro-muted maestro-m25-hidden-rolls',
                          text: t('m25.win.log.hiddenCount', { count: hiddenRolls }),
                      })
                    : null,
            ]),
            section(t('m25.widget.events'), [
                events.length
                    ? el(
                          'div',
                          { class: 'maestro-m25-list' },
                          events.slice(0, EVENTS_SHOWN).map((event) =>
                              el('div', { class: 'maestro-m25-row maestro-m25-log-event' }, [
                                  el('span', {
                                      text: eventLine(deps.app.i18n, api, event) ?? t('m25.win.log.event'),
                                  }),
                                  el('span', { class: 'maestro-muted', text: formatTime(event.at, deps.app.i18n) }),
                                  details(t('m25.play.details'), event.text),
                              ]),
                          ),
                      )
                    : el('div', { class: 'maestro-muted', text: t('m25.widget.events.none') }),
            ]),
        );
    });
}
