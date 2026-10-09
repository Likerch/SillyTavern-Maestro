// Dramatis in «Подготовить к игре» (release 1.19, Dramatis 1.3+; docs/integration-dramatis.md). Dramatis reads the
// author's intent of the card — the characters' personalities — by itself when a chat opens; the preparation makes that
// visible and lets the player have it read (again) as part of applying:
// - the review shows the switch «Личности в Dramatis» (on when Dramatis has not read this card; once it has, «Dramatis
//   уже прочитал: N персонажей» and the switch reads it again);
// - applying runs DRAMATIS_API.readIntent({ force }) — the user's own action, interactive — before the DES seeding, so
//   the seeds get Dramatis' starting cast (startCast);
// - its outcome is one line of «Итог» with «Открыть» (Dramatis' «Лист замысла»): «Dramatis: прочитал личности — N
//   персонажей», the error, or — when nothing was read now — «Dramatis: личности из карточки — N персонажей».
// No undo: Dramatis journals its own reading. Each optional method is checked before use: an older Dramatis gives no
// switch and no line.
import { dramatisOf } from '../../adapters';
import type { DramatisAdapter, DramatisIntentState } from '../../adapters';
import { pluralForm } from '../../domain/plural';
import type { App, Logger } from '../../shared/contracts';
import type { ApplyLine, DramatisIntentInfo, PrepareApplyOptions } from './api';

/** Item id of Dramatis' line in the apply summary. */
export const DRAMATIS_ITEM = 'dramatis';

/** The adapter's 1.3 members (a test double or an App without the adapter may lack them). */
type Reader = Partial<
    Pick<DramatisAdapter, 'canReadIntent' | 'intentState' | 'readIntent' | 'canOpenSheet' | 'openSheet'>
>;

export interface DramatisStepResult {
    list: 'done' | 'failed' | 'skipped';
    line: ApplyLine;
}

export class DramatisStep {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private counted(key: string, count: number): string {
        return this.t(`${key}.${pluralForm(count, this.app.i18n.locale())}`, { count });
    }

    private reader(): Reader | undefined {
        try {
            return dramatisOf(this.app) as Reader | undefined;
        } catch {
            return undefined;
        }
    }

    /** Dramatis reads cards and says where this one stands; null otherwise (absent, older, a group chat). */
    private state(reader: Reader | undefined = this.reader()): DramatisIntentState | null {
        try {
            if (typeof reader?.canReadIntent !== 'function' || !reader.canReadIntent()) return null;
            return typeof reader.intentState === 'function' ? reader.intentState() : null;
        } catch (error) {
            this.log.debug('prepare: Dramatis did not say where its reading stands', error);
            return null;
        }
    }

    info(): DramatisIntentInfo | null {
        const reader = this.reader();
        const state = this.state(reader);
        if (!state) return null;
        let canOpen: boolean;
        try {
            canOpen = typeof reader?.canOpenSheet === 'function' && reader.canOpenSheet();
        } catch {
            canOpen = false;
        }
        return { read: state.read, characters: state.characters, running: state.running, canOpen };
    }

    open(name?: string): boolean {
        const reader = this.reader();
        try {
            return typeof reader?.openSheet === 'function' && reader.openSheet(name);
        } catch (error) {
            this.log.warn('prepare: Dramatis did not open', error);
            return false;
        }
    }

    private line(text: string, info = false): ApplyLine {
        return { itemId: DRAMATIS_ITEM, kind: 'dramatis', text, ...(info ? { info: true } : {}) };
    }

    /**
     * The step of an apply: reads the card when asked (default: a full apply on a card Dramatis has not read), else
     * says what Dramatis has. Null without Dramatis 1.3.
     */
    async run(options: PrepareApplyOptions, mode: 'apply' | 'import'): Promise<DramatisStepResult | null> {
        const reader = this.reader();
        const state = this.state(reader);
        if (!state || typeof reader?.readIntent !== 'function') return null;
        const wanted = options.dramatis ?? (mode === 'apply' && !state.read);
        if (!wanted) {
            return state.read
                ? { list: 'done', line: this.line(this.counted('m37.dramatis.known', state.characters), true) }
                : { list: 'skipped', line: this.line(this.t('m37.dramatis.notRead')) };
        }
        const outcome = await reader.readIntent(state.read ? { force: true } : {});
        if (!outcome.ok) {
            const error =
                outcome.message ||
                (outcome.error === 'unsupported' ? this.t('m37.dramatis.unsupported') : outcome.error) ||
                '—';
            return { list: 'failed', line: this.line(this.t('m37.dramatis.failed', { error })) };
        }
        const characters = outcome.characters || (this.state(reader)?.characters ?? 0);
        return outcome.skipped
            ? { list: 'done', line: this.line(this.counted('m37.dramatis.known', characters), true) }
            : { list: 'done', line: this.line(this.counted('m37.dramatis.read', characters)) };
    }

    /** Dramatis' state changed (a reading ended, Dramatis appeared): the window redraws. */
    onChange(listener: () => void): () => void {
        try {
            const adapter = dramatisOf(this.app) as { onChange?(fn: () => void): () => void } | undefined;
            return typeof adapter?.onChange === 'function' ? adapter.onChange(listener) : () => {};
        } catch {
            return () => {};
        }
    }

    /** «Готово к игре»: what Dramatis has read of the card (null: Dramatis 1.3 absent or nothing read). */
    status(): { characters: number; line: string } | null {
        const state = this.state();
        if (!state?.read) return null;
        return { characters: state.characters, line: this.counted('m37.dramatis.known', state.characters) };
    }
}
