// «Подсказать модели этот формат» (M32 «Стиль сообщений»): off by default. When on, every normal generation gets a
// short system note at depth 1 (right before the last message) in the chat language, built from the enabled rules —
// e.g. «Прямую речь пиши в кавычках "…", мысли и выделения — *курсивом*.» It goes through Maestro's ephemeral
// injections (cleared after the generation, never saved, never scanned for lore).
import { dominantLanguage } from '../../domain/director-flags';
import { buildFormatHint } from '../../domain/message-style-hint';
import type { HintLanguage } from '../../domain/message-style-hint';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { MessageStyleSettings } from './settings';

export const HINT_INJECTION = 'messageStyle.hint';
/** Recent messages read to tell the chat language. */
const LANGUAGE_MESSAGES = 8;

/** The chat language by its recent messages; the UI language when the chat says too little. */
export function chatLanguage(app: App): HintLanguage {
    try {
        const chat = app.host.ctx().chat ?? [];
        const texts: string[] = [];
        for (let i = chat.length - 1; i >= 0 && texts.length < LANGUAGE_MESSAGES; i--) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            const text = cleanForAnalysis(message);
            if (text) texts.push(text);
        }
        const language = dominantLanguage(texts);
        if (language) return language;
    } catch {
        // No chat yet: the UI language below.
    }
    return app.i18n.locale();
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
