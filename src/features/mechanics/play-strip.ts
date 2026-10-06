// M25 «Механики» under the replies (plan-2 §6.А п.2 «В чате, под ответом»): one provider of the Maestro strip.
// - the change line: «Кай: ❤ 80 → 65 · 🔷 40 → 25 · + Отравлен (3 хода)» — only what the player may see under a
//   reply (each attribute's visibility, place 'strip', in its view: numbers, words, icons), never hidden-unrevealed or
//   secret values; ticks of statuses are not news; roll consequences go to their roll card. «Отменить» takes the whole
//   line back, the details list every change with its own «Отменить»;
// - a roll card per roll the player may see: the check, who, total against the target, the outcome and the applied
//   consequences («провал: −10 ❤»); the details show the dice, the other side of an opposed check, the second roll of
//   an advantage, and what the model was told (English, under «Подробнее»); «Отменить бросок» takes its
//   consequences back. It replaces the old memory-only roll badge: the roll log is stored, so the cards come back
//   after a reload;
// - a threshold event («Кай · Мана: ничего не осталось — сработало событие») with the note for the model;
// - the status block (В22: off by default — per attribute, place 'statusBlock'): under the latest reply, the state of
//   everyone in the scene after that turn as a compact table.
// Items are derived from the stored state and roll log through MechanicsApi (one index per change of the state, so
// items() stays cheap on every repaint). Display only: never the message text, the prompt or Qvink memory.
import type { App, I18n, Logger, MessageStripProvider, StripItem, Unsubscribe } from '../../shared/contracts';
import { clear, el } from '../../ui/components/dom';
import type { CheckResult, FiredEvent, MechanicDef, MechanicsApi, StateChange } from './api';
import { describeCheck } from './checks';
import {
    changeSeen,
    changeSegment,
    effectiveNumbers,
    holdersOf,
    partsShown,
    personaOf,
    sameName,
    shownIn,
    statusChip,
    statusesOf,
    translator,
    valueNode,
    wordsText,
} from './view-values';

export const PLAY_STRIP_PROVIDER = 'mechanics';
/** After the Inbox (10) and the living canon (20), before the memory-only badges (50). */
export const PLAY_STRIP_ORDER = 30;
const LOG_LOOKUP = 1000;
const ROLLS_LOOKUP = 100;
const EVENTS_LOOKUP = 200;
const SUMMARY_MAX = 140;

export const PLAY_STRIP_CSS = `
.maestro-m25-roll-card { display: flex; flex-direction: column; gap: 6px; }
.maestro-m25-dice-faces { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.maestro-m25-die { display: inline-flex; align-items: center; justify-content: center; min-width: 1.8em; height: 1.8em;
    padding: 0 3px; border-radius: 5px; border: 1px solid var(--maestro-border, rgba(127,127,127,0.5)); font-weight: 600;
    box-sizing: border-box; }
.maestro-m25-die-crit { border-color: var(--maestro-ok, #5a5); }
.maestro-m25-die-fumble { border-color: var(--maestro-error, #d55); }
.maestro-m25-roll-row { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.maestro-m25-change-list { display: flex; flex-direction: column; gap: 4px; }
.maestro-m25-change-item { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.maestro-m25-details { font-size: 0.9em; }
.maestro-m25-details > summary { cursor: pointer; opacity: 0.8; }
.maestro-m25-status-table { border-collapse: collapse; font-size: 0.9em; max-width: 100%; }
.maestro-m25-status-wrap { overflow-x: auto; max-width: 100%; }
.maestro-m25-status-table th, .maestro-m25-status-table td { padding: 2px 8px; text-align: left; vertical-align: middle;
    border-bottom: 1px solid var(--maestro-border, rgba(127,127,127,0.3)); white-space: nowrap; }
`;

interface Bucket {
    changes: StateChange[];
    rolls: CheckResult[];
    events: FiredEvent[];
}

export interface PlayStripDeps {
    app: App;
    log: Logger;
}

function safe<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/** The English note under «Подробнее» (what the model was told). */
export function details(summary: string, text: string): HTMLElement {
    return el('details', { class: 'maestro-m25-details' }, [el('summary', { text: summary }), el('div', { text })]);
}

