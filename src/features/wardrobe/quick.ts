// Quick ways to change clothes (M27 «Переодеть сейчас»):
// - «Переодеться» at the Maestro button at the message box (Ui.addComposerAction): the characters of the scene and «Я»
//   → their outfits (the one on marked), the own clothes, «Описать…» (words), «Открыть гардероб»;
// - the line under a message after a change made by itself (Ui.addMessageStripProvider): «Офелия → Домашнее» with
//   «Отменить» (the journal record) and «Другое…»;
// - `/maestro-wear <кто> <наряд|описание>`.
import { matchOutfitName, splitWho } from '../../domain/wardrobe-change';
import type { WhoCandidate } from '../../domain/wardrobe-change';
import { isOwnClothes } from '../../domain/wardrobe-names';
import { normalizeName } from '../../domain/world-names';
import type {
    App,
    ComposerGroup,
    ComposerItem,
    MessageStripProvider,
    SlashCommandSpec,
    StripItem,
} from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';
import type { WearNowWhat } from './api';
import type { PassportTarget, WardrobeService } from './service';
import { PERSONA_KEY } from './settings';
import type { WardrobeSettings } from './settings';

export const WARDROBE_GROUP = 'wardrobe';
/** The story first: before BunnyMo's sheets. */
const GROUP_ORDER = 10;
const HINT_CHARS = 60;
const WARDROBE_TAB = 'wardrobe';

function cut(text: string, max: number): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Person {
    /** 'persona' or the character's name. */
    who: string;
    name: string;
    target: PassportTarget | null;
}

/** The characters of the scene (with a look or a record) and the user's character last. */
function people(app: App, service: WardrobeService): Person[] {
    const out: Person[] = [];
    const add = (name: string, target: PassportTarget | null) => {
        const key = normalizeName(name);
        if (!key || out.some((item) => normalizeName(item.name) === key)) return;
        out.push({ who: name, name, target });
    };
    const ctx = app.host.ctx();
    const own = normalizeName(ctx.name1 ?? '');
    const scene = service.presentCharacters();
    if (scene.present) for (const target of scene.targets) add(target.name, target);
    else if (ctx.name2) add(ctx.name2, service.resolveCharacter(ctx.name2));
    for (const record of service.current()) {
        if (record.persona || !record.present || normalizeName(record.name) === own) continue;
        add(record.name, record.passportId ? service.resolveCharacter(record.name) : null);
    }
    const persona = String(ctx.name1 ?? '').trim() || 'User';
    out.push({ who: PERSONA_KEY, name: persona, target: service.personaTarget() });
    return out.filter((item) => item.who === PERSONA_KEY || normalizeName(item.name) !== own);
}

/** «Офелия → Домашнее»: a notice of a change made by hand. */
function announce(app: App, done: { who: string; outfit: string | null; wording: string } | null): void {
    if (!done) return;
    const t = app.i18n.t.bind(app.i18n);
    const label = done.outfit === null ? done.wording : done.outfit || t('m27.now.own');
    app.ui.notice(t('m27.quick.done', { name: done.who, outfit: cut(label, HINT_CHARS) }), { importance: 'urgent' });
}

async function describe(app: App, service: WardrobeService, person: { who: string; name: string }): Promise<void> {
    const t = app.i18n.t.bind(app.i18n);
    const prompt = app.ui.prompt;
    if (typeof prompt !== 'function') {
        app.ui.openPult(WARDROBE_TAB);
        return;
    }
    const text = await prompt.call(app.ui, t('m27.quick.describe.title', { name: person.name }), {
        hint: t('m27.quick.describe.hint'),
    });
    if (!text) return;
    announce(app, await service.wearNow(person.who, { wording: text }, 'user'));
}

/** The outfits of one person, the own clothes, «Описать…», «Открыть гардероб». */
function outfitItems(app: App, service: WardrobeService, person: Person): ComposerItem[] {
    const t = app.i18n.t.bind(app.i18n);
    const wear = (what: WearNowWhat) => async () => announce(app, await service.wearNow(person.who, what, 'user'));
    const items: ComposerItem[] = [];
    const passport = person.target
        ? (service.resolvePassport(person.target.passportId) ?? person.target.passport)
        : null;
    if (passport) {
        const active = passport.activeOutfit;
        passport.outfits
            .filter((outfit) => outfit.name && !isOwnClothes(outfit.name))
            .forEach((outfit, index) =>
                items.push({
                    id: `outfit-${index}`,
                    label: outfit.name,
                    icon: 'fa-shirt',
                    ...(same(active, outfit.name) ? { active: true } : {}),
                    run: wear({ outfit: outfit.name }),
                }),
            );
        items.push({
            id: 'own',
            label: t('m27.now.own'),
            icon: 'fa-user',
            ...(!active ? { active: true } : {}),
            run: wear({ outfit: '' }),
        });
    }
    items.push({
        id: 'describe',
        label: t('m27.quick.describe'),
        hint: t('m27.quick.describe.short'),
        icon: 'fa-pen',
        run: () => describe(app, service, person),
    });
    items.push({
        id: 'open',
        label: t('m27.quick.open'),
        icon: 'fa-book-open',
        run: () => app.ui.openPult(WARDROBE_TAB),
    });
    return items;
}

