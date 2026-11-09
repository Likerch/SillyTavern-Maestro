// What agents may propose to the calendar (plan §3.5, release 1.31): a promise or a deadline the story made. Through
// autonomy and the Inbox; undo calls the promise off (the calendar keeps no deletion).
import { registerProposalReceiver } from '../../core/proposal-receivers';
import type { App, JournalChange, Proposal, Unsubscribe } from '../../shared/contracts';
import type { CalendarApi } from './api';

export const AGENT_PROMISE_KIND = 'calendar.agentPromise';
export const AGENT_PROMISE_TARGET = 'calendar.agentPromise';

interface PromisePayload {
    who: string[];
    toWhom: string[];
    what: string;
    quote: string;
    sourceMessage: number;
}

function names(value: unknown): string[] {
    return Array.isArray(value)
        ? value
              .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              .map((item) => item.trim())
              .slice(0, 6)
        : [];
}

export function installCalendarReceiver(app: App, calendar: CalendarApi): Unsubscribe[] {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const apply = async (raw: unknown): Promise<void> => {
        const payload = raw as PromisePayload;
        await calendar.add({ ...payload, due: null });
    };
    // Older test apps have a journal without undo handlers.
    app.journal.registerUndo?.(AGENT_PROMISE_TARGET, async (change: JournalChange) => {
        const after = change.after as { what?: unknown } | null;
        const what = typeof after?.what === 'string' ? after.what : '';
        const found = calendar.promises().find((promise) => promise.what === what && promise.status !== 'cancelled');
        if (found) await calendar.setStatus(found.id, 'cancelled');
        return true;
    });
    return [
        registerProposalReceiver({
            kind: AGENT_PROMISE_KIND,
            module: 'calendar',
            labelKey: 'm44.recv.calendar.agentPromise',
            describe:
                'a promise, an appointment or a deadline the story made and the calendar does not have yet. who: who promised (names); toWhom: to whom; what: a short English sentence of what was promised, with its deadline in words when there is one («by the full moon», «in three days»); quote: the exact words of the story.',
            schema: {
                type: 'object',
                properties: {
                    who: { type: 'array', items: { type: 'string' } },
                    toWhom: { type: 'array', items: { type: 'string' } },
                    what: { type: 'string' },
                    quote: { type: 'string' },
                },
                required: ['who', 'what'],
            },
            defaultAutonomy: 'inbox',
            toProposal: (data, context): Proposal<PromisePayload> | null => {
                const what = typeof data.what === 'string' ? data.what.trim().slice(0, 300) : '';
                if (!what) return null;
                if (calendar.promises().some((promise) => promise.what.trim().toLowerCase() === what.toLowerCase()))
                    return null;
                const chat = app.host.ctx().chat ?? [];
                const payload: PromisePayload = {
                    who: names(data.who),
                    toWhom: names(data.toWhom),
                    what,
                    quote: typeof data.quote === 'string' ? data.quote.trim().slice(0, 400) : '',
                    sourceMessage: context.messageIndex ?? Math.max(0, chat.length - 1),
                };
                return {
                    module: 'calendar',
                    kind: AGENT_PROMISE_KIND,
                    title: t('m44.recv.promiseTitle', { who: payload.who.join(', ') || '—' }),
                    details: [what, payload.quote].filter(Boolean).join('\n'),
                    changes: [
                        {
                            target: AGENT_PROMISE_TARGET,
                            ref: { what },
                            before: null,
                            after: { what, who: payload.who },
                        },
                    ],
                    payload,
                    sourceMessage: payload.sourceMessage,
                    apply,
                };
            },
            apply,
        }),
    ];
}
