// SillyTavern events with ordering. ST's emitter (public/lib/eventemitter.js) awaits listeners one by one in
// array order; makeFirst/makeLast move a listener to the front/back. Extensions that load after Maestro can
// push themselves behind our 'last' listeners, so reassertOrder() restores our positions on demand.
//
// APP_READY and APP_INITIALIZED are "auto-fire" events: on/makeFirst/makeLast call the listener immediately
// when the event already fired. Re-asserting order on them through makeFirst/makeLast would run our handler a
// second time, so for those events the listener array is reordered directly (or left alone).
import type { HostEvents, ListenerOrder, Logger, Unsubscribe } from '../shared/contracts';

type Listener = (...args: unknown[]) => unknown;

/** The parts of ST's EventEmitter we use; makeLast is missing from global.d.ts and older ST builds. */
interface Emitter {
    on(event: string, listener: Listener): void;
    makeFirst?(event: string, listener: Listener): void;
    makeLast?(event: string, listener: Listener): void;
    removeListener(event: string, listener: Listener): void;
    emit(event: string, ...args: unknown[]): Promise<void>;
    /** ST: plain object of arrays; the test fake: Map of arrays. */
    events?: unknown;
    autoFireAfterEmit?: unknown;
}

interface Registration {
    event: string;
    order: ListenerOrder;
    listener: Listener;
}

export interface HostEventsImpl extends HostEvents {
    /** Removes every listener registered through this object (host dispose). */
    dispose(): void;
}

export function createHostEvents(ctx: () => STContext, log: Logger): HostEventsImpl {
    const registrations = new Set<Registration>();

    const emitter = (): Emitter => ctx().eventSource as unknown as Emitter;

    function eventTypes(): Record<string, string> {
        return ctx().eventTypes ?? {};
    }

    function name(key: string): string | undefined {
        const types = eventTypes();
        if (!Object.prototype.hasOwnProperty.call(types, key)) return undefined;
        const value = types[key];
        return typeof value === 'string' ? value : undefined;
    }

    /** eventTypes key → raw name; anything else is taken as a raw name. */
    function resolve(event: string): string {
        return name(event) ?? event;
    }

    /** `initial` = first registration; later calls (reassertOrder) only move an existing listener. */
    function placeFirst(es: Emitter, event: string, listener: Listener, initial: boolean): void {
        if (!initial && isAutoFire(es, event)) {
            const list = listenersOf(es, event);
            if (list) moveInList(list, listener, 'first');
            return;
        }
        // ST's makeFirst moves an existing listener; removing it first also covers emitters that only unshift.
        if (!initial) es.removeListener(event, listener);
        if (typeof es.makeFirst === 'function') {
            es.makeFirst(event, listener);
            return;
        }
        es.on(event, listener);
        const list = listenersOf(es, event);
        if (list) moveInList(list, listener, 'first');
        else log.debug(`eventSource has no makeFirst; the ${event} listener stays in registration order`);
    }

    function placeLast(es: Emitter, event: string, listener: Listener, initial: boolean): void {
        if (!initial && isAutoFire(es, event)) {
            const list = listenersOf(es, event);
            if (list) moveInList(list, listener, 'last');
            return;
        }
        if (typeof es.makeLast === 'function') {
            es.makeLast(event, listener);
            return;
        }
        es.removeListener(event, listener);
        es.on(event, listener);
    }

    return {
        on(event: string, handler: (...args: unknown[]) => unknown, options?: { order?: ListenerOrder }): Unsubscribe {
            const raw = resolve(event);
            const order = options?.order ?? 'normal';
            // A wrapper gives every subscription its own identity (the same handler may subscribe twice) and
            // reports failures under Maestro's logger; ST would only print them to the console.
            const listener: Listener = (...args: unknown[]) => {
                try {
                    const result = handler(...args);
                    if (result instanceof Promise) {
                        return result.catch((error: unknown) => log.error(`listener for ${raw} failed`, error));
                    }
                    return result;
                } catch (error) {
                    log.error(`listener for ${raw} failed`, error);
                    return undefined;
                }
            };
            const registration: Registration = { event: raw, order, listener };
            const es = emitter();
            if (order === 'first') placeFirst(es, raw, listener, true);
            else if (order === 'last') placeLast(es, raw, listener, true);
            else es.on(raw, listener);
            registrations.add(registration);

            let active = true;
            return () => {
                if (!active) return;
                active = false;
                registrations.delete(registration);
                emitter().removeListener(raw, listener);
            };
        },

        reassertOrder(): void {
            const es = emitter();
            const byEvent = new Map<string, Registration[]>();
            for (const registration of registrations) {
                if (registration.order === 'normal') continue;
                const list = byEvent.get(registration.event) ?? [];
                list.push(registration);
                byEvent.set(registration.event, list);
            }
            for (const [event, regs] of byEvent) {
                const firsts = regs.filter((r) => r.order === 'first').map((r) => r.listener);
                const lasts = regs.filter((r) => r.order === 'last').map((r) => r.listener);
                const list = listenersOf(es, event);
                // makeFirst unshifts, so the latest 'first' registration ends up in front.
                if (list && inPlace(list, [...firsts].reverse(), lasts)) continue;
                try {
                    for (const listener of firsts) placeFirst(es, event, listener, false);
                    for (const listener of lasts) placeLast(es, event, listener, false);
                } catch (error) {
                    log.warn(`could not reassert listener order for ${event}`, error);
                }
            }
        },

        emit(event: string, ...args: unknown[]): Promise<void> {
            return emitter().emit(resolve(event), ...args);
        },

        name,

        dispose(): void {
            const es = emitter();
            for (const registration of [...registrations]) {
                try {
                    es.removeListener(registration.event, registration.listener);
                } catch (error) {
                    log.warn(`could not remove ${registration.event} listener`, error);
                }
            }
            registrations.clear();
        },
    };
}

/** The live listener array of an event, when the emitter exposes it. */
function listenersOf(es: Emitter, event: string): Listener[] | undefined {
    const store = es.events;
    let list: unknown;
    if (store instanceof Map) list = store.get(event);
    else if (store && typeof store === 'object') list = (store as Record<string, unknown>)[event];
    return Array.isArray(list) ? (list as Listener[]) : undefined;
}

function isAutoFire(es: Emitter, event: string): boolean {
    const auto = es.autoFireAfterEmit;
    return auto instanceof Set && auto.has(event);
}

function moveInList(list: Listener[], listener: Listener, where: 'first' | 'last'): void {
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
    if (where === 'first') list.unshift(listener);
    else list.push(listener);
}

function inPlace(list: Listener[], head: Listener[], tail: Listener[]): boolean {
    if (list.length < head.length + tail.length) return false;
    for (let i = 0; i < head.length; i++) if (list[i] !== head[i]) return false;
    const offset = list.length - tail.length;
    for (let i = 0; i < tail.length; i++) if (list[offset + i] !== tail[i]) return false;
    return true;
}
