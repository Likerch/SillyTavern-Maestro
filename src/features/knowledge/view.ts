// Pult tab «Кто знает» (M18): the «experimental» banner, what the voice cards get now, the facts with who knows them
// (secrets highlighted, first), «знает» toggles for the characters in the scene (or for the chosen character, split into
// «не знает» / «знает»), and the settings.
import { knows, MAX_MAX_FACTS, MIN_MAX_FACTS } from '../../domain/knowledge-facts';
import { recentStoryText } from '../../domain/knowledge-match';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { clear, el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { KnowledgeFact } from './api';
import type { KnowledgeService } from './service';
import { KNOWLEDGE_KEY, KNOWLEDGE_TAB, cleanMaxFacts, readKnowledgeSettings } from './settings';
import type { KnowledgeSettings } from './settings';

/** Facts drawn at most (newest first, secrets on top). */
export const SHOWN_FACTS = 100;

export const KNOWLEDGE_CSS = `
.maestro-m18-list { display: flex; flex-direction: column; gap: 8px; }
.maestro-m18-quote { font-style: italic; overflow-wrap: anywhere; }
.maestro-m18-meta { font-size: 0.9em; overflow-wrap: anywhere; }
.maestro-m18-toggles { display: flex; flex-wrap: wrap; gap: 2px 14px; }
.maestro-m18-secret { border-left: 3px solid var(--maestro-warn, #d9a400); }
.maestro-m18-now { display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.maestro-m18-filter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
`;

/** Secrets first, then the newest message, then the newest fact. */
function ordered(facts: readonly KnowledgeFact[]): KnowledgeFact[] {
    return [...facts].sort(
        (a, b) => Number(b.secret) - Number(a.secret) || b.sourceMessage - a.sourceMessage || b.at - a.at,
    );
}

export function knowledgeTab(app: App, service: KnowledgeService): PultTab {
    const t = app.i18n.t.bind(app.i18n);

    const settings = (): KnowledgeSettings =>
        readKnowledgeSettings(app.settings.module<Partial<KnowledgeSettings>>(KNOWLEDGE_KEY));

    /** A failed «knows» toggle: a reply to the user's own click, always shown. */
    const report = (error: unknown): void => {
        app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error', urgent: true });
    };

    return {
        id: KNOWLEDGE_TAB,
        titleKey: 'm18.tab',
        icon: 'fa-user-secret',
        order: 59,
        render(container) {
            let alive = true;
            let filter = '';
            const root = el('div', { class: 'maestro-view maestro-m18' });
            container.appendChild(root);

            const setKnown = (fact: KnowledgeFact, name: string, known: boolean): void => {
                const action = known ? service.markKnown(fact.id, name) : service.markUnknown(fact.id, name);
                void action.catch((error: unknown) => {
                    report(error);
                    draw();
                });
            };

            const factCard = (fact: KnowledgeFact, toggles: readonly string[]): HTMLElement =>
                card({
                    title: fact.text,
                    level: fact.secret ? 'warn' : undefined,
                    className: fact.secret ? 'maestro-m18-secret' : undefined,
                    subtitle: [
                        fact.secret ? badge(t('m18.secret'), 'warn') : null,
                        fact.sourceMessage >= 0
                            ? badge(t('m18.message', { index: fact.sourceMessage }), 'muted')
                            : null,
                    ],
                    body: [
                        fact.quote ? el('div', { class: 'maestro-m18-quote', text: fact.quote }) : null,
                        el('div', {
                            class: 'maestro-muted maestro-m18-meta',
                            text: t('m18.knownBy', { names: fact.knownBy.join(', ') || t('m18.knownBy.none') }),
                        }),
                        fact.topics.length
                            ? el('div', {
                                  class: 'maestro-muted maestro-m18-meta',
                                  text: t('m18.topics', { list: fact.topics.slice(0, 8).join(', ') }),
                              })
                            : null,
                        toggles.length
                            ? el(
                                  'div',
                                  { class: 'maestro-m18-toggles' },
                                  toggles.map((name) =>
                                      toggle({
                                          label: t('m18.knows', { name }),
                                          checked: knows(fact, [name]),
                                          onChange: (checked) => setKnown(fact, name, checked),
                                      }),
                                  ),
                              )
                            : null,
                    ],
                });

            const list = (facts: readonly KnowledgeFact[], toggles: readonly string[]): HTMLElement[] => {
                const shown = ordered(facts).slice(0, SHOWN_FACTS);
                const out: HTMLElement[] = [];
                if (facts.length > shown.length) {
                    out.push(
                        el('div', {
                            class: 'maestro-muted',
                            text: t('m18.more', { shown: shown.length, total: facts.length }),
                        }),
                    );
                }
                out.push(
                    el(
                        'div',
                        { class: 'maestro-m18-list' },
                        shown.map((fact) => factCard(fact, toggles)),
                    ),
                );
                return out;
            };

            const nowView = (cast: readonly string[]): HTMLElement | null => {
                if (!cast.length) return null;
                const recent = recentStoryText((app.host.ctx().chat ?? []) as unknown[]);
                const lines = cast
                    .map((name) => ({ name, facts: service.unknownFor(name, recent) }))
                    .filter((row) => row.facts.length > 0)
                    .map((row) =>
                        el('div', {
                            text: t('m18.now.line', { name: row.name, facts: row.facts.map((f) => f.text).join('; ') }),
                        }),
                    );
                const voices = app.modules.api('voices') !== undefined;
                return section(t('m18.now.title'), [
                    el('div', { class: 'maestro-hint', text: t('m18.now.hint') }),
                    lines.length
                        ? el('div', { class: 'maestro-m18-now' }, lines)
                        : el('div', { class: 'maestro-muted', text: t('m18.now.empty') }),
                    voices ? null : el('div', { class: 'maestro-muted', text: t('m18.now.noVoices') }),
                ]);
            };

            const factsView = (facts: readonly KnowledgeFact[], roster: readonly string[], cast: readonly string[]) => {
                if (filter && !roster.includes(filter)) filter = '';
                const body: (HTMLElement | null)[] = [];
                if (roster.length) {
                    body.push(
                        el('div', { class: 'maestro-m18-filter' }, [
                            el('span', { class: 'maestro-field-label', text: t('m18.filter') }),
                            select({
                                value: filter,
                                label: t('m18.filter'),
                                options: [
                                    { value: '', label: t('m18.filter.all') },
                                    ...roster.map((name) => ({ value: name, label: name })),
                                ],
                                onChange: (value) => {
                                    filter = value;
                                    draw();
                                },
                            }),
                        ]),
                    );
                }
                if (!facts.length) {
                    body.push(emptyState(t('m18.empty'), 'fa-user-secret'));
                    return section(t('m18.facts.title'), body);
                }
                if (!filter) {
                    body.push(...list(facts, cast));
                    return section(t('m18.facts.title'), body);
                }
                const unknown = facts.filter((fact) => !knows(fact, [filter]));
                const known = facts.filter((fact) => knows(fact, [filter]));
                const group = (titleKey: string, items: readonly KnowledgeFact[]): HTMLElement =>
                    el('div', { class: 'maestro-m18-list' }, [
                        el('div', {
                            class: 'maestro-field-label',
                            text: t(titleKey, { name: filter, count: items.length }),
                        }),
                        ...(items.length
                            ? list(items, [filter])
                            : [el('div', { class: 'maestro-muted', text: t('m18.none') })]),
                    ]);
                body.push(group('m18.unknown.title', unknown), group('m18.known.title', known));
                return section(t('m18.facts.title'), body);
            };

            const settingsView = (): HTMLElement => {
                const current = settings();
                const save = (path: string): void => {
                    app.settings.save();
                    app.settings.notify(path);
                    draw();
                };
                return section(t('m18.settings.title'), [
                    field(
                        t('m18.settings.maxFacts'),
                        numberInput({
                            value: current.maxFacts,
                            min: MIN_MAX_FACTS,
                            max: MAX_MAX_FACTS,
                            step: 50,
                            label: t('m18.settings.maxFacts'),
                            onChange: (value) => {
                                current.maxFacts = cleanMaxFacts(value);
                                save('m18.maxFacts');
                            },
                        }),
                        t('m18.settings.maxFacts.hint'),
                    ),
                    toggle({
                        label: t('m18.settings.replyEvents'),
                        checked: current.replyEvents,
                        onChange: (checked) => {
                            current.replyEvents = checked;
                            save('m18.replyEvents');
                        },
                    }),
                ]);
            };

            const draw = (): void => {
                if (!alive) return;
                clear(root);
                root.appendChild(banner(t('m18.experimental'), 'warn', 'fa-flask'));
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m18.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsView());
                    return;
                }
                const facts = service.facts();
                const cast = service.castNow();
                const roster = service.roster();
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m18.hint') }));
                const now = nowView(cast);
                if (now) root.appendChild(now);
                root.appendChild(factsView(facts, roster, cast));
                root.appendChild(settingsView());
            };

            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => alive && redraw());
            service.follow();
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