/** The display name of a check (its id when the definition is gone). */
export function checkNameIn(api: MechanicsApi, mechanicId: string, checkId: string): string {
    const def = safe(() => api.get(mechanicId), null);
    return def?.checks.find((check) => check.id === checkId)?.name ?? checkId;
}

/** The one line of a roll: «Убеждение (Кай): 16 против 15 — успех», an opposed one with both sides. */
export function rollLine(i18n: I18n, api: MechanicsApi, result: CheckResult): string {
    const t = translator(i18n);
    const name = checkNameIn(api, result.mechanicId, result.checkId);
    let line = result.vs
        ? t('m25.play.roll.opposed', {
              check: name,
              holder: result.holder,
              total: result.total,
              other: checkNameIn(api, result.vs.mechanicId, result.vs.checkId),
              rival: result.vs.holder,
              rivalTotal: result.vs.total,
              outcome: t(`m25.check.outcome.${result.outcome}`),
          })
        : describeCheck(result, i18n, name);
    if (result.mode) line += ` ${t(`m25.play.roll.mode.${result.mode}`)}`;
    return line;
}

/** The applied consequences of a roll the player may see («−10 ❤», «Стражник: + Встревожен»). */
export function rollConsequences(
    i18n: I18n,
    api: MechanicsApi,
    result: CheckResult,
    changes: readonly StateChange[],
): string[] {
    const out: string[] = [];
    for (const change of changes) {
        if (change.rollId !== result.id) continue;
        if (!safe(() => changeSeen(api, change, 'strip'), false)) continue;
        const text = safe(() => changeSegment(i18n, api, change), null);
        if (!text) continue;
        const holder = change.holder === 'world' ? i18n.t('m25.state.holder.world') : change.holder;
        out.push(sameName(change.holder, result.holder) ? text : `${holder}: ${text}`);
    }
    return out;
}

/** «ничего не осталось» / «не больше 0» / «равно fire» / «изменилось»: the condition of a threshold event. */
function eventCondition(i18n: I18n, api: MechanicsApi, def: MechanicDef, attributeId: string, eventId: string): string {
    const t = translator(i18n);
    const attribute = def.attributes.find((item) => item.id === attributeId);
    const when = attribute?.events?.find((item) => item.id === eventId)?.when;
    if (!attribute || !when || when.op === 'changed') return t('m25.play.event.changed');
    const visibility = safe(() => api.visibilityOf?.(def.id, attribute.id) ?? null, null);
    if (visibility?.view === 'words' || visibility?.view === 'icon') {
        const words = safe(() => api.wordsOf?.(def.id, attribute.id, when.value ?? null) ?? null, null);
        if (words) return wordsText(t, words);
    }
    const value = String(when.value ?? '');
    if (when.op === '<=') return t('m25.play.event.atMost', { value });
    if (when.op === '>=') return t('m25.play.event.atLeast', { value });
    return t('m25.play.event.is', { value });
}

/**
 * A fired event in story words: «Кай · Мана: ничего не осталось — сработало событие», «Кай: состояние прошло», «Бой
 * окончен». Null for an event of a gone definition or of hidden / secret statuses. Visibility of the attribute is the
 * caller's business (the place differs).
 */
export function eventLine(i18n: I18n, api: MechanicsApi, event: FiredEvent): string | null {
    const t = translator(i18n);
    const holder = event.holder === 'world' ? t('m25.state.holder.world') : event.holder;
    if (event.attribute === 'combat') return t('m25.play.combatEnd');
    const def = safe(() => api.get(event.mechanicId), null);
    if (!def) return null;
    if (event.attribute === 'status') {
        return partsShown(api, def.id) ? t('m25.play.event.status', { holder }) : null;
    }
    const attribute = def.attributes.find((item) => item.id === event.attribute);
    if (!attribute) return null;
    return t('m25.play.event', {
        holder,
        attribute: attribute.name,
        condition: eventCondition(i18n, api, def, attribute.id, event.eventId),
    });
}

