// Tab «Картинки» of the «Агенты» window (release 1.33): who writes the image markers (NAI Studio's setting, while the
// illustrator agent is on), whether agents' pictures may spend Anlas, and «Сравнение вслепую» of the illustrator against
// the main model's markers (ab-test.ts).
import { adaptersOf } from '../../adapters';
import type { NaiAdapter, NaiMarkerWriter } from '../../adapters';
import type { AgentDef } from '../../domain/agents/types';
import { userImageUrl } from '../../domain/user-images';
import type { App, Logger, PultTab, Unsubscribe } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { field, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { AB_JOB_KEY, abVerdict, buildPairs, candidateReplies, summarize } from './ab-test';
import type { AbPair, AbSummary } from './ab-test';
import { ILLUSTRATE_KIND } from './image-receivers';
import type { AgentRunner } from './runner';
import type { AgentStore } from './store';

export const IMAGES_TAB = 'agents-images';

/** The module's settings slice of release 1.33. */
export interface AgentsImageSettings {
    imagesPaid?: boolean;
    abLast?: AbSummary;
}

export interface ImagesDeps {
    app: App;
    log: Logger;
    store: AgentStore;
    runner: AgentRunner;
    settings(): AgentsImageSettings;
    save(patch: Partial<AgentsImageSettings>): void;
    group: string;
    /** Re-registers Maestro as NAI Studio's illustrator (after a change of agents). */
    syncIllustrator(): void;
}

/** The NAI adapter, or undefined when adapters are not there (tests, a failed start). */
function naiOf(app: App): NaiAdapter | undefined {
    try {
        return adaptersOf(app).nai ?? undefined;
    } catch {
        return undefined;
    }
}

/** The illustrator agents: an own agent that proposes `nai.illustrate`; the one that is on first. */
export function illustratorAgents(store: AgentStore): AgentDef[] {
    const states = store.states();
    return store
        .list()
        .filter((def) => def.result.type === 'proposals' && def.result.options.receivers.includes(ILLUSTRATE_KIND))
        .sort((a, b) => Number(states.get(b.id)?.on === true) - Number(states.get(a.id)?.on === true));
}

/** The blind comparison in progress or done (kept while the page lives). */
interface Session {
    agentName: string;
    pairs: AbPair[];
    position: number;
    building: boolean;
    progress: { done: number; total: number };
    /** Why replies gave no pair. */
    failures: string[];
    controller: AbortController | null;
}

export function imagesTab(deps: ImagesDeps): PultTab {
    const { app } = deps;
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    let session: Session | null = null;
    const listeners = new Set<() => void>();
    const changed = () => listeners.forEach((listener) => listener());

    const start = (def: AgentDef) => {
        const job = app.jobs?.start({
            key: AB_JOB_KEY,
            title: t('m44.ab.job', { name: def.name }),
            module: 'agents',
            cancellable: true,
            open: { label: t('m44.ab.open'), run: () => app.ui.openWindow?.('agents', { tab: IMAGES_TAB }) },
        });
        if (!job) return;
        const controller = new AbortController();
        job.signal.addEventListener('abort', () => controller.abort());
        session = {
            agentName: def.name,
            pairs: [],
            position: 0,
            building: true,
            progress: { done: 0, total: 0 },
            failures: [],
            controller,
        };
        const current = session;
        changed();
        void buildPairs(app, deps.log, deps.runner, def, {
            signal: controller.signal,
            onProgress: (progress) => {
                current.progress = progress;
                job.progress(progress.done, progress.total, t('m44.ab.progress', { ...progress }));
                changed();
            },
        })
            .then(({ pairs, failures }) => {
                current.pairs = pairs;
                current.failures = failures;
                current.building = false;
                current.controller = null;
                job.finish(t('m44.ab.ready', { count: pairs.length }), { cancelled: controller.signal.aborted });
                changed();
            })
            .catch((error: unknown) => {
                current.building = false;
                current.controller = null;
                job.fail(error instanceof Error ? error.message : String(error));
                changed();
            });
    };

    const choose = (choice: AbPair['choice']) => {
        const current = session;
        const pair = current?.pairs[current.position];
        if (!current || !pair) return;
        pair.choice = choice;
        current.position += 1;
        if (current.position >= current.pairs.length) {
            deps.save({ abLast: summarize(current.pairs, current.agentName, Date.now()) });
        }
        changed();
    };

    /** NAI Studio's codes in the user's words («стоило бы Anlas», …). */
    const failureText = (codes: readonly string[]): string =>
        codes
            .map((code) => {
                if (/free-only|cost|anlas/i.test(code)) return t('m44.ab.why.cost');
                if (code === 'no-picture') return t('m44.ab.why.noPicture');
                if (code === 'agent') return t('m44.ab.why.agent');
                if (code === 'aborted') return t('m44.ab.why.aborted');
                return code;
            })
            .filter((text, index, all) => all.indexOf(text) === index)
            .join('; ') || t('m44.ab.why.unknown');

    const writerSection = (): HTMLElement => {
        const nai = naiOf(app);
        const writer = nai?.markerWriter() ?? null;
        const parts: HTMLElement[] = [el('div', { class: 'maestro-hint', text: t('m44.images.hint') })];
        if (!nai?.canIllustrate()) parts.push(banner(t('m44.images.needNai'), 'warn'));
        else if (writer) {
            parts.push(
                field(
                    t('m44.images.writer'),
                    select<NaiMarkerWriter>({
                        label: t('m44.images.writer'),
                        value: writer.setting,
                        options: (['main', 'illustrator', 'fallback'] as const).map((value) => ({
                            value,
                            label: t(`m44.images.writer.${value}`),
                        })),
                        onChange: (value) => {
                            nai.setMarkerWriter(value);
                            deps.syncIllustrator();
                            changed();
                        },
                    }),
                    t('m44.images.writerNow', { now: t(`m44.images.writer.${writer.effective}`) }),
                ),
            );
        }
        parts.push(
            toggle({
                label: t('m44.images.paid'),
                checked: deps.settings().imagesPaid === true,
                hint: t('m44.images.paidHint'),
                onChange: (checked) => {
                    deps.save({ imagesPaid: checked });
                    changed();
                },
            }),
        );
        return section(t('m44.images.title'), parts);
    };

    const picture = (path: string, label: string): HTMLElement => {
        const img = el('img', { class: 'maestro-ab-img', title: label });
        (img as HTMLImageElement).src = userImageUrl(path);
        (img as HTMLImageElement).alt = label;
        return el('figure', { class: 'maestro-ab-pic' }, [img, el('figcaption', { text: label })]);
    };

    const comparisonSection = (): HTMLElement => {
        const parts: HTMLElement[] = [el('div', { class: 'maestro-hint', text: t('m44.ab.hint') })];
        const last = deps.settings().abLast;
        if (last) {
            parts.push(
                el('div', {
                    class: 'maestro-ab-last',
                    text: t(`m44.ab.last.${abVerdict(last)}`, {
                        name: last.agentName,
                        agent: last.agent,
                        main: last.main,
                        same: last.same,
                        total: last.total,
                    }),
                }),
            );
        }
        const current = session;
        if (current?.building) {
            parts.push(
                el('div', { text: t('m44.ab.progress', { ...current.progress }) }),
                button({
                    label: t('m44.ab.stop'),
                    icon: 'fa-stop',
                    onClick: () => {
                        if (!app.jobs?.cancel(AB_JOB_KEY)) current.controller?.abort();
                    },
                }),
            );
            return section(t('m44.ab.title'), parts);
        }
        const pair = current?.pairs[current.position];
        if (current && pair) {
            const left = pair.agentLeft ? pair.agent : pair.main;
            const right = pair.agentLeft ? pair.main : pair.agent;
            parts.push(
                el('div', {
                    class: 'maestro-muted',
                    text: t('m44.ab.pair', {
                        n: current.position + 1,
                        total: current.pairs.length,
                        message: pair.messageIndex,
                    }),
                }),
                el('div', { class: 'maestro-ab-row' }, [
                    picture(left.path, t('m44.ab.left')),
                    picture(right.path, t('m44.ab.right')),
                ]),
                el('div', { class: 'maestro-ab-actions' }, [
                    button({
                        label: t('m44.ab.pickLeft'),
                        onClick: () => choose(pair.agentLeft ? 'agent' : 'main'),
                    }),
                    button({ label: t('m44.ab.same'), onClick: () => choose('same') }),
                    button({
                        label: t('m44.ab.pickRight'),
                        onClick: () => choose(pair.agentLeft ? 'main' : 'agent'),
                    }),
                ]),
            );
            return section(t('m44.ab.title'), parts);
        }
        if (current && current.pairs.length && current.position >= current.pairs.length) {
            const summary = summarize(current.pairs, current.agentName, Date.now());
            parts.push(
                banner(
                    t(`m44.ab.result.${abVerdict(summary)}`, {
                        agent: summary.agent,
                        main: summary.main,
                        same: summary.same,
                        total: summary.total,
                    }),
                    abVerdict(summary) === 'main' ? 'warn' : 'info',
                ),
            );
        }
        if (current && !current.building && !current.pairs.length) {
            parts.push(banner(t('m44.ab.empty', { reasons: failureText(current.failures) }), 'warn'));
        }
        const agents = illustratorAgents(deps.store);
        const def = agents[0];
        const candidates = naiOf(app)?.canDrawPicture() ? candidateReplies(app).length : 0;
        if (!def) parts.push(emptyState(t('m44.ab.noAgent'), 'fa-palette'));
        else if (!candidates) parts.push(emptyState(t('m44.ab.noReplies'), 'fa-image'));
        else {
            parts.push(
                el('div', { class: 'maestro-muted', text: t('m44.ab.cost', { count: candidates }) }),
                button({
                    label: t('m44.ab.start', { name: def.name }),
                    icon: 'fa-scale-balanced',
                    onClick: () => start(def),
                }),
            );
        }
        return section(t('m44.ab.title'), parts);
    };

    return {
        id: IMAGES_TAB,
        titleKey: 'm44.tab.images',
        icon: 'fa-image',
        order: 65,
        group: deps.group,
        render(container: HTMLElement): Unsubscribe {
            const paint = () => {
                clear(container);
                container.append(writerSection(), comparisonSection());
            };
            listeners.add(paint);
            const offStore = deps.store.onChange(paint);
            paint();
            return () => {
                listeners.delete(paint);
                offStore();
            };
        },
    };
}

export const IMAGES_CSS = `
.maestro-ab-row { display: flex; gap: 8px; }
.maestro-ab-pic { flex: 1 1 0; margin: 0; text-align: center; min-width: 0; }
.maestro-ab-img { width: 100%; max-height: 360px; object-fit: contain; border-radius: 6px; background: var(--black30a, rgba(0,0,0,.3)); }
.maestro-ab-actions { display: flex; gap: 6px; justify-content: center; margin-top: 6px; flex-wrap: wrap; }
.maestro-ab-last { margin: 4px 0; }
`;
