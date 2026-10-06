// Structural findings of a dossier (M7 п. 4: rules only) from the facts of one entity: the pure checks of
// domain/dossier-check plus the place-description check, turned into translated findings with their sources and a fix
// request where the fix is clear (keys to add, the place's description entry, a DES alias note).
import { structuralIssues } from '../../domain/dossier-check';
import type { StructuralIssue } from '../../domain/dossier-check';
import { kindFamily } from '../../domain/world-names';
import type { I18n } from '../../shared/contracts';
import type { EntitySource } from '../world/api';
import type { FixRequest } from './actions';
import type { DossierFinding } from './api';
import type { DossierSources, EntityFacts } from './sources';

function desSource(facts: EntityFacts): EntitySource | undefined {
    const des = facts.des;
    if (!des) return undefined;
    const source: EntitySource = { kind: 'des.character', ref: des.canonical, label: des.canonical };
    if (des.messageIndex !== undefined) source.messageIndex = des.messageIndex;
    return source;
}

function sourcesOf(issue: StructuralIssue, facts: EntityFacts): EntitySource[] {
    const des = desSource(facts);
    const entry = issue.entry
        ? facts.lore.find((fact) => fact.world === issue.entry?.world && fact.uid === issue.entry.uid)?.source
        : undefined;
    const list: (EntitySource | undefined)[] = [];
    switch (issue.kind) {
        case 'missingEntry':
        case 'missingPassport':
        case 'missingArchive':
            list.push(des);
            break;
        case 'aliasNotKey':
            list.push(entry, des);
            break;
        case 'nameMismatch':
            list.push(
                ...facts.archives.map((archive) => archive.source),
                ...facts.passports.map((passport) => passport.source),
                des,
            );
            break;
        case 'formsMissing':
            list.push(entry);
            break;
    }
    return list.filter((source): source is EntitySource => !!source);
}

function fixOf(issue: StructuralIssue, facts: EntityFacts, t: I18n['t']): DossierFinding['fix'] | undefined {
    if (issue.addKeys?.length && issue.entry) {
        const request: FixRequest = {
            op: 'addKeys',
            world: issue.entry.world,
            uid: issue.entry.uid,
            keys: issue.addKeys,
        };
        const label =
            issue.kind === 'formsMissing' ? t('m7.fix.forms') : t('m7.fix.alias', { alias: issue.addKeys.join(', ') });
        return { label, payload: request };
    }
    if (issue.kind === 'nameMismatch' && facts.des?.canonical && facts.desPresent) {
        const odd = String(issue.params.names ?? '')
            .split(', ')
            .find((name) => name.trim());
        if (odd) {
            const request: FixRequest = { op: 'desAlias', canonical: facts.des.canonical, alias: odd };
            return { label: t('m7.fix.desAlias', { alias: odd }), payload: request };
        }
    }
    return undefined;
}

/** What a namesake's source brings, in story words. */
function brings(source: EntitySource, t: I18n['t']): string {
    switch (source.kind) {
        case 'ck.archive':
            return t('m7.brings.archive', { book: source.world ?? source.label });
        case 'lore.entry':
            return t('m7.brings.entry', { entry: source.label, book: source.world ?? '' });
        case 'nai.passport':
            return t('m7.brings.passport', { card: (source.avatar ?? '').replace(/\.[^/.]+$/, '') });
        case 'des.workshop':
            return t('m7.brings.workshop');
        default:
            return source.label;
    }
}

function listOf(list: readonly EntitySource[], t: I18n['t']): string {
    return [...new Set(list.map((source) => brings(source, t)))].join('; ');
}

function keysOf(list: readonly EntitySource[]): string[] {
    return [...new Set(list.map((source) => source.key ?? `${source.kind}:${source.ref}`))];
}

/** 'being' | 'place' | 'other': the noun of the identity question, as the world model asks it («тот же персонаж»). */
function nounOf(kind: string): 'being' | 'place' | 'other' {
    const family = kindFamily(kind);
    return family === 'being' ? 'being' : family === 'place' ? 'place' : 'other';
}

/**
 * Plan-2 §9 in the dossier: a namesake of another story waiting for an answer («Тот же» / «Другой», the world
 * model's question), one declared another one («Тот же» changes it back), and data from outside the chat used for a
 * character of this chat that is not the card itself («Другой»).
 */
