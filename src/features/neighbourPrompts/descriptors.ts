// M36 «Промпты соседей»: what each neighbour puts into the prompt and how its text is read, written and found in the
// outgoing messages (api.ts has the table). Neighbours are read live through their adapters (adapters/des, nai,
// qvink, desru, ck): an adapter of an older neighbour, or a test fake, may lack a method — every call is guarded.
import { adaptersOf } from '../../adapters';
import type { DesPromptKey, NaiMarkerSettings, QvinkTextKey } from '../../adapters';
import { fillBraces, fillDoubleBraces } from '../../domain/neighbour-prompts';
import { CK_CONSISTENCY_SLOT } from '../../domain/voices-prompt';
import type { App } from '../../shared/contracts';
import type { NeighbourOwner } from './api';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface Descriptor {
    id: string;
    owner: NeighbourOwner;
    usedIn: 'prompt' | 'background';
    present(): boolean;
    /** The neighbour's setting ('' = its built-in text); absent for read-only entries, null when unreadable now. */
    setting?(): string | null;
    /** The neighbour's built-in text, when known. */
    builtin?(): string | null;
    /** For text that lives in an extension prompt slot: the slot (read now, or as last seen at a generation). */
    slot?: string;
    /** Writes the setting ('' = built-in); false when the neighbour cannot take it now. */
    write?(text: string): boolean;
    /** What a setting text is stored as (DES stores no tracker override equal to what it generates). */
    normalize?(text: string): string;
    /** Raw state for undo (NAI keeps the preset next to the text); default: the setting. */
    snapshot?(): unknown;
    restore?(raw: unknown): boolean;
    /** The neighbour must not be written now (DES Workshop open). */
    busy?(): boolean;
    /** M4 paths a write changes (acknowledged afterwards). */
    guardPaths?: string[];
    /** Copies can be applied when the global text is known (it goes into the main prompt verbatim enough). */
    scopable: boolean;
    /** Translated reason shown when it is read-only or cannot be copied (i18n key). */
    noteKey?: string;
    /** Maestro's own injections: the module whose settings change them. */
    moduleKey?: string;
    /**
     * The global text as it goes into the outgoing messages, at prompt time (null: unknown, a copy cannot apply).
     * `slotValue` is the value of the descriptor's slot now.
     */
    outgoing(slotValue: string | null): string | null;
    /** A copy in the form that goes into the messages (the neighbour's own placeholders filled). */
    render(text: string): string;
}

/** The ST user's name, as DES puts it into its tracker texts (`{userName}` → getContext().name1). */
function userName(app: App): string {
    try {
        return app.host.ctx().name1 || 'User';
    } catch {
        return 'User';
    }
}

/* ------------------------------------------------------------------ DES */

interface DesLike {
    present(): boolean;
    promptOverride?(key: DesPromptKey): string | null;
    promptBuiltin?(key: DesPromptKey): string | null;
    setPromptOverride?(key: DesPromptKey, text: string): boolean;
    isWorkshopOpen?(): boolean;
}

function des(app: App): DesLike {
    return adaptersOf(app).des as unknown as DesLike;
}

function desPrompt(
    app: App,
    id: string,
    key: DesPromptKey,
    options: { userName?: boolean; trackerBlock?: boolean } = {},
): Descriptor {
    const fill = (text: string) => (options.userName ? fillBraces(text, { userName: userName(app) }) : text);
    const setting = () => des(app).promptOverride?.(key) ?? null;
    const builtin = () => des(app).promptBuiltin?.(key) ?? null;
    return {
        id,
        owner: 'des',
        usedIn: 'prompt',
        present: () => des(app).present() && typeof des(app).promptOverride === 'function' && setting() !== null,
        setting,
        builtin,
        write: (text) => des(app).setPromptOverride?.(key, text) === true,
        // DES's own editor stores no override equal to the block it generates: that would freeze the tracker
        // settings out of the prompt (promptsEditor.js savePrompts).
        normalize: options.trackerBlock
            ? (text) => {
                  const generated = builtin();
                  return generated !== null && text.trim() === generated.trim() ? '' : text;
              }
            : undefined,
        busy: () => des(app).isWorkshopOpen?.() === true,
        guardPaths: [`des.${key}`],
        scopable: true,
        outgoing: () => {
            const text = setting() || builtin();
            return text ? fill(text) : null;
        },
        render: fill,
    };
}

