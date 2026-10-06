// Data layer of the Preset Studio (M34, stage 5): PresetStore over ST's Prompt Manager and the Chat Completion preset
// cache (contract in store-api.ts; research/parity-preset.md §1–4, §7, §9, §10.2 hard places 1, 2, 7, 8, §10.4 в).
// - Reading: the working copy is getChatCompletionPreset(oai_settings) (preset keys), the saved body is ST's cache
//   `openai_settings[openai_setting_names[name]]`; the draft is the difference between the working copy and what
//   applying the saved body (with the user's layer, when the layer module has one) would give back (P-073).
// - Prompt edits go through Prompt Manager's methods on the same `oai_settings` (P-004, P-190), typed strictly
//   (P-132), then saveServiceSettings + render(false); they never write the preset file.
// - Body keys are written by preset key through ST's own controls and `input` handlers (P-061, P-085).
// - Files are written only with an explicit body ({...cached, ...working}, P-079) to /api/presets/save through the
//   fetch gate (tab guard, M4); ST's cache and the <option> list are updated by hand (P-075); PresetManager's
//   savePreset without a body, updatePreset, renamePreset and the event's savePreset are never called (P-077,
//   P-078); ST's events are sent the way ST sends them (P-198); M4 acknowledges the change afterwards.
// - Rename and delete take care of what refers to the name: regex permissions (P-154, P-156), connection
//   profiles (P-082, asked first), Maestro versions (P-181/P-182).
// - Every write is a Maestro version (M34 п.4) and a journal record with undo (targets preset-prompt,
//   preset-keys, preset-file). Saves made outside Maestro become versions by 'st'; unsaved edits of a preset that is
//   switched away become a 'draft' version (snapped in OAI_PRESET_CHANGED_BEFORE, P-073).
// Exposed by the studio shell as app.modules.api<PresetStore>(PRESET_STORE_KEY).
import { tPlural } from '../../core/labels';
import {
    bodyHash,
    diffDraft,
    looseEqual,
    mergeBodies,
    promptsEqual,
    withSecretsOf,
} from '../../domain/preset-store-diff';
import {
    PROMPT_KEYS,
    SENSITIVE_PRESET_KEYS,
    bodyFromSettings,
    collidingName,
    hasControl,
    jsonClean,
    normalizeKeyValue,
    pickKeys,
    presentSensitiveKeys,
    sameNameLoosely,
    withoutKeys,
} from '../../domain/preset-store-keys';
import {
    allowRegex,
    isRegexAllowed,
    moveRegexPermission,
    profileRef,
    profilesUsing,
    repointProfiles,
} from '../../domain/preset-store-links';
import {
    applyPromptPatch,
    insertIndex,
    isProtectedPrompt,
    normalizePrompt,
    readOrder,
    reorderEntries,
} from '../../domain/preset-store-prompts';
import type { OrderEntry } from '../../domain/preset-store-prompts';
import { valueHash } from '../../domain/settings-diff';
import type { App, I18nParts, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';
import type { PresetLayerApi } from './layer-api';
import { paramLabel } from './param-labels';
import { CONNECTION_REFRESH_SELECTORS, PresetStoreError, PromptModel, StPreset } from './st-preset';
import type {
    PresetBody,
    PresetDraftState,
    PresetOrderItem,
    PresetPrompt,
    PresetStore,
    PresetVersion,
} from './store-api';
import { PresetVersions } from './versions';
import type { VersionInput } from './versions';

export { PresetStoreError } from './st-preset';
export type { PresetStoreErrorCode } from './st-preset';

type Dict = Record<string, unknown>;
type Translate = (key: string, params?: Record<string, string | number>) => string;

export const PRESET_STORE_KEY = 'presetStore';
/** Key under which the layer module exposes PresetLayerApi (layer-api.ts). */
export const PRESET_LAYER_KEY = 'presetLayer';
export const PROMPT_TARGET = 'preset-prompt';
export const KEYS_TARGET = 'preset-keys';
export const FILE_TARGET = 'preset-file';
/** Journal kinds of the store's writes (their labels `kind.<kind>` live in targets.ts). */
export const STORE_JOURNAL_KINDS = [
    'presetStudio.prompt',
    'presetStudio.promptAdd',
    'presetStudio.promptRemove',
    'presetStudio.detach',
    'presetStudio.toggle',
    'presetStudio.reorder',
    'presetStudio.keys',
    'presetStudio.save',
    'presetStudio.saveAs',
    'presetStudio.import',
    'presetStudio.restore',
    'presetStudio.rename',
    'presetStudio.remove',
] as const;
type StoreJournalKind = (typeof STORE_JOURNAL_KINDS)[number];
const MODULE_ID = 'M34';
/** Names listed in a journal summary before «и ещё N». */
const SUMMARY_NAMES = 3;
const SIGNATURE_DELAY_MS = 250;
const DETECT_DELAY_MS = 1500;
const ACK_DELAY_MS = 1500;

export type StoreChangeReason = 'prompts' | 'keys' | 'preset' | 'list';

export interface ExportOptions {
    /** Keep proxy/endpoint fields (P-096). Default: stripped. */
    withSensitive?: boolean;
    /** Keep connection data (source, models, …; ST's export asks, default "no", P-070). Default: `withSensitive`. */
    withConnection?: boolean;
}

type FileOp = 'save' | 'saveAs' | 'import' | 'restore' | 'undo';

interface WriteMeta {
    op: FileOp;
    by: string;
    summary: string;
    journal?: boolean;
    /** The preset that was current before the operation (undo of a created file goes back to it). */
    previous?: string;
}

interface Signature {
    preset: string;
    prompts: string;
    keys: string;
}

export const PRESET_STORE_STRINGS: I18nParts = {
    en: {
        'm34.store.sensitive.title': 'The preset contains proxy or custom endpoint settings',
        'm34.store.sensitive.remove': 'Remove them',
        'm34.store.sensitive.keep': 'Import as is',
        'm34.store.sensitive.cancel': 'Cancel import',
        'm34.store.import.overwriteTitle': 'Overwrite the preset?',
        'm34.store.import.overwriteBody': 'A preset named «{name}» already exists. Overwrite it with the file?',
        'm34.store.rename.profilesTitle': 'Connection profiles use this preset',
        'm34.store.rename.profilesBody':
            'These connection profiles select the preset «{from}»: {profiles}. Point them to «{to}»?',
        'm34.store.rename.profilesKept': 'Connection profiles {profiles} still point to the old name «{from}».',
        'm34.store.rename.oldFileKept':
            'The old file of the preset «{name}» could not be deleted: it stays on the server.',
        'm34.store.remove.failed': 'The server did not delete the preset «{name}».',
        'm34.store.remove.profiles':
            'Connection profiles {profiles} still select the deleted preset «{name}». Pick another preset for them in the Connection Manager.',
        'm34.store.remove.regex':
            'Together with the preset «{name}», SillyTavern took back the permission to run its Regex scripts.',
        'm34.store.version.save': 'Saved in the studio',
        'm34.store.version.saveAs': 'Saved as a copy of «{from}»',
        'm34.store.version.import': 'Imported from a file',
        'm34.store.version.restored': 'Rolled back to the version of {date}',
        'm34.store.version.outside': 'Saved outside Maestro',
        'm34.store.version.first': 'First snapshot',
        'm34.store.version.draft': 'Unsaved edits before the preset was switched',
        'm34.store.version.undo': 'Undone from the journal',
        'm34.store.journal.prompt': 'Preset block «{name}» changed',
        'm34.store.journal.promptAdd': 'Preset block «{name}» added',
        'm34.store.journal.promptRemove': 'Preset block «{name}» deleted',
        'm34.store.journal.detach': 'Block «{name}» taken out of the preset order (the block itself stays)',
        'm34.store.journal.enable.one': 'Preset block {names} switched on',
        'm34.store.journal.enable.few': 'Preset blocks switched on: {names}',
        'm34.store.journal.enable.many': 'Preset blocks switched on: {names}',
        'm34.store.journal.disable.one': 'Preset block {names} switched off',
        'm34.store.journal.disable.few': 'Preset blocks switched off: {names}',
        'm34.store.journal.disable.many': 'Preset blocks switched off: {names}',
        'm34.store.journal.more': '{names} and {count} more',
        'm34.store.journal.reorder': 'Preset block order changed',
        'm34.store.journal.keys': 'Preset parameters changed: {keys}',
        'm34.store.journal.keysOther': 'Service parameters of the preset changed: {count}',
        'm34.store.journal.save': 'Preset «{name}» saved',
        'm34.store.journal.saveAs': 'Preset saved as «{name}»',
        'm34.store.journal.import': 'Preset «{name}» imported',
        'm34.store.journal.restore': 'Preset «{name}» rolled back to an earlier version',
        'm34.store.journal.rename': 'Preset «{from}» renamed to «{to}»',
        'm34.store.journal.remove': 'Preset «{name}» deleted',
    },
    ru: {
        'm34.store.sensitive.title': 'В пресете есть настройки прокси или своего адреса',
        'm34.store.sensitive.remove': 'Убрать их',
        'm34.store.sensitive.keep': 'Импортировать как есть',
        'm34.store.sensitive.cancel': 'Отменить импорт',
        'm34.store.import.overwriteTitle': 'Перезаписать пресет?',
        'm34.store.import.overwriteBody': 'Пресет «{name}» уже есть. Заменить его содержимым файла?',
        'm34.store.rename.profilesTitle': 'Профили подключения ссылаются на этот пресет',
        'm34.store.rename.profilesBody':
            'Эти профили подключения выбирают пресет «{from}»: {profiles}. Переключить их на «{to}»?',
        'm34.store.rename.profilesKept': 'Профили подключения {profiles} всё ещё указывают на старое имя «{from}».',
        'm34.store.rename.oldFileKept': 'Старый файл пресета «{name}» удалить не удалось — он остался на сервере.',
        'm34.store.remove.failed': 'Сервер не удалил пресет «{name}».',
        'm34.store.remove.profiles':
            'Профили подключения {profiles} всё ещё выбирают удалённый пресет «{name}». Выбери для них другой в менеджере подключений.',
        'm34.store.remove.regex': 'Вместе с пресетом «{name}» SillyTavern снял разрешение запускать его скрипты Regex.',
        'm34.store.version.save': 'Сохранено в студии',
        'm34.store.version.saveAs': 'Сохранено как копия «{from}»',
        'm34.store.version.import': 'Импортировано из файла',
        'm34.store.version.restored': 'Откат к версии от {date}',
        'm34.store.version.outside': 'Сохранено вне Maestro',
        'm34.store.version.first': 'Первый снимок',
        'm34.store.version.draft': 'Несохранённые правки перед сменой пресета',
        'm34.store.version.undo': 'Отменено из журнала',
        'm34.store.journal.prompt': 'Изменён блок пресета «{name}»',
        'm34.store.journal.promptAdd': 'Добавлен блок пресета «{name}»',
        'm34.store.journal.promptRemove': 'Удалён блок пресета «{name}»',
        'm34.store.journal.detach': 'Блок «{name}» убран из порядка пресета (сам блок остался)',
        'm34.store.journal.enable.one': 'Включён блок пресета {names}',
        'm34.store.journal.enable.few': 'Включены блоки пресета: {names}',
        'm34.store.journal.enable.many': 'Включены блоки пресета: {names}',
        'm34.store.journal.disable.one': 'Выключен блок пресета {names}',
        'm34.store.journal.disable.few': 'Выключены блоки пресета: {names}',
        'm34.store.journal.disable.many': 'Выключены блоки пресета: {names}',
        'm34.store.journal.more': '{names} и ещё {count}',
        'm34.store.journal.reorder': 'Изменён порядок блоков пресета',
        'm34.store.journal.keys': 'Изменены параметры пресета: {keys}',
        'm34.store.journal.keysOther': 'Изменены служебные параметры пресета: {count}',
        'm34.store.journal.save': 'Сохранён пресет «{name}»',
        'm34.store.journal.saveAs': 'Пресет сохранён как «{name}»',
        'm34.store.journal.import': 'Импортирован пресет «{name}»',
        'm34.store.journal.restore': 'Пресет «{name}» возвращён к прежней версии',
        'm34.store.journal.rename': 'Пресет «{from}» переименован в «{to}»',
        'm34.store.journal.remove': 'Удалён пресет «{name}»',
    },
};

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function versionRef(version: { id: string; hash: string } | null | undefined): Dict | null {
    return version ? { version: version.id, hash: version.hash } : null;
}

export class PresetStoreService implements PresetStore {
    readonly st: StPreset;
    readonly history: PresetVersions;
    private readonly t: Translate;
    private readonly listeners = new Set<(reason: StoreChangeReason) => void>();
    private chain: Promise<unknown> = Promise.resolve();
    private readonly background = new Set<Promise<unknown>>();
    /** Store file operations in progress (outside-save detection and ST-event echoes are skipped meanwhile). */
    private ownOps = 0;
    /** Preset switches of the store's own that must not snap a draft (save as, delete, restore of a clean copy). */
    private quietSwitch = 0;
    private signature: Signature | null = null;
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Sensitive values of presets deleted in this session, by version id (versions never store them). */
    private readonly removedSecrets = new Map<string, Dict>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.t = (key, params) => app.i18n.t(key, params);
        this.st = new StPreset(app, log, this.t);
        this.history = new PresetVersions(app.files, log.scope('versions'));
    }

    /* ---------------------------------------------------------------- lifecycle */

    /** Registers strings, undo handlers and ST listeners; the shell owns the returned disposers. */
    install(): Unsubscribe[] {
        this.disposed = false;
        this.app.i18n.register(PRESET_STORE_STRINGS);
        this.app.journal.registerUndo(PROMPT_TARGET, (change) => this.undoPrompt(change));
        this.app.journal.registerUndo(KEYS_TARGET, (change) => this.undoKeys(change));
        this.app.journal.registerUndo(FILE_TARGET, (change) => this.undoFile(change));
        const on = (event: string, handler: (...args: unknown[]) => unknown) => this.app.host.events.on(event, handler);
        const disposers: Unsubscribe[] = [
            on('SETTINGS_UPDATED', () => this.later('signature', SIGNATURE_DELAY_MS, () => this.onSettingsUpdated())),
            on('OAI_PRESET_CHANGED_BEFORE', (data) => this.onPresetBefore(data)),
            on('OAI_PRESET_CHANGED_AFTER', () => this.onPresetAfter()),
            on('PRESET_RENAMED', (data) => this.onPresetRenamed(data)),
            on('PRESET_DELETED', (data) => this.onPresetDeleted(data)),
            () => this.dispose(),
        ];
        this.track(
            this.st.ensure().then(() => {
                if (this.disposed) return;
                this.signature = this.computeSignature();
                this.scheduleDetect();
            }),
        );
        return disposers;
    }

    /** ST modules loaded (sync readers answer from what is loaded; writers wait for it themselves). */
    ready(): Promise<void> {
        return this.st.ensure();
    }

    /** Resolves when queued writes and background version writes have settled (tests, «Подготовить к отключению»). */
    async whenIdle(): Promise<void> {
        for (let round = 0; round < 10; round++) {
            await this.chain.catch(() => undefined);
            const pending = [...this.background];
            if (!pending.length) return;
            await Promise.allSettled(pending);
        }
    }

    private dispose(): void {
        this.disposed = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.listeners.clear();
    }

    /* ---------------------------------------------------------------- reading */

    names(): string[] {
        const cache = this.st.cache();
        const options = this.st.optionNames();
        if (options) return cache ? options.filter((name) => Object.hasOwn(cache.names, name)) : options;
        if (!cache) return [];
        return Object.entries(cache.names)
            .sort((a, b) => a[1] - b[1])
            .map(([name]) => name);
    }

    current(): string {
        return str(this.st.oai()?.preset_settings_openai);
    }

    working(): PresetBody {
        const oai = this.st.oai();
        if (!oai) return {};
        return jsonClean(this.st.presetOf(oai) ?? bodyFromSettings(oai, this.st.keyTable())) as PresetBody;
    }

    saved(name: string): PresetBody | null {
        const body = this.savedRaw(name);
        return body ? (jsonClean(body) as PresetBody) : null;
    }

    draft(): PresetDraftState {
        const name = this.current();
        const saved = this.savedRaw(name);
        if (!saved) return { dirty: false, changedPrompts: [], changedKeys: [] };
        return diffDraft(this.working(), this.expectedWorking(name, saved), Object.keys(this.st.keyTable()));
    }

    prompts(): { item: PresetOrderItem; prompt: PresetPrompt | null }[] {
        const oai = this.st.oai();
        if (!oai) return [];
        const model = this.model(oai);
        return readOrder(model.order()).map((item) => {
            const prompt = model.get(item.identifier);
            return { item, prompt: prompt ? (jsonClean(prompt) as PresetPrompt) : null };
        });
    }

    onChange(listener: (reason: StoreChangeReason) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- prompts */

    async updatePrompt(identifier: string, patch: Partial<PresetPrompt>): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const model = this.model();
            const prompt = model.get(identifier);
            if (!prompt) throw new PresetStoreError('not-found', `no prompt ${identifier}`);
            const before = jsonClean(prompt);
            replaceContents(prompt, applyPromptPatch(prompt, patch as Dict));
            const after = jsonClean(prompt);
            if (valueHash(before) === valueHash(after)) return;
            model.quickEdit(identifier);
            this.persist(model);
            await this.record('presetStudio.prompt', this.t('m34.store.journal.prompt', { name: promptName(after) }), [
                this.promptChange(identifier, before, after),
            ]);
            this.changed('prompts');
        });
    }

    async addPrompt(
        prompt: Omit<PresetPrompt, 'identifier'> & { identifier?: string },
        after?: string,
    ): Promise<string> {
        await this.st.ensure();
        return this.serial(async () => {
            const model = this.model();
            const source = prompt as Dict;
            const wanted = str(source.identifier).trim();
            const identifier = wanted || this.newIdentifier();
            if (model.get(identifier)) throw new PresetStoreError('exists', `prompt ${identifier} exists`);
            const clean = normalizePrompt({ ...source, identifier });
            delete clean.identifier;
            delete clean.enabled;
            // PM's «insert prompt» puts a block first and switched off (P-028); a block placed explicitly is on.
            const enabled = after === undefined ? source.enabled === true : source.enabled !== false;
            const orderBefore = readOrder(model.order());
            model.add(clean, identifier);
            model.insert(identifier, enabled, insertIndex(orderBefore, after));
            const added = jsonClean(model.get(identifier) ?? { identifier, ...clean });
            this.persist(model);
            await this.record(
                'presetStudio.promptAdd',
                this.t('m34.store.journal.promptAdd', { name: promptName(added) }),
                [this.promptChange(identifier, null, added), this.orderChange(orderBefore, readOrder(model.order()))],
            );
            this.changed('prompts');
            return identifier;
        });
    }

    async removePrompt(identifier: string): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const model = this.model();
            const prompt = model.get(identifier);
            if (!prompt) throw new PresetStoreError('not-found', `no prompt ${identifier}`);
            if (isProtectedPrompt(prompt)) throw new PresetStoreError('protected', `${identifier} is a built-in block`);
            const before = jsonClean(prompt);
            const orderBefore = readOrder(model.order());
            model.detach(identifier);
            const index = model.remove(identifier);
            this.persist(model);
            await this.record(
                'presetStudio.promptRemove',
                this.t('m34.store.journal.promptRemove', { name: promptName(before) }),
                [
                    this.promptChange(identifier, before, null, index),
                    this.orderChange(orderBefore, readOrder(model.order())),
                ],
            );
            this.changed('prompts');
        });
    }

    /** PM's «Remove» (broken chain, P-026): the block leaves the active order and stays in the preset. */
    async detachPrompt(identifier: string): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const model = this.model();
            const prompt = model.get(identifier);
            if (!prompt) throw new PresetStoreError('not-found', `no prompt ${identifier}`);
            if (isProtectedPrompt(prompt)) throw new PresetStoreError('protected', `${identifier} is a built-in block`);
            const before = readOrder(model.order());
            if (model.detach(identifier) < 0) return;
            this.persist(model);
            await this.record('presetStudio.detach', this.t('m34.store.journal.detach', { name: promptName(prompt) }), [
                this.orderChange(before, readOrder(model.order())),
            ]);
            this.changed('prompts');
        });
    }

    async setEnabled(identifiers: string[], enabled: boolean): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const model = this.model();
            const before = readOrder(model.order());
            const names: string[] = [];
            for (const identifier of new Set(identifiers)) {
                const entry = model.entry(identifier);
                if (entry) {
                    if (entry.enabled === enabled) continue;
                    entry.enabled = enabled;
                } else {
                    // A block outside the order is inserted first, like PM's «insert prompt» (P-028).
                    if (!model.get(identifier)) continue;
                    model.insert(identifier, enabled, 0);
                }
                model.forgetCount(identifier);
                names.push(promptName(model.get(identifier) ?? { identifier }));
            }
            if (!names.length) return;
            this.persist(model);
            const summary = tPlural(
                this.app.i18n,
                enabled ? 'm34.store.journal.enable' : 'm34.store.journal.disable',
                names.length,
                { names: this.nameList(names.map((name) => `«${name}»`)) },
            );
            await this.record('presetStudio.toggle', summary, [this.orderChange(before, readOrder(model.order()))]);
            this.changed('prompts');
        });
    }

    async reorder(identifiers: string[]): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const model = this.model();
            const before = readOrder(model.order());
            const next = reorderEntries(before, identifiers);
            if (next.map((entry) => entry.identifier).join('\n') === before.map((entry) => entry.identifier).join('\n'))
                return;
            model.setOrder(next);
            this.persist(model);
            await this.record('presetStudio.reorder', this.t('m34.store.journal.reorder'), [
                this.orderChange(before, readOrder(model.order())),
            ]);
            this.changed('prompts');
        });
    }

    /* ---------------------------------------------------------------- body keys */

    async setKeys(patch: Record<string, unknown>): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const changes = this.applyKeys(patch);
            if (!changes) return;
            await this.record('presetStudio.keys', this.keysSummary(changes.keys), [
                {
                    target: KEYS_TARGET,
                    ref: { preset: this.current(), keys: changes.keys, absent: changes.absent },
                    before: changes.before,
                    after: changes.after,
                },
            ]);
            this.changed('keys');
        });
    }

    /**
     * Writes body keys into the working copy the way ST applies a preset (OAI:5046-5075): the control gets the
     * value and its `input` handler runs, then `oai_settings[settingKey]` is set; connection keys refresh the source
     * and provider lists; settings are saved. Returns what changed (null = nothing). `undefined` removes a key.
     */
    private applyKeys(
        patch: Record<string, unknown>,
        allowRemove = false,
    ): { keys: string[]; absent: string[]; before: Dict; after: Dict } | null {
        const oai = this.requireOai();
        const table = this.st.keyTable();
        for (const key of Object.keys(patch)) {
            if ((PROMPT_KEYS as readonly string[]).includes(key)) {
                throw new PresetStoreError('invalid', `${key} is edited through the prompt methods`);
            }
            if (!table[key]) throw new PresetStoreError('invalid', `unknown preset key ${key}`);
        }
        const keys: string[] = [];
        const absent: string[] = [];
        const before: Dict = {};
        const after: Dict = {};
        let connection = false;
        for (const [key, value] of Object.entries(patch)) {
            const spec = table[key];
            if (!spec || (value === undefined && !allowRemove)) continue;
            const setting = spec[1];
            const current = oai[setting];
            const next = key === 'extensions' ? jsonClean(value ?? {}) : normalizeKeyValue(value, current, spec[2]);
            if (
                valueHash(current ?? null) === valueHash(next ?? null) &&
                (current === undefined) === (next === undefined)
            )
                continue;
            if (next !== undefined && hasControl(spec)) this.st.setControl(spec[0], next, spec[2]);
            if (next === undefined) delete oai[setting];
            else oai[setting] = next;
            keys.push(key);
            if (current === undefined) absent.push(key);
            else before[key] = jsonClean(current);
            if (next !== undefined) after[key] = jsonClean(next);
            connection ||= spec[3];
        }
        if (!keys.length) return null;
        if (connection) for (const selector of CONNECTION_REFRESH_SELECTORS) this.st.trigger(selector, 'change');
        if (keys.includes('bias_preset_selected')) this.st.trigger('#openai_logit_bias_preset', 'change');
        this.app.host.ctx().saveSettingsDebounced();
        this.later('ack', ACK_DELAY_MS, () => void this.acknowledge());
        return { keys, absent, before, after };
    }

    /* ---------------------------------------------------------------- files */

    async save(name?: string, summary?: string, by = 'user'): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            await this.saveWorking(name ?? this.current(), {
                op: 'save',
                by,
                summary: summary ?? this.t('m34.store.version.save'),
            });
        });
    }

    async saveAs(name: string): Promise<string> {
        await this.st.ensure();
        return this.serial(async () => {
            const typed = name.trim();
            const wanted = typed ? await this.st.sanitizeName(typed) : '';
            if (!wanted) throw new PresetStoreError('invalid', 'empty preset name');
            const clash = collidingName(this.names(), wanted);
            if (clash && clash !== wanted) throw new PresetStoreError('exists', `«${clash}» differs only by case`);
            const source = this.current();
            const saved = await this.saveWorking(wanted, {
                op: 'saveAs',
                by: 'user',
                summary: this.t('m34.store.version.saveAs', { from: source }),
                previous: source,
            });
            // ST's «Save as» selects the preset and applies it again (P-066); nothing of the working copy is lost.
            if (saved !== source) await this.switchTo(saved, true);
            return saved;
        });
    }

    async rename(oldName: string, newName: string): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            await this.renameFile(oldName, newName, { ask: true, journal: true });
        });
    }

    async remove(name: string): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            await this.removeFile(name, { journal: true });
        });
    }

    async select(name: string): Promise<void> {
        await this.st.ensure();
        await this.serial(() => this.switchTo(name, false));
    }

    async importFile(file: File): Promise<string> {
        await this.st.ensure();
        return this.serial(async () => {
            const cache = this.requireCache();
            const name = file.name.replace(/\.[^/.]+$/, '');
            let body: unknown;
            try {
                body = JSON.parse(await file.text());
            } catch {
                throw new PresetStoreError('invalid', 'the file is not JSON');
            }
            if (!isDict(body) || !name) throw new PresetStoreError('invalid', 'the file is not a preset');
            const sensitive = presentSensitiveKeys(body);
            if (sensitive.length) {
                const choice = await this.st.chooseSensitive(sensitive);
                if (choice === 'cancel') throw new PresetStoreError('cancelled', 'import cancelled');
                if (choice === 'remove') for (const key of SENSITIVE_PRESET_KEYS) delete body[key];
            }
            if (Object.hasOwn(cache.names, name)) {
                const yes = await this.app.ui.confirm(
                    this.t('m34.store.import.overwriteTitle'),
                    this.t('m34.store.import.overwriteBody', { name }),
                );
                if (!yes) throw new PresetStoreError('cancelled', 'import cancelled');
            }
            // Foreign files carry strings where ST compares strictly (P-039, P-132).
            if (Array.isArray(body.prompts)) {
                body.prompts = body.prompts.map((prompt: unknown) =>
                    isDict(prompt) ? normalizePrompt(prompt) : prompt,
                );
            }
            // Neighbours may change the data before it is written (P-183); ST keeps using the same object.
            await this.st.emit('OAI_PRESET_IMPORT_READY', { data: body, presetName: name });
            const previous = this.current();
            const saved = await this.writeBody(name, body, {
                op: 'import',
                by: 'import',
                summary: this.t('m34.store.version.import'),
                previous,
            });
            // ST applies the imported preset (P-069); the draft of the preset left is snapped in BEFORE.
            await this.switchTo(saved, false);
            return saved;
        });
    }

    async exportPreset(name: string, options: ExportOptions = {}): Promise<void> {
        await this.st.ensure();
        const body = this.saved(name);
        if (!body) throw new PresetStoreError('not-found', `no preset ${name}`);
        let preset: Dict = body;
        if (!options.withSensitive) preset = withoutKeys(preset, SENSITIVE_PRESET_KEYS);
        // Connection data follows `withSensitive` unless asked separately (ST's export asks both, default "no").
        if (!(options.withConnection ?? options.withSensitive === true)) {
            preset = withoutKeys(
                preset,
                Object.entries(this.st.keyTable())
                    .filter(([, spec]) => spec[3])
                    .map(([key]) => key),
            );
        }
        // Neighbours may change the exported data (P-183).
        await this.st.emit('OAI_PRESET_EXPORT_READY', preset);
        await this.st.download(JSON.stringify(preset, null, 4), `${name}.json`);
    }

    async versions(name: string): Promise<PresetVersion[]> {
        return this.history.list(name);
    }

    async restoreVersion(name: string, versionId: string): Promise<void> {
        await this.st.ensure();
        await this.serial(async () => {
            const version = await this.history.get(name, versionId);
            if (!version) throw new PresetStoreError('not-found', `no version ${versionId} of ${name}`);
            const current = this.current() === name;
            const dirty = current && this.draft().dirty;
            const body = withSecretsOf(version.body, this.savedRaw(name) ?? this.removedSecrets.get(versionId));
            const date = new Date(version.at).toLocaleString(this.app.i18n.locale());
            const saved = await this.writeBody(name, body, {
                op: 'restore',
                by: 'user',
                summary: this.t('m34.store.version.restored', { date }),
            });
            // The working copy takes the restored body; real unsaved edits are snapped as a draft first.
            if (saved === this.current()) await this.switchTo(saved, !dirty);
        });
    }

    /* ---------------------------------------------------------------- file operations (inside the chain) */

    /** The working copy into `target`: the user's layer stripped when it is the current preset (§10.4 в 1). */
    private async saveWorking(target: string, meta: WriteMeta): Promise<string> {
        if (!target) throw new PresetStoreError('invalid', 'no preset name');
        this.requireCache();
        const source = this.current();
        let body = this.working();
        if (target === source) body = this.baseOf(source, body) as PresetBody;
        return this.writeBody(target, mergeBodies(this.savedRaw(source), body), meta);
    }

    /**
     * Writes a file with an explicit body and keeps ST in step: cache entry replaced (or appended with a new
     * <option>), versions before/after, journal, M4 acknowledge. Returns the name the server used.
     */
    private async writeBody(name: string, body: Dict, meta: WriteMeta): Promise<string> {
        this.requireCache();
        await this.assertIdle();
        this.ownOps++;
        try {
            const previous = this.savedRaw(name);
            const before = previous ? jsonClean(previous) : null;
            // The state before the save is a version too («было»): new only when it was saved outside Maestro.
            const known = before ? await this.history.newestFileHash(name).catch(() => null) : null;
            const savedName = await this.st.savePresetFile(name, body);
            const existed = this.cacheWrite(savedName, body);
            const [versionBefore, versionAfter] = await this.recordVersions(savedName, [
                before
                    ? {
                          by: 'st',
                          summary: this.t(known === null ? 'm34.store.version.first' : 'm34.store.version.outside'),
                          body: before,
                      }
                    : null,
                { by: meta.by, summary: meta.summary, body },
            ]);
            if (meta.journal !== false) {
                const kind = meta.op === 'saveAs' || meta.op === 'import' || meta.op === 'restore' ? meta.op : 'save';
                const journalKind = `presetStudio.${kind}` as const;
                await this.record(journalKind, this.t(`m34.store.journal.${kind}`, { name: savedName }), [
                    {
                        target: FILE_TARGET,
                        ref: {
                            op: meta.op,
                            name: savedName,
                            created: !existed,
                            previous: meta.previous ?? null,
                        },
                        before: versionRef(versionBefore),
                        after: versionRef(versionAfter) ?? { hash: bodyHash(body) },
                    },
                ]);
            }
            await this.acknowledge();
            this.changed(existed ? 'preset' : 'list');
            return savedName;
        } finally {
            this.ownOps--;
        }
    }

    private async renameFile(
        oldName: string,
        newName: string,
        options: { ask: boolean; journal: boolean; profileIds?: readonly string[] },
    ): Promise<string> {
        const cache = this.requireCache();
        const body = this.savedRaw(oldName);
        if (!body || !Object.hasOwn(cache.names, oldName))
            throw new PresetStoreError('not-found', `no preset ${oldName}`);
        const typed = newName.trim();
        const wanted = typed ? await this.st.sanitizeName(typed) : '';
        if (!wanted) throw new PresetStoreError('invalid', 'empty preset name');
        // ST refuses names equal ignoring case and accents: on case-insensitive disks the delete would hit the new
        // file (PRM:1059-1062).
        if (sameNameLoosely(oldName, wanted)) throw new PresetStoreError('invalid', 'the same name');
        if (collidingName(this.names(), wanted, oldName)) throw new PresetStoreError('exists', `«${wanted}» exists`);
        await this.assertIdle();
        const ext = this.app.host.ctx().extensionSettings;
        const using = profilesUsing(ext, oldName).map(profileRef);
        let move: string[] = options.profileIds ? [...options.profileIds] : [];
        if (!options.profileIds && using.length && options.ask) {
            const yes = await this.app.ui.confirm(
                this.t('m34.store.rename.profilesTitle'),
                this.t('m34.store.rename.profilesBody', {
                    from: oldName,
                    to: wanted,
                    profiles: using.map((profile) => `«${profile.name}»`).join(', '),
                }),
            );
            if (yes) move = using.map((profile) => profile.id);
        }
        this.ownOps++;
        try {
            // The new file gets the saved body, not the working copy: unsaved edits stay a draft (ST bakes them, P-067).
            const savedName = await this.st.savePresetFile(wanted, jsonClean(body));
            await this.st.emit('PRESET_RENAMED_BEFORE', { apiId: 'openai', oldName, newName: savedName });
            // The regex extension moves its permission on that event (RXI:1696-1708); do it when it is not there.
            if (moveRegexPermission(ext, oldName, savedName)) this.st.moveRegexAlert(oldName, savedName);
            const index = cache.names[oldName] as number;
            delete cache.names[oldName];
            cache.names[savedName] = index;
            this.st.renameOption(index, savedName);
            const oai = this.st.oai();
            const wasCurrent = str(oai?.preset_settings_openai) === oldName;
            // Switch by name only: applying the body again would drop the draft (P-060).
            if (oai && wasCurrent) oai.preset_settings_openai = savedName;
            const moved = repointProfiles(ext, move, oldName, savedName);
            this.app.host.ctx().saveSettingsDebounced();
            if ((await this.st.deletePresetFile(oldName)) === 'failed') {
                this.app.ui.notice(this.t('m34.store.rename.oldFileKept', { name: oldName }), { level: 'warn' });
            }
            await this.history.rename(oldName, savedName).catch((error: unknown) => {
                this.log.warn('versions did not follow the rename', error);
            });
            await this.st.emit('PRESET_RENAMED', { apiId: 'openai', oldName, newName: savedName });
            if (wasCurrent) await this.st.emit('PRESET_CHANGED', { apiId: 'openai', name: savedName });
            const kept = using.filter((profile) => !moved.includes(profile.id));
            if (kept.length && !options.profileIds) {
                this.app.ui.notice(
                    this.t('m34.store.rename.profilesKept', {
                        from: oldName,
                        profiles: kept.map((profile) => `«${profile.name}»`).join(', '),
                    }),
                    { level: 'warn' },
                );
            }
            if (options.journal) {
                await this.record(
                    'presetStudio.rename',
                    this.t('m34.store.journal.rename', { from: oldName, to: savedName }),
                    [
                        {
                            target: FILE_TARGET,
                            ref: { op: 'rename', oldName, newName: savedName, profiles: moved },
                            before: { name: oldName },
                            after: { name: savedName },
                        },
                    ],
                );
            }
            await this.acknowledge();
            this.changed('list');
            return savedName;
        } finally {
            this.ownOps--;
        }
    }

    private async removeFile(name: string, options: { journal: boolean; next?: string }): Promise<void> {
        const cache = this.requireCache();
        const body = this.savedRaw(name);
        if (!body || !Object.hasOwn(cache.names, name)) throw new PresetStoreError('not-found', `no preset ${name}`);
        await this.assertIdle();
        const ext = this.app.host.ctx().extensionSettings;
        const regexAllowed = isRegexAllowed(ext, name);
        const profiles = profilesUsing(ext, name).map(profileRef);
        this.ownOps++;
        try {
            // The deleted body stays restorable from the versions (P-182: Maestro versions are kept).
            const [version] = await this.recordVersions(name, [
                { by: 'st', summary: this.t('m34.store.version.outside'), body: jsonClean(body) },
            ]);
            const secrets = pickKeys(body, SENSITIVE_PRESET_KEYS);
            if (version && Object.keys(secrets).length) this.removedSecrets.set(version.id, secrets);
            const index = cache.names[name] as number;
            this.st.removeOption(index);
            delete cache.names[name];
            const oai = this.st.oai();
            if (oai && str(oai.preset_settings_openai) === name) {
                // ST: the first remaining preset is selected and applied; none left → no preset (OAI:4952-4963).
                oai.preset_settings_openai = null;
                const next =
                    options.next && Object.hasOwn(cache.names, options.next)
                        ? options.next
                        : Object.keys(cache.names)[0];
                if (next !== undefined) await this.switchTo(next, true);
            }
            const result = await this.st.deletePresetFile(name);
            if (result === 'failed') {
                this.app.ui.notice(this.t('m34.store.remove.failed', { name }), { level: 'warn' });
            } else {
                await this.st.emit('PRESET_DELETED', { apiId: 'openai', name });
            }
            this.app.host.ctx().saveSettingsDebounced();
            // What referred to the name is reported, never changed silently (P-082, P-156).
            if (profiles.length) {
                this.app.ui.notice(
                    this.t('m34.store.remove.profiles', {
                        name,
                        profiles: profiles.map((profile) => `«${profile.name}»`).join(', '),
                    }),
                    { level: 'warn' },
                );
            }
            if (regexAllowed) this.app.ui.notice(this.t('m34.store.remove.regex', { name }), { level: 'info' });
            if (options.journal) {
                await this.record('presetStudio.remove', this.t('m34.store.journal.remove', { name }), [
                    {
                        target: FILE_TARGET,
                        ref: { op: 'remove', name, regexAllowed, profiles: profiles.map((profile) => profile.id) },
                        before: versionRef(version),
                        after: null,
                    },
                ]);
            }
            await this.acknowledge();
            this.changed('list');
        } finally {
            this.ownOps--;
        }
    }

    /** Selects a preset through ST's own `change` (P-060/P-198); `quiet` skips the draft snapshot of the store. */
    private async switchTo(name: string, quiet: boolean): Promise<void> {
        const cache = this.st.cache();
        const value =
            this.st.optionValue(name) ?? (cache && Object.hasOwn(cache.names, name) ? String(cache.names[name]) : null);
        if (value === null) throw new PresetStoreError('not-found', `no preset ${name}`);
        if (quiet) this.quietSwitch++;
        try {
            await this.st.selectPreset(value);
        } finally {
            if (quiet) this.quietSwitch--;
        }
    }

    /** Replaces (or appends) ST's cached body; true when the name existed (P-075, §10.4 в 4). */
    private cacheWrite(name: string, body: Dict): boolean {
        const cache = this.requireCache();
        const copy = jsonClean(body);
        if (Object.hasOwn(cache.names, name)) {
            const index = cache.names[name] as number;
            const entry = cache.list[index];
            if (isDict(entry)) replaceContents(entry, copy);
            else cache.list[index] = copy;
            return true;
        }
        cache.list.push(copy);
        const index = cache.list.length - 1;
        cache.names[name] = index;
        this.st.addOption(index, name);
        return false;
    }

    /* ---------------------------------------------------------------- ST events */

    /** Snaps the unsaved edits of the preset being left (P-073); synchronous and cheap (P-178). */
    private onPresetBefore(data: unknown): void {
        if (this.quietSwitch > 0 || !isDict(data)) return;
        const name = str(data.presetNameBefore);
        const settings = data.settings;
        if (!name || !isDict(settings)) return;
        try {
            const saved = this.savedRaw(name);
            if (!saved) return;
            const working = jsonClean(this.st.presetOf(settings) ?? bodyFromSettings(settings, this.st.keyTable()));
            const keys = Object.keys(this.st.keyTable());
            if (!diffDraft(working, this.expectedWorking(name, saved), keys).dirty) return;
            const body = mergeBodies(saved, this.baseOf(name, working));
            this.track(this.history.record(name, [{ by: 'draft', summary: this.t('m34.store.version.draft'), body }]));
        } catch (error) {
            this.log.warn('draft snapshot failed', error);
        }
    }

    private onPresetAfter(): void {
        if (this.disposed) return;
        this.signature = this.computeSignature();
        this.notify('preset');
        this.scheduleDetect();
    }

    private onSettingsUpdated(): void {
        if (this.disposed) return;
        const next = this.computeSignature();
        const previous = this.signature;
        this.signature = next;
        if (previous) {
            if (previous.preset !== next.preset) this.notify('preset');
            else {
                if (previous.prompts !== next.prompts) this.notify('prompts');
                if (previous.keys !== next.keys) this.notify('keys');
            }
        }
        this.scheduleDetect();
    }

    /** ST's own rename (PRM:1048-1083): versions follow (P-181). */
    private onPresetRenamed(data: unknown): void {
        if (this.ownOps > 0 || !isDict(data) || data.apiId !== 'openai') return;
        const oldName = str(data.oldName);
        const newName = str(data.newName);
        if (!oldName || !newName) return;
        this.track(this.history.rename(oldName, newName));
        this.notify('list');
    }

    private onPresetDeleted(data: unknown): void {
        if (this.ownOps > 0 || !isDict(data) || data.apiId !== 'openai') return;
        this.notify('list');
    }

    private scheduleDetect(): void {
        this.later('detect', DETECT_DELAY_MS, () => this.track(this.checkOutsideSave()));
    }

    /**
     * A cached body of the current preset that is not its newest file version was saved outside Maestro (ST's
     * «update preset», writePresetExtensionField, /regex-toggle, P-152/P-157) or is seen for the first time: it
     * becomes a version by 'st'. Runs after OAI_PRESET_CHANGED_AFTER and SETTINGS_UPDATED (debounced).
     */
    async checkOutsideSave(): Promise<void> {
        if (this.ownOps > 0 || this.disposed) return;
        const name = this.current();
        const cached = this.savedRaw(name);
        if (!name || !cached) return;
        const hash = bodyHash(cached);
        if (this.history.knownHash(name) === hash) return;
        const known = await this.history.newestFileHash(name);
        if (known === hash || this.ownOps > 0) return;
        await this.history.record(name, [
            {
                by: 'st',
                summary: this.t(known === null ? 'm34.store.version.first' : 'm34.store.version.outside'),
                body: jsonClean(cached),
            },
        ]);
    }

    /* ---------------------------------------------------------------- undo */

    private async undoPrompt(change: JournalChange): Promise<boolean> {
        await this.st.ensure();
        if (str(change.ref.preset) !== this.current()) return false;
        return this.serial(async () => {
            const model = this.model();
            if (change.ref.part === 'order') {
                if (!looseEqual(readOrder(model.order()), readOrder(change.after))) return false;
                model.setOrder(readOrder(change.before));
            } else {
                const identifier = str(change.ref.identifier);
                const live = model.get(identifier);
                if (change.after === null) {
                    if (live || !isDict(change.before)) return false;
                    const index = typeof change.ref.index === 'number' ? change.ref.index : model.list().length;
                    model.restore(jsonClean(change.before), index);
                } else {
                    if (!live || !isDict(change.after) || !promptsEqual(live, change.after)) return false;
                    if (change.before === null) model.remove(identifier);
                    else if (isDict(change.before)) replaceContents(live, jsonClean(change.before));
                    else return false;
                }
                model.quickEdit(identifier);
            }
            this.persist(model);
            this.changed('prompts');
            return true;
        });
    }

    private async undoKeys(change: JournalChange): Promise<boolean> {
        await this.st.ensure();
        if (str(change.ref.preset) !== this.current() || !isDict(change.before) || !isDict(change.after)) return false;
        const keys = Array.isArray(change.ref.keys) ? change.ref.keys.map(String) : [];
        const absent = Array.isArray(change.ref.absent) ? change.ref.absent.map(String) : [];
        const before = change.before;
        const after = change.after;
        return this.serial(async () => {
            const live = pickKeys(this.working(), keys);
            if (!looseEqual(live, after)) return false;
            const patch: Dict = {};
            for (const key of keys) patch[key] = absent.includes(key) ? undefined : before[key];
            this.applyKeys(patch, true);
            this.changed('keys');
            return true;
        });
    }

    private async undoFile(change: JournalChange): Promise<boolean> {
        await this.st.ensure();
        const ref = change.ref;
        return this.serial(async () => {
            const op = str(ref.op);
            if (op === 'rename') {
                const oldName = str(ref.oldName);
                const newName = str(ref.newName);
                if (!this.savedRaw(newName) || this.savedRaw(oldName)) return false;
                const profiles = Array.isArray(ref.profiles) ? ref.profiles.map(String) : [];
                await this.renameFile(newName, oldName, { ask: false, journal: false, profileIds: profiles });
                return true;
            }
            if (op === 'remove') {
                const name = str(ref.name);
                const versionId = isDict(change.before) ? str(change.before.version) : '';
                if (!name || !versionId || this.savedRaw(name)) return false;
                const version = await this.history.get(name, versionId);
                if (!version) return false;
                await this.writeBody(name, withSecretsOf(version.body, this.removedSecrets.get(versionId)), {
                    op: 'undo',
                    by: 'user',
                    summary: this.t('m34.store.version.undo'),
                    journal: false,
                });
                if (ref.regexAllowed === true && allowRegex(this.app.host.ctx().extensionSettings, name)) {
                    this.app.host.ctx().saveSettingsDebounced();
                }
                return true;
            }
            // save, saveAs, import, restore: the file must still be what the operation wrote.
            const name = str(ref.name);
            const cached = this.savedRaw(name);
            const afterHash = isDict(change.after) ? str(change.after.hash) : '';
            if (!cached || !afterHash || bodyHash(cached) !== afterHash) return false;
            const versionId = isDict(change.before) ? str(change.before.version) : '';
            if (!versionId) {
                if (ref.created !== true) return false;
                await this.removeFile(name, { journal: false, next: str(ref.previous) || undefined });
                return true;
            }
            const version = await this.history.get(name, versionId);
            if (!version) return false;
            await this.writeBody(name, withSecretsOf(version.body, cached), {
                op: 'undo',
                by: 'user',
                summary: this.t('m34.store.version.undo'),
                journal: false,
            });
            // Operations that applied the body (import, restore) are undone in the working copy too.
            if ((op === 'import' || op === 'restore') && name === this.current()) await this.switchTo(name, true);
            return true;
        });
    }

    /* ---------------------------------------------------------------- helpers */

    private savedRaw(name: string): Dict | null {
        const cache = this.st.cache();
        if (!cache || !name || !Object.hasOwn(cache.names, name)) return null;
        const entry = cache.list[cache.names[name] as number];
        return isDict(entry) ? entry : null;
    }

    private requireOai(): Dict {
        const oai = this.st.oai();
        if (!oai) throw new PresetStoreError('unavailable', 'Chat Completion settings are not available');
        return oai;
    }

    private requireCache(): NonNullable<ReturnType<StPreset['cache']>> {
        const cache = this.st.cache();
        if (!cache) throw new PresetStoreError('unavailable', 'the preset cache of openai.js is not available');
        return cache;
    }

    private model(oai: Dict = this.requireOai()): PromptModel {
        return new PromptModel(oai, this.st.promptManager(), this.log, () =>
            this.app.host.ctx().saveSettingsDebounced(),
        );
    }

    private persist(model: PromptModel): void {
        this.track(model.persist());
        this.later('ack', ACK_DELAY_MS, () => void this.acknowledge());
    }

    private layer(): PresetLayerApi | undefined {
        return this.app.modules.api<PresetLayerApi>(PRESET_LAYER_KEY);
    }

    private hasLayer(name: string): PresetLayerApi | null {
        const layer = this.layer();
        try {
            return layer && (layer.get(name)?.ops.length ?? 0) > 0 ? layer : null;
        } catch (error) {
            this.log.debug('layer unavailable', error);
            return null;
        }
    }

    /** What the working copy is when nothing is unsaved: the saved body, with the user's layer laid over it. */
    private expectedWorking(name: string, saved: Dict): Dict {
        const layer = this.hasLayer(name);
        if (!layer) return saved;
        try {
            return layer.apply(name, jsonClean(saved) as PresetBody).body;
        } catch (error) {
            this.log.debug('layer apply failed', error);
            return saved;
        }
    }

    /** The working copy without the user's layer (the base file must not get it twice, §10.4 в 1). */
    private baseOf(name: string, body: Dict): Dict {
        const layer = this.hasLayer(name);
        if (!layer) return body;
        try {
            return layer.strip(name, jsonClean(body) as PresetBody);
        } catch (error) {
            this.log.warn('layer strip failed; the working copy is saved as it is', error);
            return body;
        }
    }

    private async assertIdle(): Promise<void> {
        // A quiet generation may hold a temporary max_tokens in oai_settings (TempResponseLength, P-084).
        if (await this.st.generating()) throw new PresetStoreError('busy', 'a generation is running');
    }

    private async recordVersions(name: string, inputs: (VersionInput | null)[]) {
        try {
            return await this.history.record(name, inputs);
        } catch (error) {
            this.log.warn(`versions of ${name} could not be written`, error);
            return inputs.map(() => null);
        }
    }

    private newIdentifier(): string {
        const ctx = this.app.host.ctx() as Partial<STContext>;
        if (typeof ctx.uuidv4 === 'function') return ctx.uuidv4();
        return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `maestro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    private promptChange(identifier: string, before: Dict | null, after: Dict | null, index?: number): JournalChange {
        const ref: Dict = { preset: this.current(), part: 'prompt', identifier };
        if (index !== undefined && index >= 0) ref.index = index;
        return { target: PROMPT_TARGET, ref, before, after };
    }

    private orderChange(before: OrderEntry[], after: OrderEntry[]): JournalChange {
        return { target: PROMPT_TARGET, ref: { preset: this.current(), part: 'order' }, before, after };
    }

    /** «A, B, C и ещё 2»: the first names of a summary list. */
    private nameList(names: readonly string[]): string {
        const shown = names.slice(0, SUMMARY_NAMES).join(', ');
        const more = names.length - SUMMARY_NAMES;
        return more > 0 ? this.t('m34.store.journal.more', { names: shown, count: more }) : shown;
    }

    /** Changed parameters by the «Параметры» tab's names; keys the tab does not show are only counted. */
    private keysSummary(keys: readonly string[]): string {
        const labels = keys
            .map((key) => paramLabel(key, this.app.i18n))
            .filter((label): label is string => label !== undefined);
        if (!labels.length) return this.t('m34.store.journal.keysOther', { count: keys.length });
        const shown = labels.slice(0, SUMMARY_NAMES);
        const more = keys.length - shown.length;
        const list = shown.join(', ');
        return this.t('m34.store.journal.keys', {
            keys: more > 0 ? this.t('m34.store.journal.more', { names: list, count: more }) : list,
        });
    }

    private async record(kind: StoreJournalKind, summary: string, changes: JournalChange[]): Promise<void> {
        try {
            await this.app.journal.record({ module: MODULE_ID, kind, summary, changes });
        } catch (error) {
            this.log.warn('journal record failed', error);
        }
    }

    /** M4 must not report the store's own changes as drift (A17). */
    private async acknowledge(): Promise<void> {
        const guardian = this.app.modules.api<GuardianApi>('guardian');
        if (!guardian) return;
        try {
            await guardian.acknowledge(['preset']);
        } catch (error) {
            this.log.warn('guardian acknowledge failed', error);
        }
    }

    private computeSignature(): Signature {
        const body = this.working();
        const { prompts, prompt_order: order, ...rest } = body;
        return { preset: this.current(), prompts: valueHash([prompts ?? null, order ?? null]), keys: valueHash(rest) };
    }

    /** A change made by the store: listeners hear it now, the SETTINGS_UPDATED echo stays silent. */
    private changed(reason: StoreChangeReason): void {
        try {
            this.signature = this.computeSignature();
        } catch (error) {
            this.log.debug('signature failed', error);
        }
        this.notify(reason);
    }

    private notify(reason: StoreChangeReason): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(reason);
            } catch (error) {
                this.log.error('preset store listener failed', error);
            }
        }
    }

    private serial<R>(job: () => Promise<R>): Promise<R> {
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    private track(promise: Promise<unknown>): void {
        const tracked = promise.catch((error: unknown) => this.log.warn('preset store background task failed', error));
        this.background.add(tracked);
        void tracked.finally(() => this.background.delete(tracked));
    }

    private later(id: string, ms: number, run: () => void): void {
        if (this.disposed) return;
        const previous = this.timers.get(id);
        if (previous) clearTimeout(previous);
        this.timers.set(
            id,
            setTimeout(() => {
                this.timers.delete(id);
                if (!this.disposed) run();
            }, ms),
        );
    }
}

/** Replaces the contents of a live object (Prompt Manager and ST's cache keep references to it). */
function replaceContents(target: Dict, source: Dict): void {
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
    Object.assign(target, source);
}

function promptName(prompt: Dict): string {
    return str(prompt.name) || str(prompt.identifier);
}

/** Builds the store; the shell calls install() and owns the disposers, then exposes it under PRESET_STORE_KEY. */
export function createPresetStore(app: App, log: Logger): PresetStoreService {
    return new PresetStoreService(app, log);
}
