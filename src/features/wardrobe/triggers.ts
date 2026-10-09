// «Переодевание по сообщениям» (M27): a change of clothes written in a message reaches the wardrobe without waiting for
// the tracker.
// - The player's message, at generation time (an ephemeral producer: MESSAGE_SENT comes before the interceptors): the
//   detector (src/domain/wardrobe-change.ts) reads it; a change it can tell without a model (an outfit named, garments,
//   undressing, something taken off the clothes on) is applied at once with «Переодеть сейчас» — the reply is written
//   in the new clothes (prompt line, DES's tracker). What it cannot tell («переодеваюсь») gets a one-shot hint for this
//   generation and is read by the model after the reply. A swipe or regeneration reads the same message once (its hint
//   comes again); an edit of the newest player's message takes its change back and reads it again; deleting the
//   message takes it back (the service's invalidation).
// - The narration of a committed reply (after the tracker was read): the same detector with the reply's speaker; a
//   change the tracker of that reply already shows is left to it.
// - The model (task wardrobe.change, strict schema, leader only, never in economy mode, under the background cap):
//   one request for what a message said but not told — it replaces the persona check every N turns while this is on.
import { adaptersOf } from '../../adapters';
import { stableHash } from '../../domain/hash';
import { cleanForAnalysis } from '../../domain/text-clean';
import { presentCharacters, sceneTracker } from '../../domain/voices-cards';
import {
    detectOutfitChange,
    finalChanges,
    matchOutfitName,
    mentionsChange,
    withoutGarments,
} from '../../domain/wardrobe-change';
import type { ChangeCastMember, OutfitChange } from '../../domain/wardrobe-change';
import {
    CHANGE_EXCERPT_CHARS,
    CHANGE_SCHEMA,
    CHANGE_SCHEMA_NAME,
    changeMessages,
    parseChangeAnswer,
} from '../../domain/wardrobe-change-model';
import type { ChangePerson } from '../../domain/wardrobe-change-model';
import type { PendingChange } from '../../domain/wardrobe-doc';
import { outfitTagList } from '../../domain/wardrobe-tags';
import { normalizeName } from '../../domain/world-names';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { WorldModelApi } from '../world/api';
import type { WearNowWhat } from './api';
import type { WardrobeService } from './service';
import { CHANGE_TASK, PERSONA_KEY, WARDROBE_ID, WARDROBE_WEAR_NOW_KIND } from './settings';
import type { WardrobeSettings } from './settings';

/** Ephemeral injection key of the one-shot hint (slot `maestro_wardrobe_change`). */
export const CHANGE_INJECTION = 'wardrobe_change';
/** Producer name: it runs before the prompt line's (the line then says the new clothes). */
export const CHANGE_PRODUCER = 'wardrobeChange';
const TASK_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 300;
/** Generation types that answer the player's newest message. */
const ANSWERS: ReadonlySet<string> = new Set(['normal', 'swipe', 'regenerate']);

