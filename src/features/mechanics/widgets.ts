// M25 «Механики», widgets (plan M25 п.6, §7): the pult section of the mechanics in the scene and a compact strip of
// bars next to DES's portrait bar.
// - stateSection: per mechanic on in this chat, per holder in the scene — the values (bars for bounded numbers, chips
//   for lists, the level of a scale) with inline edits (state.apply, source 'user'), the recent changes with their
//   source, the «Бросок» picker (check, who, difficulty) with the recent rolls, and the fired events.
// - MechanicStrip: when settings.strip is on and DES's `#dooms-portrait-bar-wrapper` exists, ONE own element right
//   after it (never inside DES's DOM): the visible number attributes of the characters in the scene as small bars,
//   one line when collapsed (the default on phones). DES moves or rebuilds its wrapper (position setting, re-init): a
//   MutationObserver on the wrapper's parent (childList only — streaming text never reaches it) puts the strip back;
//   without a wrapper a cheap poll looks for it. Hidden by CSS when DES hides its bar or docks it to a side.
import { initialValueOf, parseDice } from '../../domain/mechanics-defs';
import type { Unsubscribe } from '../../shared/contracts';
import { badge, card, emptyState, section } from '../../ui/components/card';
import type { Level } from '../../ui/components/card';
import { numberInput, select } from '../../ui/components/controls';
import { button, clear, el, icon } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type {
    AttributeDef,
    AttributeValue,
    ChangeSource,
    CheckDef,
    CheckResult,
    MechanicDef,
    StateChange,
} from './api';
import { checkNameOf, describeCheck } from './checks';
import type { ChecksPart, DefinitionsPart, PartDeps, SectionRenderer, StatePart } from './parts';

export const STRIP_ID = 'maestro-m25-strip';
export const DES_WRAPPER_ID = 'dooms-portrait-bar-wrapper';
export const WIDGETS_STYLE_ID = 'maestro-m25-widgets';
/** Recent changes, rolls and events shown per mechanic. */
const RECENT_SHOWN = 5;
const LOOKUP = 50;
const STRIP_POLL_MS = 2000;
const NARROW_QUERY = '(max-width: 768px)';

export const WIDGETS_CSS = `
.maestro-m25-state .maestro-m25-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m25-state .maestro-m25-holder { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.maestro-m25-state .maestro-m25-holder-name { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m25-state .maestro-m25-attr { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m25-state .maestro-m25-attr-name { min-width: 7em; opacity: 0.85; }
.maestro-m25-state .maestro-m25-attr .maestro-number { width: 6em; }
.maestro-m25-state .maestro-m25-attr .maestro-select, .maestro-m25-state .maestro-m25-attr .maestro-m25-text { max-width: 100%; }
.maestro-m25-state .maestro-m25-meter { flex: 1 1 120px; max-width: 240px; height: 8px; }
.maestro-m25-state .maestro-m25-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.maestro-m25-state .maestro-m25-chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 6px; border-radius: 10px;
    border: 1px solid var(--maestro-border); font-size: 0.9em; }
.maestro-m25-state .maestro-m25-chip button { background: none; border: none; color: inherit; cursor: pointer; padding: 0 2px; }
.maestro-m25-state .maestro-m25-sub { font-weight: 600; margin-top: 6px; }
.maestro-m25-state .maestro-m25-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.9em;
    overflow-wrap: anywhere; }
.maestro-m25-state .maestro-m25-roll { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m25-state .maestro-m25-roll .maestro-number { width: 6em; }
.maestro-m25-meter { display: inline-block; width: 56px; height: 6px; border-radius: 3px; overflow: hidden;
    background: rgba(127, 127, 127, 0.3); vertical-align: middle; }
.maestro-m25-meter-fill { display: block; height: 100%; background: var(--SmartThemeQuoteColor, #e0a84f); }
.maestro-m25-strip { display: flex; align-items: center; gap: 8px; box-sizing: border-box; max-width: 100%;
    margin: 2px 0; padding: 3px 8px; font-size: 0.85em; border-radius: 6px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.3));
    border: 1px solid var(--SmartThemeBorderColor, rgba(127, 127, 127, 0.3)); }
.maestro-m25-strip[hidden],
#${DES_WRAPPER_ID}.dooms-pb-position-left + .maestro-m25-strip,
#${DES_WRAPPER_ID}.dooms-pb-position-right + .maestro-m25-strip,
#${DES_WRAPPER_ID}[style*="display: none"] + .maestro-m25-strip { display: none; }
.maestro-m25-strip-title { flex: none; font-weight: 600; opacity: 0.8; }
.maestro-m25-strip-list { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; gap: 2px 14px; }
.maestro-m25-strip-holder { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.maestro-m25-strip-name { font-weight: 600; }
.maestro-m25-strip-stat { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.maestro-m25-strip-toggle { flex: none; min-width: 32px; min-height: 28px; background: none; border: none;
    color: inherit; cursor: pointer; }
.maestro-m25-strip-collapsed .maestro-m25-strip-list { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
    white-space: nowrap; scrollbar-width: none; }
.maestro-m25-strip-collapsed .maestro-m25-strip-list::-webkit-scrollbar { display: none; }
/* One line: holders keep their width and the line scrolls sideways instead of squeezing them over each other. */
.maestro-m25-strip-collapsed .maestro-m25-strip-holder { flex: none; }
.maestro-m25-strip-collapsed .maestro-m25-strip-title { display: none; }
@media ${NARROW_QUERY} {
    .maestro-m25-strip { gap: 6px; padding: 2px 6px; }
    .maestro-m25-strip .maestro-m25-meter { width: 36px; }
}
`;

