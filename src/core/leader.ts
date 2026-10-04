// One leader tab per chat (plan §4.10): only the leader runs background tasks and writes Maestro files.
// The lock is a user file `maestro-lock-<hash(chatId)>.json` = { tabId, heartbeatAt }. ST has no atomic
// compare-and-swap for files, so a tab that takes over writes the lock, waits a short random pause and reads
// it back: of two tabs racing for a free lock only the last writer stays leader. Tabs of one browser also
// talk over BroadcastChannel so a closing or switching tab hands over at once instead of after 30 s.
import type { Bus, FileStore, Host, Leader, Logger, Unsubscribe } from '../shared/contracts';
import { currentTabId, readFresh } from './files';

export interface LeaderLock {
    tabId: string;
    heartbeatAt: number;
    chatId?: string;
}

export interface LeaderMessage {
    type: 'claim' | 'release';
    chatId: string;
    tabId: string;
}

/** Minimal channel between tabs of one browser (BroadcastChannel in production). */
export interface LeaderChannel {
    post(message: LeaderMessage): void;
    listen(handler: (message: unknown) => void): void;
    close(): void;
}

export interface PageEvents {
    addEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
    removeEventListener(type: 'pagehide' | 'pageshow', listener: () => void): void;
}

export interface LeaderOptions {
    heartbeatMs?: number;
    staleMs?: number;
    /** Pause before reading a freshly written lock back (random 300–700 ms by default). */
    confirmDelayMs?: () => number;
    /** Tab id override (tests run several "tabs" in one process). */
    tabId?: string;
    /** null disables the channel. */
    channel?: ((name: string) => LeaderChannel | null) | null;
    /** Target for pagehide/pageshow (window); null disables. */
    page?: PageEvents | null;
}

export type LeaderService = Leader & {
    start(): void;
    stop(): void;
    /** Re-evaluates leadership now (also runs every heartbeat and on chat change). */
    refresh(): Promise<void>;
};

export const LEADER_CHANNEL = 'maestro-leader';
const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;

function browserChannel(name: string): LeaderChannel | null {
    if (typeof BroadcastChannel === 'undefined') return null;
    const channel = new BroadcastChannel(name);
    return {
        post: (message) => channel.postMessage(message),
        listen: (handler) => {
            channel.onmessage = (event: MessageEvent) => handler(event.data);
        },
        close: () => channel.close(),
    };
}

function defaultPage(): PageEvents | null {
    return typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
}

function parseLock(raw: unknown): LeaderLock | null {
    if (!raw || typeof raw !== 'object') return null;
    const lock = raw as Partial<LeaderLock>;
    if (typeof lock.tabId !== 'string' || typeof lock.heartbeatAt !== 'number') return null;
    return { tabId: lock.tabId, heartbeatAt: lock.heartbeatAt };
}

function isMessage(value: unknown): value is LeaderMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<LeaderMessage>;
    return (
        (message.type === 'claim' || message.type === 'release') &&
        typeof message.chatId === 'string' &&
        typeof message.tabId === 'string'
    );
}

