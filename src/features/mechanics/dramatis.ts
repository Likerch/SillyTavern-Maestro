// M25 and Dramatis (release 1.17, docs/integration-dramatis.md): while Dramatis's personality engine keeps attitudes
// and social standing itself (DRAMATIS_API.replacesSocialMechanics), the ready-made «relationships» and «social»
// templates leave the template list — two engines counting sympathy would fight. Mechanics made from them earlier stay
// as they are (the user decides) and get a note in the constructor.
import { dramatisOf } from '../../adapters';
import type { App } from '../../shared/contracts';

/** Templates Dramatis replaces. */
export const ENGINE_TEMPLATES: ReadonlySet<string> = new Set(['relationships', 'social']);

/** Dramatis is present and replaces the social mechanics now. */
export function engineReplacesSocial(app: App): boolean {
    try {
        const dramatis = dramatisOf(app);
        return !!dramatis && dramatis.present() && dramatis.replacesSocialMechanics();
    } catch {
        return false;
    }
}

/** The templates the picker offers (the social ones left out while Dramatis replaces them). */
export function offeredTemplates<T extends { id: string }>(app: App, templates: readonly T[]): T[] {
    if (!engineReplacesSocial(app)) return [...templates];
    return templates.filter((item) => !ENGINE_TEMPLATES.has(item.id));
}

/** A mechanic made from a template Dramatis replaces now (the constructor notes it). */
export function replacedByEngine(app: App, def: { template?: string }): boolean {
    return typeof def.template === 'string' && ENGINE_TEMPLATES.has(def.template) && engineReplacesSocial(app);
}
