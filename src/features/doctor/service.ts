// The doctor's state: runs a scan on demand (never on the send path, P15), keeps the last result for the pult and
// the wizard, and serves the regex bench. Findings point to M22 rules (fixes on the fly) or offer a file fix and regex
// actions through autonomy (stage 2: fixes.ts, regex-fix.ts).
import { adaptersOf } from '../../adapters';
import { findArchiveIssues, findWrapperCollisions, isArchive } from '../../domain/doctor-ck';
import { findBudgetIssues } from '../../domain/doctor-budget';
import { isRussianChat } from '../../domain/doctor-keys';
import { findAssistantAtDepth, findKeyIssues, findPackDuplicates } from '../../domain/doctor-lore';
import { findRecursionIssues } from '../../domain/doctor-recursion';
import { findRegexIssues, guessOwner } from '../../domain/doctor-regex';
import type { RegexScriptInfo } from '../../domain/doctor-regex';
import type { DoctorIssue } from '../../domain/doctor-types';
import { stableHash } from '../../domain/hash';
import type { App, Decision, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookStat, DoctorApi, Finding, FindingSeverity, RegexAction, RegexInfo } from './api';
import { fileFixOffered, fixInFile } from './fixes';
import type { BookFacts, FileFixOutcome } from './fixes';
import { regexAction } from './regex-fix';
import {
    archiveBooksOf,
    chatSample,
    loreTurns,
    maxContext,
    readLore,
    readRegexScripts,
    readWorldInfoSettings,
    runRegexScript,
} from './sources';
import type { RegexSnapshot } from './sources';

export interface ScanResult {
    at: number;
    chatId: string | null;
    findings: Finding[];
    books: BookStat[];
    entries: number;
    scripts: RegexScriptInfo[];
    inventory: RegexInfo[];
    /** i18n keys of notes about parts that could not be checked. */
    notes: string[];
    regexExtensionOff: boolean;
    /** BunnyMo books (never fixed in files) and the user's archive books of this scan. */
    facts: BookFacts;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };

/** Lets the page paint between heavy steps (big books take a few hundred milliseconds). */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Finding = issue + a stable id (same problem → same id across scans). */
export function toFinding(issue: DoctorIssue): Finding {
    const id = stableHash(`${issue.kind}|${issue.messageKey}|${JSON.stringify(issue.target)}`);
    return { id, ...issue };
}

export function sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.kind.localeCompare(b.kind),
    );
}

export class DoctorService {
    private result: ScanResult | null = null;
    private running: Promise<Finding[]> | null = null;
    private regex: RegexSnapshot | null = null;
    private stale = false;
    private disposed = false;
    private readonly listeners = new Set<() => void>();

