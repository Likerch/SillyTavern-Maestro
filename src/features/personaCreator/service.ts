// M41 «Персона для персонажа», the work: the model's request (task 'persona.create', interactive — the daily cap of
// background spending does not stop it; one retry when the answer breaks the rules) and the creation — the persona in
// ST, its default avatar, the link to the card, NAI Studio's passport with our outfits, the picture, and switching to it
// when the user asked. Every step reports its state; a step that cannot run says why and the rest go on.
import { adaptersOf } from '../../adapters';
import type { NaiPassport } from '../../adapters';
import { readPassport } from '../../adapters/nai';
import {
    PERSONA_MAX_TOKENS,
    PERSONA_TASK,
    buildPersonaMessages,
    parsePersonaAnswer,
    passportDescription,
    personaAvatarId,
    personaSchema,
    retryNote,
    withPersonaOutfits,
} from '../../domain/persona-create';
import type { LoreDigest, PersonaDraft, PersonaOutfit, StoryLanguage } from '../../domain/persona-create';
import { pluralForm } from '../../domain/plural';
import type { App, Logger } from '../../shared/contracts';
import { PersonaCollector } from './collect';
import type { CardRef } from './collect';
import type { PersonaCreatorSettings } from './settings';
import type { PersonaHost } from './st-personas';

/** Whether NAI Studio can make the passport and the picture of a new persona. */
export type NaiSupport = 'ok' | 'absent' | 'old';

export interface CreateOptions {
    passport: boolean;
    picture: boolean;
    link: boolean;
    makeCurrent: boolean;
}

export type GenerateOutcome =
    | { ok: true; draft: PersonaDraft; language: StoryLanguage; lore: LoreDigest; books: string[] }
    | { ok: false; error: string; cancelled?: boolean };

export interface GenerateCall {
    comment: string;
    /** Names of earlier attempts («Ещё раз»). */
    avoid?: readonly string[];
    signal?: AbortSignal;
    /** Progress line (already translated). */
    phase?(label: string): void;
}

/** What is created: the edited review. */
export interface CreatePlan {
    card: CardRef;
    name: string;
    title: string;
    /** The persona description as the user left it. */
    description: string;
    outfits: PersonaOutfit[];
    /** The answer the review came from (the English look for the passport). */
    draft: PersonaDraft;
    language: StoryLanguage;
    options: CreateOptions;
}

export type StepId = 'persona' | 'avatar' | 'link' | 'passport' | 'picture' | 'current';
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface StepState {
    id: StepId;
    status: StepStatus;
    /** Why it was skipped or failed, or what was done (translated). */
    detail?: string;
}

export interface CreateOutcome {
    /** The persona exists. */
    ok: boolean;
    avatarId: string;
    name: string;
    steps: StepState[];
    /** It is the current persona now. */
    current: boolean;
    /** NAI Studio drew its avatar. */
    picture: boolean;
    /** Outfits in the saved passport (0 without one). */
    outfits: number;
    /** Why nothing was created. */
    error?: string;
}