/* ------------------------------------------------------------------ NAI Studio */

interface NaiLike {
    present(): boolean;
    markerSettings?(): NaiMarkerSettings | null;
    setMarkerInstruction?(next: { preset: NaiMarkerSettings['preset']; template: string }): boolean;
}

function nai(app: App): NaiLike {
    return adaptersOf(app).nai as unknown as NaiLike;
}

function naiMarkers(app: App): Descriptor {
    const markers = () => nai(app).markerSettings?.() ?? null;
    return {
        id: 'nai.markers',
        owner: 'nai',
        usedIn: 'prompt',
        slot: 'nai_studio_markers',
        present: () => nai(app).present() && markers() !== null,
        setting: () => {
            const current = markers();
            if (!current) return null;
            return current.preset === 'custom' ? current.template : '';
        },
        // '' gives NAI Studio back its built-in instruction (its «natural» preset; the custom text stays stored).
        write: (text) => {
            const current = markers();
            if (!current) return false;
            return text.trim()
                ? nai(app).setMarkerInstruction?.({ preset: 'custom', template: text }) === true
                : nai(app).setMarkerInstruction?.({
                      preset: current.preset === 'custom' ? 'natural' : current.preset,
                      template: current.template,
                  }) === true;
        },
        snapshot: () => {
            const current = markers();
            return current ? { preset: current.preset, template: current.template } : null;
        },
        restore: (raw) => {
            if (!isDict(raw) || typeof raw.template !== 'string') return false;
            const preset = raw.preset === 'tags' || raw.preset === 'custom' ? raw.preset : 'natural';
            return nai(app).setMarkerInstruction?.({ preset, template: raw.template }) === true;
        },
        guardPaths: ['nai.markers'],
        scopable: true,
        // NAI Studio builds the instruction from its template before every generation: what its slot holds then.
        outgoing: (slotValue) => slotValue,
        render: (text) => {
            const current = markers();
            if (!current) return text;
            return fillDoubleBraces(text, {
                min: String(current.min),
                max: String(current.max),
                captionLanguage: current.captionLanguage || 'the language of the reply',
            });
        },
    };
}

/* ------------------------------------------------------------------ Qvink */

interface QvinkLike {
    present(): boolean;
    textSetting?(key: QvinkTextKey): string | null;
    setTextSetting?(key: QvinkTextKey, text: string): boolean;
}

function qvink(app: App): QvinkLike {
    return adaptersOf(app).qvink as unknown as QvinkLike;
}

function qvinkText(app: App, id: string, key: QvinkTextKey, usedIn: 'prompt' | 'background'): Descriptor {
    return {
        id,
        owner: 'qvink',
        usedIn,
        present: () => qvink(app).present() && typeof qvink(app).textSetting === 'function',
        setting: () => qvink(app).textSetting?.(key) ?? '',
        write: (text) => qvink(app).setTextSetting?.(key, text) === true,
        guardPaths: [`qvink.${key}`],
        scopable: false,
        noteKey: usedIn === 'background' ? 'm36.note.background' : 'm36.note.memories',
        outgoing: () => null,
        render: (text) => text,
    };
}

/* ------------------------------------------------------------------ DES-RU, CarrotKernel, Maestro (read-only) */

function desruLock(app: App): Descriptor {
    return {
        id: 'desru.languageLock',
        owner: 'desru',
        usedIn: 'prompt',
        slot: 'desru_bunnymo_language',
        present: () => {
            const adapter = adaptersOf(app).desru as unknown as {
                present(): boolean;
                moduleEnabled?(m: string): boolean;
            };
            return adapter.present() && adapter.moduleEnabled?.('bunnymo') !== false;
        },
        scopable: true,
        noteKey: 'm36.note.desru',
        outgoing: (slotValue) => slotValue,
        render: (text) => text,
    };
}

