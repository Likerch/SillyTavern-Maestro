// M26 in the strip under chat messages (plan-2 §5): «Запомнил: в деревне празднуют урожай (пробно)» under the reply a
// provisional fact came from, with [Верно] (confirm, when nothing contradicts it), [Забыть] (drop) and [Это ошибка]
// (drop, marked as Maestro's mistake); the body is the quote and what the buttons do, the arrow opens «Живой канон».
// A decision stays visible as a muted line — «Факт подтвердился: …», «Забыл: …» — for the rest of the page session in
// which it happened (confirmedAt / droppedAt not older than the provider); after a reload only what still waits for a
// decision comes back. Disputed facts are Inbox cards and come with the Inbox's own strip items. Everything is read
// from the chat's living canon document, so the lines survive reloads and go once decided.
import type { FactData } from '../../domain/living-facts';
import type { App, MessageStripProvider, StripItem } from '../../shared/contracts';
import { el } from '../../ui/components/dom';
import type { LivingCanonService } from './service';
import { LIVING_TAB } from './view';

export const LIVING_STRIP = 'livingCanon';
const LIVING_STRIP_ORDER = 20;

function quoteText(quote: string): string {
    const text = quote.trim().replace(/^[«"“„]+|[»"”]+$/g, '');
    return text ? `«${text}»` : '';
}

/** A sentence without its final full stop (it goes into a longer line). */
function bare(sentence: string): string {
    return sentence.trim().replace(/[.。]+$/u, '');
}

/** `since`: decisions made from this moment on are shown as muted lines (default: now, the module's start). */
export function livingStripProvider(app: App, service: LivingCanonService, since = Date.now()): MessageStripProvider {
    const t = app.i18n.t.bind(app.i18n);
    /** Items by message, built from one version of the document (every change replaces the facts array). */
    let byMessage: Map<number, StripItem[]> | null = null;
    let builtFrom: readonly FactData[] | null = null;

    const what = (fact: FactData): string =>
        fact.russian?.trim()
            ? bare(fact.russian)
            : t('m26.strip.named', { name: fact.name, type: t(`m26.type.${fact.type}`) });

    const factItem = (fact: FactData, uid: number): StripItem => ({
        id: fact.id,
        kind: 'fact',
        text: t('m26.strip.fact', { what: what(fact) }),
        icon: 'fa-seedling',
        actions: [
            {
                label: t('m26.strip.confirm'),
                primary: true,
                run: async () => {
                    await service.accept(uid);
                },
            },
            { label: t('m26.strip.forget'), run: () => service.drop(uid) },
            { label: t('m26.strip.mistake'), run: () => service.drop(uid, { wrong: true }) },
        ],
        body: (container) => {
            const quote = quoteText(fact.quote);
            if (quote) container.appendChild(el('div', { class: 'maestro-m26-quote', text: quote }));
            container.appendChild(el('div', { class: 'maestro-m26-small maestro-muted', text: t('m26.strip.hint') }));
        },
        open: { window: app.ui.windowOfTab?.(LIVING_TAB) ?? '', tab: LIVING_TAB },
    });

    /** A decision of this session: a muted line without buttons. */
    const doneItem = (fact: FactData): StripItem | null => {
        if (fact.status === 'active' && (fact.confirmedAt ?? 0) >= since) {
            return { id: `done:${fact.id}`, kind: 'info', text: t('m26.strip.confirmed', { what: what(fact) }) };
        }
        if (fact.status === 'dropped' && fact.droppedBy === 'user' && (fact.droppedAt ?? 0) >= since) {
            const key = fact.wrong ? 'm26.strip.wrong' : 'm26.strip.dropped';
            return { id: `done:${fact.id}`, kind: 'info', text: t(key, { what: what(fact) }), icon: 'fa-eraser' };
        }
        return null;
    };

    const indexed = (): Map<number, StripItem[]> => {
        const records = service.records();
        if (byMessage && builtFrom === records) return byMessage;
        const map = new Map<number, StripItem[]>();
        for (const fact of records) {
            if (fact.sourceMessage < 0) continue;
            const item =
                fact.status === 'provisional' && fact.uid !== undefined ? factItem(fact, fact.uid) : doneItem(fact);
            if (!item) continue;
            const list = map.get(fact.sourceMessage);
            if (list) list.push(item);
            else map.set(fact.sourceMessage, [item]);
        }
        byMessage = map;
        builtFrom = records;
        return map;
    };

    return {
        id: LIVING_STRIP,
        order: LIVING_STRIP_ORDER,
        items: (messageIndex) => indexed().get(messageIndex) ?? [],
        onChange(listener) {
            return service.onChange(() => {
                const before = byMessage;
                byMessage = null;
                if (!before) {
                    listener();
                    return;
                }
                listener([...new Set([...before.keys(), ...indexed().keys()])]);
            });
        },
    };
}
