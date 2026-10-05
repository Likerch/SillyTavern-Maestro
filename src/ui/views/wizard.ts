// First-run wizard (plan §7): a modal flow over registered WizardSteps, opened once after APP_READY while
// CoreSettings.firstRunDone is false, or on demand from Settings. A step calls done() when it is complete;
// until then the forward button skips the step.
import type { Host, I18n, Logger, SettingsService, Unsubscribe, WizardStep } from '../../shared/contracts';
import { emptyState } from '../components/card';
import { button, clear, el, icon, prefersReducedMotion } from '../components/dom';

interface PopupHandle {
    show(): Promise<unknown>;
    completeCancelled(): Promise<unknown>;
    dlg: HTMLDialogElement;
}

export interface WizardDeps {
    host: Host;
    i18n: I18n;
    log: Logger;
    settings: SettingsService;
    /** Called when the user finished or skipped the whole setup. */
    onFinished?(skipped: boolean): void;
}

export const WELCOME_STEP_ID = 'welcome';

function welcomeStep(i18n: I18n): WizardStep {
    return {
        id: WELCOME_STEP_ID,
        order: Number.NEGATIVE_INFINITY,
        titleKey: 'ui.wizard.welcomeTitle',
        render(container, done) {
            const t = i18n.t.bind(i18n);
            container.append(
                el('div', { class: 'maestro-wizard-welcome' }, [
                    el('div', { class: 'maestro-wizard-hero' }, [icon('fa-wand-magic-sparkles')]),
                    el('p', { text: t('ui.wizard.welcome1') }),
                    el('p', { text: t('ui.wizard.welcome2') }),
                    el('p', { text: t('ui.wizard.welcome3') }),
                ]),
            );
            done();
        },
    };
}

export class Wizard {
    private readonly registry = new Map<string, WizardStep>();
    private popup: PopupHandle | null = null;
    private index = 0;
    private completed = new Set<string>();
    private nodes: {
        root: HTMLElement;
        progress: HTMLElement;
        title: HTMLElement;
        counter: HTMLElement;
        body: HTMLElement;
        back: HTMLButtonElement;
        next: HTMLButtonElement;
    } | null = null;

    constructor(private readonly deps: WizardDeps) {}

    add(step: WizardStep): Unsubscribe {
        if (step.id === WELCOME_STEP_ID) this.deps.log.warn('wizard step id "welcome" is reserved');
        this.registry.set(step.id, step);
        return () => {
            if (this.registry.get(step.id) === step) this.registry.delete(step.id);
        };
    }

    /** Welcome first, then registered steps by order. */
    steps(): WizardStep[] {
        const registered = [...this.registry.values()]
            .filter((step) => step.id !== WELCOME_STEP_ID)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        return [welcomeStep(this.deps.i18n), ...registered];
    }

    isOpen(): boolean {
        return this.popup !== null;
    }

    /** Opens the wizard when the first run has not been completed yet. */
    maybeRun(): boolean {
        if (this.deps.settings.core().firstRunDone || this.isOpen()) return false;
        this.open();
        return this.isOpen();
    }

    open(): void {
        if (this.popup) return;
        const c = this.deps.host.ctx();
        if (typeof c.Popup !== 'function') {
            this.deps.log.error('ST Popup is not available; cannot open the wizard');
            return;
        }
        this.index = 0;
        this.completed = new Set();
        const root = this.build();
        const popup = new c.Popup(root, c.POPUP_TYPE.DISPLAY, '', {
            wide: true,
            allowVerticalScrolling: true,
            animation: prefersReducedMotion() ? 'none' : 'fast',
        });
        popup.dlg.classList.add('maestro-wizard-dialog');
        this.popup = popup;
        void popup.show().then(
            () => this.handleClosed(popup),
            () => this.handleClosed(popup),
        );
        this.renderStep();
    }

