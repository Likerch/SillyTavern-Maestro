// Pult tab «Летопись» (M9): chapters (title, messages, AND keys, size, open in the Lore Studio), messages Maestro
// marked «remember» with the reasons, the recap settings with «Показать сейчас», and the module switches. Cards
// instead of a table: they wrap on phones.
import type { PultTab, Unsubscribe } from '../../shared/contracts';
import { badge, banner, card, emptyState, section, moduleSettingsSection } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { Chapter } from './api';
import type { ChapterService } from './chapters';
import type { ChronicleEnv } from './env';
import type { AutoMemory } from './memory';
import type { RecapService } from './recap';
import { CHRONICLE_KEY, RECAP_SOURCES, RECAP_TARGETS } from './settings';
import type { ChronicleSettings } from './settings';

export const CHRONICLE_TAB = 'chronicle';

export const CHRONICLE_CSS = `
.maestro-m9 .maestro-m9-keys { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; overflow-wrap: anywhere; }
.maestro-m9 .maestro-m9-key { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 0 6px; font-size: 0.9em; }
.maestro-m9 .maestro-m9-and { font-weight: 600; opacity: 0.8; }
.maestro-m9 .maestro-m9-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m9 .maestro-m9-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m9 .maestro-m9-row { display: flex; gap: 8px; align-items: baseline; overflow-wrap: anywhere; }
.maestro-m9 .maestro-m9-index { font-weight: 600; white-space: nowrap; }
.maestro-m9 .maestro-m9-last { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

export interface ChronicleTabDeps {
    env: ChronicleEnv;
    chapters: ChapterService;
    memory: AutoMemory;
    recap: RecapService;
    onChange(listener: () => void): Unsubscribe;
}

const MAX_KEYS_SHOWN = 6;

export function chronicleTab(deps: ChronicleTabDeps): PultTab {
    const { env, chapters, memory, recap } = deps;
    const { app } = env;
    const t = env.t;

    const commit = (path: string) => {
        app.settings.notify(`modules.${CHRONICLE_KEY}.${path}`);
        app.settings.save();
    };

    const keyChips = (keys: readonly string[]): HTMLElement[] => {
        const shown = keys.slice(0, MAX_KEYS_SHOWN).map((key) => el('span', { class: 'maestro-m9-key', text: key }));
        if (keys.length > MAX_KEYS_SHOWN) {
            shown.push(
                el('span', {
                    class: 'maestro-muted',
                    text: t('m9.keys.more', { count: keys.length - MAX_KEYS_SHOWN }),
                }),
            );
        }
        return shown;
    };

    const openChapter = (chapter: Chapter) => {
        const studio = app.modules.api<{ open?(book?: string, uid?: number): void }>('loreStudio');
        const book = env.canon()?.bookName();
        if (typeof studio?.open !== 'function' || !book) {
            app.ui.notice(t('m9.error.noStudio'), { level: 'warn', urgent: true });
            return;
        }
        app.ui.closePult?.();
        studio.open(book, chapter.uid);
    };

    const chapterCard = (chapter: Chapter): HTMLElement =>
        card({
            title: chapter.title,
            className: 'maestro-m9-chapter',
            subtitle: el('div', { class: 'maestro-m9-meta' }, [
                el('span', { text: t('m9.chapter.range', { from: chapter.from, to: chapter.to }) }),
                el('span', { class: 'maestro-muted', text: t('m9.chapter.chars', { count: chapter.chars }) }),
                chapter.status === 'archived' ? badge(t('m9.chapter.archived'), 'muted') : null,
            ]),
            body: el('div', { class: 'maestro-m9-keys', title: t('m9.keys.hint') }, [
                ...keyChips(chapter.keys),
                el('span', { class: 'maestro-m9-and', text: t('m9.keys.and') }),
                ...keyChips(chapter.secondary),
            ]),
            actions: button({
                label: t('m9.chapter.open'),
                icon: 'fa-pen-to-square',
                title: t('m9.chapter.openHint'),
                onClick: () => openChapter(chapter),
            }),
        });

    const chaptersSection = (list: Chapter[]): HTMLElement => {
        const counts = chapters.counts();
        const waiting = counts.fallen + counts.proposed;
        return section(t('m9.chapters.title'), [
            el('div', { class: 'maestro-hint', text: t('m9.chapters.hint') }),
            waiting || counts.nokeys
                ? el('div', {
                      class: 'maestro-muted',
                      text: t('m9.chapters.waiting', { waiting, nokeys: counts.nokeys }),
                  })
                : null,
            list.length
                ? el('div', { class: 'maestro-m9-list' }, list.map(chapterCard))
                : emptyState(t('m9.chapters.empty'), 'fa-book'),
        ]);
    };

    const rememberedSection = (): HTMLElement => {
        const rows = memory.remembered();
        return section(t('m9.remembered.title'), [
            el('div', { class: 'maestro-hint', text: t('m9.remembered.hint') }),
            rows.length
                ? el(
                      'div',
                      { class: 'maestro-m9-list' },
                      rows.map((row) =>
                          el('div', { class: 'maestro-m9-row' }, [
                              el('span', {
                                  class: 'maestro-m9-index',
                                  text: t('m9.remembered.index', { index: row.messageIndex }),
                              }),
                              el('span', { text: row.reason }),
                          ]),
                      ),
                  )
                : emptyState(t('m9.remembered.empty'), 'fa-brain'),
        ]);
    };

    const recapSection = (settings: ChronicleSettings): HTMLElement => {
        const last = env.store.peek()?.recap?.text;
        return section(
            t('m9.recap.title'),
            [
                el('div', { class: 'maestro-hint', text: t('m9.recap.hint') }),
                field(
                    t('m9.recap.afterHours'),
                    numberInput({
                        value: settings.recap.afterHours,
                        min: 1,
                        max: 720,
                        step: 1,
                        label: t('m9.recap.afterHours'),
                        onChange: (value) => {
                            settings.recap.afterHours = Math.max(1, Math.round(value));
                            commit('recap.afterHours');
                        },
                    }),
                ),
                field(
                    t('m9.recap.target'),
                    select({
                        value: settings.recap.target,
                        label: t('m9.recap.target'),
                        options: RECAP_TARGETS.map((value) => ({ value, label: t(`m9.recap.target.${value}`) })),
                        onChange: (value) => {
                            settings.recap.target = value;
                            commit('recap.target');
                        },
                    }),
                ),
                field(
                    t('m9.recap.source'),
                    select({
                        value: settings.recap.source,
                        label: t('m9.recap.source'),
                        options: RECAP_SOURCES.map((value) => ({ value, label: t(`m9.recap.source.${value}`) })),
                        onChange: (value) => {
                            settings.recap.source = value;
                            commit('recap.source');
                        },
                    }),
                    t('m9.recap.sourceHint'),
                ),
                last
                    ? el('details', {}, [
                          el('summary', { text: t('m9.recap.last') }),
                          el('div', { class: 'maestro-m9-last', text: last }),
                      ])
                    : null,
            ],
            button({
                label: t('m9.recap.now'),
                icon: 'fa-book-open',
                kind: 'primary',
                onClick: async () => {
                    await recap.recapNow();
                },
            }),
        );
    };

    const settingsSection = (settings: ChronicleSettings): HTMLElement =>
        moduleSettingsSection(t('m9.settings.title'), [
            toggle({
                label: t('m9.settings.chapters'),
                hint: t('m9.settings.chaptersHint'),
                checked: settings.chapters,
                onChange: (checked) => {
                    settings.chapters = checked;
                    commit('chapters');
                },
            }),
            field(
                t('m9.settings.maxChapterChars'),
                numberInput({
                    value: settings.maxChapterChars,
                    min: 200,
                    max: 4000,
                    step: 100,
                    label: t('m9.settings.maxChapterChars'),
                    onChange: (value) => {
                        settings.maxChapterChars = Math.round(value);
                        commit('maxChapterChars');
                    },
                }),
                t('m9.settings.maxChapterCharsHint'),
            ),
            toggle({
                label: t('m9.settings.autoMemory'),
                hint: t('m9.settings.autoMemoryHint'),
                checked: settings.autoMemory,
                onChange: (checked) => {
                    settings.autoMemory = checked;
                    commit('autoMemory');
                },
            }),
            toggle({
                label: t('m9.settings.keywords'),
                hint: t('m9.settings.keywordsHint'),
                checked: settings.keywords,
                onChange: (checked) => {
                    settings.keywords = checked;
                    commit('keywords');
                },
            }),
        ]);

    return {
        id: CHRONICLE_TAB,
        titleKey: 'm9.tab',
        icon: 'fa-book-bookmark',
        order: 51,
        render(container) {
            let alive = true;
            let token = 0;
            const root = el('div', { class: 'maestro-view maestro-m9' });
            container.appendChild(root);

            const draw = async (): Promise<void> => {
                const mine = ++token;
                if (!app.host.chatId()) {
                    clear(root);
                    root.appendChild(emptyState(t('m9.noChat'), 'fa-comment-slash'));
                    return;
                }
                const list = await chapters.chapters();
                if (!alive || mine !== token) return;
                const settings = env.settings();
                clear(root);
                if (!env.qvinkReady()) root.appendChild(banner(t('m9.warn.noQvink'), 'warn'));
                if (!env.canon()) root.appendChild(banner(t('m9.warn.noCanon'), 'warn'));
                root.appendChild(chaptersSection(list));
                root.appendChild(rememberedSection());
                root.appendChild(recapSection(settings));
                root.appendChild(settingsSection(settings));
            };

            const redraw = coalesce(() => void draw(), 100);
            const off = deps.onChange(() => alive && redraw());
            void draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