export function createLeader(
    host: Host,
    files: FileStore,
    bus: Bus,
    log: Logger,
    options: LeaderOptions = {},
): LeaderService {
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    const staleMs = options.staleMs ?? STALE_MS;
    const confirmDelay = options.confirmDelayMs ?? (() => 300 + Math.floor(Math.random() * 400));
    const tabId = options.tabId ?? currentTabId();
    const listeners = new Set<(leader: boolean) => void>();

    let started = false;
    let leader = false;
    /** Chat whose lock this tab wrote last (and has not released). */
    let heldChat: string | null = null;
    let lastBeat = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy: Promise<void> | null = null;
    let again = false;
    let channel: LeaderChannel | null = null;
    let page: PageEvents | null = null;
    const unsubscribers: Unsubscribe[] = [];

    const lockName = (chatId: string) => files.fileName('lock', chatId);
    const currentChat = () => (host.isGroupChat() ? null : host.chatId());
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const setLeader = (value: boolean) => {
        if (leader === value) return;
        leader = value;
        log.info(value ? 'this tab leads the chat' : 'this tab no longer leads the chat');
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                log.error('leader listener failed', error);
            }
        }
        void bus.emit('leader:changed', { leader: value });
    };

    const post = (type: LeaderMessage['type'], chatId: string, via: LeaderChannel | null = channel) => {
        try {
            via?.post({ type, chatId, tabId });
        } catch (error) {
            log.debug('leader channel post failed', error);
        }
    };

    const release = async (chatId: string, via: LeaderChannel | null = channel): Promise<void> => {
        if (heldChat === chatId) heldChat = null;
        try {
            const lock = parseLock(await readFresh<unknown>(files, lockName(chatId)));
            if (lock?.tabId === tabId) await files.remove(lockName(chatId));
        } catch (error) {
            log.debug('could not release the lock', error);
        }
        post('release', chatId, via);
    };

    const evaluateOnce = async (): Promise<void> => {
        if (!started) return;
        const chatId = currentChat();
        if (heldChat && heldChat !== chatId) {
            setLeader(false);
            await release(heldChat);
        }
        if (!chatId) {
            setLeader(false);
            return;
        }
        const name = lockName(chatId);
        let lock: LeaderLock | null;
        try {
            lock = parseLock(await readFresh<unknown>(files, name));
        } catch (error) {
            log.warn('could not read the leader lock', error);
            if (leader && Date.now() - lastBeat > staleMs) setLeader(false);
            return;
        }
        const now = Date.now();
        const mine = lock?.tabId === tabId;
        if (lock && !mine && now - lock.heartbeatAt <= staleMs) {
            if (heldChat === chatId) heldChat = null;
            setLeader(false);
            return;
        }
        const continuing = leader && mine && heldChat === chatId;
        try {
            await files.write(name, { tabId, heartbeatAt: now, chatId } satisfies LeaderLock);
        } catch (error) {
            log.warn('could not write the leader lock', error);
            if (leader && Date.now() - lastBeat > staleMs) setLeader(false);
            return;
        }
        lastBeat = Date.now();
        heldChat = chatId;
        if (continuing) return;

        // Taking over: another tab may have written at the same moment. Read back after a pause.
        await delay(confirmDelay());
        if (!started || currentChat() !== chatId) return;
        let check: LeaderLock | null;
        try {
            check = parseLock(await readFresh<unknown>(files, name));
        } catch (error) {
            log.warn('could not confirm the leader lock', error);
            return;
        }
        if (check?.tabId !== tabId) {
            if (heldChat === chatId) heldChat = null;
            setLeader(false);
            return;
        }
        setLeader(true);
        post('claim', chatId);
    };

    const evaluate = (): Promise<void> => {
        if (busy) {
            again = true;
            return busy;
        }
        busy = (async () => {
            do {
                again = false;
                try {
                    await evaluateOnce();
                } catch (error) {
                    log.error('leader evaluation failed', error);
                }
            } while (again && started);
        })().finally(() => {
            busy = null;
        });
        return busy;
    };

    const onMessage = (raw: unknown) => {
        if (!isMessage(raw) || raw.tabId === tabId) return;
        if (raw.chatId !== currentChat()) return;
        // release: the lock is free now; claim: someone took it — if we thought we led, check again.
        if (raw.type === 'release' ? !leader : leader) void evaluate();
    };

    const onPageHide = () => {
        const chatId = heldChat;
        if (!chatId) return;
        // No time for a read-check here: the page is going away. Other tabs of this browser take over at
        // once through the channel; other devices after the lock goes stale.
        post('release', chatId);
        files.remove(lockName(chatId)).catch(() => undefined);
    };

    const onPageShow = () => void evaluate();

    return {
        isLeader: () => leader,

        onChange(listener: (value: boolean) => void): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        refresh: evaluate,

        start(): void {
            if (started) return;
            started = true;
            const chatChanged = host.events.name('CHAT_CHANGED');
            if (chatChanged) unsubscribers.push(host.events.on(chatChanged, () => void evaluate()));
            else log.warn('CHAT_CHANGED is missing; leadership follows the heartbeat only');
            const makeChannel = options.channel === undefined ? browserChannel : options.channel;
            try {
                channel = makeChannel ? makeChannel(LEADER_CHANNEL) : null;
                channel?.listen(onMessage);
            } catch (error) {
                log.debug('BroadcastChannel unavailable', error);
                channel = null;
            }
            page = options.page === undefined ? defaultPage() : options.page;
            page?.addEventListener('pagehide', onPageHide);
            page?.addEventListener('pageshow', onPageShow);
            timer = setInterval(() => void evaluate(), heartbeatMs);
            void evaluate();
        },

        stop(): void {
            if (!started) return;
            started = false;
            if (timer !== null) clearInterval(timer);
            timer = null;
            for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
            page?.removeEventListener('pagehide', onPageHide);
            page?.removeEventListener('pageshow', onPageShow);
            page = null;
            const held = heldChat;
            const closing = channel;
            channel = null;
            setLeader(false);
            const close = () => closing?.close();
            if (held) void release(held, closing).finally(close);
            else close();
        },
    };
}
