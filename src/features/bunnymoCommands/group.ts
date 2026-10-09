// The «BunnyMo» group of the Maestro button at the message box (M40): the six sheet commands with a plain hint each
// (and a warning when Maestro's «Листы», M31, are off: then BunnyMo's own entry generates the sheet with the whole
// prompt), whose target is a character of the scene or «Другой…» (a name typed in), «Запомнить момент» with a moment
// typed in; «Словарь BunnyMo» and «Досье персонажа» need no model. Shown only while the BunnyMo core is active
// (capability `bunnymo.core`). A command is put on a line of its own at the start of the message box (the text there
// stays), or — «Отправлять сразу» — sent as the user's message with `/send … | /trigger`, so M31 sees a user message
// with a sheet command; while a reply is being written it waits in the box.
import { adaptersOf } from '../../adapters';
import { insertCommand, sendScript, sheetCommandText, SHEET_BUTTONS } from '../../domain/bunnymo-commands';
import type { SheetButton } from '../../domain/bunnymo-commands';
import { sceneCast } from '../../domain/scene-cast';
import { sceneTracker } from '../../domain/voices-cards';
import { normalizeName } from '../../domain/world-names';
import type { App, ComposerGroup, ComposerItem, Logger } from '../../shared/contracts';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { DossierApi } from '../dossier/api';
import type { Entity, WorldModelApi } from '../world/api';

export const BUNNYMO_GROUP = 'bunnymo';
/** After the wardrobe's «Переодеться» (10): the story first, the sheets after. */
const GROUP_ORDER = 30;
/** Characters offered as targets at most. */
const MAX_TARGETS = 8;
const BOX = '#send_textarea';

export interface BunnyMoCommandsSettings {
    /** The command is sent as a message at once (otherwise it waits in the message box). */
    sendNow: boolean;
}

export function defaultBunnyMoCommandsSettings(): BunnyMoCommandsSettings {
    return { sendNow: false };
}

export function readBunnyMoCommandsSettings(slice: Partial<BunnyMoCommandsSettings>): BunnyMoCommandsSettings {
    if (typeof slice.sendNow !== 'boolean') slice.sendNow = false;
    return slice as BunnyMoCommandsSettings;
}

