// Who is in the scene for the next generation (plan M15, P14): the characters of the DES tracker of the committed
// reply (src/domain/voices-cards.ts sceneTracker), present, not hidden in DES, without the persona, each person once,
// named as the world model knows them. The voice cards (M15), Maestro's public API `present()` (1.17, for Dramatis) and
// the Medicine Check quiet rule (M22) read the same cast.
// Pure: no DOM, no SillyTavern.
import type { DesCharacter } from './des-tracker';
import { presentCharacters } from './voices-cards';
import type { SceneTracker } from './voices-cards';
import { normalizeName } from './world-names';

/** The part of a world entity the cast reads (WorldModelApi's Entity fits). */
export interface CastEntity {
    id: string;
    name: string;
    kind: string;
}

export interface CastMember<E extends CastEntity> {
    /** Canonical name (world model) or the name as DES writes it. */
    name: string;
    entity?: E;
    character: DesCharacter;
}

export interface CastOptions<E extends CastEntity> {
    /** The persona's canonical name (world model) and the persona as ST names it (`name1`): both are left out. */
    persona: string;
    ownName: string;
    /** Names hidden from DES's «Present Characters» in this chat. */
    hidden: readonly string[];
    /** The world model's entity of a name (character first), undefined when unknown. */
    resolve(name: string): E | undefined;
}

/** The present characters of a tracker, resolved, without the persona, one member per person. */
export function sceneCast<E extends CastEntity>(
    tracker: SceneTracker | null,
    options: CastOptions<E>,
): CastMember<E>[] {
    const self = normalizeName(options.persona);
    const own = normalizeName(options.ownName);
    const members: CastMember<E>[] = [];
    const seen = new Set<string>();
    for (const character of presentCharacters(tracker?.snapshot.characters ?? [], options.hidden)) {
        const plain = normalizeName(character.name);
        if (plain === self || plain === own) continue;
        const entity = options.resolve(character.name);
        if (entity?.kind === 'persona') continue;
        const name = entity?.name ?? character.name;
        const id = entity?.id ?? `name:${plain}`;
        if (normalizeName(name) === self || seen.has(id)) continue;
        seen.add(id);
        members.push(entity ? { name, entity, character } : { name, character });
    }
    return members;
}
