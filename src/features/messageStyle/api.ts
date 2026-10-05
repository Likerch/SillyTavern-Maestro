// Public API of M32 «Стиль сообщений», exposed as app.modules.api<MessageStyleApi>('messageStyle').
import type { PresetId } from '../../domain/message-style';
import type { Unsubscribe } from '../../shared/contracts';

export interface MessageStyleApi {
    /** Messages are being styled now (the page has the class `maestro-msgstyle`). */
    enabled(): boolean;
    /** The preset the rules came from. */
    preset(): PresetId;
    /** ST's formatter hook is in place (dash dialogue, asides and custom rules can be styled). */
    annotated(): boolean;
    /** Marks the messages on screen again (after another extension rebuilt them). */
    refresh(): void;
    onChange(listener: () => void): Unsubscribe;
}