/** The values a holder shows: the stored one, else the attribute's initial value. */
function valueOf(state: StatePart, def: MechanicDef, holder: string, attribute: AttributeDef): AttributeValue {
    try {
        return state.value(def.id, holder, attribute.id) ?? initialValueOf(attribute);
    } catch {
        return initialValueOf(attribute);
    }
}

function bounded(attribute: AttributeDef): attribute is AttributeDef & { min: number; max: number } {
    return typeof attribute.min === 'number' && typeof attribute.max === 'number' && attribute.max > attribute.min;
}

/** A small meter for a bounded number (role meter, a fill as wide as the share). */
export function meter(value: number, min: number, max: number, label: string): HTMLElement {
    const share = Math.min(1, Math.max(0, (value - min) / (max - min)));
    const fill = el('span', { class: 'maestro-m25-meter-fill' });
    fill.style.width = `${Math.round(share * 100)}%`;
    return el(
        'span',
        {
            class: 'maestro-m25-meter',
            attrs: {
                role: 'meter',
                'aria-label': label,
                'aria-valuemin': min,
                'aria-valuemax': max,
                'aria-valuenow': value,
            },
        },
        [fill],
    );
}

function plain(value: AttributeValue | null, none: string): string {
    if (value === null || value === undefined) return '—';
    if (Array.isArray(value)) return value.length ? value.join(', ') : none;
    return String(value);
}

const SOURCE_LEVEL: Record<ChangeSource, Level> = {
    desStats: 'info',
    block: 'info',
    background: 'muted',
    check: 'warn',
    event: 'warn',
    user: 'ok',
};

const OUTCOME_LEVEL: Record<CheckResult['outcome'], Level> = {
    critical: 'ok',
    success: 'ok',
    failure: 'error',
    fumble: 'error',
    none: 'muted',
};

/* ------------------------------------------------------------------ the pult section */

interface Picked {
    check: string;
    holder: string;
    difficulty: string;
}

