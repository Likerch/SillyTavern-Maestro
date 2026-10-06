// DossierApi (M7): builds a dossier from the facts of an entity, runs the structural checks, the AI comparison and
// «Разнести», remembers which entity is open and tells listeners (the pult tab) when it changes.
import { normName } from '../../domain/dossier-names';
import type { App, Unsubscribe } from '../../shared/contracts';
import type { Entity } from '../world/api';
import type { DossierActions } from './actions';
import type { Dossier, DossierApi, DossierFinding, SpreadEdit } from './api';
import type { DossierCompare } from './compare';
import { structuralFindings } from './findings';
import { buildSections } from './sections';
import type { DossierSources, EntityFacts } from './sources';
import type { DossierStyleUp, StyleUpInfo } from './style-up';

export const DOSSIER_TAB = 'dossier';

const KIND_ORDER: Record<string, number> = { persona: 0, character: 1, place: 2 };

/** Picker order: the persona first, then characters on scene, then the rest by kind and name. */
export function orderEntities(entities: readonly Entity[]): Entity[] {
    const rank = (entity: Entity) =>
        entity.kind === 'persona' ? 0 : entity.kind === 'character' && entity.present ? 1 : 2;
    return [...entities].sort(
        (a, b) =>
            rank(a) - rank(b) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name),
    );
}

/** Entities whose name, aliases or forms contain the query (normalised). */
export function searchEntities(entities: readonly Entity[], query: string): Entity[] {
    const wanted = normName(query);
    if (!wanted) return [...entities];
    return entities.filter((entity) =>
        [entity.name, ...entity.aliases, ...entity.forms].some((name) => normName(name).includes(wanted)),
    );
}

export interface LoadedDossier {
    dossier: Dossier;
    facts: EntityFacts;
    /** «Оформить» (M7 п. 6): missing stores, the card's book and the canon additions it can take. */
    styleUp: StyleUpInfo;
}

const NO_STYLE_UP: StyleUpInfo = { gaps: null, cardBook: null, promotable: [] };

export class DossierService implements DossierApi {
    private current: string | null = null;
    private readonly listeners = new Set<(entityId: string | null) => void>();

    constructor(
        private readonly app: App,
        readonly sources: DossierSources,
        readonly actions: DossierActions,
        readonly compare: DossierCompare,
        readonly styleUp: DossierStyleUp,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private entityOrThrow(entityId: string): Entity {
        const entity = this.sources.entity(entityId);
        if (!entity) throw new Error(this.t('m7.error.unknown', { id: entityId }));
        return entity;
    }

    /** Dossier and the facts it was built from (the view needs both). */
    async load(entityId: string): Promise<LoadedDossier> {
        const entity = this.entityOrThrow(entityId);
        const facts = await this.sources.facts(entity);
        const t = this.t.bind(this);
        const ai = await this.compare.last(entityId);
        const dossier: Dossier = {
            entityId: entity.id,
            name: entity.name,
            kind: entity.kind,
            builtAt: Date.now(),
            sections: buildSections(facts, t),
            findings: [...structuralFindings(facts, this.sources, t), ...(ai?.findings ?? [])],
        };
        let styleUp = NO_STYLE_UP;
        try {
            styleUp = await this.styleUp.info(facts);
        } catch (error) {
            this.app.log.debug('dossier «style up» info failed', error);
        }
        return { dossier, facts, styleUp };
    }

    async build(entityId: string): Promise<Dossier> {
        return (await this.load(entityId)).dossier;
    }

    async check(entityId: string): Promise<DossierFinding[]> {
        const facts = await this.sources.facts(this.entityOrThrow(entityId));
        return structuralFindings(facts, this.sources, this.t.bind(this));
    }

    async compareWithAi(entityId: string): Promise<DossierFinding[]> {
        this.entityOrThrow(entityId);
        // The runner tells listeners itself (compare.onResult → emit), also for results that arrive late.
        const result = await this.compare.request(entityId);
        return result.findings;
    }

    spread(edit: SpreadEdit): Promise<number> {
        return this.actions.spread(edit);
    }

    open(entityId: string): void {
        this.current = entityId || null;
        this.app.ui.openPult(DOSSIER_TAB);
        this.emit(this.current);
    }

    /** The entity the dossier tab shows (null: the picker). */
    currentId(): string | null {
        return this.current;
    }

    select(entityId: string | null): void {
        this.current = entityId;
        this.emit(entityId);
    }

    onChange(listener: (entityId: string | null) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(entityId: string | null): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(entityId);
            } catch (error) {
                this.app.log.error('dossier listener failed', error);
            }
        }
    }

    /** Entities for the picker, ordered, and whether they come from the world model. */
    entities(query = ''): { entities: Entity[]; worldOn: boolean } {
        const { entities, worldOn } = this.sources.entities();
        return { entities: orderEntities(searchEntities(entities, query)), worldOn };
    }

    /** `/maestro-dossier [name]`: resolves the name (world model, else the fallback set) and opens the dossier. */
    openNamed(name: string): Entity | null {
        const trimmed = name.trim();
        if (!trimmed) {
            this.app.ui.openPult(DOSSIER_TAB);
            return null;
        }
        const entity = this.sources.resolve(trimmed) ?? searchEntities(this.sources.entities().entities, trimmed)[0];
        if (!entity) return null;
        this.open(entity.id);
        return entity;
    }
}
