// Pictures by agents (plan §3.19, release 1.33; NAI Studio 0.16): what an agent may propose to NAI Studio.
// - `nai.illustrate` («Иллюстратор»): a marker of the reply in the main model's own form — the object of `data-nai`
//   and the sentence it goes after; NAI Studio draws it by the same path as the main model's markers (passports,
//   interpreter, style, continuity, quality gates). Available only while NAI Studio's «Кто пишет метки» gives the
//   illustrator this reply (the mode «Иллюстратор», or «…если модель не поставила метку» for a reply without one);
//   Maestro registers its illustrator with NAI Studio only while such an agent is on, so turning it off brings the main
//   model's markers back.
// - `nai.portrait` («Портретист»): an important face without a passport gets one written by NAI Studio's generator into
//   this chat (journaled with undo) and, when DES knows them, its portrait.
// - `nai.cardAvatar`: a new avatar of the chat's card — never by itself (it changes the card); NAI Studio saves the
//   previous image first.
// Pictures are free only unless «Агенты могут тратить Anlas на картинки» (the agents' settings).
import { adaptersOf } from '../../adapters';
import type { NaiPassport } from '../../adapters';
import { registerProposalReceiver } from '../../core/proposal-receivers';
import { presentNames } from '../../domain/director-scene';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { StagingApi } from '../staging/api';

export const ILLUSTRATE_KIND = 'nai.illustrate';
export const PORTRAIT_KIND = 'nai.portrait';
export const CARD_AVATAR_KIND = 'nai.cardAvatar';
/** Journal target of a passport the portraitist wrote into the chat (undo: NAI Studio drops it). */
export const CHAT_PASSPORT_TARGET = 'nai.chatPassport';
/** Journal target of a card avatar (no undo: the previous image is in /user/images/avatar-backups). */
export const CARD_AVATAR_TARGET = 'nai.cardAvatar';
/** Maestro's id as NAI Studio's illustrator. */
export const ILLUSTRATOR_ID = 'maestro-agents';

const MAX_PORTRAITS = 2;

const fold = (text: string) => text.trim().toLowerCase().replace(/ё/g, 'е');
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const isDict = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A passport of the chat (card, persona, chat, lore) named so (name or alias). */
export function passportNamed(passports: readonly NaiPassport[], name: string): NaiPassport | undefined {
    const wanted = fold(name);
    return passports.find(
        (p) => p.kind === 'character' && [p.name, ...p.aliases].some((n) => n.trim() && fold(n) === wanted),
    );
}

/** Faces each chat's portraitist was shown (folded names): a new face is considered once per session. */
const shownFaces = new Map<string, Set<string>>();

/**
 * People of the scene now (DES tracker of the latest reply, M45 staging) without a picture passport in the chat — not
 * the player, not the card itself (its avatar is the card's).
 */
export function facesWithoutPassport(app: App): string[] {
    try {
        const nai = adaptersOf(app).nai;
        if (!nai.api()) return [];
        const index = app.turn.lastAssistantIndex();
        const names = [
            ...(index >= 0 ? presentNames(adaptersOf(app).des.trackerFor(index)) : []),
            ...(app.modules.api<StagingApi>('staging')?.current() ?? []).map((entry) => entry.name),
        ];
        const ctx = app.host.ctx();
        const skip = new Set([ctx.name1, ctx.name2].filter((n): n is string => !!n).map(fold));
        const passports = nai.chatPassports();
        const seen = new Set<string>();
        return names.filter((name) => {
            const key = fold(name);
            if (!key || skip.has(key) || seen.has(key)) return false;
            seen.add(key);
            return !passportNamed(passports, name);
        });
    } catch {
        return [];
    }
}

/** Faces the portraitist of this chat has not been shown yet. */
export function unseenFaces(app: App): string[] {
    const shown = shownFaces.get(app.host.chatId() ?? '') ?? new Set<string>();
    return facesWithoutPassport(app).filter((name) => !shown.has(fold(name)));
}

/** The source «No portrait yet»: the unseen faces, then marked as shown. */
export function portraitlessText(app: App): string {
    const chatId = app.host.chatId() ?? '';
    const faces = unseenFaces(app);
    const shown = shownFaces.get(chatId) ?? new Set<string>();
    for (const name of faces) shown.add(fold(name));
    shownFaces.set(chatId, shown);
    return faces.map((name) => `- ${name}`).join('\n');
}

/** Test helper. */
export function resetShownFaces(): void {
    shownFaces.clear();
}

interface IllustratePayload {
    messageIndex: number;
    swipeId: number;
    marker: Record<string, unknown>;
    after?: string;
    freeOnly: boolean;
}

interface PortraitPayload {
    name: string;
    look: string;
    chatId: string;
}

interface CardAvatarPayload {
    avatar: string;
    name: string;
    look?: string;
    chatId: string;
}

export interface ImageReceiverDeps {
    /** «Агенты могут тратить Anlas на картинки»: false — free only. */
    paid(): boolean;
    /** The story's language for passport names ('ru'). */
    language(): string;
}

