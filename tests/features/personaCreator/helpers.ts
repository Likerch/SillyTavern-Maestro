// A stand for M41 «Персона для персонажа»: the ST mock with one card («Вера», a linked world book and greetings),
// ST's persona settings and a fake personas.js behind host.modules.load, real settings, i18n (Russian) and user jobs,
// a scripted model, book roles and the Lore Studio store, the real adapters with a NAI Studio double, and a window
// opener that puts the dialog body on the page.
import { vi } from 'vitest';
import { createAdapters } from '../../../src/adapters';
import { createBus } from '../../../src/core/bus';
import { createI18n } from '../../../src/core/i18n';
import { createUserJobs } from '../../../src/core/jobs';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { PERSONA_CREATOR_STRINGS } from '../../../src/features/personaCreator';
import { defaultPersonaCreatorSettings } from '../../../src/features/personaCreator/settings';
import type { DialogHandle, DialogOpener } from '../../../src/features/personaCreator/dialog';
import { ST_PERSONAS_PATH } from '../../../src/host/modules';
import type { App, LlmRequest, LlmResult } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

type Dict = Record<string, unknown>;

export const OUTFITS = [
    {
        name: 'Повседневный',
        wording: 'льняная рубаха, кожаный жилет и сапоги',
        tags: 'linen shirt, leather vest, boots',
    },
    { name: 'Домашний', wording: 'широкая туника и мягкие туфли', tags: 'loose tunic, slippers' },
    { name: 'Парадный', wording: 'тёмно-синий камзол с серебряной вышивкой', tags: 'navy doublet, silver embroidery' },
    { name: 'Рабочий', wording: 'стёганая куртка наёмника и наручи', tags: 'gambeson, leather bracers' },
    { name: 'Дорожный', wording: 'плащ с капюшоном и высокие сапоги', tags: 'hooded cloak, travel boots' },
    { name: 'Ночной', wording: 'длинная льняная сорочка', tags: 'nightgown' },
];

export function personaAnswer(extra: Dict = {}): Dict {
    return {
        name: 'Мира',
        title: 'наёмница с севера',
        appearance: 'Высокая худая женщина лет двадцати пяти, светлая коса, серые глаза, шрам на щеке.',
        appearance_en: 'adult woman, tall, slim, blonde braid, grey eyes, scar on cheek',
        background: 'Родилась на севере, служила в вольных отрядах; Веру знает по осаде форта.',
        personality: 'Немногословна и упряма.',
        outfits: OUTFITS,
        ...extra,
    };
}

export interface FakePersonas {
    initPersona: ReturnType<typeof vi.fn>;
    getUserAvatars: ReturnType<typeof vi.fn>;
    setUserAvatar: ReturnType<typeof vi.fn>;
    updatePersonaConnectionsAvatarList: ReturnType<typeof vi.fn>;
    user_avatar: string;
}

export interface OpenedDialog {
    handle: DialogHandle;
    /** The user closes the window (× or Escape). */
    userClose(): void;
}

export interface Env {
    app: App;
    mock: StMock;
    host: TestHost;
    ui: FakeUi;
    settings: Settings;
    power: Dict;
    personas: FakePersonas;
    /** Requests the model got and the answers it gives, in order (the last one repeats). */
    llm: { requests: LlmRequest[]; answers: LlmResult[]; available: boolean; wait: Promise<void> | null };
    books: Record<string, { entries: Record<string, Dict> }>;
    roles: Record<string, string>;
    dialogs: OpenedDialog[];
    opener: DialogOpener;
}

export interface EnvOptions {
    /** The Lore Studio store is there (the chat's bindings are read through it). Default true. */
    store?: boolean;
    locale?: 'ru' | 'en';
}

export function entry(uid: number, comment: string, content: string, extra: Dict = {}): Dict {
    return { uid, comment, key: [comment], content, disable: false, constant: false, ...extra };
}