function ckConsistency(app: App): Descriptor {
    return {
        id: 'ck.consistency',
        owner: 'ck',
        usedIn: 'prompt',
        slot: CK_CONSISTENCY_SLOT,
        present: () => adaptersOf(app).ck.present(),
        scopable: false,
        noteKey: 'm36.note.ckScene',
        outgoing: () => null,
        render: (text) => text,
    };
}

function ckTemplate(app: App): Descriptor {
    return {
        id: 'ck.template',
        owner: 'ck',
        usedIn: 'prompt',
        present: () => adaptersOf(app).ck.present(),
        builtin: () => {
            const templates = adaptersOf(app).ck.settings()?.templates;
            const template = isDict(templates) ? templates.character_consistency : undefined;
            return isDict(template) && typeof template.content === 'string' ? template.content : null;
        },
        scopable: false,
        noteKey: 'm36.note.ckTemplate',
        outgoing: () => null,
        render: (text) => text,
    };
}

/** Maestro's own injections (core/ephemeral: slot `maestro_<key>`), by the module that writes them. */
export const MAESTRO_INJECTIONS: readonly { id: string; moduleKey: string; slot: string }[] = [
    { id: 'maestro.director', moduleKey: 'director', slot: 'maestro_director' },
    { id: 'maestro.voices', moduleKey: 'voices', slot: 'maestro_voices' },
    { id: 'maestro.mechanics', moduleKey: 'mechanics', slot: 'maestro_mechanics' },
    { id: 'maestro.mechanicsFacts', moduleKey: 'mechanics', slot: 'maestro_mechanics_facts' },
    { id: 'maestro.wardrobe', moduleKey: 'wardrobe', slot: 'maestro_wardrobe' },
    { id: 'maestro.offscreen', moduleKey: 'offscreen', slot: 'maestro_offscreen' },
    { id: 'maestro.recap', moduleKey: 'chronicle', slot: 'maestro_chronicle_recap' },
    { id: 'maestro.messageStyle', moduleKey: 'messageStyle', slot: 'maestro_messageStyle.hint' },
    { id: 'maestro.qualityFix', moduleKey: 'quality', slot: 'maestro_quality_fix' },
];

function maestroInjection(app: App, spec: (typeof MAESTRO_INJECTIONS)[number]): Descriptor {
    return {
        id: spec.id,
        owner: 'maestro',
        usedIn: 'prompt',
        slot: spec.slot,
        moduleKey: spec.moduleKey,
        present: () => app.settings.isModuleEnabled(spec.moduleKey),
        scopable: false,
        noteKey: 'm36.note.maestro',
        outgoing: () => null,
        render: (text) => text,
    };
}

/** Every entry of the registry, in the order the list shows them. */
export function createDescriptors(app: App): Descriptor[] {
    return [
        desPrompt(app, 'des.tracker', 'customTrackerPrompt', { userName: true, trackerBlock: true }),
        desPrompt(app, 'des.trackerInstructions', 'customTrackerInstructionsPrompt', { userName: true }),
        desPrompt(app, 'des.trackerContinuation', 'customTrackerContinuationPrompt'),
        desPrompt(app, 'des.html', 'customHtmlPrompt'),
        desPrompt(app, 'des.dialogueColoring', 'customDialogueColoringPrompt'),
        desPrompt(app, 'des.contextInstructions', 'customContextInstructionsPrompt'),
        desPrompt(app, 'des.narrator', 'customNarratorPrompt'),
        naiMarkers(app),
        qvinkText(app, 'qvink.prompt', 'prompt', 'background'),
        qvinkText(app, 'qvink.shortTemplate', 'short_template', 'prompt'),
        qvinkText(app, 'qvink.longTemplate', 'long_template', 'prompt'),
        desruLock(app),
        ckConsistency(app),
        ckTemplate(app),
        ...MAESTRO_INJECTIONS.map((spec) => maestroInjection(app, spec)),
    ];
}
