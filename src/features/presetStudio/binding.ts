// «Пресет чата» (plan-2 «Области действия» п. 2): a whole preset bound to the card or the chat (layer.bind, stored with
// the layer's character and chat parts) is selected when that chat opens — through the studio's switch, which asks
// about unsaved edits first — and leaving the bound chats brings back the preset that was active before. That preset
// is kept in the module's settings (`bindingRestore`), so a page reload inside a bound chat still knows it. A binding
// made inside a chat remembers the preset the chat opened with, so leaving it goes back to that one too.
// M42 «Мастерская»: a workshop chat without a binding of its own selects the workshop preset the same way (the layer
// reports it as the active binding), and the binder follows the workshop flipping inside an open chat.
// These switches keep the connection: with ST's «Bind presets to API connections» a preset file carries a model and
// providers, and an automatic switch must not change the model the user chose (keepConnection).
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { PresetLayerApi } from './layer-api';
import type { PresetStore } from './store-api';
import type { PresetStudioSettings } from './studio';

export interface BinderDeps {
    app: App;
    log: Logger;
    layer(): PresetLayerApi | null;
    store(): PresetStore | null;
    settings: PresetStudioSettings;
    saveSettings(): void;
    /** The studio's guarded switch (asks about unsaved edits first); false when the user stayed. */
    switchPreset(name: string, options: { reason?: string; keepConnection?: boolean }): Promise<boolean>;
}

export class PresetBinder {
    private chain: Promise<void> = Promise.resolve();
    /** The preset an unbound chat opened with (a binding made in it goes back to this one). */
    private entered: string | null = null;
    /** Scope of the binding acted on last (the text of the way back names the workshop). */
    private lastScope: 'character' | 'chat' | 'workshop' | null = null;
    private missingShown = new Set<string>();
    private disposed = false;

    constructor(private readonly deps: BinderDeps) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        this.disposed = false;
        const offs: Unsubscribe[] = [
            this.deps.app.bus.on('chat:changed', () => this.schedule('chat')),
            // A chat switch is covered by chat:changed (the workshop decides before it); this is the tag set or removed
            // while the chat stays open.
            this.deps.app.bus.on('workshop:changed', () => this.schedule('binding')),
        ];
        const layer = this.deps.layer();
        if (layer) {
            offs.push(
                layer.onChange((change) => {
                    if (change === 'binding') this.schedule('binding');
                }),
            );
        }
        offs.push(() => {
            this.disposed = true;
        });
        this.schedule('chat');
        return offs;
    }

    /** Resolves when the bindings of the chat open now have been acted on (tests, the studio). */
    idle(): Promise<void> {
        return this.chain;
    }

    private schedule(reason: 'chat' | 'binding'): void {
        this.chain = this.chain
            .then(() => this.sync(reason))
            .catch((error: unknown) => this.deps.log.warn('preset binding was not applied', error));
    }

    private setRestore(name: string | null): void {
        if ((this.deps.settings.bindingRestore ?? null) === name) return;
        this.deps.settings.bindingRestore = name;
        this.deps.saveSettings();
    }

    /** Selects the bound preset of the chat open now, or brings back the one active before the bound chats. */
    async sync(reason: 'chat' | 'binding'): Promise<void> {
        const layer = this.deps.layer();
        const store = this.deps.store();
        if (this.disposed || !layer?.bindings || !store || !this.deps.app.host.isChatCompletion()) return;
        await layer.whenContext?.();
        if (this.disposed) return;
        const bindings = layer.bindings();
        const current = store.current();
        const names = store.names();
        const active = bindings.active;
        if (active) {
            if (!names.includes(active.preset)) {
                if (!this.missingShown.has(active.preset)) {
                    this.missingShown.add(active.preset);
                    const key = active.scope === 'workshop' ? 'm34.binding.missingWorkshop' : 'm34.binding.missing';
                    this.deps.app.ui.notice(this.t(key, { name: active.preset }), {
                        importance: 'important',
                        level: 'warn',
                    });
                }
                return;
            }
            this.lastScope = active.scope;
            if (active.preset === current) {
                // Bound right here to what is selected: leaving goes back to what the chat opened with.
                if (
                    reason === 'binding' &&
                    !this.deps.settings.bindingRestore &&
                    this.entered &&
                    this.entered !== current
                ) {
                    this.setRestore(this.entered);
                }
                return;
            }
            const restore = this.deps.settings.bindingRestore ?? current;
            const reasonText = this.t(`m34.binding.reason.${active.scope}`, {
                name: active.preset,
                character: bindings.context.character?.name ?? '',
            });
            const switched = await this.deps.switchPreset(active.preset, { reason: reasonText, keepConnection: true });
            if (!switched) return;
            this.setRestore(restore);
            this.deps.app.ui.notice(reasonText, { importance: 'info' });
            return;
        }
        const restore = this.deps.settings.bindingRestore ?? null;
        if (restore) {
            this.setRestore(null);
            if (restore !== current && names.includes(restore)) {
                const key =
                    this.lastScope === 'workshop' ? 'm34.binding.reason.restoreWorkshop' : 'm34.binding.reason.restore';
                const text = this.t(key, { name: restore });
                const switched = await this.deps.switchPreset(restore, { reason: text, keepConnection: true });
                if (switched) this.deps.app.ui.notice(text, { importance: 'info' });
            }
        }
        this.lastScope = null;
        this.entered = store.current();
    }
}
