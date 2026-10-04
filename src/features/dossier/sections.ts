// Dossier page sections (M7 п. 1–3) from the facts of one entity. Field keys are codes ('mbti', 'slot.hair',
// 'stat.Health', 'detail.appearance'); the view turns them into labels. Texts stay as stored.
import { overridePassport, passportFields, passportTagLine } from '../../domain/dossier-data';
import type { I18n } from '../../shared/contracts';
import type { DossierSection } from './api';
import type { EntityFacts, LoreFact, PassportFact } from './sources';

type Fields = Record<string, string>;

function put(fields: Fields, key: string, value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = String(value);
    else if (typeof value === 'string' && value.trim()) fields[key] = value.trim();
}

function section(
    kind: DossierSection['kind'],
    title: string,
    text: string,
    fields: Fields,
    extra: Partial<DossierSection> = {},
): DossierSection {
    const result: DossierSection = { kind, title, text: text.trim(), ...extra };
    if (Object.keys(fields).length) result.fields = fields;
    return result;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function list(value: unknown): string {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).join(', ') : '';
}

function personaSection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    const persona = facts.persona;
    if (!persona) return null;
    const fields: Fields = {};
    put(fields, 'avatar', persona.avatar);
    put(fields, 'lorebook', persona.lorebook ?? '');
    if (persona.lorebookEntries.length) {
        put(fields, 'lorebookEntries', persona.lorebookEntries.map((entry) => entry.title).join('; '));
    }
    const user = facts.des?.user;
    if (user) {
        put(fields, 'color', user.color);
        put(fields, 'pronouns', user.pronouns);
    }
    put(fields, 'relationship', facts.relation ?? '');
    const extra: Partial<DossierSection> = {
        source: {
            kind: 'persona',
            ref: persona.avatar || persona.name,
            label: persona.name,
            ...(persona.lorebook ? { world: persona.lorebook } : {}),
        },
    };
    const text = persona.description || t('m7.persona.noDescription');
    return section('persona', t('m7.section.persona', { name: persona.name }), text, fields, extra);
}

function placeSections(facts: EntityFacts, t: I18n['t']): DossierSection[] {
    const fact = facts.place;
    if (!fact) return [];
    const { place, parents, children } = fact;
    const fields: Fields = {};
    put(fields, 'aliases', place.aliases.join(', '));
    put(fields, 'forms', place.forms.join(', '));
    put(
        fields,
        'path',
        [...parents]
            .reverse()
            .map((item) => item.name)
            .concat(place.name)
            .join(' → '),
    );
    put(fields, 'children', children.map((item) => item.name).join(', '));
    put(fields, 'firstSeen', place.firstSeen >= 0 ? `#${place.firstSeen}` : '');
    put(fields, 'lastSeen', place.lastSeen >= 0 ? `#${place.lastSeen}` : '');
    put(fields, 'visits', place.visits.length);
    for (const [key, value] of Object.entries(place.state ?? {})) put(fields, `state.${key}`, value);
    put(fields, 'passport', place.passportId ?? '');
    const visits = place.visits.slice(-5).map((visit) => {
        const range = visit.to === null ? `#${visit.from}…` : `#${visit.from}–#${visit.to}`;
        const people = visit.present.length ? visit.present.join(', ') : t('m7.place.nobody');
        const date = visit.storyDate ? ` (${visit.storyDate})` : '';
        const events = visit.events.length ? ` — ${visit.events.join('; ')}` : '';
        return `${range}${date}: ${people}${events}`;
    });
    const text = [place.background ?? '', visits.length ? `${t('m7.place.visits')}\n${visits.join('\n')}` : '']
        .filter((part) => part.trim())
        .join('\n\n');
    return [
        section('place', t('m7.section.place', { name: place.name }), text, fields, {
            source: { kind: 'place', ref: place.id, label: place.name },
        }),
    ];
}

