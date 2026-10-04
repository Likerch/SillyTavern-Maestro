// Pult tab «Промпт хода» (M2): weight of every source in the last turn's prompt, change against the previous turn
// and the chat average, facts repeated across sources, and a debug export without secrets.
import { adaptersOf } from '../../adapters';
import {
    barGroups,
    compareSources,
    exportMessages,
    findRepeats,
    messageRole,
    messageText,
    scrubSecrets,
    slotOwner,
} from '../../domain/lore-inspector';
import type { InspectorSource, SourceComparison, SourceText } from '../../domain/lore-inspector';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { formatTime } from '../../ui/views/format';
import type { InspectorRecord } from './api';
import type { Inspector, InspectorSettings, InspectorTurnDetails } from './inspector';

export const PROMPT_TAB = 'prompt';
const TURN_CHOICES = 30;

/** Bar colours by group (kinds and extension owners). */
const GROUP_HUES: Record<string, number> = {
    preset: 210,
    card: 280,
    lore: 140,
    history: 30,
    des: 0,
    ck: 330,
    qvink: 180,
    nai: 50,
    desru: 15,
    maestro: 250,
    wiOutlet: 110,
    wiDepth: 120,
    summary: 195,
    authorsNote: 300,
    other: 0,
};

export const M2_CSS = `
.maestro-m2-line { margin: 2px 0; }
.maestro-m2-bar { display: flex; width: 100%; height: 18px; border-radius: 4px; overflow: hidden; margin: 8px 0;
    background: rgba(127, 127, 127, 0.2); }
.maestro-m2-seg { height: 100%; min-width: 2px; }
.maestro-m2-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 0.9em; margin-bottom: 8px; }
.maestro-m2-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.maestro-m2-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
.maestro-m2-up { color: var(--maestro-warn, #d08a2c); }
.maestro-m2-down { color: var(--maestro-ok, #4a9d5b); }
.maestro-m2-repeats { display: flex; flex-direction: column; gap: 8px; }
.maestro-m2-repeat { overflow-wrap: anywhere; }
.maestro-m2-sentence { font-style: italic; }
.maestro-m2-repeat-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.maestro-m2-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.maestro-m2-details > summary { cursor: pointer; margin: 6px 0; }
`;

function colour(group: string): string {
    const hue = GROUP_HUES[group] ?? 0;
    return group === 'other' ? 'hsl(0 0% 55%)' : `hsl(${hue} 55% 52%)`;
}

