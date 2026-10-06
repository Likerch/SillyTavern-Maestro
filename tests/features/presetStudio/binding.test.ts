// «Пресет чата» (plan-2 «Области действия» п. 2): the binder selects the preset bound to the chat or the card when that
// chat opens (through the studio's guarded switch) and brings back the preset that was on before when leaving.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { PresetBinder } from '../../../src/features/presetStudio/binding';
import type { LayerChange, PresetBindings, PresetLayerApi } from '../../../src/features/presetStudio/layer-api';
import { PRESET_STUDIO_STRINGS } from '../../../src/features/presetStudio/module';
import type { PresetStore } from '../../../src/features/presetStudio/store-api';
import { defaultPresetStudioSettings } from '../../../src/features/presetStudio/studio';
import type { PresetStudioSettings } from '../../../src/features/presetStudio/studio';
import { createFeatureEnv } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

let env: FeatureEnv;
let current: string;
let bound: { chat: string | null; character: string | null };
let settings: PresetStudioSettings;
let switchPreset: Mock<(name: string, options: { reason?: string }) => Promise<boolean>>;
let answer: boolean;
const layerListeners = new Set<(change?: LayerChange) => void>();
let binder: PresetBinder;

function bindings(): PresetBindings {
    const active = bound.chat
        ? { scope: 'chat' as const, preset: bound.chat }
        : bound.character
          ? { scope: 'character' as const, preset: bound.character }
          : null;
    return { ...bound, active, context: { character: { avatar: 'alice.png', name: 'Alice' }, chat: { id: 'c' } } };
}

async function openChat(next: { chat: string | null; character: string | null }): Promise<void> {
    bound = next;
    await env.app.bus.emit('chat:changed', { chatId: 'c' });
    await binder.idle();
}

beforeEach(async () => {
    env = await createFeatureEnv([PRESET_STUDIO_STRINGS]);
    current = 'General';
    bound = { chat: null, character: null };
    settings = defaultPresetStudioSettings();
    answer = true;
    switchPreset = vi.fn(async (name: string) => {
        if (!answer) return false;
        current = name;
        return true;
    });
    const layer = {
        bindings,
        whenContext: async () => bindings().context,
        onChange: (listener: (change?: LayerChange) => void) => {
            layerListeners.add(listener);
            return () => layerListeners.delete(listener);
        },
    } as unknown as PresetLayerApi;
    const store = {
        current: () => current,
        names: () => ['General', 'Dark', 'Light'],
    } as unknown as PresetStore;
    binder = new PresetBinder({
        app: env.app,
        log: env.app.log,
        layer: () => layer,
        store: () => store,
        settings,
        saveSettings: () => {},
        switchPreset,
    });
    binder.install();
    await binder.idle();
});

describe('PresetBinder', () => {
    it('selects the chat’s preset on entering, keeps it between bound chats, brings the old one back on leaving', async () => {
        await openChat({ chat: 'Dark', character: null });
        expect(current).toBe('Dark');
        expect(switchPreset).toHaveBeenLastCalledWith('Dark', { reason: expect.stringContaining('Dark') });
        expect(settings.bindingRestore).toBe('General');
        await openChat({ chat: null, character: 'Light' });
        expect(current).toBe('Light');
        expect(settings.bindingRestore).toBe('General');
        await openChat({ chat: null, character: null });
        expect(current).toBe('General');
        expect(settings.bindingRestore).toBeNull();
        expect(env.ui.notices.map((notice) => notice.text)).toEqual([
            expect.stringContaining('Dark'),
            expect.stringContaining('Light'),
            expect.stringContaining('General'),
        ]);
    });

    it('stays when the user keeps his unsaved edits (the guard answered no)', async () => {
        answer = false;
        await openChat({ chat: 'Dark', character: null });
        expect(current).toBe('General');
        expect(settings.bindingRestore ?? null).toBeNull();
    });

    it('does nothing for a chat bound to the preset already on, and says when the bound preset is gone', async () => {
        await openChat({ chat: 'General', character: null });
        expect(switchPreset).not.toHaveBeenCalled();
        await openChat({ chat: 'Deleted', character: null });
        expect(switchPreset).not.toHaveBeenCalled();
        expect(env.ui.notices.at(-1)?.text).toContain('Deleted');
    });

    it('a binding made inside a chat goes back to the preset the chat opened with', async () => {
        await openChat({ chat: null, character: null });
        current = 'Dark';
        bound = { chat: 'Dark', character: null };
        for (const listener of layerListeners) listener('binding');
        await binder.idle();
        expect(settings.bindingRestore).toBe('General');
        await openChat({ chat: null, character: null });
        expect(current).toBe('General');
    });
});
