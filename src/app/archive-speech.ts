// The speech digest of MAESTRO_API.speech() (release 1.17, docs/integration-dramatis.md): what Maestro's voice cards
// (M15) would show about how a character talks — the LING tags and the Linguistics prose of the character's CarrotKernel
// archive (read through M35 `readSheet` when it runs, else ST's loadWorldInfo) and the MBTI archetype — even while the
// voice cards module is off. The API call is synchronous: archives are read in the background (on chat changes, turns,
// new replies and a miss) and cached per archive; a book saved again is read again.
import { PROSE_CHARS } from '../domain/voices-cards';
import { archiveVoiceFromSheet, archiveVoiceOf, mbtiText, speechText } from '../domain/voices-speech';
import type { ArchiveVoice } from '../domain/voices-speech';
import type { BunnyMoModeApi } from '../features/bunnymoMode/api';
import type { Entity, WorldModelApi } from '../features/world/api';
import type { App, Logger, Unsubscribe } from '../shared/contracts';

const CACHE_LIMIT = 300;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitRef(ref: string): { book: string; uid: number } {
    const at = ref.lastIndexOf('#');
    return { book: ref.slice(0, at), uid: Number(ref.slice(at + 1)) };
}

/** `book#uid` of an entity's CarrotKernel archive (the world model's 'ck.archive' source), or null. */
export function archiveRefOf(entity: Pick<Entity, 'sources'>): string | null {
    const source = entity.sources.find(
        (item) => item.kind === 'ck.archive' && typeof item.world === 'string' && typeof item.uid === 'number',
    );
    return source?.world !== undefined && source.uid !== undefined ? `${source.world}#${source.uid}` : null;
}

/** The digest as the voice cards word it: «Speech: …» and «MBTI: …» joined by « | »; '' when the archive is silent. */
export function speechDigest(voice: ArchiveVoice | null, names: readonly string[]): string {
    if (!voice) return '';
    const speech = speechText(voice, { proseChars: PROSE_CHARS[0] ?? 220, names });
    const mbti = mbtiText(voice.mbti);
    return [speech ? `Speech: ${speech}` : '', mbti ? `MBTI: ${mbti}` : ''].filter(Boolean).join(' | ');
}

export class ArchiveSpeech {
    private readonly voices = new Map<string, ArchiveVoice | null>();
    private readonly loading = new Map<string, number>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const updated = this.app.host.events.name('WORLDINFO_UPDATED');
        if (updated) {
            offs.push(
                this.app.host.events.on(updated, (name) => {
                    if (typeof name !== 'string') return;
                    for (const ref of [...this.voices.keys()]) {
                        if (splitRef(ref).book === name) this.load(ref, true);
                    }
                }),
            );
        }
        offs.push(() => {
            this.disposed = true;
            this.voices.clear();
        });
        return offs;
    }

    private world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }

    private entityOf(name: string): Entity | undefined {
        const world = this.world();
        if (!world || !name.trim()) return undefined;
        try {
            return world.resolve(name, 'character') ?? world.resolve(name) ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** The digest for a character, or null (unknown name, no archive, archive not read yet, nothing about speech). */
    speech(name: string): string | null {
        const entity = this.entityOf(name);
        if (!entity) return null;
        const ref = archiveRefOf(entity);
        if (!ref) return null;
        if (!this.voices.has(ref)) {
            this.load(ref, false);
            return null;
        }
        const digest = speechDigest(this.voices.get(ref) ?? null, [entity.name, ...entity.aliases]);
        return digest || null;
    }

    /** Reads the archives of these characters ahead of the next generation. */
    warm(names: readonly string[]): void {
        for (const name of names) {
            const entity = this.entityOf(name);
            const ref = entity ? archiveRefOf(entity) : null;
            if (ref && !this.voices.has(ref)) this.load(ref, false);
        }
    }

    private load(ref: string, force: boolean): void {
        if (this.disposed) return;
        if (!force && (this.voices.has(ref) || this.loading.has(ref))) return;
        const generation = (this.loading.get(ref) ?? 0) + 1;
        this.loading.set(ref, generation);
        const { book, uid } = splitRef(ref);
        void this.read(book, uid)
            .then((voice) => {
                if (this.disposed || this.loading.get(ref) !== generation) return;
                if (this.voices.size >= CACHE_LIMIT && !this.voices.has(ref)) this.voices.clear();
                this.voices.set(ref, voice);
            })
            .catch((error: unknown) => this.log.debug(`archive ${ref} could not be read`, error))
            .finally(() => {
                if (this.loading.get(ref) === generation) this.loading.delete(ref);
            });
    }

    private async read(book: string, uid: number): Promise<ArchiveVoice | null> {
        const mode = this.app.modules.api<BunnyMoModeApi>('bunnymoMode');
        if (mode && typeof mode.readSheet === 'function') {
            try {
                const sheet = await mode.readSheet(book, uid);
                return sheet ? archiveVoiceFromSheet(sheet) : null;
            } catch (error) {
                this.log.debug(`M35 could not read ${book}#${uid}`, error);
            }
        }
        const load = this.app.host.ctx().loadWorldInfo;
        if (typeof load !== 'function') return null;
        const data: unknown = await load(book);
        const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
        const entry =
            Object.values(entries).find((item) => isDict(item) && Number(item.uid) === uid) ?? entries[String(uid)];
        return isDict(entry) ? archiveVoiceOf(entry.content) : null;
    }
}
