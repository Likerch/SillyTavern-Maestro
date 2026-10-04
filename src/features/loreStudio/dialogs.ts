// Small dialogs of the Lore Studio over ST's own Popup (callGenericPopup): name input, confirmation, a choice
// between several buttons, and a form dialog. Everything text goes in as text nodes.
import { el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import { LoreStudioError } from './st-lore';

/** Values our custom buttons resolve with (ST's AFFIRMATIVE is 1, NEGATIVE 0, CANCELLED null). */
const CUSTOM_RESULT_BASE = 100;

export class Dialogs {
    constructor(private readonly app: App) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /** Text input; null when cancelled or left empty. */
    async input(title: string, value: string, hint?: string): Promise<string | null> {
        const ctx = this.app.host.ctx();
        const body = el('div', { class: 'maestro-m23-dialog-body' }, [
            el('h3', { text: title }),
            hint ? el('p', { class: 'maestro-muted', text: hint }) : null,
        ]);
        const result = await ctx.callGenericPopup(body, ctx.POPUP_TYPE.INPUT, value, {
            okButton: this.t('m23.dialog.ok'),
            cancelButton: this.t('m23.dialog.cancel'),
        });
        if (typeof result !== 'string') return null;
        const trimmed = result.trim();
        return trimmed ? trimmed : null;
    }

    async confirm(title: string, body: string | HTMLElement, okLabel?: string): Promise<boolean> {
        const ctx = this.app.host.ctx();
        const content = el('div', { class: 'maestro-m23-dialog-body' }, [
            el('h3', { text: title }),
            typeof body === 'string' ? el('p', { text: body }) : body,
        ]);
        const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: okLabel ?? this.t('m23.dialog.ok'),
            cancelButton: this.t('m23.dialog.cancel'),
        });
        return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }

    /**
     * Several actions: the first is the OK button, the others are custom buttons. Resolves with the chosen value or
     * null when cancelled.
     */
    async choose<T extends string>(
        title: string,
        body: string | HTMLElement,
        actions: readonly { value: T; label: string }[],
    ): Promise<T | null> {
        const ctx = this.app.host.ctx();
        const [first, ...rest] = actions;
        if (!first) return null;
        const content = el('div', { class: 'maestro-m23-dialog-body' }, [
            el('h3', { text: title }),
            typeof body === 'string' ? el('p', { text: body }) : body,
        ]);
        const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: first.label,
            cancelButton: this.t('m23.dialog.cancel'),
            customButtons: rest.map((action, index) => ({
                text: action.label,
                result: CUSTOM_RESULT_BASE + index,
                classes: ['maestro-m23-choice'],
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
        const body = el('div', { class: 'maestro-m23-dialog-body maestro-m23-form-dialog' }, [
            el('h3', { text: title }),
            content,
        ]);
        const result = await ctx.callGenericPopup(body, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: okLabel ?? this.t('m23.dialog.apply'),
            cancelButton: this.t('m23.dialog.cancel'),
            wide: true,
            allowVerticalScrolling: true,
        });
        return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }

    /** User-facing text of an error (LoreStudioError codes are translated). */
    errorText(error: unknown): string {
        if (error instanceof LoreStudioError) return this.t(`m23.error.${error.code}`, error.params);
        return this.t('m23.error.generic', { error: error instanceof Error ? error.message : String(error) });
    }

    /** Runs an action and reports a failure as an urgent notice instead of throwing into the button handler. */
    async run<T>(action: () => Promise<T>): Promise<T | undefined> {
        try {
            return await action();
        } catch (error) {
            this.app.log.warn('lore studio action failed', error);
            this.app.ui.notice(this.errorText(error), { urgent: true, level: 'error' });
            return undefined;
        }
    }
}
