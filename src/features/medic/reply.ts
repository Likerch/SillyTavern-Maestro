// Per-reply checks of M3 (plan M3): after `reply:ready` — DES, DES-RU and NAI markers have processed the reply.
// Sheets (M31) and replies to a sheet command are skipped: they carry no tracker on purpose.
import { adaptersOf } from '../../adapters';
import { desSwipeRecord } from '../../domain/des-tracker';
import { hasEmptyDetailKeys, hasFencedJson, hasRawNaiMarker, trackerMissing } from '../../domain/medic-des';
import type { App, Logger } from '../../shared/contracts';
import { isStoryReply } from './sources';
import type { TrackerRepair } from './tracker-repair';
import { expectsTracker } from './tracker-repair';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface MedicSettings {
    /** Repair a missing DES tracker after each reply (together mode). */
    trackerRepair: boolean;
}

export class ReplyWatcher {
    /** `chatId:kind` already reported this page: one notice per chat and kind is enough. */
    private readonly reported = new Set<string>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly t: Translate,
        private readonly repair: TrackerRepair,
        private readonly settings: MedicSettings,
    ) {}

    onReply(messageIndex: number, type: string): void {
        try {
            this.inspect(messageIndex, type);
        } catch (error) {
            this.log.warn('reply check failed', error);
        }
    }

    private inspect(index: number, type: string): void {
        const chat = this.app.host.ctx().chat;
        if (!isStoryReply(chat, index, type)) return;
        const message = chat[index] as STChatMessage;
        const adapters = adaptersOf(this.app);

        if (adapters.nai.present() && hasRawNaiMarker(message.mes)) {
            this.app.ui.notice(this.t('m3.nai.reply', { index }), { level: 'warn' });
        }

        const des = adapters.des;
        if (!des.present() || !des.enabled() || des.generationMode() !== 'together') return;
        if (!expectsTracker(des.settings())) return;
        const record = desSwipeRecord(message);
        if (trackerMissing(record)) {
            if (hasFencedJson(message.mes)) this.once('regex', 'm3.regex.reply', { index });
            // Not awaited: the model call must not hold other reply:ready listeners.
            if (this.settings.trackerRepair) void this.repair.auto(index);
            return;
        }
        if (hasEmptyDetailKeys(record?.characterThoughts)) this.once('fieldKeys', 'm3.fieldKeys.reply');
    }

    private once(kind: string, key: string, params?: Record<string, string | number>): void {
        const id = `${this.app.host.chatId() ?? ''}:${kind}`;
        if (this.reported.has(id)) return;
        this.reported.add(id);
        this.app.ui.notice(this.t(key, params), { level: 'warn' });
    }
}
