// Dossiers (M7 п.1–5): one page per entity with everything the stack knows, structural checks by rules, an AI
// comparison of appearance/descriptions on demand, and «Разнести» (an edit proposed to every store through the
// autonomy levels). Exposed as app.modules.api<DossierApi>('dossier').
import type { Unsubscribe } from '../../shared/contracts';
import type { EntitySource } from '../world/api';

export type DossierSectionKind =
    'lore' | 'canon' | 'ck' | 'tags' | 'nai' | 'des' | 'forms' | 'qvink' | 'rag' | 'sheet' | 'place' | 'persona';

export interface DossierSection {
    kind: DossierSectionKind;
    title: string;
    source?: EntitySource;
    /** Plain text (prose, tags) as stored; the view renders it read-only with an «Открыть» link. */
    text: string;
    /** Structured bits (MBTI, relationship, outfit, stats, …). */
    fields?: Record<string, string>;
    /** Chat message the section comes from (Qvink memories, a BunnyMo sheet, the DES tracker): «Открыть» jumps there. */
    messageIndex?: number;
}

export type DossierFindingKind =
    | 'missingEntry'
    | 'missingPassport'
    | 'missingArchive'
    | 'aliasNotKey'
    | 'nameMismatch'
    | 'formsMissing'
    | 'appearanceMismatch'
    | 'descriptionMismatch';

export interface DossierFinding {
    kind: DossierFindingKind;
    severity: 'info' | 'warn';
    text: string;
    /** Stores involved. */
    sources: EntitySource[];
    /** A fix the dossier can propose (through autonomy, kind 'dossier.fix'). */
    fix?: { label: string; payload: Record<string, unknown> };
}

export interface Dossier {
    entityId: string;
    name: string;
    kind: string;
    builtAt: number;
    sections: DossierSection[];
    findings: DossierFinding[];
}

/** One edit spread to several stores; each target becomes a proposal (Inbox or auto by level). */
export interface SpreadEdit {
    entityId: string;
    field: 'name' | 'alias' | 'appearance' | 'description' | 'relationship' | 'custom';
    value: string;
    targets: EntitySource[];
}

export interface DossierApi {
    build(entityId: string): Promise<Dossier>;
    /** Structural checks only (rules, no AI). */
    check(entityId: string): Promise<DossierFinding[]>;
    /** Cheap-model comparison of appearance and descriptions across stores (background task, on demand). */
    compareWithAi(entityId: string): Promise<DossierFinding[]>;
    spread(edit: SpreadEdit): Promise<number>;
    open(entityId: string): void;
    onChange(listener: (entityId: string | null) => void): Unsubscribe;
}