function desSection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    const des = facts.des;
    if (!des || facts.entity.kind === 'persona') return null;
    const fields: Fields = {};
    const character = des.character;
    put(fields, 'emoji', character?.emoji ?? des.rosterEmoji ?? '');
    put(fields, 'color', character?.color ?? '');
    put(fields, 'aliases', des.aliases.join(', '));
    put(fields, 'relationship', character?.relationship ?? facts.relation ?? '');
    put(fields, 'relationshipOverride', des.relationshipOverride ?? '');
    put(fields, 'portraitPrompt', des.portraitPrompt ?? '');
    if (character) {
        for (const stat of character.stats) put(fields, `stat.${stat.name}`, stat.value);
        for (const [key, value] of Object.entries(character.details)) put(fields, `detail.${key}`, value);
        if (character.offScene) put(fields, 'offScene', t('m7.des.offScene'));
    }
    const extra: Partial<DossierSection> = {
        source: {
            kind: 'des.character',
            ref: des.canonical,
            label: des.canonical,
            ...(des.messageIndex !== undefined ? { messageIndex: des.messageIndex } : {}),
        },
    };
    if (des.messageIndex !== undefined) extra.messageIndex = des.messageIndex;
    const text = des.workshopDescription ?? (character ? '' : t('m7.des.noTracker'));
    return section('des', t('m7.section.des', { name: des.canonical }), text, fields, extra);
}

function loreSections(fact: LoreFact, facts: EntityFacts, t: I18n['t']): DossierSection[] {
    const fields: Fields = {};
    put(fields, 'book', fact.world);
    put(fields, 'keys', fact.baseKeys.join(', '));
    if (fact.protected) put(fields, 'protected', t('m7.lore.protected'));
    if (fact.suppressed) put(fields, 'canon', t('m7.lore.suppressed'));
    else if (fact.override) put(fields, 'canon', t('m7.lore.overridden'));
    const title = fact.description
        ? t('m7.section.placeEntry', { title: fact.title })
        : t('m7.section.lore', { title: fact.title });
    const out = [section('lore', title, str(fact.entry.content), fields, { source: fact.source })];
    const override = fact.override;
    if (override && facts.canonBook) {
        const canonFields: Fields = {};
        put(canonFields, 'keys', fact.keys.join(', '));
        put(canonFields, 'status', t(`m7.canon.status.${override.meta.status}`));
        put(canonFields, 'overrides', (override.meta.fields ?? []).join(', '));
        out.push(
            section(
                'canon',
                t('m7.section.override', { title: fact.title }),
                str(override.entry.content),
                canonFields,
                {
                    source: {
                        kind: 'canon.entry',
                        ref: `${facts.canonBook}#${override.uid}`,
                        label: fact.title,
                        world: facts.canonBook,
                        uid: override.uid,
                    },
                },
            ),
        );
    }
    return out;
}

function canonSections(facts: EntityFacts, t: I18n['t']): DossierSection[] {
    const book = facts.canonBook;
    if (!book) return [];
    return facts.canon.map((item) => {
        const title = str(item.entry.comment).trim() || list(item.entry.key) || `#${item.uid}`;
        const fields: Fields = {};
        put(fields, 'keys', list(item.entry.key));
        put(fields, 'status', t(`m7.canon.status.${item.meta.status}`));
        put(fields, 'origin', item.meta.origin);
        put(fields, 'type', item.meta.type ?? '');
        return section('canon', t('m7.section.canonAddition', { title }), str(item.entry.content), fields, {
            source: { kind: 'canon.entry', ref: `${book}#${item.uid}`, label: title, world: book, uid: item.uid },
        });
    });
}

function archiveSections(facts: EntityFacts, t: I18n['t']): DossierSection[] {
    const out: DossierSection[] = [];
    for (const archive of facts.archives) {
        const { summary } = archive;
        const fields: Fields = {};
        put(fields, 'name', summary.name ?? '');
        put(fields, 'book', archive.world);
        if (summary.mbti) {
            const variant = summary.mbti.variant ? ` · ${t(`m7.mbti.${summary.mbti.variant}`)}` : '';
            put(fields, 'mbti', `${summary.mbti.type}${variant}`);
        }
        put(fields, 'tagCount', summary.tags.length);
        out.push(
            section('ck', t('m7.section.archive', { name: archive.source.label }), summary.prose, fields, {
                source: archive.source,
            }),
        );
    }
    const first = facts.archives[0];
    const tags = [...new Set(facts.archives.flatMap((archive) => archive.summary.tags))];
    if (first && tags.length) {
        const groups: Fields = {};
        for (const archive of facts.archives) {
            for (const [category, values] of Object.entries(archive.summary.groups)) {
                const previous = groups[`tag.${category}`];
                groups[`tag.${category}`] = previous && previous !== values ? `${previous}, ${values}` : values;
            }
        }
        out.push(section('tags', t('m7.section.tags'), tags.join(' '), groups, { source: first.source }));
    }
    return out;
}

