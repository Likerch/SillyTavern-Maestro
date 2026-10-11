// M42 «Мастерская», pure helpers. A helper card (scenario or character creator, an editor) carries a workshop tag of
// ST's tag list; its chats are workshop chats: the story machinery of the stack stays silent there. This file decides
// which card is a workshop card, which extension prompt slots stay in such a chat (ST's own: the card's depth prompt,
// the Author's Note, lore that is left, vectors), how the other slots' texts are cut out of the outgoing Chat
// Completion messages, and which lorebooks stay. Pure: no DOM, no SillyTavern.
import { messageTextParts, slotNeedles } from './architect-prompt';
import { MIN_NEEDLE_LENGTH } from './neighbour-prompts';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tag names that make a card a workshop card, by default. */
export const DEFAULT_WORKSHOP_TAGS: readonly string[] = ['мастерская', 'workshop'];

/** How a tag name is compared: case, «ё», the spaces and a leading «#» do not matter. */
export function normalizeTagName(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').trim().replace(/^#/, '').replace(/\s+/g, ' ').trim();
}

/**
 * The workshop tag of a card, or null: the first of its tags whose name is one of `workshopTags`.
 * `tagIds` = ST's tag_map entry of the card, `tags` = ST's tag list.
 */
export function workshopTagOf(
    tagIds: readonly unknown[] | undefined,
    tags: readonly { id: string; name: string }[] | undefined,
    workshopTags: readonly string[],
): { id: string; name: string } | null {
    if (!tagIds?.length || !tags?.length) return null;
    const wanted = new Set(workshopTags.map(normalizeTagName).filter(Boolean));
    if (!wanted.size) return null;
    for (const id of tagIds) {
        const tag = tags.find((item) => item.id === id);
        if (tag && wanted.has(normalizeTagName(tag.name))) return tag;
    }
    return null;
}

/** The tag names of the setting: one per line or comma, empty ones dropped, each once. */
export function parseTagList(text: string): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of text.split(/[\n,;]+/)) {
        const name = raw.trim();
        const key = normalizeTagName(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

/**
 * Extension prompt slots of SillyTavern itself that stay in a workshop chat: the story string (Text Completion), quiet
 * prompts, the card's own depth prompt, lore that is left after the workshop's lore filter (at depth and outlets), the
 * Author's Note, and vector memories of this chat and its Data Bank (constants.js inject_ids, authors-note.js,
 * extensions/vectors). Everything else is a neighbour's or Maestro's injection.
 */
const KEPT_SLOT_PREFIXES: readonly string[] = [
    '__STORY_STRING__',
    'QUIET_PROMPT',
    'DEPTH_PROMPT',
    'customDepthWI',
    'customWIOutlet_',
    '2_floating_prompt',
    '3_vectors',
    '4_vectors_data_bank',
];

export function keepsSlot(key: string): boolean {
    return KEPT_SLOT_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

/** The slots to cut out: not ST's own, with a text long enough not to match by chance. */
export function slotsToCut(slots: Record<string, unknown> | undefined): { key: string; value: string }[] {
    if (!slots) return [];
    const result: { key: string; value: string }[] = [];
    for (const [key, slot] of Object.entries(slots)) {
        if (keepsSlot(key) || !isDict(slot) || typeof slot.value !== 'string') continue;
        if (slot.value.trim().length < MIN_NEEDLE_LENGTH) continue;
        result.push({ key, value: slot.value });
    }
    return result;
}

function setPartText(message: Dict, part: number, text: string): void {
    if (typeof message.content === 'string') {
        message.content = text;
        return;
    }
    if (!Array.isArray(message.content)) return;
    const parts = [...(message.content as unknown[])];
    const old = parts[part];
    if (!isDict(old)) return;
    parts[part] = { ...old, text };
    message.content = parts;
}

/** Blank lines left where a text was cut out are folded to one. */
function tidy(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Cuts every form of each text (as set, trimmed, macro-substituted) out of the messages, in place; a message left
 * without text (only whitespace, no image parts) is removed from the array. Returns the slot keys found and cut.
 */
export function cutTexts(
    messages: unknown[],
    texts: readonly { key: string; value: string }[],
    substitute?: (text: string) => string,
): string[] {
    const cut: string[] = [];
    const touched = new Set<Dict>();
    for (const { key, value } of texts) {
        // Longest forms first: the trimmed text is inside the untrimmed one.
        const needles = slotNeedles(value, substitute)
            .filter((needle) => needle.trim().length >= MIN_NEEDLE_LENGTH)
            .sort((a, b) => b.length - a.length);
        let found = false;
        for (const needle of needles) {
            for (const message of messages) {
                if (!isDict(message)) continue;
                messageTextParts(message).forEach((text, part) => {
                    if (!text.includes(needle)) return;
                    setPartText(message, part, tidy(text.split(needle).join('')));
                    touched.add(message);
                    found = true;
                });
            }
        }
        if (found) cut.push(key);
    }
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!isDict(message) || !touched.has(message)) continue;
        const hasMedia =
            Array.isArray(message.content) && message.content.some((part) => isDict(part) && part.type !== 'text');
        if (!hasMedia && messageTextParts(message).every((text) => !text.trim())) messages.splice(index, 1);
    }
    return cut;
}

/** Which lorebooks stay in a workshop chat: none, the card's and the chat's own (default), or all as usual. */
export type WorkshopLore = 'none' | 'own' | 'all';

export const WORKSHOP_LORE_MODES: readonly WorkshopLore[] = ['own', 'none', 'all'];

const LORE_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'] as const;

/**
 * WORLDINFO_ENTRIES_LOADED payload filtered in place (ST keeps using these very arrays): 'own' empties the global and
 * persona lists, 'none' all four, 'all' none. Returns how many entries were dropped.
 */
export function filterLore(payload: unknown, mode: WorkshopLore): number {
    if (mode === 'all' || !isDict(payload)) return 0;
    let dropped = 0;
    for (const name of LORE_LISTS) {
        if (mode === 'own' && (name === 'characterLore' || name === 'chatLore')) continue;
        const list = payload[name];
        if (!Array.isArray(list) || !list.length) continue;
        dropped += list.length;
        list.splice(0, list.length);
    }
    return dropped;
}