export function identityFindings(facts: EntityFacts, t: I18n['t']): DossierFinding[] {
    const identity = facts.identity;
    const entity = facts.entity;
    if (!identity) return [];
    const findings: DossierFinding[] = [];
    const name = entity.name;
    const noun = nounOf(entity.kind);
    const same = t(`m7.fix.sameAs.${noun}`);
    const other = t(`m7.fix.apart.${noun}`);
    const decide = (op: 'sameAs' | 'apart', list: readonly EntitySource[]): FixRequest => ({
        op,
        entityId: entity.id,
        keys: keysOf(list),
    });
    if (identity.pending.length) {
        const list = listOf(identity.pending, t);
        findings.push(
            {
                kind: 'otherStory',
                severity: 'warn',
                text: t(`m7.finding.otherPending.${noun}`, { name, list }),
                sources: identity.pending,
                fix: { label: same, payload: decide('sameAs', identity.pending) },
            },
            {
                kind: 'otherStory',
                severity: 'info',
                text: t(`m7.finding.otherPendingApart.${noun}`, { name }),
                sources: [],
                fix: { label: other, payload: decide('apart', identity.pending) },
            },
        );
    }
    if (identity.apart.length) {
        findings.push({
            kind: 'otherStory',
            severity: 'info',
            text: t(`m7.finding.otherApart.${noun}`, { name, list: listOf(identity.apart, t) }),
            sources: identity.apart,
            fix: { label: same, payload: decide('sameAs', identity.apart) },
        });
    }
    const anchor = entity.sources.some((source) => source.kind === 'card' || source.kind === 'persona');
    const shared = identity.shared.filter((source) => source.kind !== 'des.workshop');
    if (!anchor && shared.length) {
        findings.push({
            kind: 'sharedStory',
            severity: 'info',
            text: t('m7.finding.shared', { name, list: listOf(shared, t) }),
            sources: shared,
            fix: { label: other, payload: decide('apart', identity.shared) },
        });
    }
    return findings;
}

export function structuralFindings(facts: EntityFacts, sources: DossierSources, t: I18n['t']): DossierFinding[] {
    const { entity } = facts;
    const des = facts.des;
    const issues = structuralIssues({
        kind: entity.kind,
        name: entity.name,
        known: [...entity.aliases, ...facts.forms],
        inDes: !!des && (des.inRoster || !!des.character || des.aliases.length > 0),
        desCanonical: des?.canonical ?? null,
        desAliases: des?.aliases ?? [],
        entries: facts.lore
            .filter((fact) => !fact.description)
            .map((fact) => ({
                world: fact.world,
                uid: fact.uid,
                title: fact.title,
                keys: fact.keys,
                protected: fact.protected,
            })),
        canonItems: facts.canon.length,
        naiPresent: facts.naiPresent,
        passportNames: facts.passports.map((fact) => fact.passport.name || fact.owner),
        ckPresent: facts.ckPresent,
        archiveNames: facts.archives.map((archive) => archive.summary.name),
        formsOf: facts.desruPresent ? (name) => sources.formsOf(name) : null,
        formsKeyOf: facts.desruPresent ? (name) => sources.formsKeyOf(name) : null,
    });
    const findings: DossierFinding[] = issues.map((issue) => {
        const finding: DossierFinding = {
            kind: issue.kind,
            severity: issue.severity,
            text: t(`m7.finding.${issue.kind}`, issue.params),
            sources: sourcesOf(issue, facts),
        };
        const fix = fixOf(issue, facts, t);
        if (fix) finding.fix = fix;
        else if (issue.entry === undefined && issue.kind === 'aliasNotKey') finding.text += ` ${t('m7.finding.p13')}`;
        return finding;
    });
    const place = facts.place?.place;
    if (place && !place.entry) {
        const request: FixRequest = { op: 'placeEntry', placeId: place.id };
        findings.unshift({
            kind: 'missingEntry',
            severity: 'info',
            text: t('m7.finding.placeEntry', { name: place.name }),
            sources: [{ kind: 'place', ref: place.id, label: place.name }],
            fix: { label: t('m7.fix.placeEntry'), payload: request },
        });
    }
    findings.unshift(...identityFindings(facts, t));
    return findings;
}
