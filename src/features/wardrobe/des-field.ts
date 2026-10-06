// The clothing field in DES's tracker (plan-2 §4 п. 2, decision В6): DES asks the model only for `appearance` and
// `demeanor` per character, so clothes hide in the appearance text. With the user's consent Maestro adds one more
// per-character field — «Одежда» or "Outfit" — to DES's tracker config (live settings and the active tracker preset,
// see DesAdapter.addCharacterField) and saves through DES. It changes another extension's settings, so it asks by
// default (kind wardrobe.desField, never automatic), refuses while DES's Workshop is open (plan §10.8), and the journal
// undo takes the field away. Offered in the Wardrobe tab, by a health check and once per session by a quiet notice.
import { adaptersOf } from '../../adapters';
import type { DesCharacterField } from '../../adapters';
import { fieldAspect } from '../../domain/signals-diff';
import type { App, HealthCheck, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import { DES_FIELD_UNDO_TARGET, WARDROBE_ID, WARDROBE_KINDS } from './settings';

export const DES_FIELD_ID = 'outfit';

/** What DES is asked for in the field (in the language of the other field descriptions). */
export const DES_FIELD_TEXT = {
    ru: {
        name: 'Одежда',
        description:
            'Во что персонаж одет прямо сейчас: каждая вещь, обувь и украшения; если раздет или в одном полотенце — так и написать',
    },
    en: {
        name: 'Outfit',
        description:
            'What the character is wearing right now: every garment, footwear and jewellery; if undressed or only in a towel, say so',
    },
} as const;

export type DesFieldStatus = 'noDes' | 'unavailable' | 'present' | 'missing';

export interface DesFieldPayload {
    m27field: 1;
    id: string;
    name: string;
    description: string;
}

function isFieldPayload(value: unknown): value is DesFieldPayload {
    if (typeof value !== 'object' || value === null) return false;
    const payload = value as Partial<DesFieldPayload>;
    return payload.m27field === 1 && typeof payload.id === 'string' && typeof payload.name === 'string';
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

/** A field of DES that is about clothes (by name or id: «Одежда», "Outfit", "Clothing" …). */
export function isOutfitField(field: Pick<DesCharacterField, 'id' | 'name'>): boolean {
    return fieldAspect(field.name) === 'outfit' || fieldAspect(field.id) === 'outfit';
}

/**
 * Name and description of the new field: «Одежда» only when the other enabled field names are Cyrillic and DES-RU
 * gives Cyrillic names their keys back (its «fieldKeys» fix; without it DES would make an empty key and drop the
 * field), otherwise "Outfit". The description follows the language of the other descriptions.
 */
export function fieldFor(
    fields: readonly DesCharacterField[],
    desRuKeys: boolean,
): { name: string; description: string } {
    const enabled = fields.filter((field) => field.enabled && field.name.trim());
    const cyrillicNames = enabled.length > 0 && enabled.every((field) => CYRILLIC_RE.test(field.name));
    const described = enabled.filter((field) => field.description.trim());
    const cyrillicText = described.length > 0 && described.every((field) => CYRILLIC_RE.test(field.description));
    const name = cyrillicNames && desRuKeys ? DES_FIELD_TEXT.ru.name : DES_FIELD_TEXT.en.name;
    const description =
        cyrillicText || (cyrillicNames && desRuKeys) ? DES_FIELD_TEXT.ru.description : DES_FIELD_TEXT.en.description;
    return { name, description };
}

export class DesFieldOffer {
    private noticed = false;
    private readonly t: App['i18n']['t'];

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.t = app.i18n.t.bind(app.i18n);
    }

    /** Inbox applier, the health check; the journal undo handler stays registered (records outlive the module). */
    install(): Unsubscribe[] {
        this.app.journal.registerUndo(DES_FIELD_UNDO_TARGET, (change) => this.undo(change));
        // Another extension's settings: never by itself, whatever the level says.
        try {
            this.app.autonomy.neverAuto(WARDROBE_KINDS.desField);
        } catch (error) {
            this.log.debug('never-auto is not available', error);
        }
        const apply = async (payload: unknown) => {
            if (!isFieldPayload(payload)) throw new Error('bad wardrobe field card');
            this.write(payload);
        };
        return [
            this.app.inbox.registerApplier(WARDROBE_KINDS.desField, apply),
            this.app.ui.addHealthCheck(this.healthCheck()),
        ];
    }

    private des() {
        try {
            return adaptersOf(this.app).des;
        } catch {
            return undefined;
        }
    }

    /** DES-RU gives Cyrillic field names their keys back (module «Исправления», option fieldKeys; on by default). */
    desRuKeys(): boolean {
        try {
            const desru = adaptersOf(this.app).desru;
            if (!desru.present() || !desru.moduleEnabled('fixes')) return false;
            const modules = desru.settings()?.modules;
            const fixes =
                typeof modules === 'object' && modules !== null ? (modules as Record<string, unknown>).fixes : null;
            return !(
                typeof fixes === 'object' &&
                fixes !== null &&
                (fixes as Record<string, unknown>).fieldKeys === false
            );
        } catch {
            return false;
        }
    }

    status(): DesFieldStatus {
        const des = this.des();
        if (!des || typeof des.characterFields !== 'function' || !des.present()) return 'noDes';
        const fields = des.characterFields();
        if (!fields) return 'unavailable';
        return fields.some((field) => field.enabled && isOutfitField(field)) ? 'present' : 'missing';
    }

    /** The field DES would get now (name and description). */
    proposed(): { name: string; description: string } {
        return fieldFor(this.des()?.characterFields() ?? [], this.desRuKeys());
    }

    /**
     * Asks (by the autonomy level, 'ask' by default) and adds the field. 'added', 'exists', 'workshop' (DES's
     * Workshop is open), 'declined' or 'failed'.
     */
    async add(): Promise<'added' | 'exists' | 'workshop' | 'declined' | 'failed'> {
        const status = this.status();
        if (status === 'present') return 'exists';
        if (status !== 'missing') {
            this.app.ui.notice(this.t('m27.desField.failed'), { level: 'warn' });
            return 'failed';
        }
        const des = this.des();
        if (des?.isWorkshopOpen()) {
            this.app.ui.notice(this.t('m27.desField.workshop'), { level: 'warn' });
            return 'workshop';
        }
        const field = this.proposed();
        const payload: DesFieldPayload = { m27field: 1, id: DES_FIELD_ID, ...field };
        const change: JournalChange = {
            target: DES_FIELD_UNDO_TARGET,
            ref: { fieldId: DES_FIELD_ID, name: field.name },
            before: null,
            after: { name: field.name, description: field.description },
        };
        const proposal: Proposal<DesFieldPayload> = {
            module: WARDROBE_ID,
            kind: WARDROBE_KINDS.desField,
            title: this.t('m27.desField.proposal', { name: field.name }),
            description: this.t('m27.desField.body', { name: field.name }),
            changes: [change],
            payload,
            apply: async (value) => {
                const before = this.write(isFieldPayload(value) ? value : payload);
                // The field as it was (a switched-off «outfit» field switched on) is what undo restores.
                change.before = before;
            },
            stillValid: async () => this.status() === 'missing' && !this.des()?.isWorkshopOpen(),
        };
        let decision: string;
        try {
            decision = await this.app.autonomy.decide(proposal, 'ask');
        } catch (error) {
            this.log.warn('DES field: decision failed', error);
            return 'failed';
        }
        if (decision !== 'applied') return decision === 'rejected' ? 'declined' : 'failed';
        this.app.ui.notice(this.t('m27.desField.added', { name: field.name }));
        return 'added';
    }

    /** Writes the field into DES; the field as it was before (null: added). Throws when it cannot. */
    private write(payload: DesFieldPayload): Record<string, unknown> | null {
        const des = this.des();
        if (!des || des.isWorkshopOpen()) throw new Error(this.t('m27.desField.workshop'));
        const result = des.addCharacterField({ id: payload.id, name: payload.name, description: payload.description });
        if (!result) throw new Error(this.t('m27.desField.failed'));
        return result.before;
    }

    /** Journal undo: the field goes (or gets back its old state); not while the Workshop is open. */
    async undo(change: JournalChange): Promise<boolean> {
        const des = this.des();
        const id = typeof change.ref.fieldId === 'string' ? change.ref.fieldId : '';
        if (!des || !id || des.isWorkshopOpen()) return false;
        const before =
            typeof change.before === 'object' && change.before !== null
                ? (change.before as Record<string, unknown>)
                : null;
        return des.removeCharacterField(id, before);
    }

    healthCheck(): HealthCheck {
        return {
            id: 'm27.desField',
            module: WARDROBE_ID,
            titleKey: 'm27.health.desField',
            run: async () => {
                const status = this.status();
                if (status === 'present') return { status: 'ok', message: this.t('m27.health.desField.ok') };
                if (status !== 'missing') return { status: 'skip' };
                return {
                    status: 'warn',
                    message: this.t('m27.health.desField.missing'),
                    fix: async () => {
                        await this.add();
                    },
                };
            },
        };
    }

    /** Once per session: a quiet notice with «Добавить поле» when DES is there without a clothing field. */
    noticeOnce(): void {
        if (this.noticed || this.status() !== 'missing') return;
        this.noticed = true;
        this.app.ui.notice(this.t('m27.desField.notice'), {
            level: 'info',
            action: { label: this.t('m27.desField.add'), run: () => void this.add() },
        });
    }
}