export interface CreateCall {
    signal?: AbortSignal;
    /** Called after every step change with a copy of the steps. */
    onStep?(steps: StepState[]): void;
    /** The time for the avatar file name (tests). */
    now?: number;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class PersonaCreator {
    private readonly collector: PersonaCollector;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        readonly personas: PersonaHost,
        private readonly settings: () => PersonaCreatorSettings,
    ) {
        this.collector = new PersonaCollector(app, log, personas);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private plural(base: string, count: number): string {
        return this.t(`${base}.${pluralForm(count, this.app.i18n.locale())}`, { count });
    }

    /** NAI Studio's part: present with persona passports and avatars by key, present but older, or absent. */
    naiSupport(): NaiSupport {
        try {
            const nai = adaptersOf(this.app).nai;
            if (!nai.present() || !nai.api()) return 'absent';
            if (!nai.canUsePersonaKeys() || typeof nai.api()?.generatePassport !== 'function') return 'old';
            return 'ok';
        } catch {
            return 'absent';
        }
    }

    /** A background profile can run the task. */
    available(): boolean {
        try {
            return this.app.llm.available(PERSONA_TASK);
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------------- the model */

    async generate(card: CardRef, call: GenerateCall): Promise<GenerateOutcome> {
        if (!this.available()) return { ok: false, error: this.t('m41.error.noProfile') };
        call.phase?.(this.t('m41.phase.reading'));
        const collected = await this.collector.collect(card, this.settings().loreChars);
        if (!collected) return { ok: false, error: this.t('m41.error.noCard') };
        if (call.signal?.aborted) return { ok: false, error: this.t('m41.detail.cancelled'), cancelled: true };
        let fix: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            call.phase?.(this.t(attempt ? 'm41.phase.retry' : 'm41.phase.thinking'));
            const messages = buildPersonaMessages({
                ...collected.request,
                comment: call.comment,
                avoid: call.avoid ?? [],
                ...(fix ? { fix } : {}),
            });
            let result;
            try {
                result = await this.app.llm.request({
                    task: PERSONA_TASK,
                    messages,
                    maxTokens: PERSONA_MAX_TOKENS,
                    temperature: call.avoid?.length ? 0.95 : 0.8,
                    schema: personaSchema(),
                    signal: call.signal,
                    interactive: true,
                });
            } catch (error) {
                if (call.signal?.aborted) return { ok: false, error: this.t('m41.detail.cancelled'), cancelled: true };
                return { ok: false, error: this.t('m41.error.request', { reason: errorText(error) }) };
            }
            if (call.signal?.aborted) return { ok: false, error: this.t('m41.detail.cancelled'), cancelled: true };
            if (!result.ok) {
                if (result.refusal) return { ok: false, error: this.t('m41.error.refusal') };
                return { ok: false, error: this.t('m41.error.request', { reason: result.error ?? '?' }) };
            }
            const parsed = parsePersonaAnswer(result.data ?? result.text ?? '');
            if (parsed.ok) {
                return {
                    ok: true,
                    draft: parsed.draft,
                    language: collected.language,
                    lore: collected.lore,
                    books: collected.books,
                };
            }
            this.log.debug(`persona answer rejected (${parsed.reason})`);
            if (attempt === 1) {
                const error =
                    parsed.reason === 'outfits'
                        ? this.t('m41.error.answer.outfits', { count: parsed.outfits ?? 0 })
                        : this.t(`m41.error.answer.${parsed.reason}`);
                return { ok: false, error };
            }
            fix = retryNote(parsed);
        }
        return { ok: false, error: this.t('m41.error.answer.shape') };
    }

    /* ---------------------------------------------------------------- creation */

    async create(plan: CreatePlan, call: CreateCall = {}): Promise<CreateOutcome> {
        const name = plan.name.trim();
        const avatarId = personaAvatarId(name, call.now ?? Date.now());
        const ids: StepId[] = ['persona', 'avatar', 'link', 'passport', 'picture', 'current'];
        const steps: StepState[] = ids.map((id) => ({ id, status: 'pending' }));
        const outcome: CreateOutcome = { ok: false, avatarId, name, steps, current: false, picture: false, outfits: 0 };
        const set = (id: StepId, status: StepStatus, detail?: string) => {
            const step = steps.find((item) => item.id === id);
            if (!step) return;
            step.status = status;
            if (detail === undefined) delete step.detail;
            else step.detail = detail;
            try {
                call.onStep?.(steps.map((item) => ({ ...item })));
            } catch (error) {
                this.log.debug('persona step listener failed', error);
            }
        };
        const stopped = () => call.signal?.aborted === true;
        const skipRest = (from: StepId[]) => {
            for (const id of from) {
                if (steps.find((step) => step.id === id)?.status === 'pending') {
                    set(id, 'skipped', this.t('m41.detail.cancelled'));
                }
            }
        };

        // 1. The persona itself.
        set('persona', 'running');
        try {
            await this.personas.create(avatarId, name, plan.description.trim(), plan.title.trim());
        } catch (error) {
            const reason = errorText(error);
            this.log.warn('initPersona failed', error);
            set('persona', 'failed', reason);
            for (const id of ids.slice(1)) set(id, 'skipped');
            outcome.error = this.t('m41.error.create', { reason });
            return outcome;
        }
        outcome.ok = true;
        set('persona', 'done');

        // 2. ST's default avatar under its file name: the persona shows in the list.
        set('avatar', 'running');
        const uploaded = await this.personas.uploadDefaultAvatar(avatarId);
        set('avatar', uploaded ? 'done' : 'failed', uploaded ? undefined : this.t('m41.detail.avatarFailed'));

        // 3. The link to the card (the card's other personas stay linked).
        if (plan.options.link) {
            set('link', 'running');
            const linked = this.personas.connect(avatarId, plan.card.avatar);
            set('link', linked ? 'done' : 'failed', linked ? undefined : this.t('m41.detail.unknown'));
        } else set('link', 'skipped', this.t('m41.detail.notChosen'));
        await this.personas.refresh(avatarId);

        // 4. NAI Studio's passport with our outfits.
        let passport: NaiPassport | null = null;
        if (stopped()) skipRest(['passport', 'picture', 'current']);
        else if (!plan.options.passport) set('passport', 'skipped', this.t('m41.detail.notChosen'));
        else passport = await this.passport(plan, avatarId, set);

        // 5. The picture, drawn from the passport.
        if (stopped()) skipRest(['picture', 'current']);
        else if (!plan.options.picture) set('picture', 'skipped', this.t('m41.detail.notChosen'));
        else if (!passport) {
            const support = this.naiSupport();
            set(
                'picture',
                'skipped',
                support === 'ok'
                    ? this.t('m41.detail.noPassport')
                    : this.t(support === 'old' ? 'm41.detail.naiOld' : 'm41.detail.naiAbsent'),
            );
        } else {
            set('picture', 'running');
            const drawn = await adaptersOf(this.app).nai.generatePersonaAvatar({
                personaKey: avatarId,
                passport,
                ...(call.signal ? { signal: call.signal } : {}),
            });
            if (drawn.ok) {
                outcome.picture = true;
                set('picture', 'done');
                await this.personas.refresh(avatarId);
            } else if (stopped()) set('picture', 'skipped', this.t('m41.detail.cancelled'));
            else set('picture', 'failed', this.t('m41.detail.pictureFailed', { reason: drawn.error ?? '?' }));
        }
        outcome.outfits = passport?.outfits.length ?? 0;

        // 6. The current persona, only when asked.
        if (stopped()) skipRest(['current']);
        else if (!plan.options.makeCurrent) set('current', 'skipped', this.t('m41.detail.notChosen'));
        else {
            set('current', 'running');
            outcome.current = await this.personas.select(avatarId);
            set(
                'current',
                outcome.current ? 'done' : 'failed',
                outcome.current ? undefined : this.t('m41.detail.unknown'),
            );
        }
        return outcome;
    }

    /** Makes the current persona of this chat; true when done. */
    async makeCurrent(avatarId: string): Promise<boolean> {
        return this.personas.select(avatarId);
    }

    private async passport(
        plan: CreatePlan,
        avatarId: string,
        set: (id: StepId, status: StepStatus, detail?: string) => void,
    ): Promise<NaiPassport | null> {
        const support = this.naiSupport();
        if (support !== 'ok') {
            set('passport', 'skipped', this.t(support === 'old' ? 'm41.detail.naiOld' : 'm41.detail.naiAbsent'));
            return null;
        }
        set('passport', 'running');
        const nai = adaptersOf(this.app).nai;
        const failures: string[] = [];
        const off = nai.on('requestFailed', (detail) => {
            if (detail.request === 'passport' && detail.message) failures.push(detail.message);
        });
        const draft: PersonaDraft = { ...plan.draft, name: plan.name.trim(), outfits: plan.outfits };
        let generated: NaiPassport | null;
        try {
            generated = await nai.generatePassport({
                name: plan.name.trim(),
                kind: 'character',
                persona: true,
                description: passportDescription(draft),
                language: plan.language,
            });
        } finally {
            off();
        }
        if (!generated) {
            set(
                'passport',
                'failed',
                this.t('m41.detail.passportFailed', { reason: failures[0] ?? this.t('m41.detail.unknown') }),
            );
            return null;
        }
        const passport = readPassport(withPersonaOutfits(generated, plan.outfits));
        if (!passport || !(await nai.savePersonaPassport(avatarId, passport))) {
            set('passport', 'failed', this.t('m41.detail.passportNotSaved'));
            return null;
        }
        set('passport', 'done', this.plural('m41.detail.outfits', passport.outfits.length));
        return passport;
    }
}