export function stateSection(
    deps: PartDeps,
    defs: DefinitionsPart,
    state: StatePart,
    checks: ChecksPart,
): SectionRenderer {
    const { app } = deps;
    const t = app.i18n.t.bind(app.i18n);
    const picked = new Map<string, Picked>();

    const run = async (job: () => Promise<unknown>): Promise<void> => {
        try {
            await job();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            app.ui.notice(t('m25.widget.edit.failed', { error: message }), { level: 'warn' });
        }
    };

    const apply = (def: MechanicDef, holder: string, attribute: AttributeDef, value: AttributeValue) =>
        run(() =>
            state.apply([
                { mechanicId: def.id, holder, attribute: attribute.id, value, source: 'user', messageIndex: -1 },
            ]),
        );

    const numberControl = (def: MechanicDef, holder: string, attribute: AttributeDef, value: AttributeValue) => {
        const number = typeof value === 'number' ? value : Number(value) || 0;
        const input = numberInput({
            value: number,
            ...(typeof attribute.min === 'number' ? { min: attribute.min } : {}),
            ...(typeof attribute.max === 'number' ? { max: attribute.max } : {}),
            label: t('m25.widget.edit', { name: attribute.name }),
            onChange: (next) => apply(def, holder, attribute, next),
        });
        return [
            bounded(attribute) ? meter(number, attribute.min, attribute.max, attribute.name) : null,
            input,
            typeof attribute.max === 'number'
                ? el('span', { class: 'maestro-muted', text: `/ ${attribute.max}` })
                : null,
        ];
    };

    const scaleControl = (def: MechanicDef, holder: string, attribute: AttributeDef, value: AttributeValue) => {
        const levels = attribute.levels ?? [];
        const current = String(value);
        const index = levels.indexOf(current);
        return [
            select({
                value: current,
                options: levels.map((level) => ({ value: level, label: level })),
                label: t('m25.widget.edit', { name: attribute.name }),
                onChange: (next) => apply(def, holder, attribute, next),
            }),
            index >= 0
                ? el('span', {
                      class: 'maestro-muted',
                      text: t('m25.widget.level', { level: current, index: index + 1, count: levels.length }),
                  })
                : null,
        ];
    };

    const listControl = (def: MechanicDef, holder: string, attribute: AttributeDef, value: AttributeValue) => {
        const items = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
        const options = attribute.options ?? [];
        if (!attribute.multi && options.length) {
            return [
                select({
                    value: items[0] ?? '',
                    options: [
                        { value: '', label: t('m25.widget.list.none') },
                        ...options.map((option) => ({ value: option, label: option })),
                    ],
                    label: t('m25.widget.edit', { name: attribute.name }),
                    onChange: (next) => apply(def, holder, attribute, next ? [next] : []),
                }),
            ];
        }
        const chips = items.map((item) =>
            el('span', { class: 'maestro-m25-chip' }, [
                el('span', { text: item }),
                el('button', {
                    text: '×',
                    title: t('m25.widget.list.remove', { item }),
                    attrs: { type: 'button', 'aria-label': t('m25.widget.list.remove', { item }) },
                    on: {
                        click: () =>
                            void apply(
                                def,
                                holder,
                                attribute,
                                items.filter((other) => other !== item),
                            ),
                    },
                }),
            ]),
        );
        const rest = options.filter((option) => !items.includes(option));
        return [
            el('span', { class: 'maestro-m25-chips' }, [
                ...(chips.length ? chips : [el('span', { class: 'maestro-muted', text: t('m25.widget.list.none') })]),
                rest.length
                    ? select({
                          value: '',
                          options: [
                              { value: '', label: t('m25.widget.list.add') },
                              ...rest.map((option) => ({ value: option, label: option })),
                          ],
                          label: t('m25.widget.list.add'),
                          onChange: (next) => (next ? apply(def, holder, attribute, [...items, next]) : undefined),
                      })
                    : null,
            ]),
        ];
    };

    const textControl = (def: MechanicDef, holder: string, attribute: AttributeDef, value: AttributeValue) => {
        const input = el('input', {
            class: 'text_pole maestro-m25-text',
            attrs: { type: 'text', 'aria-label': t('m25.widget.edit', { name: attribute.name }) },
        });
        input.value = plain(value, '');
        input.addEventListener('change', () => void apply(def, holder, attribute, input.value.trim()));
        return [input];
    };

    const attributeRow = (def: MechanicDef, holder: string, attribute: AttributeDef): HTMLElement => {
        const value = valueOf(state, def, holder, attribute);
        const controls =
            attribute.kind === 'number'
                ? numberControl(def, holder, attribute, value)
                : attribute.kind === 'scale'
                  ? scaleControl(def, holder, attribute, value)
                  : attribute.kind === 'list'
                    ? listControl(def, holder, attribute, value)
                    : textControl(def, holder, attribute, value);
        return el('div', { class: 'maestro-m25-attr', data: { attribute: attribute.id } }, [
            el('span', { class: 'maestro-m25-attr-name', text: attribute.name }),
            ...controls,
        ]);
    };

    const holderBlock = (def: MechanicDef, holder: string): HTMLElement =>
        el('div', { class: 'maestro-m25-holder', data: { holder } }, [
            el('div', { class: 'maestro-m25-holder-name', text: holder }),
            ...def.attributes
                .filter((attribute) => attribute.visible !== false)
                .map((attribute) => attributeRow(def, holder, attribute)),
        ]);

    const changeRow = (def: MechanicDef, change: StateChange): HTMLElement => {
        const attribute = def.attributes.find((item) => item.id === change.attribute);
        const none = t('m25.widget.list.none');
        return el('div', { class: 'maestro-m25-row maestro-m25-change' }, [
            el('span', {
                text: t('m25.widget.change', {
                    holder: change.holder,
                    attribute: attribute?.name ?? change.attribute,
                    from: plain(change.from, none),
                    to: plain(change.to, none),
                }),
            }),
            badge(t(`m25.widget.source.${change.source}`), SOURCE_LEVEL[change.source] ?? 'muted'),
            change.reason
                ? el('span', { class: 'maestro-muted', text: t('m25.widget.change.reason', { reason: change.reason }) })
                : null,
            el('span', { class: 'maestro-muted', text: formatTime(change.at, app.i18n) }),
        ]);
    };

    const rollBlock = (def: MechanicDef, holders: string[]): HTMLElement => {
        const memory = picked.get(def.id);
        const firstCheck = def.checks.find((check) => check.id === memory?.check) ?? (def.checks[0] as CheckDef);
        const choice: Picked = {
            check: firstCheck.id,
            holder: memory && holders.includes(memory.holder) ? memory.holder : (holders[0] ?? ''),
            difficulty: memory?.difficulty ?? '',
        };
        picked.set(def.id, choice);
        const hint = el('div', { class: 'maestro-hint' });
        const difficulty = el('input', {
            class: 'text_pole maestro-number maestro-m25-difficulty',
            attrs: { type: 'number', inputmode: 'numeric', 'aria-label': t('m25.widget.roll.difficulty') },
        });
        difficulty.value = choice.difficulty;
        const describe = () => {
            const check = def.checks.find((item) => item.id === choice.check) ?? firstCheck;
            const under = parseDice(check.dice)?.under ?? null;
            difficulty.disabled = under !== null;
            difficulty.placeholder = check.difficulty === null ? '' : String(check.difficulty);
            hint.textContent = under
                ? t('m25.widget.roll.under')
                : check.difficulty === null
                  ? t('m25.widget.roll.noDefault')
                  : t('m25.widget.roll.default', { value: check.difficulty });
        };
        difficulty.addEventListener('input', () => {
            choice.difficulty = difficulty.value;
        });
        describe();
        const holderOptions = holders.length ? holders : [];
        return el('div', { class: 'maestro-m25-rolls' }, [
            el('div', { class: 'maestro-m25-sub', text: t('m25.widget.roll.title') }),
            el('div', { class: 'maestro-m25-roll' }, [
                select({
                    value: choice.check,
                    options: def.checks.map((check) => ({ value: check.id, label: check.name })),
                    label: t('m25.widget.roll.check'),
                    onChange: (value) => {
                        choice.check = value;
                        describe();
                    },
                }),
                holderOptions.length
                    ? select({
                          value: choice.holder,
                          options: holderOptions.map((holder) => ({ value: holder, label: holder })),
                          label: t('m25.widget.roll.holder'),
                          onChange: (value) => {
                              choice.holder = value;
                          },
                      })
                    : null,
                difficulty,
                button({
                    label: t('m25.widget.roll.button'),
                    title: t('m25.widget.roll.hint'),
                    icon: 'fa-dice-d20',
                    kind: 'primary',
                    className: 'maestro-m25-roll-button',
                    onClick: async () => {
                        const typed = difficulty.value.trim();
                        const value = typed && !difficulty.disabled ? Number(typed) : NaN;
                        try {
                            const result = await checks.roll(
                                def.id,
                                choice.check,
                                choice.holder,
                                Number.isFinite(value) ? { difficulty: value } : {},
                            );
                            const line = describeCheck(result, app.i18n, checkNameOf(defs, result));
                            app.ui.notice(t('m25.check.rolled', { line }), { urgent: true });
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            app.ui.notice(message, { urgent: true, level: 'warn' });
                        }
                    },
                }),
            ]),
            hint,
        ]);
    };

    const resultsBlock = (def: MechanicDef, pendingIds: ReadonlySet<string>): HTMLElement => {
        const results = checks
            .checks(LOOKUP)
            .filter((result) => result.mechanicId === def.id)
            .slice(0, RECENT_SHOWN);
        return el('div', { class: 'maestro-m25-results' }, [
            el('div', { class: 'maestro-m25-sub', text: t('m25.widget.results') }),
            results.length
                ? el(
                      'div',
                      { class: 'maestro-m25-list' },
                      results.map((result) =>
                          el('div', { class: 'maestro-m25-row maestro-m25-result', data: { id: result.id } }, [
                              badge(t(`m25.check.outcome.${result.outcome}`), OUTCOME_LEVEL[result.outcome]),
                              el('span', { text: describeCheck(result, app.i18n, checkNameOf(defs, result)) }),
                              el('span', {
                                  class: 'maestro-muted',
                                  text: `${result.dice} · ${t(`m25.check.by.${result.by}`)}`,
                              }),
                              pendingIds.has(result.id) ? badge(t('m25.widget.pending'), 'info') : null,
                          ]),
                      ),
                  )
                : el('div', { class: 'maestro-muted', text: t('m25.widget.results.none') }),
        ]);
    };

    const eventsBlock = (def: MechanicDef): HTMLElement | null => {
        const events = safeList(() => state.events(LOOKUP)).filter((event) => event.mechanicId === def.id);
        const hasEvents = def.attributes.some((attribute) => (attribute.events ?? []).length > 0);
        if (!events.length && !hasEvents) return null;
        const pendingKeys = new Set(
            safeList(() => state.pendingEvents()).map((event) => `${event.eventId}|${event.holder}|${event.at}`),
        );
        return el('div', { class: 'maestro-m25-events' }, [
            el('div', { class: 'maestro-m25-sub', text: t('m25.widget.events') }),
            events.length
                ? el(
                      'div',
                      { class: 'maestro-m25-list' },
                      events
                          .slice(0, RECENT_SHOWN)
                          .map((event) =>
                              el('div', { class: 'maestro-m25-row maestro-m25-event' }, [
                                  el('span', { text: event.text }),
                                  el('span', { class: 'maestro-muted', text: formatTime(event.at, app.i18n) }),
                                  pendingKeys.has(`${event.eventId}|${event.holder}|${event.at}`)
                                      ? badge(t('m25.widget.pending'), 'info')
                                      : null,
                              ]),
                          ),
                  )
                : el('div', { class: 'maestro-muted', text: t('m25.widget.events.none') }),
        ]);
    };

    const recentBlock = (def: MechanicDef): HTMLElement => {
        const changes = safeList(() => state.history(LOOKUP))
            .filter((change) => change.mechanicId === def.id)
            .slice(0, RECENT_SHOWN);
        return el('div', { class: 'maestro-m25-recent' }, [
            el('div', { class: 'maestro-m25-sub', text: t('m25.widget.recent') }),
            changes.length
                ? el(
                      'div',
                      { class: 'maestro-m25-list' },
                      changes.map((change) => changeRow(def, change)),
                  )
                : el('div', { class: 'maestro-muted', text: t('m25.widget.recent.none') }),
        ]);
    };

    const mechanicCard = (def: MechanicDef, pendingIds: ReadonlySet<string>): HTMLElement => {
        const holders = safeList(() => state.holdersInScene(def));
        return card({
            className: 'maestro-m25-mechanic',
            title: def.name,
            body: [
                holders.length
                    ? el(
                          'div',
                          { class: 'maestro-m25-list' },
                          holders.map((holder) => holderBlock(def, holder)),
                      )
                    : el('div', { class: 'maestro-muted', text: t('m25.widget.noHolders') }),
                def.checks.length ? rollBlock(def, holders) : null,
                def.checks.length ? resultsBlock(def, pendingIds) : null,
                eventsBlock(def),
                recentBlock(def),
            ],
        });
    };

    return (container) => {
        let alive = true;
        const root = el('div', { class: 'maestro-m25-state' });
        container.appendChild(root);
        const draw = () => {
            if (!alive) return;
            clear(root);
            if (!app.host.chatId()) {
                root.appendChild(emptyState(t('m25.widget.noChat'), 'fa-comment-slash'));
                return;
            }
            const active = safeList(() => defs.active());
            if (!active.length) {
                root.appendChild(emptyState(t('m25.widget.none'), 'fa-dice-d20'));
                return;
            }
            const pendingIds = new Set(safeList(() => checks.pendingChecks()).map((result) => result.id));
            root.appendChild(
                section(t('m25.widget.state.title'), [
                    el('div', { class: 'maestro-hint', text: t('m25.widget.state.hint') }),
                    ...active.map((def) => mechanicCard(def, pendingIds)),
                ]),
            );
        };
        const redraw = coalesce(draw, 100);
        const offs: Unsubscribe[] = [
            defs.onChange(() => alive && redraw()),
            state.onChange(() => alive && redraw()),
            checks.onChange(() => alive && redraw()),
            app.bus.on('chat:changed', () => {
                if (alive) redraw();
            }),
        ];
        draw();
        return () => {
            alive = false;
            redraw.cancel();
            for (const off of offs) off();
        };
    };
}