export function installImageReceivers(app: App, log: Logger, deps: ImageReceiverDeps): Unsubscribe[] {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const nai = () => adaptersOf(app).nai;
    const swipeOf = (index: number): number => Number(app.host.ctx().chat[index]?.swipe_id ?? 0) || 0;

    /* ---------------------------------------------------------------- the illustrator */

    const illustrate = async (raw: unknown): Promise<void> => {
        const payload = raw as IllustratePayload;
        const request: Parameters<ReturnType<typeof nai>['requestImage']>[0] = {
            messageIndex: payload.messageIndex,
            marker: payload.marker,
            swipeId: payload.swipeId,
            freeOnly: payload.freeOnly,
        };
        if (payload.after) request.after = payload.after;
        const result = await nai().requestImage(request);
        if (!result.ok) throw new Error(t('m44.recv.illustrate.failed', { error: result.error }));
    };

    /* ---------------------------------------------------------------- portraits */

    const portrait = async (raw: unknown, changes?: JournalChange[]): Promise<void> => {
        const payload = raw as PortraitPayload;
        if (app.host.chatId() !== payload.chatId) throw new Error(t('m44.recv.portrait.otherChat'));
        const adapter = nai();
        const api = adapter.api();
        if (!api) throw new Error(t('m44.recv.portrait.noNai'));
        if (!passportNamed(adapter.chatPassports(), payload.name)) {
            const language = deps.language();
            const written = await adapter.generatePassport({
                name: payload.name,
                kind: 'character',
                description: payload.look,
                ...(language ? { language } : {}),
            });
            if (!written) throw new Error(t('m44.recv.portrait.noPassport', { name: payload.name }));
            await api.savePassport(written, 'chat');
            changes?.push({
                target: CHAT_PASSPORT_TARGET,
                ref: { id: written.id, chatId: payload.chatId, name: payload.name },
                before: null,
                after: payload.name,
            });
        }
        if (adapter.canRequestDesPortrait()) await adapter.requestDesPortrait(payload.name, { reason: 'agent' });
    };

    /* ---------------------------------------------------------------- the card's avatar */

    const currentCard = (): { avatar: string; name: string; index: number } | null => {
        if (app.host.isGroupChat()) return null;
        const ctx = app.host.ctx();
        const index = Number(ctx.characterId);
        const character = Number.isInteger(index) ? ctx.characters?.[index] : undefined;
        const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
        return avatar && avatar !== 'none' ? { avatar, name: character?.name ?? '', index } : null;
    };

    const cardAvatar = async (raw: unknown): Promise<void> => {
        const payload = raw as CardAvatarPayload;
        if (app.host.chatId() !== payload.chatId) throw new Error(t('m44.recv.portrait.otherChat'));
        const adapter = nai();
        const card = currentCard();
        if (!card || card.avatar !== payload.avatar) throw new Error(t('m44.recv.portrait.otherChat'));
        let passport: NaiPassport | undefined;
        const own = adapter.passportsOf(card.index).some((p) => p.kind === 'character');
        if (!own && payload.look) {
            passport =
                (await adapter.generatePassport({
                    name: payload.name,
                    kind: 'character',
                    description: payload.look,
                })) ?? undefined;
        }
        const result = await adapter.generateCardAvatar({ avatar: payload.avatar, ...(passport ? { passport } : {}) });
        if (!result.ok) throw new Error(t('m44.recv.cardAvatar.failed', { error: result.error ?? '' }));
        app.ui.notice(t('m44.recv.cardAvatar.done', { name: payload.name, backup: result.backup ?? '' }), {
            importance: 'info',
        });
    };

    return [
        registerProposalReceiver({
            kind: ILLUSTRATE_KIND,
            module: 'agents',
            labelKey: 'm44.recv.nai.illustrate',
            describe:
                "one picture for the reply, written exactly as the image rules (in the sources) describe a marker — the same object you would put inside data-nai: marker: that object (prompt, chars with name / look / action / pos, ratio, and the optional keys the rules allow) plus caption: the picture's caption as the rules ask for the figcaption; after: the last sentence of the paragraph the picture shows, copied word for word from the reply. As many items as the rules ask for; none when the reply needs no picture. Never HTML, never the <img> tag: only the object.",
            schema: {
                type: 'object',
                properties: { marker: { type: 'object' }, after: { type: 'string' } },
                required: ['marker'],
            },
            defaultAutonomy: 'auto',
            direct: true,
            available: ({ messageIndex }) => {
                const adapter = nai();
                if (messageIndex === undefined || !adapter.canIllustrate()) return false;
                const writer = adapter.markerWriter();
                if (!writer || writer.effective === 'main') return false;
                return writer.effective === 'illustrator' || adapter.messageMarkers(messageIndex).length === 0;
            },
            toProposal: (data, context): Proposal | null => {
                const index = context.messageIndex;
                const marker = isDict(data.marker) ? structuredClone(data.marker) : null;
                if (index === undefined || !marker || !str(marker.prompt)) return null;
                const payload: IllustratePayload = {
                    messageIndex: index,
                    swipeId: swipeOf(index),
                    marker,
                    freeOnly: !deps.paid(),
                };
                const after = str(data.after);
                if (after) payload.after = after;
                const caption = str(marker.caption) || str(marker.prompt).slice(0, 60);
                return {
                    module: 'agents',
                    kind: ILLUSTRATE_KIND,
                    title: t('m44.recv.illustrateTitle', { caption }),
                    // The picture is NAI Studio's: deleted or redrawn there, nothing to journal here.
                    changes: [],
                    payload,
                    sourceMessage: index,
                    apply: illustrate,
                };
            },
            apply: illustrate,
        }),
        registerProposalReceiver({
            kind: PORTRAIT_KIND,
            module: 'agents',
            labelKey: 'm44.recv.nai.portrait',
            describe: `a person who should get a picture now: an important face of the story who appears or matters in this reply and has no image passport yet (the list "No portrait yet" in the sources, when given). name: as the story calls them; look: their appearance for an artist, in English — sex and apparent age, hair, eyes, build, usual clothes, distinctive marks — only what the story and the lore say or clearly imply. At most ${MAX_PORTRAITS}; none when nobody new matters.`,
            schema: {
                type: 'object',
                properties: { name: { type: 'string' }, look: { type: 'string' } },
                required: ['name', 'look'],
            },
            defaultAutonomy: 'auto',
            direct: true,
            available: () => typeof nai().api()?.generatePassport === 'function' && unseenFaces(app).length > 0,
            toProposal: (data, context): Proposal | null => {
                const name = str(data.name);
                const look = str(data.look);
                const chatId = app.host.chatId();
                if (!name || !look || !chatId) return null;
                if (passportNamed(nai().chatPassports(), name)) return null;
                const changes: JournalChange[] = [];
                const payload: PortraitPayload = { name, look, chatId };
                const proposal: Proposal = {
                    module: 'agents',
                    kind: PORTRAIT_KIND,
                    title: t('m44.recv.portraitTitle', { name }),
                    changes,
                    payload,
                    // The changes are known once the passport is written: the runtime journals them after apply.
                    apply: (raw) => portrait(raw, changes),
                };
                if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
                return proposal;
            },
            apply: (raw) => portrait(raw),
        }),
        registerProposalReceiver({
            kind: CARD_AVATAR_KIND,
            module: 'agents',
            labelKey: 'm44.recv.nai.cardAvatar',
            describe:
                "a new avatar picture for the chat's character card, only when the user asked for it or the character's look changed for good in the story. look: how they look now, for an artist, in English (appearance and clothes); used only when the card has no image passport. One item at most.",
            schema: { type: 'object', properties: { look: { type: 'string' } } },
            defaultAutonomy: 'ask',
            neverAuto: true,
            available: () => nai().canCardAvatar() && currentCard() !== null,
            toProposal: (data, context): Proposal | null => {
                const card = currentCard();
                const chatId = app.host.chatId();
                if (!card || !chatId) return null;
                const payload: CardAvatarPayload = { avatar: card.avatar, name: card.name, chatId };
                const look = str(data.look);
                if (look) payload.look = look;
                const proposal: Proposal = {
                    module: 'agents',
                    kind: CARD_AVATAR_KIND,
                    title: t('m44.recv.cardAvatarTitle', { name: card.name }),
                    description: t('m44.recv.cardAvatarWarn'),
                    changes: [
                        {
                            target: CARD_AVATAR_TARGET,
                            ref: { avatar: card.avatar },
                            before: null,
                            after: card.name,
                        },
                    ],
                    payload,
                    apply: cardAvatar,
                };
                if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
                return proposal;
            },
            apply: cardAvatar,
        }),
    ];
}

/**
 * Keeps Maestro registered as NAI Studio's illustrator exactly while an agent that writes `nai.illustrate` is on for the
 * current chat (and NAI Studio takes an illustrator): `sync` is called on agent and chat changes.
 */
export class IllustratorRegistration {
    private off: (() => void) | null = null;
    private api: unknown = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly wanted: () => boolean,
    ) {}

    sync(): void {
        let want = false;
        let api: unknown = null;
        try {
            const adapter = adaptersOf(this.app).nai;
            api = adapter.api() ?? null;
            want = !!api && adapter.canIllustrate() && this.wanted();
        } catch (error) {
            this.log.debug('illustrator registration: NAI Studio not readable', error);
        }
        // NAI Studio published its API again (disabled and enabled): its registrations are gone.
        if (this.off && (!want || api !== this.api)) this.dispose();
        if (!want || this.off) return;
        this.off = adaptersOf(this.app).nai.registerIllustrator(ILLUSTRATOR_ID);
        this.api = api;
    }

    registered(): boolean {
        return this.off !== null;
    }

    dispose(): void {
        const off = this.off;
        this.off = null;
        this.api = null;
        try {
            off?.();
        } catch (error) {
            this.log.debug('illustrator unregistration failed', error);
        }
    }
}
