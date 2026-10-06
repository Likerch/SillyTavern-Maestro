// The prompt line «кто во что одет» (plan-2 §4 п. 5, decision В8): one short system line near the end of the chat —
// the characters of the scene of the last committed reply and the persona with what they wear now — so the model
// keeps clothes consistent. Ephemeral (slot `maestro_wardrobe`, cleared after every generation, P8), in chat at the
// configured depth, never scanned, about 80 tokens at most; switched off in the settings. The architect has no budget
// source for it: the line keeps its own cap. Cheap on the send path: one tracker parse and a dictionary pass.
import { wearingLine } from '../../domain/wardrobe-current';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { WardrobeService } from './service';
import { WARDROBE_INJECTION } from './settings';
import type { WardrobeSettings } from './settings';

export const WEARING_HEADER = '[Currently wearing — keep consistent unless the story changes it]';
export const WEARING_MAX_TOKENS = 80;

export function installPromptLine(
    app: App,
    service: WardrobeService,
    settings: () => WardrobeSettings,
    log: Logger,
): Unsubscribe {
    return app.ephemeral.addProducer(WARDROBE_INJECTION, (gen) => {
        if (gen.quiet || gen.dryRun || gen.sheetCommand) return;
        const current = settings();
        if (!current.promptLine || !current.outfits || !app.host.chatId() || app.host.isGroupChat()) return;
        let text: string;
        try {
            text = wearingLine(service.promptEntries(), WEARING_HEADER, WEARING_MAX_TOKENS);
        } catch (error) {
            log.debug('wardrobe prompt line failed', error);
            return;
        }
        if (!text) return;
        app.ephemeral.setInjection(WARDROBE_INJECTION, {
            text,
            position: 1,
            depth: current.promptDepth,
            role: 0,
            scan: false,
        });
    });
}