/** «Переодеться» at the Maestro button at the message box. */
export function wardrobeComposerGroup(
    app: App,
    service: WardrobeService,
    settings: () => WardrobeSettings,
): ComposerGroup {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: WARDROBE_GROUP,
        order: GROUP_ORDER,
        label: () => t('m27.quick.group'),
        visible: () => settings().composer && !!app.host.chatId() && !app.host.isGroupChat(),
        items: () => {
            const current = service.current();
            return people(app, service).map((person, index) => {
                const record =
                    person.who === PERSONA_KEY
                        ? current.find((item) => item.persona)
                        : current.find(
                              (item) => !item.persona && normalizeName(item.name) === normalizeName(person.name),
                          );
                const item: ComposerItem = {
                    id: person.who === PERSONA_KEY ? 'me' : `who-${index}`,
                    label: person.who === PERSONA_KEY ? t('m27.quick.me', { name: person.name }) : person.name,
                    icon: person.who === PERSONA_KEY ? 'fa-user' : 'fa-user-tag',
                    submenu: () => outfitItems(app, service, person),
                };
                if (record?.wording) item.hint = cut(record.wording, HINT_CHARS);
                return item;
            });
        },
        onChange: (listener) => service.onChange(listener),
    };
}

/** The line under a message after a change made by itself: «Офелия → Домашнее · Отменить · Другое…». */
export function wardrobeStripProvider(app: App, service: WardrobeService): MessageStripProvider {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'wardrobe',
        order: 45,
        items: (index) =>
            service
                .stripEntries(index)
                .filter((entry) => !entry.undone)
                .map((entry): StripItem => ({
                    id: entry.op,
                    kind: 'change',
                    icon: 'fa-shirt',
                    text: t('m27.strip.text', { name: entry.who, outfit: cut(entry.label, HINT_CHARS) }),
                    actions: [
                        {
                            label: t('m27.strip.undo'),
                            run: async () => {
                                if (!(await app.journal.undo(entry.journalId))) throw new Error(t('m27.undo.failed'));
                            },
                        },
                        {
                            label: t('m27.strip.other'),
                            run: () => describe(app, service, { who: entry.target, name: entry.who }),
                        },
                    ],
                })),
        onChange: (listener) => service.onChange(() => listener()),
    };
}

/** `/maestro-wear <кто> <наряд|описание>`: «я» or a character, then an outfit by name or the clothes in words. */
export function wearSlashCommand(app: App, service: WardrobeService): SlashCommandSpec {
    const t = app.i18n.t.bind(app.i18n);
    return {
        name: 'maestro-wear',
        helpKey: 'm27.slash.help',
        args: [{ name: 'value', descriptionKey: 'm27.slash.value', optional: true }],
        callback: async (_args, value) => {
            const text = String(value ?? '').trim();
            if (!text) {
                app.ui.openPult(WARDROBE_TAB);
                return '';
            }
            const ctx = app.host.ctx();
            const persona = String(ctx.name1 ?? '').trim();
            const candidates: WhoCandidate[] = [
                { who: PERSONA_KEY, names: ['я', 'меня', 'me', 'i', 'persona', persona].filter(Boolean) },
            ];
            const names = service.outfitNames();
            const known = (name: string): string[] => {
                try {
                    const entity = app.modules.api<WorldModelApi>('world')?.resolve(name, 'character');
                    return entity ? [entity.name, ...entity.aliases, ...entity.forms] : [];
                } catch {
                    return [];
                }
            };
            for (const person of people(app, service)) {
                if (person.who === PERSONA_KEY) continue;
                const aliases = person.target ? [person.target.passport.name, ...person.target.passport.aliases] : [];
                candidates.push({ who: person.name, names: [person.name, ...aliases, ...known(person.name)] });
            }
            for (const name of Object.keys(names)) {
                if (name !== PERSONA_KEY && !candidates.some((item) => same(item.who, name))) {
                    candidates.push({ who: name, names: [name] });
                }
            }
            const parsed = splitWho(text, candidates);
            if (!parsed) return t('m27.slash.who');
            if (!parsed.rest) return t('m27.slash.what');
            const outfits = names[parsed.who] ?? [];
            const own =
                isOwnClothes(parsed.rest) ||
                ['своё', 'свое', 'own', 'своя одежда'].includes(normalizeName(parsed.rest));
            const outfit = own ? '' : matchOutfitName(parsed.rest, outfits);
            const what: WearNowWhat = outfit === null ? { wording: parsed.rest } : { outfit };
            const done = await service.wearNow(parsed.who, what, 'user');
            if (!done) return t('m27.slash.nothing');
            const label = done.outfit === null ? done.wording : done.outfit || t('m27.now.own');
            return t('m27.quick.done', { name: done.who, outfit: label });
        },
    };
}
