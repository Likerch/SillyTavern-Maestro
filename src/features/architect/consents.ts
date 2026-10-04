// The user's consents for duplicate facts (plan M20 п. 4: «сначала отчёт, затем по согласию — один источник»), per
// chat in the chat document 'architect'. A consent names the source to keep and the sentence keys of the fact; from
// then on the other sources' copies are dropped on the fly — lore entries on the scan copy (ENTRIES_LOADED),
// injections in the assembled prompt (PROMPT_READY). The maps those handlers read are kept in memory.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const ARCHITECT_DOC_KIND = 'architect';
const MAX_CONSENTS = 200;
/** Owners whose `ref` is a lorebook entry (`${world}#${uid}`); every other owner is an extension prompt key. */
export const LORE_OWNERS: ReadonlySet<string> = new Set(['lore', 'canon', 'ckArchive']);

export interface ConsentSource {
    owner: string;
    ref: string;
    tokens: number;
}

export interface DuplicateConsent {
    id: string;
    /** Sentence keys of the fact in every source (sentenceKey()). */
    keys: string[];
    text: string;
    sources: ConsentSource[];
    /** The `ref` of the source that stays. */
    keep: string;
    at: number;
}

interface ArchitectDoc {
    v: 1;
    consents: DuplicateConsent[];
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyDoc(): ArchitectDoc {
    return { v: 1, consents: [] };
}

function isConsent(value: unknown): value is DuplicateConsent {
    return (
        isDict(value) &&
        typeof value.id === 'string' &&
        typeof value.keep === 'string' &&
        Array.isArray(value.keys) &&
        Array.isArray(value.sources)
    );
}

function ensureDoc(doc: object): ArchitectDoc {
    const raw = doc as Record<string, unknown>;
    raw.v = 1;
    raw.consents = Array.isArray(raw.consents) ? raw.consents.filter(isConsent) : [];
    return raw as unknown as ArchitectDoc;
}

export class ConsentStore {
    private chatId: string | null = null;
    private consents: DuplicateConsent[] = [];
    private loading: Promise<void> | null = null;
    private drops: { lore: Map<string, Set<string>>; slots: Map<string, Set<string>> } | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** Loads the consents of the current chat (cheap when already loaded). */
    async load(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (chatId === this.chatId && !this.loading) return;
        if (!chatId) {
            this.set(null, []);
            return;
        }
        if (!this.loading) {
            this.loading = (async () => {
                const doc = ensureDoc(await this.app.chat.getFor(chatId, ARCHITECT_DOC_KIND, emptyDoc));
                if (this.app.host.chatId() === chatId) this.set(chatId, doc.consents);
            })()
                .catch((error: unknown) => this.log.warn('duplicate consents could not be loaded', error))
                .finally(() => {
                    this.loading = null;
                });
        }
        await this.loading;
    }

    list(): DuplicateConsent[] {
        return this.matchesChat() ? this.consents.map((item) => ({ ...item, sources: [...item.sources] })) : [];
    }

    /** The consent covering a fact: same id, or any shared sentence key. */
    find(id: string, keys: readonly string[] = []): DuplicateConsent | undefined {
        if (!this.matchesChat()) return undefined;
        const wanted = new Set(keys);
        return this.consents.find((item) => item.id === id || item.keys.some((key) => wanted.has(key)));
    }

    /** Stores (or with `keep` null removes) the consent for a fact; persisted in the chat document. */
    async save(consent: DuplicateConsent | null, id: string): Promise<void> {
        await this.load();
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        for (let attempt = 0; attempt < 2; attempt++) {
            const doc = ensureDoc(await this.app.chat.getFor(chatId, ARCHITECT_DOC_KIND, emptyDoc));
            const keys = new Set(consent?.keys ?? []);
            doc.consents = doc.consents.filter((item) => item.id !== id && !item.keys.some((key) => keys.has(key)));
            if (consent) doc.consents.push(consent);
            if (doc.consents.length > MAX_CONSENTS) doc.consents = doc.consents.slice(-MAX_CONSENTS);
            const saved = await this.app.chat.put(ARCHITECT_DOC_KIND, doc);
            if (this.app.host.chatId() === chatId) this.set(chatId, doc.consents);
            if (saved) return;
        }
        this.log.warn('duplicate consents were not saved (another tab keeps writing them)');
    }

    /** Lore refs (`world#uid`) → sentence keys to remove from that entry's scan copy. */
    loreDrops(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.dropMaps().lore;
    }

    /** Extension prompt keys → sentence keys to remove from that injection in the assembled prompt. */
    slotDrops(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.dropMaps().slots;
    }

    /** Duplicate id the given source copy of a sentence belongs to (for the report). */
    consentFor(ref: string): DuplicateConsent[] {
        return this.matchesChat()
            ? this.consents.filter((item) => item.keep !== ref && item.sources.some((source) => source.ref === ref))
            : [];
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private matchesChat(): boolean {
        return this.chatId !== null && this.chatId === this.app.host.chatId();
    }

    private dropMaps(): NonNullable<ConsentStore['drops']> {
        if (!this.matchesChat()) return { lore: new Map(), slots: new Map() };
        if (this.drops) return this.drops;
        const lore = new Map<string, Set<string>>();
        const slots = new Map<string, Set<string>>();
        for (const consent of this.consents) {
            for (const source of consent.sources) {
                if (source.ref === consent.keep) continue;
                const target = LORE_OWNERS.has(source.owner) ? lore : slots;
                const set = target.get(source.ref) ?? new Set<string>();
                for (const key of consent.keys) set.add(key);
                target.set(source.ref, set);
            }
        }
        this.drops = { lore, slots };
        return this.drops;
    }

    private set(chatId: string | null, consents: DuplicateConsent[]): void {
        this.chatId = chatId;
        this.consents = consents.map((item) => ({ ...item }));
        this.drops = null;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('consent listener failed', error);
            }
        }
    }
}
