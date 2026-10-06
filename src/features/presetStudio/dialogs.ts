// Small dialogs of the Preset Studio over ST's own Popup (callGenericPopup): name input, confirmation, a choice
// between several buttons («Сохранить / Отбросить / Отмена») and a form dialog. Everything goes in as text nodes.
import { el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import { PresetStoreError } from './st-preset';

/** Values our custom buttons resolve with (ST's AFFIRMATIVE is 1, NEGATIVE 0, CANCELLED null). */
const CUSTOM_RESULT_BASE = 100;

export class Dialogs {
    constructor(private readonly app: App) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private body(title: string, content: string | HTMLElement | null, className = ''): HTMLElement {
        return el('div', { class: ['maestro-m34-dialog-body', className] }, [
            el('h3', { text: title }),
            content === null ? null : typeof content === 'string' ? el('p', { text: content }) : content,
        ]);
    }

    /** Text input; null when cancelled or left empty. */
    async input(title: string, value: string, hint?: string): Promise<string | null> {
        const ctx = this.app.host.ctx();
        const result = await ctx.callGenericPopup(this.body(title, hint ?? null), ctx.POPUP_TYPE.INPUT, value, {
            okButton: this.t('m34.dialog.ok'),
            cancelButton: this.t('m34.dialog.cancel'),
        });
        if (typeof result !== 'string') return null;
        const trimmed = result.trim();
        return trimmed ? trimmed : null;
    }

    async confirm(title: string, body: string | HTMLElement, okLabel?: string): Promise<boolean> {
        const ctx = this.app.host.ctx();
        const result = await ctx.callGenericPopup(this.body(title, body), ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: okLabel ?? this.t('m34.dialog.ok'),
            cancelButton: this.t('m34.dialog.cancel'),
        });
        return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }

    /** Several actions: the first is the OK button, the others custom buttons; null when cancelled. */
    async choose<T extends string>(
        title: string,
        body: string | HTMLElement,
        actions: readonly { value: T; label: string }[],
    ): Promise<T | null> {
        const ctx = this.app.host.ctx();
        const [first, ...rest] = actions;
        if (!first) return null;
        const result = await ctx.callGenericPopup(this.body(title, body), ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: first.label,
            cancelButton: this.t('m34.dialog.cancel'),
            customButtons: rest.map((action, index) => ({
                text: action.label,
                result: CUSTOM_RESULT_BASE + index,
                classes: ['maestro-m34-choice'],
            })),
        });
        if (result === ctx.POPUP_RESULT.AFFIRMATIVE) return first.value;
        if (typeof result === 'number' && result >= CUSTOM_RESULT_BASE) {
            return rest[result - CUSTOM_RESULT_BASE]?.value ?? null;
        }
        return null;
    }

    /** A form in a popup; the caller reads its inputs after `true`. */
    async form(title: string, content: HTMLElement, okLabel?: string): Promise<boolean> {
        const ctx = this.app.host.ctx();
        const result = await ctx.callGenericPopup(
            this.body(title, content, 'maestro-m34-form-dialog'),
            ctx.POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: okLabel ?? this.t('m34.dialog.apply'),
                cancelButton: this.t('m34.dialog.cancel'),
                wide: true,
                allowVerticalScrolling: true,
            },
        );
        return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }

    /** Opens the file picker; resolves with the chosen file or null. */
    pickFile(accept: string): Promise<File | null> {
        return new Promise((resolve) => {
            const input = el('input', { class: 'maestro-m34-hidden-file', attrs: { type: 'file', accept } });
            input.addEventListener('change', () => {
                resolve(input.files?.[0] ?? null);
                input.remove();
            });
            input.addEventListener('cancel', () => {
                resolve(null);
                input.remove();
            });
            document.body.append(input);
            input.click();
        });
    }

    /**
     * A failure in plain words: the store's errors by their code (`m34.error.<code>`); anything else only says that it
     * did not work — the English message is for the log, which the callers write.
     */
    errorText(error: unknown): string {
        if (error instanceof PresetStoreError) {
            const key = `m34.error.${error.code}`;
            const text = this.t(key, { status: error.status ?? '' });
            if (text !== key) return text;
        }
        return this.t('m34.error.generic');
    }

    /** Runs an action and reports a failure as an urgent notice instead of throwing into the button handler. */
    async run<T>(action: () => Promise<T>): Promise<T | undefined> {
        try {
            return await action();
        } catch (error) {
            this.app.log.warn('preset studio action failed', error);
            const cancelled = error instanceof PresetStoreError && error.code === 'cancelled';
            this.app.ui.notice(this.errorText(error), { urgent: true, level: cancelled ? 'info' : 'error' });
            return undefined;
        }
    }
}

/** Saves a JSON file through the browser (the same way PM exports, PM:1793-1812). */
export function downloadJson(name: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { attrs: { href: url, download: name } });
    link.click();
    URL.revokeObjectURL(url);
}
