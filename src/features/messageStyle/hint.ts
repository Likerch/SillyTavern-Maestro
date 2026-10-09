// «Подсказать модели этот формат» (M32 «Стиль сообщений»): off by default. When on, every normal generation gets a
// short system note at depth 1 (right before the last message) in the story's language («Язык истории», core/language:
// the setting, else the player's messages, else the interface language), built from the enabled rules —
// e.g. «Прямую речь пиши в кавычках "…", мысли и выделения — *курсивом*.» It goes through Maestro's ephemeral
// injections (cleared after the generation, never saved, never scanned for lore).
import { storyLanguage } from '../../core/language';
import { buildFormatHint } from '../../domain/message-style-hint';
import type { HintLanguage } from '../../domain/message-style-hint';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { MessageStyleSettings } from './settings';

export const HINT_INJECTION = 'messageStyle.hint';

/** The language of the hint: the story's («Язык истории»). */
export function chatLanguage(app: App): HintLanguage {
    return storyLanguage(app);
}

/** The note the model gets now ('' when the rules ask nothing of it). */
export function currentHint(app: App, settings: MessageStyleSettings): string {
    return buildFormatHint(settings.rules, chatLanguage(app));
}

/** Registers the producer; returns its remover (own() it). */
export function installHint(app: App, settings: () => MessageStyleSettings): Unsubscribe {
    return app.ephemeral.addProducer(HINT_INJECTION, (gen) => {
        if (gen.quiet || gen.dryRun || gen.sheetCommand) return;
        const current = settings();
        if (!current.enabled || !current.hint) return;
        const text = currentHint(app, current);
        if (!text) return;
        app.ephemeral.setInjection(HINT_INJECTION, { text, position: 1, depth: 1, role: 0, scan: false });
    });
}