/** A passport as this chat sees it, with the card values of the fields the chat overrides (base and override). */
function passportSection(fact: PassportFact, t: I18n['t']): DossierSection {
    const { passport, overridden } = overridePassport(fact.passport, fact.chat);
    const fields = passportFields(passport);
    fields.level = t(`m7.passport.level.${fact.level}`);
    if (fact.level === 'card') fields.owner = fact.owner;
    const effective = passportTagLine(passport);
    const lines = [effective];
    if (fact.chat) {
        fields.chatOverride = overridden.length
            ? overridden.map((field) => field.replace(/^slot\./, '')).join(', ')
            : t('m7.passport.chatSame');
        const base = passportFields(fact.passport);
        for (const field of overridden) fields[`base.${field}`] = base[field] ?? '—';
        const card = passportTagLine(fact.passport);
        if (card !== effective) lines.push(t('m7.passport.cardLine', { tags: card || '—' }));
    }
    fields.edit = t('m7.passport.where');
    const title = t('m7.section.passport', { name: passport.name || fact.owner });
    return section('nai', title, lines.join('\n'), fields, { source: fact.source });
}

function formsSection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    if (!facts.forms.length && !facts.formsKey) return null;
    const fields: Fields = {};
    put(fields, 'formsKey', facts.formsKey ?? '');
    if (!facts.desruPresent) put(fields, 'desru', t('m7.forms.noDesru'));
    return section('forms', t('m7.section.forms'), facts.forms.join(', '), fields);
}

function memorySection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    if (!facts.memories.length) return null;
    const lines = facts.memories.map((memory) => `#${memory.index}${memory.longTerm ? ' ★' : ''} ${memory.text}`);
    const newest = facts.memories[facts.memories.length - 1];
    const longTerm = facts.memories.filter((memory) => memory.longTerm).length;
    const fields: Fields = {};
    put(fields, 'longTerm', longTerm);
    put(fields, 'recent', facts.memories.length - longTerm);
    const extra: Partial<DossierSection> = {};
    if (newest) {
        extra.messageIndex = newest.index;
        extra.source = {
            kind: 'qvink.memory',
            ref: String(newest.index),
            label: `#${newest.index}`,
            messageIndex: newest.index,
        };
    }
    return section('qvink', t('m7.section.qvink', { count: facts.memories.length }), lines.join('\n'), fields, extra);
}

function ragSection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    if (!facts.ckPresent || facts.entity.kind === 'place') return null;
    const fields: Fields = {};
    for (const collection of facts.rag) {
        const triggers = collection.keywords.join(', ') || t('m7.rag.noTriggers');
        put(fields, `rag.${collection.id}`, collection.alwaysActive ? `${triggers} (${t('m7.rag.always')})` : triggers);
    }
    const text = facts.ragEnabled ? (facts.rag.length ? t('m7.rag.on') : t('m7.rag.onNone')) : t('m7.rag.off');
    return section('rag', t('m7.section.rag'), text, fields);
}

function sheetSection(facts: EntityFacts, t: I18n['t']): DossierSection | null {
    const sheet = facts.sheet;
    if (!sheet) return null;
    const fields: Fields = {};
    put(fields, 'command', sheet.command ? `!${sheet.command}` : '');
    put(fields, 'message', `#${sheet.index}`);
    return section('sheet', t('m7.section.sheet'), sheet.text, fields, { messageIndex: sheet.index });
}

/** Every section of the dossier, in page order. */
export function buildSections(facts: EntityFacts, t: I18n['t']): DossierSection[] {
    const out: DossierSection[] = [];
    const push = (item: DossierSection | null) => {
        if (item) out.push(item);
    };
    push(personaSection(facts, t));
    out.push(...placeSections(facts, t));
    push(desSection(facts, t));
    const lore = [...facts.lore].sort((a, b) => Number(b.description === true) - Number(a.description === true));
    for (const fact of lore) out.push(...loreSections(fact, facts, t));
    out.push(...canonSections(facts, t));
    out.push(...archiveSections(facts, t));
    for (const passport of facts.passports) out.push(passportSection(passport, t));
    push(formsSection(facts, t));
    push(memorySection(facts, t));
    push(ragSection(facts, t));
    push(sheetSection(facts, t));
    return out;
}
