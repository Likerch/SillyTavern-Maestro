// The wizard shell (src/ui/views/wizard.ts) has no "leave step" hook: a step that applies its choices on «Далее»
// listens to the shell's forward button in the capture phase, so it runs before the shell renders the next step.
// The listener removes itself on the first click and ignores clicks after its step left the screen.

const NEXT_SELECTOR = '.maestro-wizard-next';

/**
 * Calls `apply` when the forward button is pressed while `container` is on screen. Returns false when the step is
 * not inside the wizard shell (the caller then shows its own "Apply" button).
 */
export function onNext(
    container: HTMLElement,
    apply: () => void | Promise<void>,
    onError: (error: unknown) => void,
    alive: () => boolean = () => true,
): boolean {
    const next = container.closest('.maestro-wizard')?.querySelector<HTMLButtonElement>(NEXT_SELECTOR);
    if (!next) return false;
    const handler = (): void => {
        next.removeEventListener('click', handler, true);
        if (!container.isConnected || !alive()) return;
        void Promise.resolve()
            .then(apply)
            .catch((error: unknown) => onError(error));
    };
    next.addEventListener('click', handler, true);
    return true;
}