export class BunnyMoCommands {
    private readonly t: App['i18n']['t'];

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => BunnyMoCommandsSettings,
    ) {
        this.t = app.i18n.t.bind(app.i18n);
    }

    group(): ComposerGroup {
        return {
            id: BUNNYMO_GROUP,
            order: GROUP_ORDER,
            label: () => this.t('m40.group'),
            visible: () => this.available(),
            items: () => this.items(),
        };
    }

    /** A chat is open and the BunnyMo core is among the active books. */
    available(): boolean {
        try {
            return !!this.app.host.chatId() && this.app.host.caps.has('bunnymo.core');
        } catch {
            return false;
        }
    }

    items(): ComposerItem[] {
        const items: ComposerItem[] = SHEET_BUTTONS.map((button) => this.sheetItem(button));
        if (this.api<BunnyMoModeApi>('bunnymoMode')) {
            items.push({
                id: 'dictionary',
                label: this.t('m40.dictionary'),
                hint: this.t('m40.dictionary.hint'),
                icon: 'fa-book-open',
                run: () => this.api<BunnyMoModeApi>('bunnymoMode')?.open(),
            });
        }
        const dossier = this.api<DossierApi>('dossier');
        if (dossier && typeof dossier.openByName === 'function') {
            items.push({
                id: 'dossier',
                label: this.t('m40.dossier'),
                hint: this.t('m40.dossier.hint'),
                icon: 'fa-address-card',
                submenu: () =>
                    this.targets().map((name, index) => ({
                        id: `who-${index}`,
                        label: this.targetLabel(name),
                        run: () => this.openDossier(name),
                    })),
            });
        }
        return items;
    }

    private sheetItem(button: SheetButton): ComposerItem {
        const { command } = button;
        const plain = this.t(`m40.cmd.${command}.hint`);
        const item: ComposerItem = {
            id: command,
            label: this.t(`m40.cmd.${command}`),
            hint: this.sheetsOn() ? plain : this.t('m40.noSheets', { hint: plain }),
            icon: command === 'memsheet' ? 'fa-bookmark' : command === 'physheet' ? 'fa-user' : 'fa-file-lines',
        };
        if (button.target === 'moment') {
            item.run = async () => {
                const moment = await this.ask('m40.moment.title', 'm40.moment.hint');
                if (moment) await this.use(sheetCommandText(command, moment));
            };
            return item;
        }
        item.submenu = () => [
            ...this.targets().map((name, index) => ({
                id: `who-${index}`,
                label: this.targetLabel(name),
                run: () => this.use(sheetCommandText(command, name)),
            })),
            {
                id: 'other',
                label: this.t('m40.other'),
                icon: 'fa-pen',
                run: async () => {
                    const name = await this.ask('m40.other.title', 'm40.other.hint');
                    if (name) await this.use(sheetCommandText(command, name));
                },
            },
        ];
        return item;
    }

    /** M31 «Листы» runs (the sheet is generated with its own small context). */
    private sheetsOn(): boolean {
        try {
            return this.app.settings.isModuleEnabled('sheets');
        } catch {
            return true;
        }
    }

    private targetLabel(name: string): string {
        return normalizeName(name) === normalizeName(this.app.host.ctx().name1 ?? '')
            ? this.t('m40.you', { name })
            : name;
    }

    /**
     * Whom a sheet can be about: the characters of the scene (DES's tracker of the committed reply, named as the world
     * model knows them), the card's character, the user's character last.
     */
    targets(): string[] {
        const ctx = this.app.host.ctx();
        const ownName = String(ctx.name1 ?? '').trim();
        const world = this.api<WorldModelApi>('world');
        const resolve = (name: string): Entity | undefined => {
            try {
                return world?.resolve(name, 'character') ?? world?.resolve(name) ?? undefined;
            } catch {
                return undefined;
            }
        };
        const hidden = ((): string[] => {
            try {
                const des = adaptersOf(this.app).des as { removedCharacters?: () => string[] };
                return typeof des.removedCharacters === 'function' ? des.removedCharacters() : [];
            } catch {
                return [];
            }
        })();
        const persona = ((): string => {
            try {
                return (ownName ? world?.resolve(ownName, 'persona')?.name : undefined) ?? ownName;
            } catch {
                return ownName;
            }
        })();
        const names: string[] = [];
        const add = (name: string) => {
            const key = normalizeName(name);
            if (key && !names.some((item) => normalizeName(item) === key)) names.push(name.trim());
        };
        const card = String(ctx.name2 ?? '').trim();
        try {
            // The scene the player sees: the latest reply counts before it is answered (a fresh chat has only the
            // greeting, whose DES tracker the preparation filled), so the chat is read as if the next message were sent.
            const chat = [...((ctx.chat ?? []) as unknown[]), { is_user: true }];
            const cast = sceneCast(sceneTracker(chat), { persona, ownName, hidden, resolve });
            // As the story writes the name (the tracker's «Вера»), not the world model's canonical «Vera».
            for (const member of cast) add(member.character.name || member.name);
        } catch (error) {
            this.log.debug('BunnyMo commands: the scene is not readable', error);
        }
        if (card && !this.app.host.isGroupChat()) add(card);
        const list = names.slice(0, MAX_TARGETS);
        if (ownName) list.push(ownName);
        return list;
    }

    private async ask(titleKey: string, hintKey: string): Promise<string | null> {
        const prompt = this.app.ui.prompt;
        if (typeof prompt !== 'function') return null;
        return prompt.call(this.app.ui, this.t(titleKey), { hint: this.t(hintKey) });
    }

    /** Puts the command into the message box, or sends it at once («Отправлять сразу», no reply running). */
    async use(command: string): Promise<void> {
        if (this.settings().sendNow) {
            if (this.app.turn.current() === null) {
                await this.app.host.ctx().executeSlashCommandsWithOptions(sendScript(command), {
                    handleExecutionErrors: true,
                });
                return;
            }
            this.app.ui.notice(this.t('m40.busy'), { importance: 'urgent' });
        }
        this.insert(command);
    }

    /** The command on a line of its own at the start of the box (the text there stays), the cursor after it. */
    insert(command: string): void {
        const box = document.querySelector<HTMLTextAreaElement>(BOX);
        if (!box) {
            this.app.ui.notice(this.t('m40.noBox'), { level: 'warn', importance: 'urgent' });
            return;
        }
        const { value, caret } = insertCommand(box.value, command);
        box.value = value;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.focus();
        try {
            box.setSelectionRange(caret, caret);
        } catch {
            // a box that cannot place the cursor still has the command
        }
    }

    private openDossier(name: string): void {
        const dossier = this.api<DossierApi>('dossier');
        if (dossier?.openByName?.(name)) return;
        this.app.ui.notice(this.t('m40.noDossier', { name }), { importance: 'urgent' });
    }

    private api<T>(key: string): T | undefined {
        try {
            return this.app.modules.api<T>(key);
        } catch {
            return undefined;
        }
    }
}