export class MechanicsPlayStrip {
    private index: Map<number, Bucket> | null = null;
    /** Consequences by roll id (a roll by hand made before its message keeps its changes at -1). */
    private byRoll = new Map<string, StateChange[]>();
    private readonly listeners = new Set<(indexes?: number[]) => void>();
    private readonly offs: Unsubscribe[] = [];
    private disposed = false;

    constructor(
        private readonly deps: PlayStripDeps,
        private readonly api: MechanicsApi,
    ) {}

    private get t() {
        return translator(this.deps.app.i18n);
    }

    install(): void {
        const { app } = this.deps;
        this.offs.push(app.ui.style('maestro-m25-play-strip', PLAY_STRIP_CSS));
        this.offs.push(
            this.api.onChange(() => {
                this.index = null;
                this.emit();
            }),
        );
        if (this.api.onEvent) {
            this.offs.push(
                this.api.onEvent((event) => {
                    this.index = null;
                    const indexes = new Set<number>();
                    if (event.type === 'changes' || event.type === 'undone')
                        for (const change of event.changes) indexes.add(change.messageIndex);
                    if (event.type === 'changes') indexes.add(event.messageIndex);
                    if (event.type === 'roll') indexes.add(event.result.messageIndex);
                    if (event.type === 'event') indexes.add(event.event.messageIndex);
                    const known = [...indexes].filter((index) => index >= 0);
                    if (event.type === 'combat') this.emit();
                    else if (known.length) this.emit(known);
                }),
            );
        }
        // A new reply takes the status block from the previous one.
        this.offs.push(app.bus.on('reply:ready', () => this.emit()));
        this.offs.push(
            app.bus.on('chat:changed', () => {
                this.index = null;
            }),
        );
        if (app.ui.addMessageStripProvider) this.offs.push(app.ui.addMessageStripProvider(this.provider()));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics strip: release failed', error);
            }
        }
        this.listeners.clear();
        this.index = null;
    }

    provider(): MessageStripProvider {
        return {
            id: PLAY_STRIP_PROVIDER,
            order: PLAY_STRIP_ORDER,
            items: (index) => this.items(index),
            onChange: (listener) => {
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
            },
        };
    }

    private emit(indexes?: number[]): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(indexes);
            } catch (error) {
                this.deps.log.debug('mechanics strip listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- the index */

    private bucket(index: number): Bucket | undefined {
        if (!this.index) this.index = this.build();
        return this.index.get(index);
    }

    private build(): Map<number, Bucket> {
        const map = new Map<number, Bucket>();
        const at = (index: number): Bucket => {
            let bucket = map.get(index);
            if (!bucket) {
                bucket = { changes: [], rolls: [], events: [] };
                map.set(index, bucket);
            }
            return bucket;
        };
        this.byRoll = new Map();
        if (!this.deps.app.host.chatId()) return map;
        // history() is newest first: oldest first per message.
        for (const change of [...safe(() => this.api.history(LOG_LOOKUP), [])].reverse()) {
            if (change.rollId) {
                const list = this.byRoll.get(change.rollId) ?? [];
                list.push(change);
                this.byRoll.set(change.rollId, list);
            }
            if (change.messageIndex >= 0) at(change.messageIndex).changes.push(change);
        }
        for (const result of [...safe(() => this.api.checks(ROLLS_LOOKUP), [])].reverse()) {
            if (result.messageIndex >= 0 && !result.hidden) at(result.messageIndex).rolls.push(result);
        }
        for (const event of [...safe(() => this.api.events(EVENTS_LOOKUP), [])].reverse()) {
            if (event.messageIndex >= 0) at(event.messageIndex).events.push(event);
        }
        return map;
    }

    /* ---------------------------------------------------------------- items */

    items(index: number): StripItem[] {
        if (this.disposed || !this.deps.app.host.chatId()) return [];
        const bucket = this.bucket(index);
        const items: StripItem[] = [];
        if (bucket) {
            const line = this.changeItem(bucket.changes);
            if (line) items.push(line);
            for (const roll of bucket.rolls) {
                const card = this.rollItem(roll, this.byRoll.get(roll.id) ?? []);
                if (card) items.push(card);
            }
            for (const event of bucket.events) {
                const item = this.eventItem(event);
                if (item) items.push(item);
            }
        }
        const block = this.statusBlockItem(index);
        if (block) items.push(block);
        return items;
    }

    /** Changes of the line: seen under a reply, not a roll's consequence (its card says them), not a status tick. */
    private lineChanges(changes: readonly StateChange[]): { change: StateChange; text: string }[] {
        const out: { change: StateChange; text: string }[] = [];
        for (const change of changes) {
            if (change.rollId) continue;
            if (!safe(() => changeSeen(this.api, change, 'strip'), false)) continue;
            const text = safe(() => changeSegment(this.deps.app.i18n, this.api, change), null);
            if (text) out.push({ change, text });
        }
        return out;
    }

    private holderLabel(holder: string): string {
        return holder === 'world' ? this.t('m25.state.holder.world') : holder;
    }

    /** «Кай: ❤ 80 → 65 · + Отравлен; Мира: − Отравлен» (holders in their first-change order). */
    private lineText(entries: readonly { change: StateChange; text: string }[]): string {
        const groups = new Map<string, string[]>();
        for (const { change, text } of entries) {
            const holder = change.kind === 'combat' ? '' : change.holder;
            const list = groups.get(holder) ?? [];
            list.push(text);
            groups.set(holder, list);
        }
        return [...groups.entries()]
            .map(([holder, texts]) =>
                holder ? `${this.holderLabel(holder)}: ${texts.join(' · ')}` : texts.join(' · '),
            )
            .join('; ');
    }

    private async undoAll(changes: readonly StateChange[]): Promise<void> {
        let failed = 0;
        for (const change of [...changes].reverse()) {
            const ok = await safe(
                () => this.api.undoChange?.(change.id) ?? Promise.resolve(false),
                Promise.resolve(false),
            );
            if (!ok) failed++;
        }
        if (failed)
            this.deps.app.ui.notice(this.t('m25.play.undo.partial', { count: failed }), {
                level: 'warn',
                urgent: true,
            });
    }

    private changeItem(changes: readonly StateChange[]): StripItem | null {
        const entries = this.lineChanges(changes);
        if (!entries.length) return null;
        const t = this.t;
        const list = entries.map((entry) => entry.change);
        return {
            id: 'changes',
            kind: 'change',
            icon: 'fa-arrow-right-arrow-left',
            text: this.lineText(entries),
            actions: [{ label: t('m25.play.undo'), run: () => this.undoAll(list) }],
            body: (container) => {
                const box = el(
                    'div',
                    { class: 'maestro-m25-change-list' },
                    entries.map(({ change, text }) =>
                        el('div', { class: 'maestro-m25-change-item', data: { change: change.id } }, [
                            el('span', {
                                text: change.kind === 'combat' ? text : `${this.holderLabel(change.holder)}: ${text}`,
                            }),
                            el('span', { class: 'maestro-muted', text: t(`m25.widget.source.${change.source}`) }),
                            change.reason
                                ? el('span', {
                                      class: 'maestro-muted',
                                      text: t('m25.widget.change.reason', { reason: change.reason }),
                                  })
                                : null,
                            el('button', {
                                class: 'maestro-strip-action maestro-m25-undo-one',
                                text: t('m25.play.undo'),
                                attrs: { type: 'button' },
                                on: {
                                    click: (event) => {
                                        const node = event.currentTarget as HTMLButtonElement;
                                        node.disabled = true;
                                        void this.undoOne(change);
                                    },
                                },
                            }),
                        ]),
                    ),
                );
                container.appendChild(box);
                return () => clear(container);
            },
        };
    }

    private async undoOne(change: StateChange): Promise<void> {
        const ok = await safe(() => this.api.undoChange?.(change.id) ?? Promise.resolve(false), Promise.resolve(false));
        if (!ok) this.deps.app.ui.notice(this.t('m25.play.undo.failed'), { level: 'warn', urgent: true });
    }

    /* ---------------------------------------------------------------- rolls */

    private checkName(mechanicId: string, checkId: string): string {
        return checkNameIn(this.api, mechanicId, checkId);
    }

    private rollItem(result: CheckResult, changes: readonly StateChange[]): StripItem | null {
        if (result.hidden) return null;
        const t = this.t;
        const consequences = rollConsequences(this.deps.app.i18n, this.api, result, changes);
        const outcome = consequences.length ? ` · ${consequences.join(' · ')}` : '';
        const line = rollLine(this.deps.app.i18n, this.api, result);
        const text = `${line}${outcome}${result.undone ? ` ${t('m25.play.roll.undone')}` : ''}`;
        const undoable = !result.undone && (result.changes?.length ?? 0) > 0 && !!this.api.undoRoll;
        const item: StripItem = {
            id: `roll-${result.id}`,
            kind: 'roll',
            icon: 'fa-dice-d20',
            tone: result.outcome === 'critical' ? 'accent' : result.outcome === 'fumble' ? 'warn' : 'normal',
            text,
            body: (container) => {
                container.appendChild(this.rollCard(result, consequences));
                return () => clear(container);
            },
        };
        if (undoable) {
            item.actions = [
                {
                    label: t('m25.play.roll.undo'),
                    run: async () => {
                        const ok = await this.api.undoRoll?.(result.id);
                        if (!ok) this.deps.app.ui.notice(t('m25.play.undo.failed'), { level: 'warn', urgent: true });
                    },
                },
            ];
        }
        return item;
    }

    private dice(rolls: readonly number[], sides: number | null): HTMLElement {
        return el(
            'span',
            { class: 'maestro-m25-dice-faces' },
            rolls.map((value) =>
                el('span', {
                    class: [
                        'maestro-m25-die',
                        sides !== null && value === sides ? 'maestro-m25-die-crit' : null,
                        sides !== null && value === 1 ? 'maestro-m25-die-fumble' : null,
                    ],
                    text: String(value),
                }),
            ),
        );
    }

    /** Dice faces, the modifier, the total and the target; the other side; consequences; the model's note. */
    rollCard(result: CheckResult, consequences: readonly string[]): HTMLElement {
        const t = this.t;
        const sides = /^\d*d(\d+)/i.exec(result.dice)?.[1];
        const sideCount = sides ? Number(sides) : null;
        const modifier = result.modifier ? (result.modifier > 0 ? `+${result.modifier}` : String(result.modifier)) : '';
        const rows: (HTMLElement | null)[] = [
            el('div', { class: 'maestro-m25-roll-row' }, [
                el('span', { class: 'maestro-muted', text: t('m25.play.roll.dice', { dice: result.dice }) }),
                this.dice(result.rolls, sideCount),
                modifier ? el('span', { text: modifier }) : null,
                el('span', { text: t('m25.play.roll.total', { total: result.total }) }),
                result.target !== null && !result.vs
                    ? el('span', { class: 'maestro-muted', text: t('m25.play.roll.target', { target: result.target }) })
                    : null,
            ]),
            result.mode && result.other !== undefined
                ? el('div', {
                      class: 'maestro-muted',
                      text: t(`m25.play.roll.other.${result.mode}`, { other: result.other }),
                  })
                : null,
            result.vs
                ? el('div', { class: 'maestro-m25-roll-row' }, [
                      el('span', {
                          text: t('m25.play.roll.rival', {
                              holder: result.vs.holder,
                              check: this.checkName(result.vs.mechanicId, result.vs.checkId),
                          }),
                      }),
                      this.dice(result.vs.rolls, null),
                      el('span', { text: t('m25.play.roll.total', { total: result.vs.total }) }),
                  ])
                : null,
            el('div', { text: t('m25.play.roll.outcome', { outcome: t(`m25.check.outcome.${result.outcome}`) }) }),
            consequences.length
                ? el('div', { text: t('m25.play.roll.consequences', { list: consequences.join(' · ') }) })
                : null,
            result.undone ? el('div', { class: 'maestro-muted', text: t('m25.play.roll.undoneHint') }) : null,
            el('div', { class: 'maestro-muted', text: t(`m25.check.by.${result.by}`) }),
            result.text ? details(t('m25.play.details'), result.text) : null,
        ];
        return el('div', { class: 'maestro-m25-roll-card', data: { roll: result.id } }, rows);
    }

    /* ---------------------------------------------------------------- events */

    private eventItem(event: FiredEvent): StripItem | null {
        const t = this.t;
        if (event.attribute !== 'combat' && event.attribute !== 'status') {
            const visible = safe(
                () => this.api.shown?.(event.mechanicId, event.attribute, 'strip', event.holder) ?? true,
                false,
            );
            if (!visible) return null;
        }
        const text = eventLine(this.deps.app.i18n, this.api, event);
        if (!text) return null;
        return {
            id: `event-${event.mechanicId}-${event.eventId}-${event.holder}-${event.at}`,
            kind: 'info',
            icon: 'fa-bolt',
            tone: 'warn',
            text,
            body: (container) => {
                container.appendChild(details(t('m25.play.details'), event.text));
                return () => clear(container);
            },
        };
    }

    /* ---------------------------------------------------------------- the status block */

    private lastReply(): number {
        const chat = safe(() => this.deps.app.host.ctx().chat ?? [], [] as STChatMessage[]);
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return i;
        }
        return -1;
    }

    /** Who the block lists: the user's character first, then the characters in the scene. */
    private blockHolders(): string[] {
        const persona = personaOf(this.api);
        const names: string[] = [];
        for (const def of safe(() => this.api.active(), [] as MechanicDef[])) {
            if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
            for (const holder of holdersOf(this.api, def))
                if (!names.some((name) => sameName(name, holder))) names.push(holder);
        }
        names.sort((a, b) => Number(sameName(b, persona)) - Number(sameName(a, persona)));
        return names;
    }

    /** Values of the block per holder: [mechanic, attribute, shown] for every attribute with the place on. */
    private blockRows(): { holder: string; cells: HTMLElement[]; short: string[] }[] {
        const t = this.t;
        const rows: { holder: string; cells: HTMLElement[]; short: string[] }[] = [];
        for (const holder of this.blockHolders()) {
            const cells: HTMLElement[] = [];
            const short: string[] = [];
            for (const def of safe(() => this.api.active(), [] as MechanicDef[])) {
                if (!holdersOf(this.api, def).some((name) => sameName(name, holder))) continue;
                const effective = effectiveNumbers(this.api, def, holder);
                for (const attribute of def.attributes) {
                    const shown = shownIn(this.api, def, attribute, holder, 'statusBlock', effective);
                    if (!shown) continue;
                    cells.push(valueNode(t, attribute, shown));
                    short.push(
                        `${attribute.icon || attribute.name} ${shown.view === 'words' ? wordsText(t, shown.words) : shown.text}`,
                    );
                }
            }
            if (cells.length) rows.push({ holder, cells, short });
        }
        return rows;
    }

    private statusBlockItem(index: number): StripItem | null {
        if (index !== this.lastReply()) return null;
        const rows = this.blockRows();
        if (!rows.length) return null;
        const t = this.t;
        let summary = rows.map((row) => `${row.holder} ${row.short.slice(0, 3).join(' ')}`).join(' · ');
        if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`;
        return {
            id: 'status-block',
            kind: 'info',
            icon: 'fa-table-list',
            text: t('m25.play.block', { summary }),
            body: (container) => {
                const table = el('table', { class: 'maestro-m25-status-table' }, [
                    el(
                        'tbody',
                        {},
                        rows.map((row) => {
                            const statuses = statusesOf(this.api, row.holder);
                            return el('tr', { data: { holder: row.holder } }, [
                                el('th', { text: row.holder, attrs: { scope: 'row' } }),
                                ...row.cells.map((cell) => el('td', {}, [cell])),
                                el(
                                    'td',
                                    {},
                                    statuses.map((status) => statusChip(this.deps.app.i18n, status, true)),
                                ),
                            ]);
                        }),
                    ),
                ]);
                container.appendChild(el('div', { class: 'maestro-m25-status-wrap' }, [table]));
                return () => clear(container);
            },
        };
    }
}
