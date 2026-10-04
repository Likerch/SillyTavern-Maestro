// Structural findings of a dossier (M7 п. 4: rules only) from the facts of one entity: the pure checks of
// domain/dossier-check plus the place-description check, turned into translated findings with their sources and a fix
// request where the fix is clear (keys to add, the place's description entry, a DES alias note).
import { structuralIssues } from '../../domain/dossier-check';
import type { StructuralIssue } from '../../domain/dossier-check';
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
    return findings;
}
