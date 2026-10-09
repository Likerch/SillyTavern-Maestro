// The window of M41: one ST popup (DISPLAY: no buttons of ST's own, × and Escape close it) whose body the flow
// re-renders stage by stage. Closing by the user is reported once; closing by code is not.
import type { App } from '../../shared/contracts';
import { el, prefersReducedMotion } from '../../ui/components/dom';

export interface DialogHandle {
    readonly body: HTMLElement;
    /** Still on screen. */
    readonly open: boolean;
    /** Closes it without reporting the close. */
    close(): void;
}

/** Opens a window; `onClosed` runs when the user closes it. Null when the host cannot show one. */
export type DialogOpener = (onClosed: () => void) => DialogHandle | null;

export const DIALOG_CLASS = 'maestro-m41-dialog';

/** The window as an ST popup. */
export function stDialog(app: App): DialogOpener {
    return (onClosed) => {
        const ctx = app.host.ctx();
        if (typeof ctx.Popup !== 'function' || !ctx.POPUP_TYPE) return null;
        const body = el('div', { class: DIALOG_CLASS });
        const popup = new ctx.Popup(body, ctx.POPUP_TYPE.DISPLAY, '', {
            wide: true,
            allowVerticalScrolling: true,
            animation: prefersReducedMotion() ? 'none' : 'fast',
        });
        let open = true;
        const closedByUser = () => {
            if (!open) return;
            open = false;
            onClosed();
        };
        void popup.show().then(closedByUser, closedByUser);
        return {
            body,
            get open() {
                return open;
            },
            close() {
                if (!open) return;
                open = false;
                void popup.completeCancelled().catch(() => undefined);
            },
        };
    };
}
