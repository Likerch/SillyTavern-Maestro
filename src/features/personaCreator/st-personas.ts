// SillyTavern's personas for M41 (ST 1.19 public/scripts/personas.js, loaded through app.host.modules — the same live
// module ST uses; capability `st.personas`). A new persona is made the way ST's own «Create» does (createDummyPersona,
// not exported): initPersona with the name, description and title, then the default avatar uploaded under the new file
// name (POST /api/avatars/upload, multipart `avatar` + `overwrite_name`), then the persona list re-rendered on it. The
// link to a card is a connection added to the persona's own descriptor (`persona_descriptions[key].connections`) — never
// lockPersona, which would unlink the card's other personas when multiple connections are off. Switching the current
// persona (setUserAvatar) happens only when the user asked for it.
import { ST_PERSONAS_PATH } from '../../host/modules';
import type { App, Logger } from '../../shared/contracts';

type Dict = Record<string, unknown>;

/** ST's default user avatar (script.js `default_user_avatar`). */
export const DEFAULT_PERSONA_AVATAR = 'img/user-default.png';
export const AVATAR_UPLOAD_URL = '/api/avatars/upload';

/** What Maestro calls in personas.js. */
export interface PersonasModule {
    initPersona(avatarId: string, name: string, description: string, title: string, options?: Dict): Promise<void>;
    getUserAvatars(doRender?: boolean, openPageAt?: string): Promise<unknown>;
    setUserAvatar(avatarId: string, options?: Dict): Promise<void>;
    updatePersonaConnectionsAvatarList?(): void;
    /** The current persona's avatar key (a live binding). */
    user_avatar: string;
}

export interface PersonaHost {
    /** personas.js is there with what Maestro needs. */
    ready(): Promise<boolean>;
    /** The current persona's key ('' when unknown). */
    current(): string;
    /** Display name of a persona ('' when unknown). */
    nameOf(key: string): string;
    /** Keys of the personas connected to a card (its avatar file). */
    connectedTo(characterAvatar: string): string[];
    /** The current persona's name and description. */
    currentPersona(): { name: string; description: string } | null;
    /** initPersona: the persona exists in the settings (no image yet). */
    create(avatarId: string, name: string, description: string, title: string): Promise<void>;
    /** ST's default avatar under the persona's file name; false when the upload failed. */
    uploadDefaultAvatar(avatarId: string): Promise<boolean>;
    /** Adds a connection to the card (the card's other personas stay linked); false without the persona. */
    connect(avatarId: string, characterAvatar: string): boolean;
    /** Re-renders the persona list on this persona. */
    refresh(avatarId: string): Promise<void>;
    /** Makes it the current persona; false when ST refused. */
    select(avatarId: string): Promise<boolean>;
    /** Opens ST's persona panel on this persona. */
    open(avatarId: string): Promise<void>;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function isPersonasModule(value: unknown): value is PersonasModule {
    if (!isDict(value)) return false;
    return (
        typeof value.initPersona === 'function' &&
        typeof value.getUserAvatars === 'function' &&
        typeof value.setUserAvatar === 'function' &&
        'user_avatar' in value
    );
}

export class StPersonas implements PersonaHost {
    private module: PersonasModule | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private async load(): Promise<PersonasModule> {
        if (this.module) return this.module;
        const loaded: unknown = await this.app.host.modules.load(ST_PERSONAS_PATH);
        if (!isPersonasModule(loaded))
            throw new Error('personas.js has no initPersona / getUserAvatars / setUserAvatar');
        this.module = loaded;
        return loaded;
    }

    async ready(): Promise<boolean> {
        try {
            await this.load();
            return true;
        } catch (error) {
            this.log.debug('personas.js is not usable', error);
            return false;
        }
    }

    private power(): Dict {
        try {
            const power = this.app.host.ctx().powerUserSettings;
            return isDict(power) ? power : {};
        } catch {
            return {};
        }
    }

    private descriptors(): Dict {
        const value = this.power().persona_descriptions;
        return isDict(value) ? value : {};
    }

    current(): string {
        return str(this.module?.user_avatar);
    }

    nameOf(key: string): string {
        const names = this.power().personas;
        return isDict(names) ? str(names[key]).trim() : '';
    }

    connectedTo(characterAvatar: string): string[] {
        if (!characterAvatar) return [];
        return Object.entries(this.descriptors())
            .filter(
                ([, descriptor]) =>
                    isDict(descriptor) &&
                    Array.isArray(descriptor.connections) &&
                    descriptor.connections.some(
                        (connection) =>
                            isDict(connection) && connection.type === 'character' && connection.id === characterAvatar,
                    ),
            )
            .map(([key]) => key);
    }

    currentPersona(): { name: string; description: string } | null {
        let name = '';
        try {
            name = str(this.app.host.ctx().name1).trim();
        } catch {
            // no context
        }
        const description = str(this.power().persona_description).trim();
        return name || description ? { name, description } : null;
    }

    async create(avatarId: string, name: string, description: string, title: string): Promise<void> {
        const module = await this.load();
        await module.initPersona(avatarId, name, description, title);
    }

    async uploadDefaultAvatar(avatarId: string): Promise<boolean> {
        try {
            const image = await fetch(DEFAULT_PERSONA_AVATAR);
            const blob = await image.blob();
            const form = new FormData();
            form.append('avatar', new File([blob], 'avatar.png', { type: 'image/png' }));
            form.append('overwrite_name', avatarId);
            const response = await fetch(AVATAR_UPLOAD_URL, {
                method: 'POST',
                headers: this.app.host.ctx().getRequestHeaders({ omitContentType: true }),
                cache: 'no-cache',
                body: form,
            });
            if (!response.ok) this.log.warn(`persona avatar upload: ${response.status} ${response.statusText}`);
            return response.ok;
        } catch (error) {
            this.log.warn('persona avatar upload failed', error);
            return false;
        }
    }

    connect(avatarId: string, characterAvatar: string): boolean {
        const descriptor = this.descriptors()[avatarId];
        if (!isDict(descriptor) || !characterAvatar) return false;
        const connections = Array.isArray(descriptor.connections) ? descriptor.connections : [];
        const linked = connections.some(
            (connection) => isDict(connection) && connection.type === 'character' && connection.id === characterAvatar,
        );
        if (!linked) connections.push({ type: 'character', id: characterAvatar });
        descriptor.connections = connections;
        this.app.host.ctx().saveSettingsDebounced();
        try {
            this.module?.updatePersonaConnectionsAvatarList?.();
        } catch (error) {
            this.log.debug('persona connections list did not refresh', error);
        }
        return true;
    }

    async refresh(avatarId: string): Promise<void> {
        try {
            const module = await this.load();
            await module.getUserAvatars(true, avatarId);
        } catch (error) {
            this.log.debug('persona list did not refresh', error);
        }
    }

    async select(avatarId: string): Promise<boolean> {
        try {
            const module = await this.load();
            await module.setUserAvatar(avatarId, { toastPersonaNameChange: false });
            return true;
        } catch (error) {
            this.log.warn('persona was not selected', error);
            return false;
        }
    }

    async open(avatarId: string): Promise<void> {
        if (typeof document !== 'undefined') {
            const drawer = document.getElementById('PersonaManagement');
            const toggle = document.querySelector<HTMLElement>('#persona-management-button .drawer-toggle');
            if (drawer?.classList.contains('closedDrawer') && toggle) toggle.click();
        }
        await this.refresh(avatarId);
    }
}