export function promptTab(app: App, inspector: Inspector, settings: InspectorSettings): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);
    const number = (value: number): string => {
        try {
            return new Intl.NumberFormat(i18n.locale() === 'ru' ? 'ru-RU' : 'en-US').format(value);
        } catch {
            return String(value);
        }
    };
    const percent = (share: number): string => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
    const signed = (value: number | undefined): Child => {
        if (value === undefined) return '';
        if (value === 0) return '0';
        return el('span', {
            class: value > 0 ? 'maestro-m2-up' : 'maestro-m2-down',
            text: `${value > 0 ? '+' : '−'}${number(Math.abs(value))}`,
        });
    };

    const translated = (key: string, fallback: string): string => {
        const text = t(key);
        return text === key ? fallback : text;
    };

    const groupLabel = (group: string): string =>
        ['preset', 'card', 'lore', 'history'].includes(group)
            ? t(`m2.group.${group}`)
            : translated(`m2.owner.${group}`, group);

    const sourceLabel = (source: InspectorSource): string => {
        switch (source.kind) {
            case 'history':
                return t('m2.src.history');
            case 'lore':
                return source.name ? t('m2.src.lore', { book: source.name }) : t('m2.src.loreAll');
            case 'extension':
                return translated(`m2.owner.${source.owner ?? 'other'}`, source.owner ?? '');
            case 'card': {
                const name = source.name ?? '';
                if (name.startsWith('DEPTH_PROMPT')) return t('m2.card.depthPrompt');
                if (name === 'PERSONA_DESCRIPTION') return t('m2.card.personaDescription');
                return translated(`m2.card.${name}`, name);
            }
            default:
                return source.name === 'worldInfoFormat' ? t('m2.src.wiFormat') : (source.name ?? source.id);
        }
    };

    const barView = (record: InspectorRecord): HTMLElement[] => {
        const groups = barGroups(record.sources);
        const total = groups.reduce((sum, group) => sum + group.tokens, 0) || 1;
        return [
            el(
                'div',
                { class: 'maestro-m2-bar', attrs: { role: 'img', 'aria-label': t('m2.turn.title') } },
                groups.map((group) =>
                    el('div', {
                        class: 'maestro-m2-seg',
                        title: `${groupLabel(group.group)}: ${number(group.tokens)} (${percent(group.tokens / total)})`,
                        attrs: {
                            style: `width:${((group.tokens / total) * 100).toFixed(2)}%;background:${colour(group.group)}`,
                        },
                    }),
                ),
            ),
            el(
                'div',
                { class: 'maestro-m2-legend' },
                groups.map((group) =>
                    el('span', { class: 'maestro-m2-legend-item' }, [
                        el('span', { class: 'maestro-m2-dot', attrs: { style: `background:${colour(group.group)}` } }),
                        `${groupLabel(group.group)} · ${percent(group.tokens / total)}`,
                    ]),
                ),
            ),
        ];
    };

    const sourcesTable = (rows: SourceComparison[]): HTMLElement =>
        table(
            [
                { key: 'source', label: t('m2.col.source'), cell: (row) => sourceLabel(row.source) },
                { key: 'tokens', label: t('m2.col.tokens'), numeric: true, cell: (row) => number(row.source.tokens) },
                { key: 'share', label: t('m2.col.share'), numeric: true, cell: (row) => percent(row.share) },
                { key: 'prev', label: t('m2.col.prev'), numeric: true, cell: (row) => signed(row.deltaPrevious) },
                { key: 'avg', label: t('m2.col.avg'), numeric: true, cell: (row) => signed(row.deltaAverage) },
            ],
            rows,
            { caption: t('m2.turn.title') },
        );

    /** Texts by source for the repeat finder (only for the last turn of this session). */
    const sourceTexts = (details: InspectorTurnDetails): SourceText[] => {
        const texts: SourceText[] = [];
        for (const slot of details.capture.slots) {
            if (slot.position < 0) continue;
            const owner = slotOwner(slot.key);
            if (owner === 'wiDepth' && details.lore.length) continue;
            texts.push({ source: translated(`m2.owner.${owner}`, owner), text: slot.value });
        }
        const books = new Map<string, string[]>();
        for (const item of details.lore) books.set(item.world, [...(books.get(item.world) ?? []), item.content]);
        for (const [book, contents] of books)
            texts.push({ source: t('m2.src.lore', { book }), text: contents.join('\n') });
        try {
            const getter = (app.host.ctx() as unknown as { getCharacterCardFields?: () => Record<string, unknown> })
                .getCharacterCardFields;
            const fields = typeof getter === 'function' ? (getter() ?? {}) : {};
            const card: [string, unknown][] = [
                ['charDescription', fields.description],
                ['charPersonality', fields.personality],
                ['scenario', fields.scenario],
                ['personaDescription', fields.persona],
            ];
            for (const [name, value] of card) {
                if (typeof value === 'string' && value) texts.push({ source: t(`m2.card.${name}`), text: value });
            }
        } catch (error) {
            app.log.debug('card fields', error);
        }
        try {
            const counts = details.capture.counts ?? {};
            const prompts = adaptersOf(app).preset.settings()?.prompts;
            if (Array.isArray(prompts)) {
                for (const prompt of prompts) {
                    if (typeof prompt !== 'object' || prompt === null) continue;
                    const { identifier, name, content } = prompt as Record<string, unknown>;
                    if (typeof identifier !== 'string' || typeof content !== 'string' || !content) continue;
                    if (!(counts[identifier] ?? 0)) continue;
                    texts.push({ source: typeof name === 'string' && name ? name : identifier, text: content });
                }
            }
        } catch (error) {
            app.log.debug('preset prompts', error);
        }
        const history = details.capture.messages
            .filter((message) => ['user', 'assistant'].includes(messageRole(message)))
            .map((message) => messageText(message))
            .join('\n');
        if (history) texts.push({ source: t('m2.src.history'), text: history });
        return texts;
    };

    const repeatsView = (record: InspectorRecord): HTMLElement => {
        const details = inspector.detailsFor(record);
        if (!details) {
            return section(
                t('m2.repeats.title'),
                el('div', { class: 'maestro-muted', text: t('m2.repeats.unavailable') }),
            );
        }
        const repeats = findRepeats(sourceTexts(details));
        return section(t('m2.repeats.title'), [
            el('div', { class: 'maestro-hint', text: t('m2.repeats.hint') }),
            repeats.length
                ? el(
                      'div',
                      { class: 'maestro-m2-repeats' },
                      repeats.map((repeat) =>
                          el('div', { class: 'maestro-m2-repeat' }, [
                              el('div', { class: 'maestro-m2-sentence', text: repeat.sentence }),
                              el(
                                  'div',
                                  { class: 'maestro-m2-repeat-sources' },
                                  repeat.sources.map((source) => badge(source, 'muted')),
                              ),
                          ]),
                      ),
                  )
                : emptyState(t('m2.repeats.none')),
        ]);
    };

    const exportJson = (record: InspectorRecord, redact: boolean): string => {
        const details = inspector.detailsFor(record);
        let preset: string | undefined;
        try {
            preset = adaptersOf(app).preset.presetName();
        } catch {
            preset = undefined;
        }
        const lore = details?.loreRecord;
        const payload = {
            format: 'maestro-turn',
            version: 1,
            exportedAt: new Date().toISOString(),
            sillyTavern: app.host.version() ?? null,
            api: app.host.isChatCompletion() ? 'chat-completion' : 'other',
            preset: preset ?? null,
            redactedChat: redact,
            turn: record,
            lore: lore
                ? {
                      totalChars: lore.totalChars,
                      totalTokens: lore.totalTokens,
                      budgetTokens: lore.budgetTokens ?? null,
                      overflow: lore.overflow,
                      activations: lore.activations,
                  }
                : null,
            prompt: details ? exportMessages(details.capture.messages, redact) : null,
        };
        // Last line of defence: anything that looks like a key is masked, wherever it came from.
        return scrubSecrets(JSON.stringify(payload, null, 2));
    };

    const download = (name: string, text: string): void => {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = el('a', { attrs: { href: url, download: name } });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    /** The async Clipboard API exists only in secure contexts; ST is often served over plain HTTP on a LAN/VPS. */
    const copy = async (text: string): Promise<void> => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const area = el('textarea', { attrs: { readonly: true, 'aria-hidden': 'true' } });
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        try {
            document.execCommand('copy');
        } finally {
            area.remove();
        }
    };

    return {
        id: PROMPT_TAB,
        titleKey: 'm2.tab',
        icon: 'fa-layer-group',
        order: 21,
        render(container) {
            let alive = true;
            let selectedAt: number | null = null;
            let redact = true;
            let exportNote = '';

            const exportView = (record: InspectorRecord): HTMLElement => {
                const details = inspector.detailsFor(record);
                return section(t('m2.export.title'), [
                    toggle({
                        label: t('m2.export.redact'),
                        checked: redact,
                        onChange: (checked) => {
                            redact = checked;
                        },
                    }),
                    el('div', { class: 'maestro-hint', text: t('m2.export.hint') }),
                    details ? null : el('div', { class: 'maestro-hint', text: t('m2.export.noPrompt') }),
                    el('div', { class: 'maestro-m2-actions' }, [
                        button({
                            label: t('m2.export.download'),
                            icon: 'fa-file-export',
                            onClick: () =>
                                download(`maestro-turn-${record.messageIndex}.json`, exportJson(record, redact)),
                        }),
                        button({
                            label: t('m2.export.copy'),
                            icon: 'fa-copy',
                            kind: 'ghost',
                            onClick: async () => {
                                await copy(exportJson(record, redact));
                                exportNote = t('m2.export.copied');
                                draw();
                            },
                        }),
                        exportNote ? el('span', { class: 'maestro-muted', text: exportNote }) : null,
                    ]),
                ]);
            };

            const turnView = (records: InspectorRecord[], record: InspectorRecord): HTMLElement => {
                const index = records.indexOf(record);
                const previous = index > 0 ? records[index - 1] : undefined;
                const rows = compareSources(
                    record.sources,
                    previous?.sources,
                    records.map((item) => item.sources),
                );
                const picker =
                    records.length > 1
                        ? select({
                              label: t('m2.turn.pick'),
                              value: String(record.at),
                              options: records
                                  .slice(-TURN_CHOICES)
                                  .reverse()
                                  .map((item) => ({
                                      value: String(item.at),
                                      label: t('m2.turn.option', {
                                          index: item.messageIndex,
                                          type: item.generationType,
                                          time: formatTime(item.at, i18n),
                                      }),
                                  })),
                              onChange: (value) => {
                                  selectedAt = Number(value);
                                  exportNote = '';
                                  draw();
                              },
                          })
                        : undefined;
                return section(
                    t('m2.turn.title'),
                    [
                        el('div', {
                            class: 'maestro-m2-line',
                            text: t('m2.turn.summary', {
                                messages: record.messages,
                                tokens: number(record.totalTokens),
                            }),
                        }),
                        el('div', {
                            class: 'maestro-m2-line maestro-muted',
                            text: t('m2.turn.chars', {
                                system: number(record.chars.system),
                                user: number(record.chars.user),
                                assistant: number(record.chars.assistant),
                            }),
                        }),
                        el('div', {
                            class: 'maestro-m2-line maestro-muted',
                            text: `${record.exact ? t('m2.turn.exact') : t('m2.turn.estimate')} ${t('m2.turn.reconstructed')}`,
                        }),
                        record.loreByBook ? null : banner(t('m2.turn.loreNoBooks'), 'info', 'fa-circle-info'),
                        ...barView(record),
                        sourcesTable(rows),
                    ],
                    picker,
                );
            };

            const settingsView = (): HTMLElement =>
                el('details', { class: 'maestro-m2-details' }, [
                    el('summary', { text: t('m2.settings.title') }),
                    field(
                        t('m2.settings.keepTurns'),
                        numberInput({
                            value: settings.keepTurns,
                            min: 10,
                            max: 1000,
                            step: 10,
                            label: t('m2.settings.keepTurns'),
                            onChange: (value) => {
                                settings.keepTurns = Math.round(value);
                                app.settings.notify('modules.inspector.keepTurns');
                                app.settings.save();
                            },
                        }),
                    ),
                ]);

            const draw = (): void => {
                if (!alive) return;
                clear(container);
                if (!app.host.chatId()) {
                    container.append(el('div', { class: 'maestro-view' }, [emptyState(t('m2.noChat'), 'fa-comments')]));
                    return;
                }
                const records = inspector.turns();
                const record =
                    (selectedAt !== null ? records.find((item) => item.at === selectedAt) : undefined) ??
                    records[records.length - 1];
                container.append(
                    el('div', { class: 'maestro-view maestro-m2' }, [
                        app.host.isChatCompletion() ? null : banner(t('m2.ccOnly'), 'info', 'fa-circle-info'),
                        record
                            ? turnView(records, record)
                            : section(t('m2.turn.title'), emptyState(t('m2.turn.empty'), 'fa-layer-group')),
                        record ? repeatsView(record) : null,
                        record ? exportView(record) : null,
                        settingsView(),
                    ]),
                );
            };

            const offTurn = inspector.onTurn(() => {
                selectedAt = null;
                exportNote = '';
                draw();
            });
            void inspector.ensureLoaded().then(draw);
            draw();
            return () => {
                alive = false;
                offTurn();
            };
        },
    };
}