    close(): void {
        const popup = this.popup;
        if (!popup) return;
        this.handleClosed(popup);
        void popup.completeCancelled().catch((error: unknown) => this.deps.log.debug('wizard close', error));
    }

    dispose(): void {
        this.close();
        this.registry.clear();
    }

    /** Test/inspection helper: id of the step on screen. */
    currentStep(): string | null {
        return this.popup ? (this.steps()[this.index]?.id ?? null) : null;
    }

    next(): void {
        const steps = this.steps();
        if (this.index >= steps.length - 1) {
            this.finish(false);
            return;
        }
        this.index += 1;
        this.renderStep();
    }

    back(): void {
        if (this.index === 0) return;
        this.index -= 1;
        this.renderStep();
    }

    finish(skipped: boolean): void {
        const core = this.deps.settings.core();
        core.firstRunDone = true;
        this.deps.settings.save();
        this.deps.settings.notify('core.firstRunDone');
        this.close();
        this.deps.onFinished?.(skipped);
    }

    private build(): HTMLElement {
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const progress = el('div', { class: 'maestro-wizard-progress-bar' });
        const title = el('h3', { class: 'maestro-wizard-title' });
        const counter = el('div', { class: 'maestro-muted maestro-wizard-counter' });
        const body = el('div', { class: 'maestro-wizard-body' });
        const back = button({
            label: t('ui.wizard.back'),
            icon: 'fa-arrow-left',
            kind: 'ghost',
            onClick: () => this.back(),
        });
        const next = button({
            label: t('ui.wizard.next'),
            icon: 'fa-arrow-right',
            kind: 'primary',
            className: 'maestro-wizard-next',
            onClick: () => this.next(),
        });
        const root = el('div', { class: 'maestro-wizard maestro-ui' }, [
            el('div', { class: 'maestro-wizard-head' }, [
                counter,
                title,
                el('div', { class: 'maestro-wizard-progress' }, [progress]),
            ]),
            body,
            el('div', { class: 'maestro-wizard-foot' }, [
                button({ label: t('ui.wizard.skipAll'), kind: 'ghost', onClick: () => this.finish(true) }),
                el('span', { class: 'maestro-grow' }),
                back,
                next,
            ]),
        ]);
        this.nodes = { root, progress, title, counter, body, back, next };
        return root;
    }

    private renderStep(): void {
        const nodes = this.nodes;
        if (!nodes || !this.popup) return;
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const steps = this.steps();
        const step = steps[this.index];
        if (!step) return;
        const last = this.index === steps.length - 1;
        nodes.title.textContent = t(step.titleKey);
        nodes.counter.textContent = t('ui.wizard.stepOf', { step: this.index + 1, total: steps.length });
        nodes.progress.style.width = `${Math.round(((this.index + 1) / steps.length) * 100)}%`;
        nodes.back.disabled = this.index === 0;
        const updateNext = () => {
            const isDone = this.completed.has(step.id);
            const label = last ? t('ui.wizard.finish') : isDone ? t('ui.wizard.next') : t('ui.wizard.skipStep');
            const span = nodes.next.querySelector('span');
            if (span) span.textContent = label;
            nodes.next.classList.toggle('maestro-btn-primary', isDone || last);
        };
        clear(nodes.body);
        const target = el('div', { class: 'maestro-wizard-step', data: { step: step.id } });
        nodes.body.appendChild(target);
        const stepIndex = this.index;
        try {
            step.render(target, () => {
                this.completed.add(step.id);
                if (this.index === stepIndex) updateNext();
            });
        } catch (error) {
            this.deps.log.error(`wizard step ${step.id} failed`, error);
            clear(target);
            target.appendChild(emptyState(t('ui.wizard.stepFailed'), 'fa-bug'));
        }
        updateNext();
    }

    private handleClosed(popup: PopupHandle): void {
        if (this.popup !== popup) return;
        this.popup = null;
        this.nodes = null;
    }
}