export class WardrobeTriggers {
    private readonly t: App['i18n']['t'];

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly service: WardrobeService,
        private readonly settings: () => WardrobeSettings,
    ) {
        this.t = app.i18n.t.bind(app.i18n);
    }

    /** The producer first: the prompt line's producer comes after it and says the new clothes. */
    install(): Unsubscribe[] {
        return [
            this.app.ephemeral.addProducer(CHANGE_PRODUCER, (gen) => this.produce(gen)),
            this.app.tasks.register(CHANGE_TASK, (payload) => this.run(payload)),
            this.app.bus.on('reply:ready', ({ messageIndex, type }) => {
                void this.onReply(messageIndex, type).catch((error: unknown) =>
                    this.log.warn('wardrobe: the reply check failed', error),
                );
            }),
            this.app.bus.on('message:invalidated', ({ messageIndex, reason }) => {
                if (reason !== 'edited') return;
                void this.onEdited(messageIndex).catch((error: unknown) =>
                    this.log.warn('wardrobe: the edited message was not read again', error),
                );
            }),
            registerProfileTask(CHANGE_TASK, 'm27.change.profileTask'),
        ];
    }

    private on(): boolean {
        const settings = this.settings();
        return settings.triggers && !!this.app.host.chatId() && !this.app.host.isGroupChat();
    }

    private chat(): STChatMessage[] {
        try {
            return this.app.host.ctx().chat ?? [];
        } catch {
            return [];
        }
    }

    /* ---------------------------------------------------------------- who is there */

    private world(): WorldModelApi | undefined {
        try {
            return this.app.modules.api<WorldModelApi>('world');
        } catch {
            return undefined;
        }
    }

    /** Other names (nominative: the world model's name and aliases) and case forms (world model, DES-RU) of a name. */
    private namesOf(name: string): { aliases: string[]; forms: string[] } {
        const aliases: string[] = [];
        const forms: string[] = [];
        try {
            const entity = this.world()?.resolve(name, 'character') ?? this.world()?.resolve(name);
            if (entity) {
                aliases.push(entity.name, ...entity.aliases);
                forms.push(...entity.forms);
            }
        } catch {
            // no world model
        }
        try {
            const list = adaptersOf(this.app).desru.api()?.nameForms(name);
            if (Array.isArray(list)) forms.push(...list.filter((form): form is string => typeof form === 'string'));
        } catch {
            // no DES-RU
        }
        const own = normalizeName(name);
        const clean = (list: string[]) => [...new Set(list.filter((item) => item && normalizeName(item) !== own))];
        return { aliases: clean(aliases), forms: clean(forms) };
    }

    /**
     * The people the detector knows: the characters of the scene (present), the card's character and the characters
     * with a look in this chat (known, maybe away).
     */
    cast(): ChangeCastMember[] {
        const ctx = this.app.host.ctx();
        const own = normalizeName(ctx.name1 ?? '');
        const out: ChangeCastMember[] = [];
        const add = (name: string, present: boolean) => {
            const key = normalizeName(name);
            if (!key || key === own) return;
            const found = out.find((item) => normalizeName(item.name) === key);
            if (found) {
                if (present) found.present = true;
                return;
            }
            out.push({ name: name.trim(), ...this.namesOf(name), present });
        };
        let hidden: string[] = [];
        try {
            const des = adaptersOf(this.app).des as { removedCharacters?: () => string[] };
            if (typeof des.removedCharacters === 'function') hidden = des.removedCharacters();
        } catch {
            hidden = [];
        }
        const tracker = sceneTracker(this.chat());
        for (const character of presentCharacters(tracker?.snapshot.characters ?? [], hidden))
            add(character.name, true);
        const card = String(ctx.name2 ?? '').trim();
        if (card) add(card, !tracker);
        for (const name of Object.keys(this.service.outfitNames())) if (name !== PERSONA_KEY) add(name, false);
        return out;
    }

    private personaOption(): { name: string; aliases: string[]; forms: string[] } | undefined {
        const name = String(this.app.host.ctx().name1 ?? '').trim();
        return name ? { name, ...this.namesOf(name) } : undefined;
    }

    /* ---------------------------------------------------------------- what can be told without a model */

    /** What «Переодеть сейчас» gets for a change, or null when only the model can tell. */
    resolvable(change: OutfitChange): WearNowWhat | null {
        if (change.who === '?') return null;
        if (change.outfitName) return { outfit: change.outfitName };
        if (change.kind === 'undress') return { undress: change.undress ?? 'naked' };
        const garments = change.garments.join(', ');
        if (change.kind === 'change' && garments && outfitTagList(garments).some((tag) => tag.garment)) {
            return { wording: garments };
        }
        const current = this.service.current(change.who === PERSONA_KEY ? undefined : change.who);
        const record =
            change.who === PERSONA_KEY ? current.find((item) => item.persona) : current.find((item) => !item.persona);
        if (change.kind === 'remove' && record?.wording) {
            const left = withoutGarments(record.wording, change.garments);
            if (left) return { wording: left };
        }
        return null;
    }

    /* ---------------------------------------------------------------- the player's message */

    /** The player's message this generation answers (the newest, followed by at most the reply being redone). */
    private playerMessage(gen: GenerationInfo): number {
        if (!ANSWERS.has(gen.type || 'normal')) return -1;
        const chat = this.chat();
        for (let index = chat.length - 1; index >= 0 && index >= chat.length - 2; index--) {
            const message = chat[index];
            if (message?.is_user) return index;
            if (message?.is_system) return -1;
        }
        return -1;
    }

    /**
     * The ephemeral producer: changes of the player's message applied now, the rest a hint for this generation. A
     * message without a verb of changing clothes costs a regular expression and nothing is written (the send path).
     */
    private async produce(gen: GenerationInfo): Promise<void> {
        if (gen.quiet || gen.dryRun || gen.sheetCommand || !this.on()) return;
        const index = this.playerMessage(gen);
        if (index < 0) return;
        const text = cleanForAnalysis(this.chat()[index]);
        if (!text || !mentionsChange(text)) return;
        const hash = stableHash(text);
        const mark = await this.service.triggerMark();
        if (mark && mark.index === index && mark.hash === hash) {
            // A swipe or a regeneration: read once; what waits for the model is hinted again.
            this.hint(this.service.pendingChanges().filter((item) => item.index === index));
            return;
        }
        const pending = await this.readPlayer(index, text, true, hash);
        this.hint(pending);
    }

    /**
     * Reads one player's message: applies what can be told now; what waits for the model, remembered and returned. The
     * message is marked read (a swipe does not read it again) once it said a change.
     */
    private async readPlayer(index: number, text: string, generating: boolean, hash: string): Promise<PendingChange[]> {
        const changes = finalChanges(
            detectOutfitChange(text, this.cast(), {
                persona: this.personaOption(),
                speaker: 'player',
                outfits: this.service.outfitNames(),
            }),
        );
        if (!changes.length) return [];
        await this.service.setTriggerMark({ index, hash });
        const waiting: Omit<PendingChange, 'index' | 'at'>[] = [];
        for (const change of changes) {
            const what = this.resolvable(change);
            if (what) {
                const done = await this.service.wearNow(change.who, what, 'player', index, { generating });
                if (done) continue;
            }
            waiting.push({ who: change.who, phrase: change.phrase, kind: change.kind });
        }
        await this.service.setPending(index, waiting);
        return waiting.map((item) => ({ ...item, index, at: Date.now() }));
    }

    /** The one-shot hint of this generation: who changes and the words, to describe the clothes and update the tracker. */
    private hint(pending: readonly PendingChange[]): void {
        if (!pending.length) return;
        const persona = String(this.app.host.ctx().name1 ?? '').trim() || 'User';
        const parts = pending.map((item) => {
            const who = item.who === PERSONA_KEY ? persona : item.who === '?' ? 'Someone' : item.who;
            return `${who} is changing clothes — "${item.phrase}"`;
        });
        this.app.ephemeral.setInjection(CHANGE_INJECTION, {
            text: `[Clothing: ${parts.join('; ')}. Describe the new clothes and update the tracker.]`,
            position: 1,
            depth: 0,
            role: 0,
            scan: false,
        });
    }

    /** An edit of the newest player's message: its change goes back and the new text is read again. */
    private async onEdited(index: number): Promise<void> {
        if (!this.on() || !this.app.leader.isLeader()) return;
        const chat = this.chat();
        const message = chat[index];
        if (!message?.is_user) return;
        // Only the newest player's message: an older one has been answered and overtaken.
        for (let i = index + 1; i < chat.length; i++) if (chat[i]?.is_user) return;
        const text = cleanForAnalysis(message);
        const hash = stableHash(text);
        const mark = await this.service.triggerMark();
        if (mark?.index === index && mark.hash === hash) return;
        // Only a message the trigger read (or one that says a change now) has anything to take back or apply.
        if (mark?.index !== index && !mentionsChange(text)) return;
        for (const record of this.app.journal.list({ module: WARDROBE_ID })) {
            if (record.sourceMessage !== index || record.undone || record.kind !== WARDROBE_WEAR_NOW_KIND) continue;
            try {
                await this.app.journal.undo(record.id);
            } catch (error) {
                this.log.warn('wardrobe: the change of the edited message was not undone', error);
            }
        }
        await this.service.setPending(index, []);
        if (mark?.index === index) await this.service.setTriggerMark(null);
        await this.readPlayer(index, text, false, hash);
    }

    /* ---------------------------------------------------------------- the narration of a reply */

    /** After the committed reply `index` was read (the tracker first): what its narration says. */
    async afterTurn(index: number): Promise<void> {
        if (!this.on() || !this.app.leader.isLeader()) return;
        const message = this.chat()[index];
        if (!message || message.is_user || message.is_system) return;
        const text = cleanForAnalysis(message);
        if (!text || !mentionsChange(text)) return;
        const cast = this.cast();
        const changes = finalChanges(
            detectOutfitChange(text, cast, {
                persona: this.personaOption(),
                speaker: 'narrator',
                narrator: typeof message.name === 'string' ? message.name : '',
                outfits: this.service.outfitNames(),
            }),
        );
        const waiting: PendingChange[] = [];
        for (const change of changes) {
            if (change.who !== '?' && change.who !== PERSONA_KEY && this.trackerSaid(change.who, index)) continue;
            const what = this.resolvable(change);
            if (what) {
                const done = await this.service.wearNow(change.who, what, 'reply', index);
                if (done) continue;
            }
            if (change.who === '?' && !cast.some((member) => member.present)) continue;
            waiting.push({ who: change.who, phrase: change.phrase, kind: change.kind, index, at: Date.now() });
        }
        if (waiting.length) await this.ask(index, index, waiting, 'reply');
    }

    /** The tracker of this reply already shows new clothes for this character (the turn's reading took them). */
    private trackerSaid(who: string, index: number): boolean {
        const record = this.service.current(who).find((item) => !item.persona);
        return !!record && record.since === index && (record.source === 'field' || record.source === 'appearance');
    }

    /** A reply to a player's message with changes the text did not tell: the model reads them now. */
    private async onReply(index: number, type: string): Promise<void> {
        if (!this.on() || !this.app.leader.isLeader() || type === 'impersonate' || type === 'continue') return;
        const chat = this.chat();
        let player = -1;
        for (let i = index - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                player = i;
                break;
            }
            if (!chat[i]?.is_system && i < index - 1) break;
        }
        if (player < 0) return;
        const pending = this.service.pendingChanges().filter((item) => item.index === player);
        if (pending.length) await this.ask(player, index, pending, 'player');
    }

    /* ---------------------------------------------------------------- the model */

    private modelAllowed(): boolean {
        const { app } = this;
        try {
            if (!this.settings().triggers || app.settings.core().mode === 'economy' || !app.leader.isLeader()) {
                return false;
            }
            return app.llm.available(CHANGE_TASK) && !app.cost.backgroundCapReached();
        } catch {
            return false;
        }
    }

    /** Queues one model request for the changes of message `source` (read with the messages up to `upTo`). */
    private async ask(
        source: number,
        upTo: number,
        pending: readonly PendingChange[],
        mode: 'player' | 'reply',
    ): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || !this.modelAllowed()) return;
        const chat = this.chat();
        const persona = String(this.app.host.ctx().name1 ?? '').trim() || 'User';
        const lines: string[] = [];
        for (let i = Math.max(0, source - (mode === 'reply' ? 1 : 0)); i <= upTo && i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            const text = cleanForAnalysis(message);
            if (text) lines.push(`${message.is_user ? persona : message.name || 'Narrator'}: ${text}`);
        }
        const names = this.service.outfitNames();
        const people: ChangePerson[] = [];
        const addPerson = (who: string) => {
            const isPersona = who === PERSONA_KEY;
            const name = isPersona ? persona : who;
            if (people.some((item) => normalizeName(item.name) === normalizeName(name))) return;
            const current = this.service.current(isPersona ? undefined : who);
            const record = isPersona ? current.find((item) => item.persona) : current.find((item) => !item.persona);
            people.push({
                name,
                ...(isPersona ? { persona: true } : {}),
                outfits: names[isPersona ? PERSONA_KEY : who] ?? [],
                current: record?.wording ?? '',
            });
        };
        for (const item of pending) {
            if (item.who === '?')
                for (const member of this.cast().filter((entry) => entry.present)) addPerson(member.name);
            else addPerson(item.who);
        }
        if (!people.length) return;
        const said = pending.map((item) => {
            const who = item.who === PERSONA_KEY ? persona : item.who === '?' ? '?' : item.who;
            return `${who}: ${item.phrase}`;
        });
        try {
            await this.app.tasks.enqueue({
                kind: CHANGE_TASK,
                dedupeKey: `${CHANGE_TASK}:${chatId}:${source}`,
                payload: {
                    chatId,
                    source,
                    mode,
                    people: people as unknown as Record<string, unknown>[],
                    said,
                    excerpt: lines.join('\n\n').slice(-CHANGE_EXCERPT_CHARS),
                },
                chatId,
                ttlMs: TASK_TTL_MS,
                priority: 3,
            });
            this.app.tasks.kick();
        } catch (error) {
            this.log.warn('wardrobe: the change check could not be queued', error);
        }
    }

    /** Task runner: one small request; never throws (no answer keeps what is known). */
    private async run(payload: Record<string, unknown>): Promise<void> {
        const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
        if (!chatId || chatId !== this.app.host.chatId()) return;
        const source = typeof payload.source === 'number' ? payload.source : -1;
        const mode = payload.mode === 'reply' ? 'reply' : 'player';
        const people = (Array.isArray(payload.people) ? payload.people : []).filter(
            (item): item is ChangePerson =>
                typeof item === 'object' && item !== null && typeof (item as ChangePerson).name === 'string',
        );
        const said = (Array.isArray(payload.said) ? payload.said : []).filter(
            (item): item is string => typeof item === 'string',
        );
        const excerpt = typeof payload.excerpt === 'string' ? payload.excerpt : '';
        let answers: ReturnType<typeof parseChangeAnswer> = [];
        try {
            const response = await this.app.llm.request<unknown>({
                task: CHANGE_TASK,
                messages: changeMessages({ people, said, excerpt }),
                maxTokens: MAX_TOKENS,
                temperature: 0,
                schema: { name: CHANGE_SCHEMA_NAME, schema: CHANGE_SCHEMA },
            });
            if (response.ok) answers = parseChangeAnswer(response.data ?? response.text);
            else this.log.debug('wardrobe change check failed', response.error);
        } catch (error) {
            this.log.debug('wardrobe change check request failed', error);
        }
        if (chatId !== this.app.host.chatId()) return;
        for (const answer of answers) {
            const person = people.find((item) => normalizeName(item.name) === normalizeName(answer.name));
            if (!person) continue;
            const who = person.persona ? PERSONA_KEY : person.name;
            const outfit = answer.outfit ? matchOutfitName(answer.outfit, person.outfits) : null;
            const what: WearNowWhat = outfit ? { outfit } : { wording: answer.wearing ?? '' };
            if (!outfit && !answer.wearing) continue;
            await this.service.wearNow(who, what, 'model', source, { sourceMessage: source, stripIndex: source });
        }
        if (mode === 'player') await this.service.setPending(source, []);
    }
}