    readonly api: DoctorApi;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.api = {
            scan: () => this.scan(),
            findings: () => this.result?.findings ?? [],
            regexInventory: () => this.regexInventory(),
            bookStats: () => this.result?.books ?? [],
            lastScanAt: () => this.result?.at ?? 0,
            testRegex: (id, text) => this.testRegex(id, text),
            onChange: (listener) => this.onChange(listener),
            fixInFile: async (id) => {
                const outcome = await this.fixFinding(id);
                return outcome?.status === 'decided' ? outcome.decision : 'skipped';
            },
            regexAction: (id, action) => this.regexAction(id, action),
        };
    }

    /** «Исправить в файле» for a finding of the last scan; rescans after an applied fix. Null: no file fix offered. */
    async fixFinding(id: string): Promise<FileFixOutcome | null> {
        const result = this.result;
        const finding = result?.findings.find((item) => item.id === id);
        if (!result || !finding || !fileFixOffered(finding, result.facts)) return null;
        const outcome = await fixInFile(this.app, finding);
        if (outcome.status === 'decided' && outcome.decision === 'applied') await this.scan();
        return outcome;
    }

    /** Enables, disables or deletes one script of the last inventory; rescans after an applied change. */
    async regexAction(id: string, action: RegexAction, note?: string): Promise<Decision> {
        const script = this.result?.scripts.find((item) => item.id === id);
        if (!script) return 'skipped';
        const decision = await regexAction(this.app, script, action, note);
        if (decision === 'applied') await this.scan();
        return decision;
    }

    last(): ScanResult | null {
        return this.result;
    }

    isScanning(): boolean {
        return this.running !== null;
    }

    /** The chat changed after the last scan: findings describe another chat. */
    isStale(): boolean {
        return this.stale && this.result !== null;
    }

    markStale(): void {
        if (!this.result) return;
        this.stale = true;
        this.emit();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }

    /** Concurrent calls share one run. */
    scan(): Promise<Finding[]> {
        this.running ??= this.runScan()
            .then((result) => {
                if (!this.disposed) {
                    this.result = result;
                    this.stale = false;
                }
                return result.findings;
            })
            .finally(() => {
                this.running = null;
                this.emit();
            });
        this.emit();
        return this.running;
    }

    async regexInventory(): Promise<RegexInfo[]> {
        if (this.result) return this.result.inventory;
        const snapshot = await readRegexScripts(this.app, this.log);
        this.regex = snapshot;
        return this.inventoryOf(snapshot.scripts);
    }

    async testRegex(id: string, text: string): Promise<string | null> {
        const snapshot = this.regex ?? (await readRegexScripts(this.app, this.log));
        this.regex = snapshot;
        const raw = snapshot.raw.get(id);
        if (!raw) return null;
        return runRegexScript(this.app, raw, text);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.warn('doctor listener failed', error);
            }
        }
    }

    private inventoryOf(scripts: RegexScriptInfo[]): RegexInfo[] {
        let presetIsMarinara = false;
        try {
            presetIsMarinara = adaptersOf(this.app).preset.isMarinara();
        } catch {
            presetIsMarinara = false;
        }
        return scripts.map((script) => ({
            id: script.id,
            name: script.name,
            type: script.type,
            disabled: script.disabled,
            placement: [...script.placement],
            promptOnly: script.promptOnly,
            markdownOnly: script.markdownOnly,
            owner: guessOwner(script, { presetIsMarinara }),
            find: script.find,
            replace: script.replace,
            allowed: script.allowed,
            minDepth: script.minDepth,
            maxDepth: script.maxDepth,
        }));
    }

    private async runScan(): Promise<ScanResult> {
        const app = this.app;
        const started = Date.now();
        const notes: string[] = [];
        const adapters = adaptersOf(app);
        const lore = await readLore(app, this.log);
        if (!lore.books.length) notes.push('m5.notes.noBooks');
        const wi = await readWorldInfoSettings(app, this.log);
        if (!wi) notes.push('m5.notes.noWorldInfo');
        const chat = chatSample(app);
        const russianChat = isRussianChat(
            chat.messages
                .slice(-30)
                .map((message) => message.text)
                .filter(Boolean),
        );

        const issues: DoctorIssue[] = [];
        issues.push(...findPackDuplicates(lore.entries, lore.bunnyBooks));
        issues.push(...findAssistantAtDepth(lore.entries, lore.bunnyBooks));
        issues.push(
            ...findKeyIssues(lore.entries, {
                russianChat,
                wholeWordsGlobal: wi?.wholeWords ?? false,
                bunnyBooks: lore.bunnyBooks,
            }),
        );
        let ckPresent = false;
        let repoBooks: string[] = [];
        try {
            ckPresent = adapters.ck.present();
            repoBooks = adapters.ck.repoBooks();
        } catch (error) {
            this.log.debug('CK adapter is not available', error);
        }
        issues.push(...findArchiveIssues(lore.entries, { ckPresent, repoBooks, bunnyBooks: lore.bunnyBooks }));
        await pause();
        const recursion = findRecursionIssues(lore.entries, {
            recursive: wi?.recursive ?? false,
            caseSensitive: wi?.caseSensitive ?? false,
            wholeWords: wi?.wholeWords ?? false,
            maxSteps: wi?.maxRecursionSteps ?? 0,
        });
        if (wi) {
            issues.push(
                ...findWrapperCollisions(lore.entries, {
                    recursive: wi.recursive,
                    caseSensitiveGlobal: wi.caseSensitive,
                    wholeWordsGlobal: wi.wholeWords,
                }),
            );
            issues.push(...recursion.issues);
            issues.push(
                ...findBudgetIssues({
                    settings: wi,
                    maxContext: maxContext(app),
                    entries: lore.entries,
                    journal: loreTurns(app),
                }),
            );
        }

        await pause();
        const regex = await readRegexScripts(app, this.log);
        this.regex = regex;
        if (!regex.extensionOff) {
            const bunnymo = lore.bunnyBooks.size > 0 || app.host.caps.has('bunnymo.archives');
            let des: 'off' | 'on' | 'together' = 'off';
            let nai = false;
            try {
                if (adapters.des.present()) des = adapters.des.generationMode() === 'together' ? 'together' : 'on';
                nai = adapters.nai.present();
            } catch (error) {
                this.log.debug('neighbour adapters are not available', error);
            }
            issues.push(
                ...findRegexIssues(regex.scripts, {
                    bunnymo,
                    des,
                    nai,
                    chat: { user: chat.user, ai: chat.ai, reasoning: chat.reasoning, checked: chat.checked },
                    lore: lore.entries.filter((entry) => !entry.disable).map((entry) => entry.content),
                }),
            );
        }

        const archiveBooks = new Set(archiveBooksOf(app, lore, isArchive));
        const books: BookStat[] = recursion.books.map((stats) => ({
            book: stats.book,
            entries: stats.entries,
            chars: stats.chars,
            constantChars: stats.constantChars,
            links: stats.links,
            maxDepth: stats.maxDepth,
            vacuums: stats.vacuums,
            bunnymo: lore.bunnyBooks.get(stats.book) ?? null,
            archive: archiveBooks.has(stats.book),
        }));
        this.log.debug(`scan: ${issues.length} findings in ${Date.now() - started} ms`);
        return {
            at: Date.now(),
            chatId: app.host.chatId(),
            findings: sortFindings(issues.map(toFinding)),
            books,
            entries: lore.entries.length,
            scripts: regex.scripts,
            inventory: this.inventoryOf(regex.scripts),
            notes,
            regexExtensionOff: regex.extensionOff,
            facts: { bunny: new Set(lore.bunnyBooks.keys()), archive: archiveBooks },
        };
    }
}