export function createEnv(options: EnvOptions = {}): Env {
    const mock = installStMock();
    const power: Dict = {
        personas: { 'kai.png': 'Кай', 'old.png': 'Странник' },
        persona_descriptions: {
            'kai.png': { description: 'Рыжий бард с лютней.', title: '' },
            'old.png': { description: '', title: '', connections: [{ type: 'character', id: 'vera.png' }] },
        },
        persona_description: 'Рыжий бард с лютней.',
    };
    const books: Env['books'] = {
        Гавань: {
            entries: {
                1: entry(1, 'Таверна «Якорь»', 'Шумное место у причала.'),
                2: entry(2, 'История гавани', 'Город основан триста лет назад вольными капитанами.'),
                3: entry(3, 'Прибытие', 'Каждый новичок в гавани обязан явиться к капитану стражи.'),
                4: entry(4, 'Отключённая', 'Тайна.', { disable: true }),
            },
        },
        'Maestro · Вера': { entries: { 1: entry(1, 'Канон', 'Служебная запись Maestro.') } },
        'BunnyMo Pack': { entries: { 1: entry(1, 'SPECIES', '<BunnyMoTags>ELF</BunnyMoTags>') } },
        Чатовая: { entries: { 1: entry(1, 'Буря', 'В этом чате над гаванью бушует буря.') } },
    };
    const roles: Record<string, string> = { 'BunnyMo Pack': 'bunnymo.pack' };
    Object.assign(mock.context, {
        name1: 'Кай',
        characterId: 0,
        characters: [
            {
                name: 'Вера',
                avatar: 'vera.png',
                description: 'Вера — капитан портовой стражи. {{user}} — её старый должник.',
                personality: 'Сдержанная, наблюдательная.',
                scenario: 'Осень в Серебряной Гавани.',
                first_mes: 'Вера поднимает взгляд на {{user}}: «Опять ты».',
                data: {
                    extensions: { world: 'Гавань' },
                    alternate_greetings: ['Ночью {{user}} стучит в ворота форта.'],
                    creator_notes: 'Играть медленно.',
                },
            },
            { name: 'Мартин', avatar: 'martin.png', description: 'Алхимик.', data: { extensions: {} } },
        ],
        powerUserSettings: power,
        getWorldInfoNames: () => Object.keys(books),
        loadWorldInfo: async (name: string) => structuredClone(books[name] ?? null),
        getThumbnailUrl: (type: string, file: string) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`,
        // As ST's script.js: a multipart upload leaves Content-Type to the browser.
        getRequestHeaders: ({ omitContentType = false }: { omitContentType?: boolean } = {}) =>
            omitContentType
                ? { 'X-CSRF-Token': 'token' }
                : { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' },
    });
    mock.chat.push({
        name: 'Вера',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: 'Ночью Кай стучит в ворота форта.',
        swipes: ['Вера поднимает взгляд на Кай: «Опять ты».', 'Ночью Кай стучит в ворота форта.'],
        swipe_id: 1,
    });
    const personas: FakePersonas = {
        initPersona: vi.fn(async (avatarId: string, name: string, description: string, title: string) => {
            (power.personas as Dict)[avatarId] = name;
            (power.persona_descriptions as Dict)[avatarId] = { description, title, position: 0, depth: 2, role: 0 };
        }),
        getUserAvatars: vi.fn(async () => []),
        setUserAvatar: vi.fn(async (avatarId: string) => {
            personas.user_avatar = avatarId;
        }),
        updatePersonaConnectionsAvatarList: vi.fn(),
        user_avatar: 'kai.png',
    };
    const host = createTestHost(mock);
    host.modules.load = async (path: string) => (path === ST_PERSONAS_PATH ? (personas as unknown as Dict) : {});
    const log = createTestLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('personaCreator', defaultPersonaCreatorSettings, true);
    const i18n = createI18n(() => options.locale ?? 'ru');
    i18n.register(CORE_STRINGS);
    i18n.register(PERSONA_CREATOR_STRINGS);
    const ui = createFakeUi();
    const llm: Env['llm'] = {
        requests: [],
        answers: [{ ok: true, data: personaAnswer() }],
        available: true,
        wait: null,
    };
    const apis: Dict = {
        bookRoles: { roleOf: (book: string) => (roles[book] ? { book, role: roles[book] } : undefined) },
    };
    if (options.store ?? true) {
        apis.loreStore = {
            bindings: async () => ({
                global: ['Глобальная'],
                character: { primary: 'Гавань', extra: ['Maestro · Вера', 'BunnyMo Pack'] },
                chat: 'Чатовая',
                persona: null,
            }),
            load: async (name: string) => structuredClone(books[name] ?? null),
        };
    }
    const jobs = createUserJobs({ log, notice: (text, notice) => ui.notice(text, notice) });
    const app = {
        host,
        log,
        i18n,
        settings,
        jobs,
        llm: {
            available: () => llm.available,
            request: async (request: LlmRequest) => {
                llm.requests.push(request);
                if (llm.wait) await llm.wait;
                if (request.signal?.aborted) return { ok: false, error: 'aborted' };
                const index = Math.min(llm.requests.length - 1, llm.answers.length - 1);
                return llm.answers[index] ?? { ok: false, error: 'no answer' };
            },
        },
        bus: createBus(log),
        ui,
        modules: {
            api: (key: string) => apis[key],
            expose: () => {},
            list: () => [],
            enable: async () => {},
            disable: async () => {},
        },
    } as unknown as App;
    (app as unknown as { adapters: unknown }).adapters = createAdapters(host, log);
    const dialogs: OpenedDialog[] = [];
    const opener: DialogOpener = (onClosed) => {
        const body = document.createElement('div');
        body.className = 'maestro-m41-dialog';
        document.body.append(body);
        let open = true;
        const handle: DialogHandle = {
            body,
            get open() {
                return open;
            },
            close() {
                open = false;
                body.remove();
            },
        };
        dialogs.push({
            handle,
            userClose() {
                if (!open) return;
                open = false;
                body.remove();
                onClosed();
            },
        });
        return handle;
    };
    return { app, mock, host, ui, settings, power, personas, llm, books, roles, dialogs, opener };
}

/** Lets promise chains (the model, the uploads, the steps) settle. */
export async function flush(rounds = 6): Promise<void> {
    for (let round = 0; round < rounds; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The editor of ST's character panel, as much of it as M41 touches. */
export function installEditor(avatar = 'vera.png', mode = 'editcharacter'): HTMLElement {
    document.body.innerHTML = '';
    const form = document.createElement('form');
    form.id = 'form_create';
    form.setAttribute('actiontype', mode);
    form.innerHTML = `
        <div id="avatar_controls">
            <div class="form_create_bottom_buttons_block buttons_block">
                <div id="favorite_button" class="menu_button"></div>
                <div id="char_connections_button" class="menu_button"></div>
                <div id="export_button" class="menu_button"></div>
            </div>
            <label><select id="char-management-dropdown"><option value="default">More...</option></select></label>
        </div>
        <input id="avatar_url_pole" type="hidden" value="${avatar}">`;
    document.body.append(form);
    return form;
}