function safeList<T>(read: () => T[]): T[] {
    try {
        return read();
    } catch {
        return [];
    }
}

/* ------------------------------------------------------------------ the strip next to DES's portrait bar */

interface StripStat {
    label: string;
    value: number;
    min?: number;
    max?: number;
}

interface StripRow {
    holder: string;
    stats: StripStat[];
}

function narrowScreen(): boolean {
    try {
        return globalThis.matchMedia?.(NARROW_QUERY).matches ?? false;
    } catch {
        return false;
    }
}

export class MechanicStrip {
    private node: HTMLElement | null = null;
    private observer: MutationObserver | null = null;
    private watched: Node | null = null;
    private poll: ReturnType<typeof setInterval> | null = null;
    private readonly offs: Unsubscribe[] = [];
    private collapsed = narrowScreen();
    private disposed = false;
    private readonly redraw = coalesce(() => this.render(), 50);

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly state: StatePart,
    ) {}

    install(): void {
        const { app } = this.deps;
        this.offs.push(app.ui.style(WIDGETS_STYLE_ID, WIDGETS_CSS));
        this.offs.push(this.state.onChange(() => this.redraw()));
        this.offs.push(this.defs.onChange(() => this.redraw()));
        this.offs.push(app.bus.on('chat:changed', () => this.place()));
        this.offs.push(app.bus.on('reply:ready', () => this.redraw()));
        this.offs.push(app.settings.onChange(() => this.place()));
        this.place();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.redraw.cancel();
        this.unwatch();
        this.stopPolling();
        this.node?.remove();
        this.node = null;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('strip: release failed', error);
            }
        }
    }

    /** The strip element while it is attached (tests, the pult). */
    element(): HTMLElement | null {
        return this.node?.isConnected ? this.node : null;
    }

    private wanted(): boolean {
        return !!this.deps.settings().strip && !!this.deps.app.host.chatId();
    }

    /** Puts the strip right after DES's wrapper (or takes it away); idempotent and cheap. */
    place(): void {
        if (this.disposed || typeof document === 'undefined') return;
        if (!this.deps.settings().strip) {
            this.unwatch();
            this.stopPolling();
            this.node?.remove();
            return;
        }
        const wrapper = document.getElementById(DES_WRAPPER_ID);
        if (!wrapper?.parentNode) {
            this.unwatch();
            this.node?.remove();
            this.startPolling();
            return;
        }
        this.stopPolling();
        this.watch(wrapper.parentNode);
        if (!this.wanted()) {
            this.node?.remove();
            return;
        }
        const node = this.node ?? this.create();
        if (wrapper.nextSibling !== node) wrapper.after(node);
        this.render();
    }

    private create(): HTMLElement {
        this.node = el('div', {
            class: 'maestro-m25-strip',
            attrs: { id: STRIP_ID, role: 'region', 'aria-label': this.deps.app.i18n.t('m25.widget.strip.title') },
        });
        return this.node;
    }

    private watch(parent: Node): void {
        if (this.watched === parent && this.observer) return;
        this.unwatch();
        if (typeof MutationObserver === 'undefined') return;
        // childList of the wrapper's parent only: DES rebuilding or moving its bar shows here, chat streaming does not.
        this.observer = new MutationObserver(() => this.place());
        this.observer.observe(parent, { childList: true });
        this.watched = parent;
    }

    private unwatch(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.watched = null;
    }

    private startPolling(): void {
        if (this.poll !== null || this.disposed) return;
        this.poll = setInterval(() => {
            if (document.getElementById(DES_WRAPPER_ID)) this.place();
        }, STRIP_POLL_MS);
    }

    private stopPolling(): void {
        if (this.poll === null) return;
        clearInterval(this.poll);
        this.poll = null;
    }

    /** Visible number attributes of the characters in the scene (world and faction holders are not characters). */
    rows(): StripRow[] {
        const rows = new Map<string, StripRow>();
        for (const def of safeList(() => this.defs.active())) {
            if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
            const numbers = def.attributes.filter(
                (attribute) => attribute.kind === 'number' && attribute.visible !== false,
            );
            if (!numbers.length) continue;
            for (const holder of safeList(() => this.state.holdersInScene(def))) {
                const row = rows.get(holder) ?? { holder, stats: [] };
                for (const attribute of numbers) {
                    const value = valueOf(this.state, def, holder, attribute);
                    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
                    const stat: StripStat = { label: attribute.name, value };
                    if (bounded(attribute)) {
                        stat.min = attribute.min;
                        stat.max = attribute.max;
                    }
                    row.stats.push(stat);
                }
                if (row.stats.length) rows.set(holder, row);
            }
        }
        return [...rows.values()];
    }

    private render(): void {
        const node = this.node;
        if (this.disposed || !node?.isConnected) return;
        const t = this.deps.app.i18n.t.bind(this.deps.app.i18n);
        const rows = this.rows();
        clear(node);
        node.hidden = rows.length === 0;
        node.classList.toggle('maestro-m25-strip-collapsed', this.collapsed);
        if (!rows.length) return;
        const list = el(
            'div',
            { class: 'maestro-m25-strip-list' },
            rows.map((row) =>
                el('span', { class: 'maestro-m25-strip-holder', data: { holder: row.holder } }, [
                    el('span', { class: 'maestro-m25-strip-name', text: row.holder }),
                    ...row.stats.map((stat) =>
                        el('span', { class: 'maestro-m25-strip-stat', title: stat.label }, [
                            el('span', { class: 'maestro-m25-strip-label', text: stat.label }),
                            stat.max !== undefined && stat.min !== undefined
                                ? meter(stat.value, stat.min, stat.max, stat.label)
                                : null,
                            el('span', {
                                class: 'maestro-m25-strip-value',
                                text: stat.max !== undefined ? `${stat.value}/${stat.max}` : String(stat.value),
                            }),
                        ]),
                    ),
                ]),
            ),
        );
        const label = t(this.collapsed ? 'm25.widget.strip.expand' : 'm25.widget.strip.collapse');
        const toggle = el(
            'button',
            {
                class: 'maestro-m25-strip-toggle',
                title: label,
                attrs: { type: 'button', 'aria-label': label, 'aria-expanded': this.collapsed ? 'false' : 'true' },
                on: {
                    click: () => {
                        this.collapsed = !this.collapsed;
                        this.render();
                    },
                },
            },
            [icon(this.collapsed ? 'fa-chevron-down' : 'fa-chevron-up')],
        );
        node.append(el('span', { class: 'maestro-m25-strip-title', text: t('m25.widget.strip.title') }), list, toggle);
    }
}
