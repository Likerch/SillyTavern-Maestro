// CarrotKernel's quiet mode (plan §2.2 п. 2, M15 п. 4): CK's «Character Consistency» text is taken out of the assembled
// prompt (CK's slot and settings stay as CK left them), and DES-RU (0.8 `setMaestroOwned` 'ck.consistencyRebuild') is
// told to stop rebuilding that insert. Shared by the voice cards (M15) and, while M15 is off, by Maestro's Dramatis
// bridge (src/app/dramatis-bridge.ts) when Dramatis claims 'ck.consistency' for a generation with its cast block.
import { adaptersOf } from '../../adapters';
import type { DesRuAdapter, DesRuApi, DesRuFunction } from '../../adapters';
import { estimateTokens } from '../../domain/rules-lore';
import { CK_CONSISTENCY_SLOT, removeSlotText, slotText } from '../../domain/voices-prompt';
import type { App, Logger } from '../../shared/contracts';
import type { CkInsertOutcome, VoicesQuietState } from './api';

/** The DES-RU function the quiet mode takes over. */
export const CK_FUNCTION: DesRuFunction = 'ck.consistencyRebuild';

export interface CkRemoval {
    outcome: CkInsertOutcome;
    at: number;
    tokens: number;
}

export class CkQuiet {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    /** Takes CK's insert out of the final messages (changed in place): removed, CK sent none, or not found. */
    remove(messages: unknown[]): CkRemoval {
        const value = slotText(this.app.host.ctx().extensionPrompts, CK_CONSISTENCY_SLOT);
        let outcome: CkInsertOutcome = 'absent';
        let tokens = 0;
        if (value) {
            try {
                const result = removeSlotText(messages, value, (text) => this.substitute(text));
                outcome = result.removed ? 'removed' : 'notFound';
                tokens = estimateTokens(result.chars);
            } catch (error) {
                this.log.warn('CK consistency insert could not be removed', error);
                outcome = 'notFound';
            }
            if (outcome === 'notFound') this.log.warn('CK consistency insert is not in the assembled prompt');
        }
        return { outcome, at: Date.now(), tokens };
    }

    /** DES-RU's adapter and published API (0.8+), read live: the API comes and goes with DES-RU. */
    private desRu(): { adapter: DesRuAdapter; api: DesRuApi } | null {
        try {
            const adapter = adaptersOf(this.app).desru as Partial<DesRuAdapter> | undefined;
            if (typeof adapter?.api !== 'function' || typeof adapter.setMaestroOwned !== 'function') return null;
            const api = adapter.api();
            return api ? { adapter: adapter as DesRuAdapter, api } : null;
        } catch {
            return null;
        }
    }

    /** DES-RU stops rebuilding CK's insert (its other functions Maestro owns stay as they are). */
    claimDesRu(): void {
        const desru = this.desRu();
        if (!desru) return;
        try {
            const owned = desru.api.maestroOwned();
            if (owned.includes(CK_FUNCTION)) return;
            desru.adapter.setMaestroOwned([...owned, CK_FUNCTION] as DesRuFunction[]);
        } catch (error) {
            this.log.debug('DES-RU ownership could not be set', error);
        }
    }

    /** P11: the function goes back to DES-RU. */
    releaseDesRu(): void {
        const desru = this.desRu();
        if (!desru) return;
        try {
            const owned = desru.api.maestroOwned();
            if (!owned.includes(CK_FUNCTION)) return;
            desru.adapter.setMaestroOwned(owned.filter((id) => id !== CK_FUNCTION) as DesRuFunction[]);
        } catch (error) {
            this.log.debug('DES-RU ownership could not be released', error);
        }
    }

    desRuState(): VoicesQuietState['desru'] {
        const desru = this.desRu();
        if (!desru) return 'absent';
        try {
            return desru.api.maestroOwned().includes(CK_FUNCTION) ? 'told' : 'notTold';
        } catch {
            return 'notTold';
        }
    }
}
