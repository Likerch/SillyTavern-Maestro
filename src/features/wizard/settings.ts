// Settings slice of the wizard (`extensionSettings.maestro.modules.wizard`).

/** Long chats that started before Maestro: parse their history once (stage 4) or track from now on. */
export type OldChatsPolicy = 'fromNow' | 'bootstrap';

export interface WizardSettings {
    oldChatsPolicy: OldChatsPolicy;
    /**
     * Book caps in tokens chosen in the wizard (rule `book.cap`). Kept here only while the rules API cannot take
     * rule options (`setOptions`); when it can, the rules module owns them and this is a mirror.
     */
    bookCaps: Record<string, number>;
}

export function defaultWizardSettings(): WizardSettings {
    return { oldChatsPolicy: 'fromNow', bookCaps: {} };
}
