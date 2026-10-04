//#region src/adapters/base.ts
function isDict$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringList(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
/** The page document, or null outside a browser (unit tests in the node environment). */
function pageDocument() {
	return typeof document === "undefined" ? null : document;
}
/** True when an element matching `selector` is on the page. */
function hasElement(selector) {
	try {
		return !!pageDocument()?.querySelector(selector);
	} catch {
		return false;
	}
}
function extras(host) {
	return host.ctx();
}
/** `extension_settings[key]` when it is an object. */
function extensionSettingsOf(host, key) {
	const value = host.ctx().extensionSettings[key];
	return isDict$1(value) ? value : null;
}
function toManifest(value) {
	if (!isDict$1(value)) return null;
	const manifest = {};
	for (const key of [
		"display_name",
		"version",
		"js",
		"homePage",
		"generate_interceptor"
	]) {
		const field = value[key];
		if (typeof field === "string") manifest[key] = field;
	}
	return manifest;
}
var EXTENSION_PATH_RE = /\/scripts\/extensions\/(third-party\/[^/]+)\//;
/** Absolute URL of a script element's `src`, resolved against the document (null when unparseable). */
function scriptHref(script, doc) {
	const raw = script.getAttribute("src");
	if (!raw) return null;
	try {
		return new URL(raw, doc.baseURI || "http://localhost/").href;
	} catch {
		return null;
	}
}
function decodedPath(href) {
	try {
		return decodeURIComponent(new URL(href).pathname);
	} catch {
		return "";
	}
}
/**
* Finds installed extensions. Names come from ST's `extensionNames` (scripts/extensions.js), from the module
* scripts ST put on the page, and from known folder names; manifests from ST's own manifest cache
* (`getExtensionManifest`, the JSON ST fetched from `/scripts/extensions/<name>/manifest.json` at start, i.e. the
* version actually running) and, on an ST without it, from that URL directly. Everything is fetched once.
* Global and per-user installs both live under `/scripts/extensions/third-party/<folder>/`, so one lookup fits both.
*/
var ExtensionLocator = class {
	host;
	log;
	fetchManifest;
	namesPromise = null;
	manifests = /* @__PURE__ */ new Map();
	constructor(host, log, fetchManifest) {
		this.host = host;
		this.log = log;
		this.fetchManifest = fetchManifest;
	}
	/** Internal names of every extension ST knows about, plus third-party scripts found on the page. */
	names() {
		this.namesPromise ??= this.loadNames();
		return this.namesPromise;
	}
	manifest(name) {
		let cached = this.manifests.get(name);
		if (!cached) {
			cached = this.loadManifest(name);
			this.manifests.set(name, cached);
		}
		return cached;
	}
	/** First third-party extension whose manifest matches; `known` folder names are tried after ST's list. */
	async find(match, known) {
		const names = (await this.names()).filter((name) => name.startsWith("third-party/"));
		const candidates = [...names, ...known.filter((name) => !names.includes(name))];
		for (const name of candidates) {
			const manifest = await this.manifest(name);
			if (manifest && match(manifest)) return {
				name,
				manifest
			};
		}
		return null;
	}
	/** ST keeps extensions switched off in its Extensions panel in `extension_settings.disabledExtensions`. */
	isDisabled(name) {
		const list = this.host.ctx().extensionSettings.disabledExtensions;
		return Array.isArray(list) && list.includes(name);
	}
	/**
	* The extension's own module script on the page (ST inserts `<script type="module"
	* src="/scripts/extensions/<name>/<js>">` only for enabled extensions). Its URL is the base for importing the
	* extension's modules. Null when ST has not loaded it.
	*/
	scriptOf(located) {
		const doc = pageDocument();
		if (!doc) return null;
		const suffix = `/scripts/extensions/${located.name}/${located.manifest.js || "index.js"}`;
		for (const script of doc.querySelectorAll("script[type=\"module\"][src]")) {
			const href = scriptHref(script, doc);
			if (href && decodedPath(href).endsWith(suffix)) return href;
		}
		return null;
	}
	async loadNames() {
		const names = /* @__PURE__ */ new Set();
		try {
			const module = await this.host.modules.load("extensions.js");
			for (const name of stringList(module.extensionNames)) names.add(name);
		} catch (error) {
			this.log.debug("ST extension list is not available; using page scripts and known folders", error);
		}
		const doc = pageDocument();
		for (const script of doc?.querySelectorAll("script[type=\"module\"][src]") ?? []) {
			const href = doc ? scriptHref(script, doc) : null;
			const match = href ? EXTENSION_PATH_RE.exec(decodedPath(href)) : null;
			if (match?.[1]) names.add(match[1]);
		}
		return [...names];
	}
	async loadManifest(name) {
		const lookup = extras(this.host).getExtensionManifest;
		if (typeof lookup === "function") try {
			return toManifest(lookup(name));
		} catch (error) {
			this.log.debug(`getExtensionManifest(${name}) failed`, error);
		}
		try {
			const path = name.split("/").map(encodeURIComponent).join("/");
			const response = await this.fetchManifest(`/scripts/extensions/${path}/manifest.json`, { cache: "no-store" });
			return response.ok ? toManifest(await response.json()) : null;
		} catch {
			return null;
		}
	}
};
/**
* Base of the adapters. Subclasses register their capabilities in the constructor and implement `connect()`
* (one attempt; resolves `true` when there is nothing left to retry: connected, not installed, or disabled).
*/
var NeighbourBase = class {
	deps;
	located = null;
	probes = /* @__PURE__ */ new Map();
	settled = false;
	pending = null;
	constructor(deps) {
		this.deps = deps;
	}
	get host() {
		return this.deps.host;
	}
	get log() {
		return this.deps.log;
	}
	/** Version from the neighbour's manifest; undefined until ready() located it. */
	version() {
		return this.located?.manifest.version;
	}
	/** ST's internal name of the neighbour (`third-party/<folder>`), when located. */
	extensionName() {
		return this.located?.name;
	}
	/** Capability ids whose probes pass right now. */
	capabilities() {
		return [...this.probes].filter(([, probe]) => probe()).map(([id]) => id);
	}
	/** Every capability id this adapter can report, available or not. */
	capabilityIds() {
		return [...this.probes.keys()];
	}
	ready() {
		if (this.settled) return Promise.resolve();
		this.pending ??= this.connect().then((settled) => {
			this.settled = settled;
		}, (error) => {
			this.log.warn("connection failed", error);
		}).finally(() => {
			this.pending = null;
		});
		return this.pending;
	}
	/**
	* Registers a capability in `host.caps` and in this adapter's list. Probes never throw. `refresh` runs before
	* the probe when Capabilities refreshes (for data that has to be loaded first).
	*/
	capability(id, probe, detail, refresh) {
		const safe = () => {
			try {
				return probe();
			} catch (error) {
				this.log.debug(`probe ${id} failed`, error);
				return false;
			}
		};
		this.probes.set(id, safe);
		const hostProbe = refresh ? async () => {
			try {
				await refresh();
			} catch (error) {
				this.log.debug(`refresh for ${id} failed`, error);
			}
			return safe();
		} : safe;
		this.host.caps.register(id, hostProbe, detail);
	}
	/** Located, and not switched off in ST's Extensions panel. */
	enabledInSt() {
		return this.located !== null && !this.deps.locator.isDisabled(this.located.name);
	}
	/** Locates the neighbour by manifest; logs what was found. */
	async locate(match, known) {
		this.located ??= await this.deps.locator.find(match, known);
		if (this.located) {
			const state = this.deps.locator.isDisabled(this.located.name) ? "disabled in ST" : "enabled";
			this.log.debug(`${this.located.name} ${this.located.manifest.version ?? "?"} (${state})`);
		}
	}
	/** The neighbour's module script URL (live: ST adds it while loading extensions). */
	scriptUrl() {
		return this.located ? this.deps.locator.scriptOf(this.located) : null;
	}
};
/** Case-insensitive "homePage contains". */
function homePageHas(manifest, fragment) {
	return (manifest.homePage ?? "").toLowerCase().includes(fragment.toLowerCase());
}
//#endregion
//#region src/domain/bunnymo.ts
/** Sheet commands of the core lorebook (core entries #2–#7). */
var BUNNYMO_SHEET_COMMANDS = Object.freeze([
	"!fullsheet",
	"!quicksheet",
	"!tagsheet",
	"!memsheet",
	"!updatesheet",
	"!physheet"
]);
/** Comment prefixes of core entries; titles are stable between BunnyMo versions, uids are not. */
var CORE_COMMENT_RE = /Master - |AUTO-TRIGGER:|AUTO-FILTRATION:|ANTI[\s-]*CLANKER|HawThorne Link/i;
/** A pack key: `<SPECIES:ELF>`, `<DEPRESSION>`, `<ENFJ-U>`. */
var PACK_KEY_RE = /^<([A-Za-z][A-Za-z0-9_-]*)(?::([^<>]+))?>$/;
/** A character tag block: `<BunnymoTags>…</BunnymoTags>` (with a colon it is an entry wrapper instead). */
var TAG_BLOCK_RE = /<bunnymotags>([\s\S]*?)<\/bunnymotags>/i;
var TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
/** Bare MBTI archetype without a colon: `<ESFP-H>`, `<INTJ-U>`. MBTI pack entries fire on it. */
var MBTI_TAG_RE = /<([EI][NS][FT][JP]-[UH])>/gi;
/**
* Template placeholders in place of a tag value or name: `<Name:NAME>`, `<GENRE:BLANK>`, `<Dere:NEW>`.
* NONE and OLD are not placeholders: packs have entries for `<LING:NONE>` and `<LING:OLD>`.
*/
var PLACEHOLDER_RE = /^(?:BLANK|NEW|VALUE|TARGET|NAME|NAME[\s_]HERE|PLACEHOLDER|TBD|X{3,})$/i;
/** Entry wrapper `<BunnymoTags:Title>…</BunnymoTags:Title>`, used by the core and by some packs. */
var WRAPPED_RE = /^<BunnymoTags:/i;
function text$1(value) {
	return value === void 0 || value === null ? "" : String(value);
}
/** Primary and secondary keys of an entry, trimmed, without empty ones. */
function entryKeys(entry) {
	const list = (value) => Array.isArray(value) ? value : [];
	return [...list(entry?.key), ...list(entry?.keysecondary)].map((key) => text$1(key).trim()).filter(Boolean);
}
/**
* Is this an entry of the BunnyMo core lorebook? By a sheet command in its keys or by a known entry title.
* The `<BunnymoTags:…>` wrapper is no sign: pack entries (CarrotCast, Linguistics, lenses) use it too.
*/
function isBunnyMoCoreEntry(entry) {
	if (entryKeys(entry).some((key) => BUNNYMO_SHEET_COMMANDS.includes(key.toLowerCase()))) return true;
	return CORE_COMMENT_RE.test(text$1(entry?.comment));
}
/**
* Which books are BunnyMo: the core (3+ core entries) and packs ((3+ tag-keyed entries that are at least 60 %
* of the keyed entries) or 3+ wrapped entries). Entries without `world` are ignored.
*/
function classifyWorlds(entries) {
	const stats = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const world = text$1(entry?.world);
		if (!world) continue;
		const item = stats.get(world) ?? {
			core: 0,
			keyed: 0,
			tagged: 0,
			wrapped: 0
		};
		if (isBunnyMoCoreEntry(entry)) item.core += 1;
		if (WRAPPED_RE.test(text$1(entry?.content).trimStart())) item.wrapped += 1;
		const keys = entryKeys(entry);
		if (keys.length) {
			item.keyed += 1;
			if (keys.some((key) => PACK_KEY_RE.test(key))) item.tagged += 1;
		}
		stats.set(world, item);
	}
	const core = /* @__PURE__ */ new Set();
	const packs = /* @__PURE__ */ new Set();
	for (const [world, item] of stats) if (item.core >= 3) core.add(world);
	else if (item.tagged >= 3 && item.tagged / Math.max(item.keyed, 1) >= .6 || item.wrapped >= 3) packs.add(world);
	return {
		core,
		packs
	};
}
/**
* Character tags of an archive entry: name (from `<Name:…>`), `<KEY:VALUE>` tags and the MBTI archetype.
* Template placeholders (`<GENRE:BLANK>`, `<Dere:NEW>`) are skipped.
*/
function archiveTags(entry) {
	const block = TAG_BLOCK_RE.exec(text$1(entry?.content));
	if (!block?.[1]) return {
		name: null,
		tags: []
	};
	let name = null;
	const tags = /* @__PURE__ */ new Set();
	for (const match of block[1].matchAll(TAG_RE)) {
		const key = (match[1] ?? "").trim();
		const value = (match[2] ?? "").trim();
		if (key.toUpperCase() === "NAME") name = value;
		else if (!PLACEHOLDER_RE.test(value)) tags.add(`<${key.toUpperCase()}:${value}>`);
	}
	for (const match of block[1].matchAll(MBTI_TAG_RE)) tags.add(`<${(match[1] ?? "").toUpperCase()}>`);
	return {
		name,
		tags: [...tags]
	};
}
/**
* A character archive: an entry with a `<BunnymoTags>` block holding a real name or tags (a CarrotKernel
* archive, BunnyMo example #43). Not archives: sheet templates of the core (`<Name:NAME>`, `<…:BLANK>`) and any
* block whose name is a placeholder.
*/
function isCharacterArchive(entry) {
	if (!TAG_BLOCK_RE.test(text$1(entry?.content)) || isBunnyMoCoreEntry(entry)) return false;
	const { name, tags } = archiveTags(entry);
	return name !== null ? !PLACEHOLDER_RE.test(name) : tags.length > 0;
}
/** Books that hold at least one character archive (by `world`). */
function archiveWorlds(entries) {
	const worlds = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const world = text$1(entry?.world);
		if (world && !worlds.has(world) && isCharacterArchive(entry)) worlds.add(world);
	}
	return worlds;
}
//#endregion
//#region src/adapters/bunnymo/index.ts
/** ST's `getCharaFilename`: the avatar file name without its extension (key of `world_info.charLore`). */
function avatarKey(avatar) {
	return avatar.replace(/\.[^/.]+$/, "");
}
var BunnyMoAdapter = class extends NeighbourBase {
	id = "bunnymo";
	state = {
		core: [],
		packs: [],
		archives: []
	};
	facts = /* @__PURE__ */ new Map();
	refreshing = null;
	listeners = [];
	constructor(deps) {
		super(deps);
		const refresh = () => this.refresh();
		this.capability("bunnymo.core", () => this.state.core.length > 0, void 0, refresh);
		this.capability("bunnymo.packs", () => this.state.packs.length > 0, void 0, refresh);
		this.capability("bunnymo.archives", () => this.state.archives.length > 0, void 0, refresh);
	}
	/** BunnyMo is in use: its core or a pack is active (as of the last refresh). */
	present() {
		return this.state.core.length > 0 || this.state.packs.length > 0;
	}
	/** BunnyMo has no manifest; the core version is not recorded in its files. */
	version() {}
	/** Last classification of the active books (a copy). */
	books() {
		return {
			core: [...this.state.core],
			packs: [...this.state.packs],
			archives: [...this.state.archives]
		};
	}
	/** Re-reads which books are active and classifies the ones not cached yet. Concurrent calls share one run. */
	refresh() {
		this.refreshing ??= this.classifyActive().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}
	/** Stops listening to ST (the host also drops its listeners on dispose). */
	dispose() {
		for (const unsubscribe of this.listeners.splice(0)) unsubscribe();
	}
	async connect() {
		if (!this.listeners.length) this.listen();
		await this.refresh();
		return true;
	}
	/**
	* Names of the books ST scans now: global selection, chat book, persona book, the primary and extra books of
	* the current character (every member in a group chat). Unknown names (deleted books) are skipped.
	*/
	async activeBooks() {
		const ctx = this.host.ctx();
		const names = /* @__PURE__ */ new Set();
		let charLore = [];
		try {
			const worldInfo = await this.host.modules.worldInfo();
			for (const name of stringList(worldInfo.selected_world_info)) names.add(name);
			const settings = worldInfo.world_info;
			if (isDict$1(settings) && Array.isArray(settings.charLore)) charLore = settings.charLore;
		} catch (error) {
			this.log.debug("world-info.js is not available; global books are skipped", error);
		}
		const chatBook = ctx.chatMetadata.world_info;
		if (typeof chatBook === "string" && chatBook) names.add(chatBook);
		const personaBook = ctx.powerUserSettings.persona_description_lorebook;
		if (typeof personaBook === "string" && personaBook) names.add(personaBook);
		const members = ctx.groupId ? (ctx.groups.find((group) => group.id === ctx.groupId)?.members ?? []).map((avatar) => ctx.characters.find((character) => character.avatar === avatar)) : [ctx.characterId === void 0 ? void 0 : ctx.characters[Number(ctx.characterId)]];
		for (const character of members) {
			if (!character) continue;
			const primary = character.data?.extensions?.world;
			if (typeof primary === "string" && primary) names.add(primary);
			const key = avatarKey(character.avatar ?? "");
			for (const lore of charLore) if (isDict$1(lore) && lore.name === key) for (const book of stringList(lore.extraBooks)) names.add(book);
		}
		const known = extras(this.host).getWorldInfoNames?.() ?? [];
		return known.length ? [...names].filter((name) => known.includes(name)) : [...names];
	}
	listen() {
		const on = (key, handler) => {
			const name = this.host.events.name(key);
			if (name) this.listeners.push(this.host.events.on(name, handler));
		};
		on("WORLDINFO_UPDATED", (name) => {
			if (typeof name === "string") this.facts.delete(name);
		});
		const refresh = () => void this.refresh();
		on("CHAT_CHANGED", refresh);
		on("WORLDINFO_SETTINGS_UPDATED", refresh);
	}
	async classifyActive() {
		const books = await this.activeBooks();
		const next = {
			core: [],
			packs: [],
			archives: []
		};
		for (const book of books) {
			const facts = this.facts.get(book) ?? await this.classifyBook(book);
			if (!facts) continue;
			if (facts.core) next.core.push(book);
			else if (facts.pack) next.packs.push(book);
			if (facts.archives) next.archives.push(book);
		}
		this.state = next;
	}
	async classifyBook(book) {
		const load = extras(this.host).loadWorldInfo;
		if (typeof load !== "function") return null;
		let data;
		try {
			data = await load(book);
		} catch (error) {
			this.log.debug(`lorebook ${book} did not load`, error);
			return null;
		}
		if (!isDict$1(data) || !isDict$1(data.entries)) return null;
		const entries = [];
		const enabled = [];
		for (const raw of Object.values(data.entries)) {
			if (!isDict$1(raw)) continue;
			const entry = {
				key: raw.key,
				keysecondary: raw.keysecondary,
				comment: raw.comment,
				content: raw.content,
				world: book
			};
			entries.push(entry);
			if (raw.disable !== true) enabled.push(entry);
		}
		const { core, packs } = classifyWorlds(entries);
		const facts = {
			core: core.has(book),
			pack: packs.has(book),
			archives: archiveWorlds(enabled).has(book)
		};
		this.facts.set(book, facts);
		return facts;
	}
};
//#endregion
//#region src/adapters/ck/index.ts
var CK_DISPLAY_NAME = "CarrotKernel";
var CK_KNOWN_NAMES = ["third-party/CarrotKernel"];
var CK_SETTINGS_KEY = "CarrotKernel";
function isCkManifest(manifest) {
	return manifest.display_name === CK_DISPLAY_NAME;
}
function globalObject(name) {
	const value = globalThis[name];
	return isDict$1(value) ? value : null;
}
var CkAdapter = class extends NeighbourBase {
	id = "ck";
	constructor(deps) {
		super(deps);
		this.capability("ck.present", () => this.present());
		this.capability("ck.repos", () => this.present() && this.repoBooks().length > 0);
		this.capability("ck.rag", () => this.present() && this.ragEnabled() && !!globalObject("CarrotKernelFullsheetRag"));
	}
	present() {
		return !(this.located !== null && this.deps.locator.isDisabled(this.located.name)) && this.kernel() !== null;
	}
	async connect() {
		await this.locate(isCkManifest, CK_KNOWN_NAMES);
		return true;
	}
	/**
	* `window.CarrotKernel`, read live: CK creates it at the top level of its module, so it exists as soon as ST has
	* loaded CK. Never call sheet-generator setup through it.
	*/
	kernel() {
		return globalObject("CarrotKernel");
	}
	/** `extension_settings.CarrotKernel` (live object, read-only for Maestro). */
	settings() {
		return extensionSettingsOf(this.host, CK_SETTINGS_KEY);
	}
	/** CK's own master switch (on unless explicitly false). */
	enabled() {
		return this.settings()?.enabled !== false;
	}
	/** Lorebooks marked as Character Repos (archives CK scans for `<BunnymoTags>`). */
	repoBooks() {
		return stringList(this.settings()?.characterRepoBooks);
	}
	/** Lorebooks marked as Tag Libraries. */
	tagLibraries() {
		return stringList(this.settings()?.tagLibraries);
	}
	ragEnabled() {
		const rag = this.settings()?.rag;
		return isDict$1(rag) && rag.enabled === true;
	}
};
//#endregion
//#region src/domain/des-tracker.ts
/** DES's English off-scene detector (portraitBar.js getCharacterList); it also matches DES-RU's `(off-scene)`. */
var OFF_SCENE_RE = /\b(not\s+(currently\s+)?(in|at|present\s+in|present\s+at)\s+(the\s+)?(scene|area|room|location|vicinity))\b|\b(off[\s-]?scene)\b|\b(not\s+physically\s+present)\b|\b(absent\s+from\s+(the\s+)?(scene|room|area|location))\b|\b(away\s+from\s+(the\s+)?scene)\b/i;
/** Values DES (and DES-RU's "Нет" → "None" fix) use for "no quest". */
var NO_QUEST_RE = /^(?:none|нет)$/i;
var FENCE_RE = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i;
var KNOWN_INFO_KEYS = /* @__PURE__ */ new Set([
	"location",
	"date",
	"time",
	"weather",
	"temperature",
	"recentEvents"
]);
function isDict(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Trims and drops brackets that wrap the whole value (`[Friend]`), as DES's renderers do. */
function clean(value) {
	let result = value.trim();
	while (result.length >= 2 && result.startsWith("[") && result.endsWith("]")) result = result.slice(1, -1).trim();
	return result;
}
/** Text of a scalar or of `{value}` / `{text}` / `{description}`; arrays joined with ", ". Empty → undefined. */
function textOf(value) {
	if (typeof value === "string") return clean(value) || void 0;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts = value.map(textOf).filter((part) => !!part);
		return parts.length ? parts.join(", ") : void 0;
	}
	if (isDict(value)) for (const key of [
		"value",
		"text",
		"description",
		"content",
		"title"
	]) {
		const inner = textOf(value[key]);
		if (inner) return inner;
	}
}
/**
* Parses one tracker section. Strings are JSON (optionally inside a ``` fence); already-parsed values pass
* through; anything unparseable gives null (DES's legacy text formats are not read).
*/
function parseTrackerJson(raw) {
	if (raw === void 0 || raw === null) return null;
	if (typeof raw !== "string") return raw;
	let source = raw.trim();
	if (!source) return null;
	const fenced = FENCE_RE.exec(source);
	if (fenced?.[1] !== void 0) source = fenced[1].trim();
	try {
		return JSON.parse(source);
	} catch {
		return null;
	}
}
function statsOf(raw) {
	const stats = [];
	const push = (name, value) => {
		if (typeof name !== "string" || !name.trim()) return;
		if (typeof value === "number" && Number.isFinite(value)) stats.push({
			name: name.trim(),
			value
		});
		else if (typeof value === "string" && value.trim()) stats.push({
			name: name.trim(),
			value: value.trim()
		});
	};
	if (Array.isArray(raw)) {
		for (const item of raw) if (isDict(item)) push(item.name, item.value);
	} else if (isDict(raw)) for (const [name, value] of Object.entries(raw)) push(name, isDict(value) ? value.value : value);
	return stats;
}
function detailsOf(raw) {
	const details = {};
	if (!isDict(raw)) return details;
	for (const [key, value] of Object.entries(raw)) {
		const text = textOf(value);
		if (key && text) details[key] = text;
	}
	return details;
}
function relationshipOf(entry) {
	if (typeof entry.Relationship === "string") return clean(entry.Relationship) || void 0;
	const relationship = entry.relationship;
	if (isDict(relationship)) return textOf(relationship.status) ?? textOf(relationship);
	return textOf(relationship);
}
function thoughtsOf(entry) {
	const thoughts = entry.thoughts;
	if (isDict(thoughts)) return textOf(thoughts.content) ?? textOf(thoughts);
	return textOf(thoughts);
}
function characterOf(raw) {
	if (!isDict(raw) || typeof raw.name !== "string" || !raw.name.trim()) return null;
	const thoughts = thoughtsOf(raw);
	const character = {
		name: raw.name.trim(),
		details: detailsOf(raw.details),
		stats: statsOf(raw.stats),
		offScene: raw.present === false || thoughts !== void 0 && OFF_SCENE_RE.test(thoughts)
	};
	if (typeof raw.emoji === "string" && raw.emoji.trim()) character.emoji = raw.emoji.trim();
	if (typeof raw.color === "string" && raw.color.trim()) character.color = raw.color.trim();
	const relationship = relationshipOf(raw);
	if (relationship) character.relationship = relationship;
	if (thoughts) character.thoughts = thoughts;
	return character;
}
/** Characters from `characterThoughts`: an array (DES 2.6 parse) or `{characters: [...]}` (legacy, defaults). */
function parseDesCharacters(raw) {
	const data = parseTrackerJson(raw);
	const list = Array.isArray(data) ? data : isDict(data) && Array.isArray(data.characters) ? data.characters : [];
	const characters = [];
	for (const item of list) {
		const character = characterOf(item);
		if (character) characters.push(character);
	}
	return characters;
}
function timeOf(raw) {
	if (isDict(raw)) {
		const start = textOf(raw.start) ?? textOf(raw.value);
		const end = textOf(raw.end);
		if (!start && !end) return void 0;
		const time = {};
		if (start) time.start = start;
		if (end) time.end = end;
		return time;
	}
	const flat = textOf(raw);
	return flat ? { start: flat } : void 0;
}
function weatherOf(raw) {
	if (isDict(raw)) {
		const emoji = textOf(raw.emoji);
		const forecast = textOf(raw.forecast) ?? textOf(raw.value);
		if (!emoji && !forecast) return void 0;
		const weather = {};
		if (emoji) weather.emoji = emoji;
		if (forecast) weather.forecast = forecast;
		return weather;
	}
	const flat = textOf(raw);
	return flat ? { forecast: flat } : void 0;
}
function temperatureOf(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
	if (typeof raw === "string") return raw.trim() ? { value: raw.trim() } : void 0;
	if (!isDict(raw)) return void 0;
	const value = raw.value;
	const temperature = typeof value === "number" && Number.isFinite(value) ? { value } : typeof value === "string" && value.trim() ? { value: value.trim() } : void 0;
	const unit = textOf(raw.unit);
	if (temperature && unit) temperature.unit = unit;
	return temperature;
}
function eventsOf(raw) {
	if (Array.isArray(raw)) return raw.map(textOf).filter((event) => !!event);
	if (isDict(raw) && raw.events !== void 0 && raw.value === void 0) return eventsOf(raw.events);
	const flat = textOf(raw);
	return flat ? [flat] : [];
}
/** Scene data from `infoBox`; null when the section is missing or not a JSON object. */
function parseDesInfoBox(raw) {
	const data = parseTrackerJson(raw);
	if (!isDict(data)) return null;
	const info = {
		recentEvents: eventsOf(data.recentEvents),
		fields: {}
	};
	const location = textOf(data.location);
	if (location) info.location = location;
	const date = textOf(data.date);
	if (date) info.date = date;
	const time = timeOf(data.time);
	if (time) info.time = time;
	const weather = weatherOf(data.weather);
	if (weather) info.weather = weather;
	const temperature = temperatureOf(data.temperature);
	if (temperature) info.temperature = temperature;
	for (const [key, value] of Object.entries(data)) {
		if (KNOWN_INFO_KEYS.has(key)) continue;
		const text = textOf(value);
		if (text) info.fields[key] = text;
	}
	return info;
}
/** A quest title from a string, `{title}`, `{value}` (nested) or `{description}`; "None" → null. */
function questOf(raw) {
	let value = raw;
	while (isDict(value) && value.value !== void 0) value = value.value;
	const title = isDict(value) ? textOf(value.title) ?? textOf(value.description) : textOf(value);
	return title && !NO_QUEST_RE.test(title) ? title : null;
}
/** Quests from `quests`: `{main, optional[]}` with string or `{title}` items. Null when missing. */
function parseDesQuests(raw) {
	const data = parseTrackerJson(raw);
	if (!isDict(data)) return null;
	const optional = Array.isArray(data.optional) ? data.optional.map(questOf).filter((quest) => quest !== null) : [];
	return {
		main: questOf(data.main),
		optional
	};
}
/** Parses a raw per-swipe record into a snapshot. */
function parseDesTracker(strings) {
	return {
		characters: parseDesCharacters(strings.characterThoughts),
		infoBox: parseDesInfoBox(strings.infoBox),
		quests: parseDesQuests(strings.quests)
	};
}
function swipeRecordOf(swipes, swipeId) {
	const record = Array.isArray(swipes) ? swipes[swipeId] : isDict(swipes) ? swipes[String(swipeId)] : void 0;
	if (!isDict(record)) return null;
	const { quests = null, infoBox = null, characterThoughts = null } = record;
	if (quests === null && infoBox === null && characterThoughts === null) return null;
	return {
		quests,
		infoBox,
		characterThoughts
	};
}
/**
* The raw tracker record of a chat message for its current swipe: `extra.dooms_tracker_swipes[swipe_id]`, with
* `swipe_info[swipe_id].extra.dooms_tracker_swipes[swipe_id]` as the fallback DES itself uses
* (persistence.js, injector.js). Null for user messages and messages without tracker data (a reply without JSON
* stores an all-null record).
*/
function desSwipeRecord(message) {
	if (!isDict(message) || message.is_user === true) return null;
	const swipeId = typeof message.swipe_id === "number" && message.swipe_id >= 0 ? message.swipe_id : 0;
	const direct = swipeRecordOf((isDict(message.extra) ? message.extra : void 0)?.dooms_tracker_swipes, swipeId);
	if (direct) return direct;
	const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : void 0;
	return swipeRecordOf((isDict(info) && isDict(info.extra) ? info.extra : void 0)?.dooms_tracker_swipes, swipeId);
}
var DES_KNOWN_NAMES = ["third-party/Dooms-Enhancement-Suite"];
var DES_VERIFIED_VERSIONS = ["2.6.0"];
/** DES modules relative to its script; `required` exports are checked by type. */
var DES_MODULES = {
	state: {
		path: "src/core/state.js",
		required: { extensionSettings: "object" }
	},
	persistence: {
		path: "src/core/persistence.js",
		required: {
			saveSettings: "function",
			saveChatData: "function"
		}
	},
	lorebookApi: {
		path: "src/systems/lorebook/lorebookAPI.js",
		required: { invalidateWICache: "function" }
	}
};
var DES_KEYS = {
	chatMetadata: "dooms_tracker",
	swipeData: "dooms_tracker_swipes",
	updateCompleteEvent: "dooms_tracker_update_complete"
};
var DES_SELECTORS = {
	/** DES's drawer toggle in the Extensions panel: present once DES has loaded its settings. */
	drawerToggle: "#rpg-extension-enabled",
	/** While open, the Workshop overwrites aliases, injection, appearance and relationship on save (research §8.10). */
	workshopOpen: "#character-workshop-popup.is-open"
};
function isDesManifest(manifest) {
	return homePageHas(manifest, "dangerdaza/dooms-enhancement-suite") || manifest.display_name === "Doom's Enhancement Suite";
}
function hasExports(namespace, required) {
	return Object.entries(required).every(([name, type]) => typeof namespace[name] === type && namespace[name] !== null);
}
var DesAdapter = class extends NeighbourBase {
	id = "des";
	modules = {};
	constructor(deps) {
		super(deps);
		this.capability("des.present", () => this.present());
		this.capability("des.state", () => this.present() && !!this.modules.state);
		this.capability("des.enabled", () => this.present() && this.enabled());
		this.capability("des.together", () => this.present() && this.generationMode() === "together");
		this.capability("des.lore", () => this.present() && !!this.modules.lorebookApi);
	}
	present() {
		return this.enabledInSt() && (this.scriptUrl() !== null || hasElement(DES_SELECTORS.drawerToggle));
	}
	/** True when the installed version is one Maestro was checked against. */
	verified() {
		const version = this.version();
		return version !== void 0 && DES_VERIFIED_VERSIONS.includes(version);
	}
	async connect() {
		await this.locate(isDesManifest, DES_KNOWN_NAMES);
		if (!this.located || !this.enabledInSt()) return true;
		const script = this.scriptUrl();
		if (!script) return false;
		for (const [key, spec] of Object.entries(DES_MODULES)) {
			if (this.modules[key]) continue;
			try {
				const namespace = await this.deps.importModule(new URL(spec.path, script).href);
				if (hasExports(namespace, spec.required)) this.modules[key] = namespace;
				else this.log.warn(`${spec.path} lacks ${Object.keys(spec.required).join(", ")}`);
			} catch (error) {
				this.log.warn(`${spec.path} did not load`, error);
			}
		}
		return true;
	}
	/**
	* DES's live settings object (state.js), or the saved blob `extension_settings[<name>]` when state.js is not
	* imported. Read-only for Maestro in stage 0.
	*/
	settings() {
		const live = this.modules.state?.extensionSettings;
		if (isDict$1(live)) return live;
		const saved = this.located ? this.host.ctx().extensionSettings[this.located.name] : void 0;
		return isDict$1(saved) ? saved : null;
	}
	/** DES's own switch (on unless explicitly false). */
	enabled() {
		return this.settings()?.enabled !== false;
	}
	generationMode() {
		const mode = this.settings()?.generationMode;
		return mode === "separate" || mode === "external" ? mode : "together";
	}
	/**
	* Parsed tracker of a chat message for its current swipe: `extra.dooms_tracker_swipes[swipe_id]`, falling back
	* to `swipe_info[swipe_id].extra…` like DES does. Null for user messages, out-of-range indexes and messages
	* without tracker data. The result is a fresh object, never shared with DES.
	*/
	trackerFor(messageIndex) {
		const message = this.host.ctx().chat[messageIndex];
		const record = desSwipeRecord(message);
		return record ? parseDesTracker(record) : null;
	}
	/**
	* Names in this chat's DES roster (`chat_metadata.dooms_tracker.knownCharacters`; DES forces per-chat roster
	* tracking). Includes absent and hidden characters; see `removedCharacters()`.
	*/
	knownCharacters() {
		const roster = this.chatState()?.knownCharacters;
		return isDict$1(roster) ? Object.keys(roster) : [];
	}
	/** Names hidden from "Present Characters" in this chat (DES compares them case-insensitively). */
	removedCharacters() {
		return stringList(this.chatState()?.removedCharacters);
	}
	/** Canonical aliases `{card name: [aliases]}` (global DES setting), as a copy. */
	aliases() {
		const map = this.settings()?.characterAliases;
		const copy = {};
		if (!isDict$1(map)) return copy;
		for (const [canonical, list] of Object.entries(map)) if (Array.isArray(list)) copy[canonical] = list.map(String);
		return copy;
	}
	/** The Workshop is open: Maestro must not write DES stores until it closes (plan §10.8). */
	isWorkshopOpen() {
		return hasElement(DES_SELECTORS.workshopOpen);
	}
	/**
	* Drops one book from the Lore Library cache after Maestro saved it (DES ignores WORLDINFO_UPDATED and would
	* otherwise save its stale copy over ours). No-op when the module is not loaded.
	*/
	invalidateLoreCache(bookName) {
		const invalidate = this.modules.lorebookApi?.invalidateWICache;
		if (typeof invalidate !== "function") return;
		try {
			invalidate(bookName);
		} catch (error) {
			this.log.warn("Lore Library cache reset failed", error);
		}
	}
	chatState() {
		const state = this.host.ctx().chatMetadata[DES_KEYS.chatMetadata];
		return isDict$1(state) ? state : null;
	}
};
var DESRU_KNOWN_NAMES = ["third-party/SillyTavern-DES-RU", "third-party/SillyTavern-Doom-Enhancement-Suite-RU"];
var DESRU_SETTINGS_KEY = "desru";
function isDesRuManifest(manifest) {
	return homePageHas(manifest, "likerch/sillytavern-doom-enhancement-suite-ru") || manifest.display_name === "SillyTavern - Doom's Enhancement Suite - RU";
}
var DesRuAdapter = class extends NeighbourBase {
	id = "desru";
	constructor(deps) {
		super(deps);
		this.capability("desru.present", () => this.present());
		this.capability("desru.names", () => this.present() && this.moduleEnabled("names"));
		this.capability("desru.bunnymo", () => this.present() && this.moduleEnabled("bunnymo"));
		this.capability("desru.carrotKernel", () => this.present() && this.moduleEnabled("carrotKernel"));
	}
	present() {
		return this.enabledInSt() && (this.scriptUrl() !== null || hasElement("#desru-settings"));
	}
	async connect() {
		await this.locate(isDesRuManifest, DESRU_KNOWN_NAMES);
		return true;
	}
	/** `extension_settings.desru` (live object, read-only for Maestro). */
	settings() {
		return extensionSettingsOf(this.host, DESRU_SETTINGS_KEY);
	}
	/** A DES-RU module switch; modules are on by default, as in DES-RU's DEFAULT_SETTINGS. */
	moduleEnabled(module) {
		const modules = this.settings()?.modules;
		const slice = isDict$1(modules) ? modules[module] : void 0;
		return !isDict$1(slice) || slice.enabled !== false;
	}
};
//#endregion
//#region src/adapters/localizer/index.ts
var LOCALIZER_SETTINGS_KEY = "lorebookLocalizer";
var LOCALIZER_MARKER_KEY = "lorebook_localizer";
var LOCALIZER_KNOWN_NAMES = ["third-party/SillyTavern-LorebookLocalizer"];
function isLocalizerManifest(manifest) {
	return manifest.display_name === "Lorebook Localizer" || homePageHas(manifest, "likerch/sillytavern-lorebooklocalizer");
}
/** Reads the Localizer marker of a World Info entry as a typed copy; null when the entry has none. */
function readLocalizerMarker(entry) {
	const extensions = isDict$1(entry) ? entry.extensions : void 0;
	const marker = isDict$1(extensions) ? extensions[LOCALIZER_MARKER_KEY] : void 0;
	if (!isDict$1(marker)) return null;
	const languages = {};
	if (isDict$1(marker.languages)) for (const [id, state] of Object.entries(marker.languages)) {
		if (!isDict$1(state)) continue;
		const added = isDict$1(state.added) ? state.added : {};
		languages[id] = {
			language: typeof state.language === "string" ? state.language : id,
			sources: stringList(state.sources),
			added: {
				key: stringList(added.key),
				keysecondary: stringList(added.keysecondary)
			}
		};
	}
	return {
		version: typeof marker.version === "number" ? marker.version : 0,
		languages
	};
}
var LocalizerAdapter = class extends NeighbourBase {
	id = "localizer";
	constructor(deps) {
		super(deps);
		this.capability("localizer.present", () => this.present());
	}
	present() {
		if (!this.enabledInSt()) return false;
		return this.scriptUrl() !== null || hasElement("#lorebook_localizer_button") || this.settings() !== null;
	}
	async connect() {
		await this.locate(isLocalizerManifest, LOCALIZER_KNOWN_NAMES);
		return true;
	}
	/** `extension_settings.lorebookLocalizer` (live object, read-only for Maestro). */
	settings() {
		return extensionSettingsOf(this.host, LOCALIZER_SETTINGS_KEY);
	}
	/** The Localizer's provenance marker of a World Info entry (keys it translated and added); null if none. */
	markerOf(entry) {
		return readLocalizerMarker(entry);
	}
	/** Every key the Localizer appended to an entry, over all languages (Maestro must not treat them as the author's). */
	addedKeysOf(entry) {
		const keys = /* @__PURE__ */ new Set();
		for (const state of Object.values(this.markerOf(entry)?.languages ?? {})) for (const key of [...state.added.key, ...state.added.keysecondary]) keys.add(key);
		return keys;
	}
};
//#endregion
//#region src/adapters/nai/index.ts
var NAI_KEY = "nai_studio";
var NAI_KNOWN_NAMES = ["third-party/SillyTavern-NAI-Studio", "third-party/ST-NAI-Studio"];
var KINDS = [
	"character",
	"world",
	"location",
	"scenario",
	"object"
];
function isNaiManifest(manifest) {
	return manifest.display_name === "NAI Studio" || manifest.generate_interceptor === "NAIST_ProcessTriggers" || homePageHas(manifest, "likerch/st-nai-studio");
}
function text(value) {
	return typeof value === "string" ? value : "";
}
/** A typed deep copy of one stored passport; null for junk. Legacy passports without an id get 'main'. */
function readPassport(raw) {
	if (!isDict$1(raw)) return null;
	const copy = structuredClone(raw);
	const slots = {};
	if (isDict$1(copy.slots)) {
		for (const [slot, value] of Object.entries(copy.slots)) if (typeof value === "string") slots[slot] = value;
	}
	const outfits = Array.isArray(copy.outfits) ? copy.outfits.filter(isDict$1).map((outfit) => ({
		name: text(outfit.name),
		tags: text(outfit.tags)
	})) : [];
	const states = Array.isArray(copy.states) ? copy.states.filter(isDict$1).map((state) => ({
		id: text(state.id),
		tags: text(state.tags),
		enabled: state.enabled === true
	})) : [];
	const kind = KINDS.find((candidate) => candidate === copy.kind) ?? "character";
	return {
		...copy,
		id: text(copy.id) || "main",
		kind,
		name: text(copy.name),
		aliases: stringList(copy.aliases),
		tags: text(copy.tags),
		slots,
		outfits,
		activeOutfit: text(copy.activeOutfit),
		states,
		negative: text(copy.negative)
	};
}
var NaiAdapter = class extends NeighbourBase {
	id = "nai";
	constructor(deps) {
		super(deps);
		this.capability("nai.present", () => this.present());
		this.capability("nai.api", () => false);
	}
	present() {
		return !(this.located !== null && this.deps.locator.isDisabled(this.located.name)) && typeof globalThis["NAIST_ProcessTriggers"] === "function";
	}
	async connect() {
		await this.locate(isNaiManifest, NAI_KNOWN_NAMES);
		return true;
	}
	/** `extension_settings.nai_studio` (live object, read-only for Maestro). */
	settings() {
		return extensionSettingsOf(this.host, NAI_KEY);
	}
	/**
	* Passports of a card (`characters[index].data.extensions.nai_studio.passports`, or the legacy single
	* `passport` of cards saved before 0.8), as typed copies: editing them changes nothing.
	*/
	passportsOf(characterIndex) {
		const field = this.host.ctx().characters[characterIndex]?.data?.extensions?.[NAI_KEY];
		if (!isDict$1(field)) return [];
		return (Array.isArray(field.passports) ? field.passports : isDict$1(field.passport) ? [field.passport] : []).map(readPassport).filter((passport) => passport !== null);
	}
};
//#endregion
//#region src/adapters/preset/index.ts
var MARINARA_NAME_RE = /marinara|spaghetti/i;
var MARINARA_SECTION_TAGS = ["<instructions>", "<output_format>"];
var PresetAdapter = class extends NeighbourBase {
	id = "preset";
	constructor(deps) {
		super(deps);
		this.capability("preset.cc", () => this.present());
		this.capability("preset.marinara", () => this.present() && this.isMarinara());
	}
	present() {
		const settings = this.settings();
		return this.host.isChatCompletion() && settings !== null && Array.isArray(settings.prompts) && settings.prompts.length > 0 && Array.isArray(settings.prompt_order);
	}
	/** No manifest: the preset is part of ST. */
	version() {}
	async connect() {
		return true;
	}
	/** ST's live Chat Completion settings (`oai_settings`); read-only for Maestro. */
	settings() {
		const settings = extras(this.host).chatCompletionSettings;
		return isDict$1(settings) ? settings : null;
	}
	/** Name of the active Chat Completion preset. */
	presetName() {
		const name = this.settings()?.preset_settings_openai;
		return typeof name === "string" && name ? name : void 0;
	}
	/** Prompt Manager prompts of the live settings (identity fields only). */
	prompts() {
		const prompts = this.settings()?.prompts;
		if (!Array.isArray(prompts)) return [];
		return prompts.filter(isDict$1).map((prompt) => ({
			identifier: typeof prompt.identifier === "string" ? prompt.identifier : "",
			name: typeof prompt.name === "string" ? prompt.name : "",
			role: typeof prompt.role === "string" ? prompt.role : "system",
			marker: prompt.marker === true
		}));
	}
	/** See `preset.marinara` above. */
	isMarinara() {
		if (MARINARA_NAME_RE.test(this.presetName() ?? "")) return true;
		const prompts = this.settings()?.prompts;
		if (!Array.isArray(prompts)) return false;
		const contents = prompts.filter(isDict$1).map((prompt) => typeof prompt.content === "string" ? prompt.content : "");
		return MARINARA_SECTION_TAGS.every((tag) => contents.some((content) => content.includes(tag)));
	}
};
//#endregion
//#region src/adapters/qvink/index.ts
var QVINK_KEY = "qvink_memory";
var QVINK_KNOWN_NAMES = ["third-party/SillyTavern-MessageSummarize", "third-party/qvink_memory"];
/** Qvink defaults for the settings Maestro reads (Q:129-169). */
var QVINK_DEFAULTS = {
	exclude_messages_after_threshold: true,
	default_chat_enabled: true,
	use_global_toggle_state: false,
	global_toggle_state: true
};
function isQvinkManifest(manifest) {
	return manifest.generate_interceptor === "memory_intercept_messages" || manifest.display_name === "qvink_memory" || homePageHas(manifest, "qvink/qvink_memory") || homePageHas(manifest, "qvink/sillytavern-messagesummarize");
}
/** Texts Qvink shows under a message while a summary is pending (SummaryQueue, Q:3238, 3303, 3381). */
var PENDING_TEXT_RE = /^(?:Summary queued|Delaying summary|Summarizing)/;
var QvinkAdapter = class extends NeighbourBase {
	id = "qvink";
	constructor(deps) {
		super(deps);
		this.capability("qvink.present", () => this.present());
		this.capability("qvink.chat", () => this.present() && this.chatEnabled());
		this.capability("qvink.removeMessages", () => this.present() && this.chatEnabled() && this.removesMessages());
	}
	present() {
		return !(this.located !== null && this.deps.locator.isDisabled(this.located.name)) && typeof globalThis["memory_intercept_messages"] === "function";
	}
	async connect() {
		await this.locate(isQvinkManifest, QVINK_KNOWN_NAMES);
		return true;
	}
	/** `extension_settings.qvink_memory` (live object, read-only for Maestro). */
	settings() {
		return extensionSettingsOf(this.host, QVINK_KEY);
	}
	/** Qvink is on for this chat, as its `chat_enabled()` decides. */
	chatEnabled() {
		if (this.setting("use_global_toggle_state")) return this.setting("global_toggle_state");
		const chatState = this.host.ctx().chatMetadata[QVINK_KEY];
		const perChat = isDict$1(chatState) ? chatState.enabled : void 0;
		return typeof perChat === "boolean" ? perChat : this.setting("default_chat_enabled");
	}
	/** "Remove Messages": every message older than the injection threshold leaves the prompt. */
	removesMessages() {
		return this.setting("exclude_messages_after_threshold");
	}
	/** Qvink's record of a message, as a typed copy; null when there is none. */
	memoryOf(index) {
		const raw = this.host.ctx().chat[index]?.extra?.[QVINK_KEY];
		if (!isDict$1(raw)) return null;
		const memory = {
			memory: typeof raw.memory === "string" ? raw.memory : "",
			remember: raw.remember === true,
			exclude: raw.exclude === true,
			include: raw.include === "short" || raw.include === "long" ? raw.include : null,
			lagging: raw.lagging === true,
			edited: raw.edited === true
		};
		if (typeof raw.error === "string" && raw.error) memory.error = raw.error;
		return memory;
	}
	/**
	* Best effort "Qvink is summarizing now" (it has no event for it, research §A3/§A4): its progress bar is on the
	* page, or a message shows a pending-summary text. Hidden memories (`display_memories` off) and single
	* summaries without a progress bar can be missed; callers should treat false as "probably idle".
	*/
	isBusy() {
		if (!this.present()) return false;
		if (hasElement(".summarize.qvink_progress_bar")) return true;
		const doc = pageDocument();
		if (!doc) return false;
		for (const element of doc.querySelectorAll("#chat div.qvink_memory_text")) if (PENDING_TEXT_RE.test((element.textContent ?? "").trim())) return true;
		return false;
	}
	setting(key) {
		const value = this.settings()?.[key];
		return typeof value === "boolean" ? value : QVINK_DEFAULTS[key];
	}
};
//#endregion
//#region src/adapters/index.ts
var nativeImport = (url) => import(
	/* @vite-ignore */
	url
);
/** Builds every adapter. Capabilities are registered now; call each adapter's ready() after `host.install()`. */
function createAdapters(host, log, options = {}) {
	const fetchManifest = options.fetch ?? ((url, init) => fetch(url, init));
	const locator = new ExtensionLocator(host, log.scope("locator"), fetchManifest);
	const deps = (id) => ({
		host,
		log: log.scope(id),
		locator,
		importModule: options.importModule ?? nativeImport
	});
	return {
		des: new DesAdapter(deps("des")),
		desru: new DesRuAdapter(deps("desru")),
		ck: new CkAdapter(deps("ck")),
		bunnymo: new BunnyMoAdapter(deps("bunnymo")),
		qvink: new QvinkAdapter(deps("qvink")),
		nai: new NaiAdapter(deps("nai")),
		localizer: new LocalizerAdapter(deps("localizer")),
		preset: new PresetAdapter(deps("preset"))
	};
}
//#endregion
//#region src/domain/hash.ts
/** Calls `visit` with every UTF-8 byte of `text` without allocating a buffer. Lone surrogates become U+FFFD. */
function forEachUtf8Byte(text, visit) {
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code >= 55296 && code <= 56319) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (next >= 56320 && next <= 57343) {
				code = 65536 + (code - 55296 << 10) + (next - 56320);
				i++;
			} else code = 65533;
		} else if (code >= 56320 && code <= 57343) code = 65533;
		if (code < 128) visit(code);
		else if (code < 2048) {
			visit(192 | code >> 6);
			visit(128 | code & 63);
		} else if (code < 65536) {
			visit(224 | code >> 12);
			visit(128 | code >> 6 & 63);
			visit(128 | code & 63);
		} else {
			visit(240 | code >> 18);
			visit(128 | code >> 12 & 63);
			visit(128 | code >> 6 & 63);
			visit(128 | code & 63);
		}
	}
}
/**
* 53-bit hash (cyrb53 by bryc, public domain) over UTF-8 bytes: two 32-bit lanes mixed at the end, so it fits
* a JavaScript number exactly. Far fewer collisions than 32 bits for ids and content keys.
*/
function hash53(text, seed = 0) {
	let h1 = 3735928559 ^ seed;
	let h2 = 1103547991 ^ seed;
	forEachUtf8Byte(text, (byte) => {
		h1 = Math.imul(h1 ^ byte, 2654435761);
		h2 = Math.imul(h2 ^ byte, 1597334677);
	});
	h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
	h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
	h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
	h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** Short stable id for any string: the 53-bit hash in base 36 (1–11 chars of [0-9a-z]). */
function stableHash(text) {
	return hash53(text).toString(36);
}
//#endregion
//#region src/core/files.ts
var FILE_PREFIX = "maestro-";
var NAME_RE = /^[A-Za-z0-9_.-]+$/;
var MAX_NAME_LENGTH = 200;
var CACHE_LIMIT = 32;
var CACHE_MAX_TEXT = 524288;
var FileStoreError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
		this.name = "FileStoreError";
	}
};
var tabIdValue = null;
/** Random id of this browser tab (page load), used in file envelopes and leader locks. */
function currentTabId() {
	if (!tabIdValue) {
		const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
		tabIdValue = `t${Date.now().toString(36)}${random}`;
	}
	return tabIdValue;
}
/** Reads a file around any cache (works with any FileStore; MaestroFileStore skips its cache). */
function readFresh(files, name) {
	if (isMaestroFileStore(files)) return files.read(name, { fresh: true });
	return files.read(name);
}
function isMaestroFileStore(files) {
	return typeof files.invalidate === "function";
}
/** Throws unless the name is a valid ST user file name with the Maestro prefix. */
function assertFileName(name) {
	if (!name.startsWith("maestro-")) throw new FileStoreError(`file name must start with ${FILE_PREFIX}: ${name}`);
	if (!NAME_RE.test(name) || name.length > MAX_NAME_LENGTH || name.includes("..")) throw new FileStoreError(`invalid file name: ${name}`);
}
/** `maestro-<kind>[-<hash(key)>].json`; characters outside [A-Za-z0-9_-] in the kind become `_`. */
function makeFileName(kind, key) {
	return `${FILE_PREFIX}${(kind.startsWith("maestro-") ? kind.slice(8) : kind).replace(/[^A-Za-z0-9_-]/g, "_") || "file"}${key === void 0 ? "" : `-${stableHash(key)}`}.json`;
}
/** Base64 of the UTF-8 bytes of a string (btoa alone only accepts Latin-1). */
function utf8ToBase64(text) {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	const chunk = 32768;
	for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(binary);
}
function createFileStore(host, log) {
	const cache = /* @__PURE__ */ new Map();
	const chains = /* @__PURE__ */ new Map();
	const remember = (name, text) => {
		cache.delete(name);
		if (text !== null && text.length > CACHE_MAX_TEXT) return;
		cache.set(name, text);
		while (cache.size > CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest === void 0) break;
			cache.delete(oldest);
		}
	};
	const parse = (name, text) => {
		if (text === null) return null;
		try {
			return JSON.parse(text);
		} catch (error) {
			log.warn(`file ${name} is not valid JSON; treating it as absent`, error);
			return null;
		}
	};
	const serial = (name, job) => {
		const next = (chains.get(name) ?? Promise.resolve()).then(job, job);
		const settled = next.catch(() => void 0);
		chains.set(name, settled);
		settled.then(() => {
			if (chains.get(name) === settled) chains.delete(name);
		});
		return next;
	};
	const headers = () => host.ctx().getRequestHeaders();
	return {
		async read(name, options) {
			assertFileName(name);
			if (!options?.fresh && cache.has(name)) return parse(name, cache.get(name) ?? null);
			await chains.get(name);
			const response = await fetch(`/user/files/${encodeURIComponent(name)}`, {
				method: "GET",
				headers: headers(),
				cache: "no-store"
			});
			if (response.status === 404) {
				remember(name, null);
				return null;
			}
			if (!response.ok) throw new FileStoreError(`read ${name} failed: HTTP ${response.status}`, response.status);
			const text = await response.text();
			remember(name, text);
			return parse(name, text);
		},
		async write(name, data) {
			assertFileName(name);
			const text = JSON.stringify(data);
			if (text === void 0) throw new FileStoreError(`cannot serialise data for ${name}`);
			return serial(name, async () => {
				const response = await fetch("/api/files/upload", {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						name,
						data: utf8ToBase64(text)
					})
				});
				if (!response.ok) {
					cache.delete(name);
					throw new FileStoreError(`write ${name} failed: HTTP ${response.status}`, response.status);
				}
				remember(name, text);
				log.debug(`wrote ${name} (${text.length} chars)`);
			});
		},
		async remove(name) {
			assertFileName(name);
			return serial(name, async () => {
				const response = await fetch("/api/files/delete", {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({ path: `/user/files/${name}` })
				});
				if (!response.ok && response.status !== 404) {
					cache.delete(name);
					throw new FileStoreError(`delete ${name} failed: HTTP ${response.status}`, response.status);
				}
				remember(name, null);
			});
		},
		fileName(kind, key) {
			return makeFileName(kind, key);
		},
		invalidate(name) {
			if (name === void 0) cache.clear();
			else cache.delete(name);
		}
	};
}
//#endregion
//#region src/core/autonomy.ts
var STATS_KIND = "autonomy";
var TRUST_STREAK = 5;
var SAVE_DELAY_MS = 2e3;
function zero() {
	return {
		accepted: 0,
		edited: 0,
		rejected: 0,
		undone: 0,
		streak: 0
	};
}
function zeroDelta() {
	return {
		...zero(),
		reset: false
	};
}
function readCounters(value) {
	const source = value && typeof value === "object" ? value : {};
	const num = (field) => {
		const raw = source[field];
		return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
	};
	return {
		accepted: num("accepted"),
		edited: num("edited"),
		rejected: num("rejected"),
		undone: num("undone"),
		streak: num("streak")
	};
}
function applyDelta(base, delta) {
	return {
		accepted: base.accepted + delta.accepted,
		edited: base.edited + delta.edited,
		rejected: base.rejected + delta.rejected,
		undone: base.undone + delta.undone,
		streak: delta.reset ? delta.streak : base.streak + delta.streak
	};
}
function createAutonomy(deps, options = {}) {
	const { settings, journal, log, files } = deps;
	const trustStreak = options.trustStreak ?? TRUST_STREAK;
	const saveDelay = options.saveDelayMs ?? SAVE_DELAY_MS;
	const never = /* @__PURE__ */ new Set();
	/** Module default seen for each kind (trust growth needs the effective level outside decide()). */
	const fallbacks = /* @__PURE__ */ new Map();
	const stats = /* @__PURE__ */ new Map();
	const deltas = /* @__PURE__ */ new Map();
	const fileName = files?.fileName(STATS_KIND);
	let bound = null;
	let saveTimer = null;
	let saving = Promise.resolve();
	let badgeSeq = 0;
	const loaded = files && fileName ? readFresh(files, fileName).then((file) => {
		const stored = file && typeof file.stats === "object" && file.stats ? file.stats : {};
		for (const [kind, value] of Object.entries(stored)) {
			const base = readCounters(value);
			const delta = deltas.get(kind);
			stats.set(kind, delta ? applyDelta(base, delta) : base);
		}
	}).catch((error) => log.warn("could not load autonomy stats", error)) : Promise.resolve();
	const save = async () => {
		if (!files || !fileName) return;
		await loaded;
		if (deltas.size === 0) return;
		const pending = new Map(deltas);
		deltas.clear();
		try {
			const file = await readFresh(files, fileName);
			const merged = {};
			const stored = file && typeof file.stats === "object" && file.stats ? file.stats : {};
			for (const [kind, value] of Object.entries(stored)) merged[kind] = readCounters(value);
			for (const [kind, delta] of pending) merged[kind] = applyDelta(merged[kind] ?? zero(), delta);
			await files.write(fileName, {
				schema: 1,
				stats: merged
			});
			for (const [kind, counters] of Object.entries(merged)) {
				const later = deltas.get(kind);
				stats.set(kind, later ? applyDelta(counters, later) : counters);
			}
		} catch (error) {
			log.warn("could not save autonomy stats", error);
			for (const [kind, delta] of pending) {
				const later = deltas.get(kind);
				deltas.set(kind, later ? mergeDeltas(delta, later) : delta);
			}
		}
	};
	const flush = () => {
		if (saveTimer !== null) clearTimeout(saveTimer);
		saveTimer = null;
		saving = saving.then(save, save);
		return saving;
	};
	const scheduleSave = () => {
		if (!files) return;
		if (saveTimer !== null) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void flush(), saveDelay);
	};
	const level = (kind, fallback) => {
		const value = settings.core().autonomy[kind] ?? fallback;
		if (value === "auto" && never.has(kind)) return fallback === "auto" ? "ask" : fallback;
		return value;
	};
	const kindLabel = (kind) => {
		if (!bound) return kind;
		const key = `kind.${kind}`;
		const text = bound.i18n.t(key);
		return text === key ? kind : text;
	};
	const offerPromotion = (kind) => {
		if (!bound || never.has(kind)) return;
		const current = level(kind, fallbacks.get(kind) ?? "inbox");
		if (current !== "inbox" && current !== "notify") return;
		const { ui, i18n } = bound;
		const label = kindLabel(kind);
		ui.notice(i18n.t("core.autonomy.promote", {
			kind: label,
			count: trustStreak
		}), {
			urgent: false,
			level: "info",
			action: {
				label: i18n.t("core.autonomy.promoteAction"),
				run: () => {
					settings.core().autonomy[kind] = "auto";
					settings.save();
					settings.notify(`core.autonomy.${kind}`);
					ui.notice(i18n.t("core.autonomy.promoted", { kind: label }));
				}
			}
		});
	};
	const record = (kind, outcome) => {
		const current = stats.get(kind) ?? zero();
		const delta = deltas.get(kind) ?? zeroDelta();
		current[outcome]++;
		delta[outcome]++;
		if (outcome === "accepted") {
			current.streak++;
			delta.streak++;
		} else {
			current.streak = 0;
			delta.streak = 0;
			delta.reset = true;
		}
		stats.set(kind, current);
		deltas.set(kind, delta);
		scheduleSave();
		if (outcome === "accepted" && current.streak === trustStreak) offerPromotion(kind);
	};
	/** Validates, applies and journals a proposal. */
	const applyNow = async (proposal, quiet) => {
		try {
			if (proposal.stillValid && !await proposal.stillValid()) {
				log.info(`${proposal.kind}: proposal is out of date; skipped`);
				if (!quiet && bound) bound.ui.notice(bound.i18n.t("core.autonomy.stale"), { level: "warn" });
				return false;
			}
			await proposal.apply(proposal.payload);
		} catch (error) {
			log.error(`${proposal.kind}: apply failed`, error);
			if (bound) bound.ui.notice(bound.i18n.t("core.autonomy.failed", { title: proposal.title }), { level: "error" });
			return false;
		}
		try {
			await journal.record({
				module: proposal.module,
				kind: proposal.kind,
				summary: proposal.title,
				changes: proposal.changes,
				sourceMessage: proposal.sourceMessage
			});
		} catch (error) {
			log.error(`${proposal.kind}: applied but not journaled`, error);
		}
		return true;
	};
	const notify = (proposal, ui, i18n) => {
		let off = null;
		let done = false;
		const run = () => {
			if (done) return;
			done = true;
			off?.();
			applyNow(proposal, false).then((ok) => {
				if (ok) record(proposal.kind, "accepted");
			});
		};
		const action = {
			label: i18n.t("core.autonomy.apply"),
			run
		};
		if (proposal.sourceMessage !== void 0) off = ui.messageBadge(proposal.sourceMessage, {
			id: `maestro-autonomy-${++badgeSeq}`,
			text: proposal.title,
			action
		});
		else ui.notice(proposal.title, { action });
		return "notified";
	};
	const offUndone = journal.onUndone?.((entry) => record(entry.kind, "undone")) ?? (() => {});
	return {
		level,
		async decide(proposal, fallback) {
			fallbacks.set(proposal.kind, fallback);
			let chosen = level(proposal.kind, fallback);
			if ((chosen === "notify" || chosen === "ask") && !bound) {
				log.warn(`${proposal.kind}: UI is not ready; treating '${chosen}' as 'inbox'`);
				chosen = "inbox";
			}
			switch (chosen) {
				case "off": return "skipped";
				case "auto": return await applyNow(proposal, true) ? "applied" : "skipped";
				case "notify": return bound ? notify(proposal, bound.ui, bound.i18n) : "skipped";
				case "inbox":
					if (!bound) {
						log.warn(`${proposal.kind}: Inbox is not ready; proposal skipped`);
						return "skipped";
					}
					await bound.inbox.add(proposal);
					return "queued";
				case "ask":
					if (!bound) return "skipped";
					if (!await bound.ui.confirm(proposal.title, proposal.description ?? "")) {
						record(proposal.kind, "rejected");
						return "rejected";
					}
					if (!await applyNow(proposal, false)) return "skipped";
					record(proposal.kind, "accepted");
					return "applied";
			}
		},
		record,
		stats() {
			return [...stats.entries()].map(([kind, counters]) => ({
				kind,
				...counters
			}));
		},
		neverAuto(kind) {
			never.add(kind);
		},
		bind(next) {
			bound = next;
		},
		ready: () => loaded,
		flush,
		dispose() {
			offUndone();
			if (saveTimer !== null) flush();
		}
	};
}
function mergeDeltas(first, second) {
	return {
		accepted: first.accepted + second.accepted,
		edited: first.edited + second.edited,
		rejected: first.rejected + second.rejected,
		undone: first.undone + second.undone,
		streak: second.reset ? second.streak : first.streak + second.streak,
		reset: first.reset || second.reset
	};
}
//#endregion
//#region src/core/bus.ts
/** Maestro's internal event bus. Handlers run in registration order; one failing handler does not stop others. */
var EventBus = class {
	log;
	handlers = /* @__PURE__ */ new Map();
	constructor(log) {
		this.log = log;
	}
	on(event, handler) {
		let set = this.handlers.get(event);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.handlers.set(event, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}
	async emit(event, payload) {
		const set = this.handlers.get(event);
		if (!set) return;
		for (const handler of [...set]) try {
			await handler(payload);
		} catch (error) {
			this.log.error(`bus handler for ${String(event)} failed`, error);
		}
	}
};
function createBus(log) {
	return new EventBus(log);
}
//#endregion
//#region src/core/chat-store.ts
var META_KEY = "maestro";
var KINDS_FILE_KIND = "chat-kinds";
var DEFAULT_SAVE_DELAY_MS = 500;
function chatDocName(files, chatId, kind) {
	return files.fileName(`chat-${stableHash(chatId)}-${kind}`);
}
function isEnvelope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const env = value;
	return typeof env.version === "number" && typeof env.schema === "number" && "data" in env;
}
function isPlainObject$1(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function createChatStore(host, files, log, options = {}) {
	const saveDelay = options.metadataSaveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
	const tabId = currentTabId();
	const cache = /* @__PURE__ */ new Map();
	const loading = /* @__PURE__ */ new Map();
	const chains = /* @__PURE__ */ new Map();
	const migrations = /* @__PURE__ */ new Map();
	const defaultsByKind = /* @__PURE__ */ new Map();
	const knownKinds = /* @__PURE__ */ new Set();
	const owners = /* @__PURE__ */ new WeakMap();
	const knownVersions = /* @__PURE__ */ new Map();
	let generation = 0;
	let saveTimer = null;
	let saveChatId = null;
	let saveWaiters = [];
	let globalKinds = null;
	const keyOf = (chatId, kind) => `${chatId}\u0000${kind}`;
	const currentSchema = (kind) => {
		const steps = migrations.get(kind);
		if (!steps || steps.size === 0) return 1;
		return Math.max(1, Math.max(...steps.keys()) + 1);
	};
	const migrate = (kind, env) => {
		const target = currentSchema(kind);
		let schema = env.schema;
		let data = env.data;
		while (schema < target) {
			const step = migrations.get(kind)?.get(schema);
			if (!step) {
				log.warn(`no migration for ${kind} from schema ${schema}`);
				break;
			}
			try {
				data = step(isPlainObject$1(data) ? data : { value: data });
			} catch (error) {
				throw new Error(`migration of ${kind} from schema ${schema} failed: ${String(error)}`, { cause: error });
			}
			schema++;
		}
		return {
			...env,
			schema,
			data
		};
	};
	const withDefaults = (data, defaults) => {
		if (!defaults) return isPlainObject$1(data) || Array.isArray(data) ? data : {};
		const base = defaults();
		if (isPlainObject$1(base) && isPlainObject$1(data)) return {
			...base,
			...data
		};
		if (data && typeof data === "object") return data;
		return base;
	};
	const toEntry = (kind, raw, defaults) => {
		if (raw !== null && !isEnvelope(raw)) log.warn(`chat document ${kind} has no envelope; starting from defaults`);
		if (!isEnvelope(raw)) {
			const data = withDefaults(void 0, defaults);
			return {
				env: {
					schema: currentSchema(kind),
					version: 0,
					updatedAt: 0,
					tabId,
					data
				},
				known: 0
			};
		}
		const env = migrate(kind, raw);
		return {
			env: {
				...env,
				data: withDefaults(env.data, defaults)
			},
			known: raw.version
		};
	};
	const serial = (key, job) => {
		const next = (chains.get(key) ?? Promise.resolve()).then(job, job);
		const settled = next.catch(() => void 0);
		chains.set(key, settled);
		settled.then(() => {
			if (chains.get(key) === settled) chains.delete(key);
		});
		return next;
	};
	/** Loads go through the same per-document chain as writes, so a read never overtakes this tab's write. */
	const load = (chatId, kind, defaults) => {
		knownKinds.add(kind);
		defaultsByKind.set(kind, defaults);
		const key = keyOf(chatId, kind);
		const cached = cache.get(key);
		if (cached) return Promise.resolve(cached);
		const pending = loading.get(key);
		if (pending) return pending;
		const startedIn = generation;
		const job = serial(key, async () => {
			const again = cache.get(key);
			if (again) return again;
			const raw = await readFresh(files, chatDocName(files, chatId, kind));
			const entry = toEntry(kind, raw, defaults);
			owners.set(entry.env.data, chatId);
			knownVersions.set(key, entry.known);
			if (startedIn === generation) cache.set(key, entry);
			return entry;
		});
		loading.set(key, job);
		job.finally(() => {
			if (loading.get(key) === job) loading.delete(key);
		}).catch(() => void 0);
		return job;
	};
	const readRoot = () => {
		const root = host.ctx().chatMetadata?.[META_KEY];
		if (!isPlainObject$1(root)) return null;
		return root;
	};
	/** Always re-reads ctx().chatMetadata: ST reassigns it on chat load. */
	const ensureRoot = () => {
		const meta = host.ctx().chatMetadata;
		const existing = meta[META_KEY];
		const root = isPlainObject$1(existing) ? existing : {
			schema: 1,
			kinds: [],
			pointers: {}
		};
		if (!Array.isArray(root.kinds)) root.kinds = [];
		if (!isPlainObject$1(root.pointers)) root.pointers = {};
		if (root.schema !== 1) root.schema = 1;
		meta[META_KEY] = root;
		return root;
	};
	const flushMetadata = async () => {
		saveTimer = null;
		const waiters = saveWaiters;
		saveWaiters = [];
		const target = saveChatId;
		saveChatId = null;
		try {
			if (target !== null && target === host.chatId()) await host.ctx().saveMetadata();
			else log.debug("chat changed before the metadata save; pointer change dropped");
		} catch (error) {
			log.warn("saveMetadata failed", error);
		} finally {
			for (const resolve of waiters) resolve();
		}
	};
	const scheduleMetadataSave = () => {
		saveChatId = host.chatId();
		return new Promise((resolve) => {
			saveWaiters.push(resolve);
			if (saveTimer !== null) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => void flushMetadata(), saveDelay);
		});
	};
	const indexKind = (chatId, kind) => {
		if (chatId === host.chatId()) {
			const root = ensureRoot();
			if (!root.kinds.includes(kind)) {
				root.kinds.push(kind);
				scheduleMetadataSave();
			}
		}
		rememberGlobalKind(kind);
	};
	/** Kinds ever written in any chat: lets exportChat find documents of chats that are not open. */
	const loadGlobalKinds = () => {
		globalKinds ??= readFresh(files, files.fileName(KINDS_FILE_KIND)).then((raw) => {
			const list = isPlainObject$1(raw) && Array.isArray(raw.kinds) ? raw.kinds : [];
			return new Set(list.filter((kind) => typeof kind === "string"));
		}).catch((error) => {
			log.warn("could not read the kinds index", error);
			globalKinds = null;
			return /* @__PURE__ */ new Set();
		});
		return globalKinds;
	};
	const rememberGlobalKind = async (kind) => {
		const kinds = await loadGlobalKinds();
		if (kinds.has(kind)) return;
		kinds.add(kind);
		const name = files.fileName(KINDS_FILE_KIND);
		try {
			const raw = await readFresh(files, name);
			if (isPlainObject$1(raw) && Array.isArray(raw.kinds)) {
				for (const other of raw.kinds) if (typeof other === "string") kinds.add(other);
			}
			await files.write(name, { kinds: [...kinds].sort() });
		} catch (error) {
			kinds.delete(kind);
			log.warn("could not update the kinds index", error);
		}
	};
	const putFor = (chatId, kind, data) => {
		knownKinds.add(kind);
		const key = keyOf(chatId, kind);
		return serial(key, async () => {
			const name = chatDocName(files, chatId, kind);
			const target = currentSchema(kind);
			const startedIn = generation;
			let raw;
			try {
				raw = await readFresh(files, name);
			} catch (error) {
				log.warn(`could not re-read ${kind} before writing`, error);
				return false;
			}
			const remote = isEnvelope(raw) ? raw : null;
			const remoteVersion = remote?.version ?? 0;
			const known = knownVersions.get(key) ?? 0;
			if (remote && (remoteVersion > known || remote.schema > target)) {
				log.info(`${kind}: another tab wrote version ${remoteVersion} (this tab saw ${known}); reloading`);
				knownVersions.set(key, remoteVersion);
				if (startedIn === generation) try {
					const fresh = toEntry(kind, remote, defaultsByKind.get(kind));
					owners.set(fresh.env.data, chatId);
					cache.set(key, fresh);
				} catch (error) {
					cache.delete(key);
					log.error(`could not refresh ${kind}`, error);
				}
				return false;
			}
			const env = {
				schema: target,
				version: Math.max(known, remoteVersion) + 1,
				updatedAt: Date.now(),
				tabId,
				data
			};
			try {
				await files.write(name, env);
			} catch (error) {
				log.error(`could not write ${kind}`, error);
				return false;
			}
			owners.set(data, chatId);
			knownVersions.set(key, env.version);
			if (startedIn === generation) cache.set(key, {
				env,
				known: env.version
			});
			indexKind(chatId, kind);
			return true;
		});
	};
	const clearCache = () => {
		generation++;
		cache.clear();
	};
	const chatChanged = host.events.name("CHAT_CHANGED");
	const offChatChanged = chatChanged ? host.events.on(chatChanged, () => clearCache()) : () => {};
	if (!chatChanged) log.warn("CHAT_CHANGED is missing; chat documents are not reloaded on chat switch");
	return {
		async get(kind, defaults) {
			const chatId = host.chatId();
			if (!chatId) return defaults();
			return (await load(chatId, kind, defaults)).env.data;
		},
		async put(kind, data) {
			const chatId = owners.get(data) ?? host.chatId();
			if (!chatId) {
				log.debug(`no chat: ${kind} not saved`);
				return false;
			}
			return putFor(chatId, kind, data);
		},
		async getFor(chatId, kind, defaults) {
			return (await load(chatId, kind, defaults)).env.data;
		},
		pointer(name) {
			const root = readRoot();
			if (!root || !isPlainObject$1(root.pointers)) return void 0;
			return root.pointers[name];
		},
		async setPointer(name, value) {
			if (!host.chatId()) return;
			const root = ensureRoot();
			if (value === void 0) delete root.pointers[name];
			else root.pointers[name] = value;
			await scheduleMetadataSave();
		},
		migration(kind, fromVersion, migrateDoc) {
			knownKinds.add(kind);
			let steps = migrations.get(kind);
			if (!steps) {
				steps = /* @__PURE__ */ new Map();
				migrations.set(kind, steps);
			}
			if (steps.has(fromVersion)) log.warn(`migration ${kind}@${fromVersion} registered twice; the last one wins`);
			steps.set(fromVersion, migrateDoc);
		},
		async exportChat(chatId) {
			const kinds = new Set(knownKinds);
			for (const kind of await loadGlobalKinds()) kinds.add(kind);
			const root = chatId === host.chatId() ? readRoot() : null;
			if (root && Array.isArray(root.kinds)) for (const kind of root.kinds) kinds.add(kind);
			const docs = {};
			for (const kind of [...kinds].sort()) {
				const raw = await readFresh(files, chatDocName(files, chatId, kind));
				if (isEnvelope(raw)) docs[kind] = raw;
			}
			const bundle = {
				format: "maestro-chat",
				formatVersion: 1,
				chatId,
				exportedAt: Date.now(),
				docs
			};
			if (root && isPlainObject$1(root.pointers)) bundle.pointers = structuredClone(root.pointers);
			return bundle;
		},
		async importChat(chatId, bundle) {
			if (bundle.format !== "maestro-chat" || !isPlainObject$1(bundle.docs)) throw new Error("not a Maestro chat bundle");
			const imported = [];
			for (const [kind, env] of Object.entries(bundle.docs)) {
				if (!isEnvelope(env)) {
					log.warn(`import: ${kind} has no envelope; skipped`);
					continue;
				}
				const key = keyOf(chatId, kind);
				await serial(key, async () => {
					const name = chatDocName(files, chatId, kind);
					const remote = await readFresh(files, name);
					const remoteVersion = isEnvelope(remote) ? remote.version : 0;
					const version = Math.max(remoteVersion, knownVersions.get(key) ?? 0) + 1;
					await files.write(name, {
						...env,
						version,
						updatedAt: Date.now(),
						tabId
					});
					knownVersions.set(key, version);
					cache.delete(key);
				});
				knownKinds.add(kind);
				imported.push(kind);
				rememberGlobalKind(kind);
			}
			if (chatId === host.chatId()) {
				const root = ensureRoot();
				for (const kind of imported) if (!root.kinds.includes(kind)) root.kinds.push(kind);
				if (isPlainObject$1(bundle.pointers)) Object.assign(root.pointers, structuredClone(bundle.pointers));
				await scheduleMetadataSave();
			}
		},
		clearCache,
		dispose() {
			offChatChanged();
			if (saveTimer !== null) {
				clearTimeout(saveTimer);
				flushMetadata();
			}
			clearCache();
		}
	};
}
//#endregion
//#region src/core/cost.ts
var GENERATE_URL = /\/api\/backends\/chat-completions\/generate/;
/** A generation whose request never left (aborted by an interceptor) must not claim later requests. */
var ARM_TTL_MS = 3e5;
var MAX_RECENT = 200;
var MAX_SEEN = 5e3;
var DOC_VERSION = 1;
function costFileName(date) {
	return `maestro-cost-${date}.json`;
}
function createCostMeter(deps) {
	const { host, settings, files, bus, log } = deps;
	const now = deps.now ?? Date.now;
	const persistDelay = deps.persistDelayMs ?? 5e3;
	let doc = emptyDay(dateKey(now()));
	let pending = emptyDay(doc.date);
	let chain = Promise.resolve();
	let timer = null;
	let limitNotifiedFor = null;
	const changeListeners = /* @__PURE__ */ new Set();
	const limitListeners = /* @__PURE__ */ new Set();
	const unsubscribers = [];
	const ownSignals = /* @__PURE__ */ new Set();
	let unmarkedOwn = 0;
	/** Armed by generation:before, consumed by the next generate request. */
	let generation = null;
	const attributions = /* @__PURE__ */ new WeakMap();
	const seenAnlas = /* @__PURE__ */ new Set();
	function enqueue(op) {
		chain = chain.then(op).catch((error) => log.warn("cost file operation failed", error));
		return chain;
	}
	function rollIfNeeded() {
		const key = dateKey(now());
		if (key === doc.date) return;
		const previous = pending;
		if (!isEmptyDay(previous)) enqueue(() => writeDelta(previous));
		doc = emptyDay(key);
		pending = emptyDay(key);
		enqueue(() => loadFromDisk(key));
	}
	async function loadFromDisk(date) {
		const stored = await files.read(costFileName(date));
		if (doc.date !== date) return;
		doc = addDays(sanitizeDay(stored, date), pending);
		notify();
	}
	async function writeDelta(delta) {
		const name = costFileName(delta.date);
		const merged = addDays(sanitizeDay(await files.read(name), delta.date), delta);
		await files.write(name, {
			version: DOC_VERSION,
			...merged
		});
		if (doc.date === delta.date) {
			doc = addDays(merged, pending);
			notify();
		}
	}
	function persistNow() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		return enqueue(async () => {
			const delta = pending;
			if (isEmptyDay(delta)) return;
			pending = emptyDay(delta.date);
			try {
				await writeDelta(delta);
			} catch (error) {
				if (pending.date === delta.date) pending = addDays(delta, pending);
				throw error;
			}
		});
	}
	function schedulePersist() {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			persistNow();
		}, persistDelay);
	}
	function notify() {
		for (const listener of [...changeListeners]) try {
			listener();
		} catch (error) {
			log.error("cost listener failed", error);
		}
		const limit = settings.core().dailyLimit;
		if (limitNotifiedFor !== doc.date && limitReached(limit, doc.totalUsd)) {
			limitNotifiedFor = doc.date;
			const info = {
				usd: doc.totalUsd,
				limit: limit.usd,
				action: limit.action
			};
			for (const listener of [...limitListeners]) try {
				listener(info);
			} catch (error) {
				log.error("daily limit listener failed", error);
			}
		}
	}
	function safeChatId() {
		try {
			return host.chatId();
		} catch {
			return null;
		}
	}
	function add(entry) {
		applyEntry(doc, entry);
		applyEntry(pending, entry);
		schedulePersist();
		notify();
	}
	function isOwn(init) {
		const signal = init?.signal;
		if (signal && ownSignals.has(signal)) return true;
		return unmarkedOwn > 0;
	}
	/** Decided when the request leaves; the first generate request after generation:before is the main one. */
	function attribute(init) {
		if (isOwn(init)) return { own: true };
		const armed = generation;
		if (armed) {
			generation = null;
			if (now() - armed.at <= ARM_TTL_MS) return {
				own: false,
				source: "main",
				task: armed.type
			};
		}
		if (qvinkInstalled()) return {
			own: false,
			source: "qvink"
		};
		return {
			own: false,
			source: "other"
		};
	}
	function onGenerateRequest(_url, init) {
		if (init) attributions.set(init, attribute(init));
	}
	function onGenerateResponse(_url, response, init) {
		const attribution = (init && attributions.get(init)) ?? attribute(init);
		if (attribution.own || !response.ok) return;
		const { source, task } = attribution;
		const chatId = safeChatId();
		response.text().then((text) => {
			const usage = usageFromBody(text);
			if (!usage) return;
			meter.record({
				source,
				task,
				usd: usage.usd ?? 0,
				tokens: {
					prompt: usage.prompt,
					completion: usage.completion
				},
				estimated: usage.usd === void 0,
				chatId
			});
		}).catch((error) => log.debug("could not read usage from a generate response", error));
	}
	function onReplyReady(messageIndex) {
		const message = host.ctx().chat?.[messageIndex];
		const extra = message?.extra;
		if (!message || !isRecord$1(extra)) return;
		const chatId = safeChatId() ?? "";
		const remember = (key) => {
			if (seenAnlas.has(key)) return false;
			seenAnlas.add(key);
			if (seenAnlas.size > MAX_SEEN) for (const old of [...seenAnlas].slice(0, MAX_SEEN / 5)) seenAnlas.delete(old);
			return true;
		};
		const post = isRecord$1(extra["nai_studio"]) ? extra["nai_studio"] : void 0;
		const postCost = post ? positiveNumber(post["cost"]) : void 0;
		const mediaRaw = extra["media"];
		const media = Array.isArray(mediaRaw) ? mediaRaw.filter(isRecord$1) : [];
		if (postCost !== void 0) {
			if (remember(`${chatId}|post|${messageIndex}|${String(message.send_date)}`)) meter.recordAnlas(postCost);
			for (const item of media) if (typeof item["url"] === "string") seenAnlas.add(`${chatId}|media|${item["url"]}`);
			return;
		}
		for (const item of media) {
			const meta = isRecord$1(item["nai_studio"]) ? item["nai_studio"] : void 0;
			const cost = meta ? positiveNumber(meta["cost"]) : void 0;
			if (cost === void 0 || !meta) continue;
			const batch = typeof meta["correlationId"] === "string" ? meta["correlationId"] : void 0;
			if (remember(batch ? `${chatId}|batch|${batch}` : `${chatId}|media|${String(item["url"])}`)) meter.recordAnlas(cost);
		}
	}
	const meter = {
		record(entry) {
			rollIfNeeded();
			const full = {
				...entry,
				usd: nonNegative(entry.usd),
				at: now(),
				chatId: entry.chatId === void 0 ? safeChatId() : entry.chatId
			};
			if (full.task === void 0) delete full.task;
			add(full);
		},
		recordAnlas(amount) {
			const value = nonNegative(amount);
			if (value <= 0) return;
			rollIfNeeded();
			add({
				source: "nai",
				usd: 0,
				anlas: value,
				at: now(),
				chatId: safeChatId()
			});
		},
		summary() {
			rollIfNeeded();
			return {
				todayUsd: doc.totalUsd,
				todayBySource: { ...doc.bySource },
				backgroundTodayUsd: doc.bySource["maestro"] ?? 0,
				anlasToday: doc.anlas
			};
		},
		backgroundCapReached() {
			rollIfNeeded();
			const core = settings.core();
			const cap = core.backgroundDailyCapUsd;
			if (cap > 0 && (doc.bySource["maestro"] ?? 0) >= cap) return true;
			return core.dailyLimit.action === "stopBackground" && limitReached(core.dailyLimit, doc.totalUsd);
		},
		dailyLimitReached() {
			rollIfNeeded();
			return limitReached(settings.core().dailyLimit, doc.totalUsd);
		},
		onChange(listener) {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
		onLimitReached(listener) {
			limitListeners.add(listener);
			return () => {
				limitListeners.delete(listener);
			};
		},
		today() {
			rollIfNeeded();
			return doc;
		},
		beginOwn(signal) {
			if (signal) ownSignals.add(signal);
			else unmarkedOwn++;
		},
		endOwn(signal) {
			if (signal) ownSignals.delete(signal);
			else unmarkedOwn = Math.max(0, unmarkedOwn - 1);
		},
		install() {
			if (unsubscribers.length > 0) return;
			unsubscribers.push(host.fetchGate.beforeRequest(GENERATE_URL, onGenerateRequest));
			unsubscribers.push(host.fetchGate.afterResponse(GENERATE_URL, onGenerateResponse));
			unsubscribers.push(bus.on("generation:before", (info) => {
				generation = {
					type: info.type,
					at: now()
				};
			}));
			unsubscribers.push(bus.on("generation:ended", () => {
				generation = null;
			}));
			unsubscribers.push(bus.on("chat:changed", () => {
				generation = null;
			}));
			unsubscribers.push(bus.on("reply:ready", ({ messageIndex }) => onReplyReady(messageIndex)));
			enqueue(() => loadFromDisk(doc.date));
		},
		dispose() {
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			generation = null;
			persistNow();
		},
		flush() {
			return persistNow();
		}
	};
	return meter;
}
/**
* Reads `usage` from a chat-completion response object: OpenAI/OpenRouter (prompt_tokens, completion_tokens,
* cost), Claude (input_tokens, output_tokens; also nested in a stream's message_start) and Gemini
* (usageMetadata).
*/
function readUsage(raw) {
	if (!isRecord$1(raw)) return void 0;
	const nested = isRecord$1(raw["message"]) ? raw["message"] : void 0;
	const usage = isRecord$1(raw["usage"]) ? raw["usage"] : isRecord$1(raw["usageMetadata"]) ? raw["usageMetadata"] : nested && isRecord$1(nested["usage"]) ? nested["usage"] : void 0;
	if (!usage) return void 0;
	const prompt = firstNumber(usage["prompt_tokens"], usage["input_tokens"], usage["promptTokenCount"]) ?? 0;
	const completion = firstNumber(usage["completion_tokens"], usage["output_tokens"], usage["candidatesTokenCount"]) ?? 0;
	const usd = firstNumber(usage["cost"], usage["total_cost"]);
	return usd === void 0 ? {
		prompt,
		completion
	} : {
		prompt,
		completion,
		usd
	};
}
/** Usage from a response body: a JSON object, or SSE text whose chunks carry usage (last/biggest wins). */
function usageFromBody(text) {
	const trimmed = text.trim();
	if (!trimmed) return void 0;
	if (trimmed.startsWith("{")) try {
		return readUsage(JSON.parse(trimmed));
	} catch {}
	let result;
	for (const line of trimmed.split(/\r?\n/)) {
		const data = /^data:\s?(.*)$/.exec(line)?.[1]?.trim();
		if (!data || data === "[DONE]" || !data.includes("usage")) continue;
		try {
			const usage = readUsage(JSON.parse(data));
			if (usage) result = mergeUsage(result, usage);
		} catch {}
	}
	return result;
}
/** Claude streams input tokens in message_start and output tokens in message_delta: keep the max of each. */
function mergeUsage(a, b) {
	if (!a) return b;
	const usd = b.usd ?? a.usd;
	const merged = {
		prompt: Math.max(a.prompt, b.prompt),
		completion: Math.max(a.completion, b.completion)
	};
	return usd === void 0 ? merged : {
		...merged,
		usd
	};
}
function dateKey(ms) {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function emptyDay(date) {
	return {
		date,
		totalUsd: 0,
		bySource: {},
		byTask: {},
		tokens: {
			prompt: 0,
			completion: 0
		},
		requests: 0,
		estimated: 0,
		anlas: 0,
		recent: []
	};
}
function isEmptyDay(day) {
	return day.requests === 0 && day.anlas === 0 && day.totalUsd === 0 && day.recent.length === 0;
}
function applyEntry(day, entry) {
	if (entry.anlas !== void 0) day.anlas += entry.anlas;
	else {
		day.totalUsd += entry.usd;
		day.bySource[entry.source] = (day.bySource[entry.source] ?? 0) + entry.usd;
		if (entry.task) day.byTask[entry.task] = (day.byTask[entry.task] ?? 0) + entry.usd;
		day.tokens.prompt += entry.tokens?.prompt ?? 0;
		day.tokens.completion += entry.tokens?.completion ?? 0;
		day.requests += 1;
		if (entry.estimated) day.estimated += 1;
	}
	day.recent.push(entry);
	if (day.recent.length > MAX_RECENT) day.recent.splice(0, day.recent.length - MAX_RECENT);
}
function addDays(a, b) {
	const sum = (x, y) => {
		const out = { ...x };
		for (const [key, value] of Object.entries(y)) out[key] = (out[key] ?? 0) + value;
		return out;
	};
	return {
		date: a.date,
		totalUsd: a.totalUsd + b.totalUsd,
		bySource: sum(a.bySource, b.bySource),
		byTask: sum(a.byTask, b.byTask),
		tokens: {
			prompt: a.tokens.prompt + b.tokens.prompt,
			completion: a.tokens.completion + b.tokens.completion
		},
		requests: a.requests + b.requests,
		estimated: a.estimated + b.estimated,
		anlas: a.anlas + b.anlas,
		recent: [...a.recent, ...b.recent].sort((x, y) => x.at - y.at).slice(-200)
	};
}
/** Accepts whatever is on disk (other versions, hand edits) and returns valid totals for that date. */
function sanitizeDay(raw, date) {
	const day = emptyDay(date);
	if (!isRecord$1(raw) || raw["date"] !== date) return day;
	day.totalUsd = nonNegative(raw["totalUsd"]);
	day.bySource = numberMap(raw["bySource"]);
	day.byTask = numberMap(raw["byTask"]);
	const tokens = isRecord$1(raw["tokens"]) ? raw["tokens"] : {};
	day.tokens = {
		prompt: nonNegative(tokens["prompt"]),
		completion: nonNegative(tokens["completion"])
	};
	day.requests = nonNegative(raw["requests"]);
	day.estimated = nonNegative(raw["estimated"]);
	day.anlas = nonNegative(raw["anlas"]);
	day.recent = Array.isArray(raw["recent"]) ? raw["recent"].filter((entry) => isRecord$1(entry) && typeof entry["at"] === "number" && typeof entry["source"] === "string").slice(-200) : [];
	return day;
}
function limitReached(limit, totalUsd) {
	return Boolean(limit?.enabled) && (limit?.usd ?? 0) > 0 && totalUsd >= (limit?.usd ?? 0);
}
function qvinkInstalled() {
	return typeof globalThis["memory_intercept_messages"] === "function";
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function firstNumber(...values) {
	for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
}
function nonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function positiveNumber(value) {
	const n = nonNegative(value);
	return n > 0 ? n : void 0;
}
function numberMap(value) {
	const out = {};
	if (!isRecord$1(value)) return out;
	for (const [key, item] of Object.entries(value)) {
		const n = nonNegative(item);
		if (n > 0) out[key] = n;
	}
	return out;
}
//#endregion
//#region src/core/ephemeral.ts
function injectionKey(key) {
	return `maestro_${key}`;
}
function createEphemeral(deps) {
	const { host, log } = deps;
	const producers = /* @__PURE__ */ new Map();
	const flags = /* @__PURE__ */ new Map();
	const injections = /* @__PURE__ */ new Map();
	const variables = () => {
		const meta = host.ctx().chatMetadata;
		const current = meta.variables;
		if (current && typeof current === "object" && !Array.isArray(current)) return current;
		const created = {};
		meta.variables = created;
		return created;
	};
	const clearAll = () => {
		for (const [name, store] of flags) delete store[name];
		flags.clear();
		if (injections.size === 0) return;
		const ctx = host.ctx();
		for (const [key, spec] of injections) try {
			ctx.setExtensionPrompt(injectionKey(key), "", spec.position, spec.depth ?? 0, false, spec.role ?? 0);
		} catch (error) {
			log.warn(`could not clear injection ${key}`, error);
		}
		injections.clear();
	};
	return {
		setFlag(name, value) {
			const store = variables();
			const previous = flags.get(name);
			if (previous && previous !== store) delete previous[name];
			store[name] = typeof value === "string" ? value : String(value);
			flags.set(name, store);
		},
		setInjection(key, spec) {
			host.ctx().setExtensionPrompt(injectionKey(key), spec.text, spec.position, spec.depth ?? 0, spec.scan ?? false, spec.role ?? 0);
			injections.set(key, { ...spec });
		},
		addProducer(name, producer) {
			if (producers.has(name)) log.warn(`ephemeral producer ${name} replaced`);
			producers.set(name, producer);
			return () => {
				if (producers.get(name) === producer) producers.delete(name);
			};
		},
		clearAll,
		async run(info) {
			clearAll();
			if (info.dryRun) return;
			for (const [name, producer] of [...producers]) try {
				await producer(info);
			} catch (error) {
				log.error(`ephemeral producer ${name} failed`, error);
			}
		}
	};
}
//#endregion
//#region src/core/i18n.ts
/**
* Both dictionaries are bundled: modules register their parts at load time, so the manifest needs no
* i18n files and there is no merge step. The language follows the core setting, then ST's locale.
*/
var Translations = class {
	resolveLocale;
	en = {};
	ru = {};
	constructor(resolveLocale) {
		this.resolveLocale = resolveLocale;
	}
	register(parts) {
		Object.assign(this.en, parts.en);
		Object.assign(this.ru, parts.ru);
	}
	locale() {
		return this.resolveLocale();
	}
	t(key, params) {
		const text = (this.locale() === "ru" ? this.ru[key] : this.en[key]) ?? this.en[key] ?? key;
		if (!params) return text;
		return text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
	}
	has(key) {
		return Object.hasOwn(this.en, key);
	}
	/** Keys present in English but missing in Russian (used by tests). */
	missingRussian() {
		return Object.keys(this.en).filter((key) => !Object.hasOwn(this.ru, key));
	}
};
/** ST stores the UI language in localStorage 'language' (e.g. 'ru-ru'); getCurrentLocale() exists in 1.19. */
function hostLocale(getLocale) {
	let value;
	try {
		value = getLocale?.() ?? globalThis.localStorage?.getItem("language") ?? void 0;
	} catch {
		value = void 0;
	}
	return value?.toLowerCase().startsWith("ru") ? "ru" : "en";
}
function createI18n(resolveLocale) {
	return new Translations(resolveLocale);
}
//#endregion
//#region src/core/inbox.ts
var INBOX_KIND = "inbox";
var DEFAULT_TTL_MS = 12096e5;
var CAP = 200;
var PUT_ATTEMPTS$1 = 3;
var SNOOZE_GRACE_MS = 864e5;
function newId$2() {
	return `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function jsonCopy$1(value) {
	const text = JSON.stringify(value);
	return text === void 0 ? value : JSON.parse(text);
}
function createInbox(deps, options = {}) {
	const { chat, journal, autonomy, bus, log } = deps;
	const defaultTtl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
	const cap = options.cap ?? CAP;
	const appliers = /* @__PURE__ */ new Map();
	const live = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Set();
	const busy = /* @__PURE__ */ new Set();
	/** Cards of the current chat, null until loaded. */
	let cards = null;
	let loading = null;
	/** Bumped on chat change: work started for the previous chat must not touch the new one. */
	let generation = 0;
	let chain = Promise.resolve();
	const defaults = () => ({ cards: [] });
	const emit = () => {
		for (const listener of [...listeners]) try {
			listener();
		} catch (error) {
			log.error("inbox listener failed", error);
		}
	};
	const expired = (card, now) => card.expiresAt !== void 0 && card.expiresAt <= now;
	/** Drops expired cards, then the oldest non-deferred ones above the cap. Returns dropped ids. */
	const prune = (list, now) => {
		const dropped = [];
		for (let i = list.length - 1; i >= 0; i--) {
			const card = list[i];
			if (card && expired(card, now)) dropped.push(...list.splice(i, 1).map((item) => item.id));
		}
		while (list.length > cap) {
			const index = list.findIndex((card) => !card.deferred);
			const [removed] = list.splice(index >= 0 ? index : 0, 1);
			if (removed) dropped.push(removed.id);
		}
		for (const id of dropped) live.delete(id);
		return dropped;
	};
	/** Read-modify-write of the current chat's cards with retries when another tab wrote first. */
	const mutate = (change) => {
		const job = async () => {
			const startedIn = generation;
			for (let attempt = 0; attempt < PUT_ATTEMPTS$1; attempt++) {
				if (generation !== startedIn) {
					log.warn("chat changed during an inbox update; the update was dropped");
					return;
				}
				const doc = await chat.get(INBOX_KIND, defaults);
				if (!Array.isArray(doc.cards)) doc.cards = [];
				const { changed, result } = change(doc.cards, Date.now());
				if (!changed) {
					if (generation === startedIn) cards = doc.cards;
					return result;
				}
				if (await chat.put("inbox", doc)) {
					if (generation === startedIn) {
						cards = doc.cards;
						emit();
					}
					return result;
				}
			}
			log.error(`inbox could not be saved after ${PUT_ATTEMPTS$1} attempts`);
		};
		const next = chain.then(job, job);
		chain = next.catch(() => void 0);
		return next;
	};
	const load = () => {
		if (loading && loading.generation === generation) return loading.promise;
		const startedIn = generation;
		const promise = chat.get(INBOX_KIND, defaults).then((doc) => {
			if (generation !== startedIn) return;
			if (!Array.isArray(doc.cards)) doc.cards = [];
			cards = doc.cards;
			emit();
			if (doc.cards.some((card) => expired(card, Date.now()))) mutate((list, now) => ({
				changed: prune(list, now).length > 0,
				result: void 0
			}));
		}).catch((error) => log.warn("could not load the inbox", error)).finally(() => {
			if (loading?.promise === promise) loading = null;
		});
		loading = {
			generation: startedIn,
			promise
		};
		return promise;
	};
	const currentCards = async () => {
		if (!cards) await load();
		return cards ?? [];
	};
	const removeCard = (id) => mutate((list) => {
		const index = list.findIndex((card) => card.id === id);
		if (index < 0) return {
			changed: false,
			result: void 0
		};
		const [removed] = list.splice(index, 1);
		live.delete(id);
		return {
			changed: true,
			result: removed
		};
	});
	const invalidateMessage = async (messageIndex) => {
		return await mutate((list) => {
			let count = 0;
			for (let i = list.length - 1; i >= 0; i--) {
				const card = list[i];
				if (card?.sourceMessage === messageIndex) {
					list.splice(i, 1);
					live.delete(card.id);
					count++;
				}
			}
			return {
				changed: count > 0,
				result: count
			};
		}) ?? 0;
	};
	const unsubscribers = [bus.on("chat:changed", () => {
		generation++;
		cards = null;
		live.clear();
		emit();
		load();
	}), bus.on("message:invalidated", ({ messageIndex }) => {
		invalidateMessage(messageIndex);
	})];
	const visible = () => {
		if (!cards) {
			load();
			return [];
		}
		const now = Date.now();
		return cards.filter((card) => !expired(card, now) && !(card.snoozedUntil !== void 0 && card.snoozedUntil > now));
	};
	return {
		registerApplier(kind, apply, stillValid) {
			const entry = {
				apply,
				stillValid
			};
			appliers.set(kind, entry);
			return () => {
				if (appliers.get(kind) === entry) appliers.delete(kind);
			};
		},
		async add(proposal, addOptions) {
			const now = Date.now();
			const card = {
				id: newId$2(),
				module: proposal.module,
				kind: proposal.kind,
				title: proposal.title,
				description: proposal.description,
				changes: jsonCopy$1(proposal.changes),
				payload: jsonCopy$1(proposal.payload),
				createdAt: now,
				sourceMessage: proposal.sourceMessage,
				expiresAt: now + (addOptions?.ttlMs ?? defaultTtl)
			};
			if (addOptions?.deferred) card.deferred = true;
			live.set(card.id, proposal);
			if (!await mutate((list, at) => {
				list.push(card);
				prune(list, at);
				return {
					changed: true,
					result: true
				};
			})) live.delete(card.id);
			return card.id;
		},
		list() {
			return visible().map((card) => ({ ...card }));
		},
		async accept(id, edited) {
			if (busy.has(id)) return false;
			busy.add(id);
			try {
				const card = (await currentCards()).find((item) => item.id === id);
				if (!card) return false;
				const proposal = live.get(id);
				const applier = appliers.get(card.kind);
				const payload = edited !== void 0 ? edited : proposal ? proposal.payload : card.payload;
				let valid = true;
				try {
					if (proposal?.stillValid) valid = await proposal.stillValid();
					else if (applier?.stillValid) valid = await applier.stillValid(payload);
				} catch (error) {
					log.warn(`${card.kind}: validation failed`, error);
					valid = false;
				}
				if (!valid) {
					log.info(`${card.kind}: card is out of date; dropped`);
					await removeCard(id);
					return false;
				}
				const apply = proposal ? (value) => proposal.apply(value) : applier?.apply;
				if (!apply) {
					log.warn(`${card.kind}: nothing can apply this card yet (module off?); kept`);
					return false;
				}
				try {
					await apply(payload);
				} catch (error) {
					log.error(`${card.kind}: apply failed`, error);
					return false;
				}
				await removeCard(id);
				try {
					await journal.record({
						module: card.module,
						kind: card.kind,
						summary: card.title,
						changes: card.changes,
						sourceMessage: card.sourceMessage
					});
				} catch (error) {
					log.error(`${card.kind}: applied but not journaled`, error);
				}
				autonomy.record(card.kind, edited !== void 0 ? "edited" : "accepted");
				return true;
			} finally {
				busy.delete(id);
			}
		},
		async reject(id) {
			const removed = await removeCard(id);
			if (removed) autonomy.record(removed.kind, "rejected");
		},
		async snooze(id, ms) {
			await mutate((list, now) => {
				const card = list.find((item) => item.id === id);
				if (!card) return {
					changed: false,
					result: void 0
				};
				card.snoozedUntil = now + Math.max(0, ms);
				card.expiresAt = Math.max(card.expiresAt ?? 0, card.snoozedUntil + SNOOZE_GRACE_MS);
				return {
					changed: true,
					result: void 0
				};
			});
		},
		invalidateMessage,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		count() {
			return visible().filter((card) => !card.deferred).length;
		},
		load,
		dispose() {
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			listeners.clear();
		}
	};
}
//#endregion
//#region src/core/journal.ts
var JOURNAL_KIND = "journal";
var RETENTION_MS = 2592e6;
var MAX_RECORDS = 2e3;
var PUT_ATTEMPTS = 3;
function newId$1() {
	return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** JSON copy: the journal is stored as JSON, so what is kept in memory must look the same. */
function jsonCopy(value) {
	const text = JSON.stringify(value);
	return text === void 0 ? value : JSON.parse(text);
}
function createJournal(deps, options = {}) {
	const { host, chat, log } = deps;
	const retentionMs = options.retentionMs ?? RETENTION_MS;
	const maxRecords = options.maxRecords ?? MAX_RECORDS;
	const handlers = /* @__PURE__ */ new Map();
	const undoneListeners = /* @__PURE__ */ new Set();
	const changeListeners = /* @__PURE__ */ new Set();
	const undoing = /* @__PURE__ */ new Set();
	/** Records made without a chat live only in memory. */
	const loose = [];
	let loaded = null;
	let loading = null;
	let chain = Promise.resolve();
	const defaults = () => ({ records: [] });
	const emitChange = () => {
		for (const listener of [...changeListeners]) try {
			listener();
		} catch (error) {
			log.error("journal listener failed", error);
		}
	};
	const trim = (records, now) => {
		const cutoff = now - retentionMs;
		let drop = 0;
		while (drop < records.length && (records[drop]?.at ?? 0) < cutoff) drop++;
		if (records.length - drop > maxRecords) drop = records.length - maxRecords;
		if (drop > 0) records.splice(0, drop);
	};
	const needsTrim = (records, now) => records.length > maxRecords || (records[0]?.at ?? now) < now - retentionMs;
	const readDoc = async (chatId) => {
		const doc = await chat.getFor(chatId, JOURNAL_KIND, defaults);
		if (!Array.isArray(doc.records)) doc.records = [];
		return doc;
	};
	/** Read-modify-write of one chat's journal with retries when another tab wrote first. */
	const mutate = (chatId, change) => {
		const job = async () => {
			for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
				const doc = await readDoc(chatId);
				if (!change(doc.records)) return true;
				trim(doc.records, Date.now());
				if (await chat.put("journal", doc)) {
					if (host.chatId() === chatId) {
						loaded = {
							chatId,
							records: doc.records
						};
						emitChange();
					}
					return true;
				}
			}
			log.error(`journal of this chat could not be saved after ${PUT_ATTEMPTS} attempts`);
			return false;
		};
		const next = chain.then(job, job);
		chain = next.catch(() => void 0);
		return next;
	};
	const load = () => {
		const chatId = host.chatId();
		if (!chatId) {
			loaded = null;
			return Promise.resolve();
		}
		if (loaded?.chatId === chatId) return Promise.resolve();
		if (loading?.chatId === chatId) return loading.promise;
		const promise = readDoc(chatId).then((doc) => {
			if (host.chatId() !== chatId) return;
			loaded = {
				chatId,
				records: doc.records
			};
			emitChange();
			if (needsTrim(doc.records, Date.now())) mutate(chatId, () => true);
		}).catch((error) => log.warn("could not load the journal", error)).finally(() => {
			if (loading?.promise === promise) loading = null;
		});
		loading = {
			chatId,
			promise
		};
		return promise;
	};
	const currentRecords = async () => {
		const chatId = host.chatId();
		if (!chatId) return loose;
		if (loaded?.chatId !== chatId) return (await readDoc(chatId)).records;
		return loaded.records;
	};
	const markUndone = async (record) => {
		if (!record.chatId) {
			record.undone = true;
			return;
		}
		await mutate(record.chatId, (records) => {
			const stored = records.find((item) => item.id === record.id);
			if (!stored || stored.undone) return false;
			stored.undone = true;
			return true;
		});
		record.undone = true;
	};
	const undo = async (id) => {
		if (undoing.has(id)) return false;
		const record = (await currentRecords()).find((item) => item.id === id) ?? loose.find((item) => item.id === id);
		if (!record || record.undone) return false;
		const missing = record.changes.find((change) => !handlers.has(change.target));
		if (missing) {
			log.warn(`no undo handler for ${missing.target}; ${record.kind} cannot be undone`);
			return false;
		}
		undoing.add(id);
		try {
			for (const change of [...record.changes].reverse()) {
				const handler = handlers.get(change.target);
				let ok = false;
				try {
					ok = handler ? await handler(change) : false;
				} catch (error) {
					log.error(`undo handler for ${change.target} failed`, error);
				}
				if (!ok) {
					log.warn(`undo of ${record.kind} stopped at ${change.target}`);
					return false;
				}
			}
			await markUndone(record);
			const copy = jsonCopy(record);
			for (const listener of [...undoneListeners]) try {
				listener(copy);
			} catch (error) {
				log.error("undo listener failed", error);
			}
			return true;
		} finally {
			undoing.delete(id);
		}
	};
	const chatChanged = host.events.name("CHAT_CHANGED");
	if (chatChanged) host.events.on(chatChanged, () => {
		loaded = null;
		emitChange();
		load();
	});
	return {
		async record(action) {
			const chatId = host.chatId();
			const record = {
				...jsonCopy(action),
				id: newId$1(),
				at: Date.now(),
				chatId
			};
			if (!chatId) {
				loose.push(record);
				trim(loose, record.at);
				return record.id;
			}
			await mutate(chatId, (records) => {
				records.push(record);
				return true;
			});
			return record.id;
		},
		undo,
		async undoForMessage(messageIndex) {
			const targets = (await currentRecords()).filter((record) => record.sourceMessage === messageIndex && !record.undone).reverse();
			let count = 0;
			for (const record of targets) if (await undo(record.id)) count++;
			return count;
		},
		list(filter) {
			const chatId = host.chatId();
			let records;
			if (!chatId) records = loose;
			else if (loaded?.chatId === chatId) records = loaded.records;
			else {
				load();
				records = [];
			}
			let result = [...records].reverse();
			if (filter?.module) result = result.filter((record) => record.module === filter.module);
			if (filter?.limit !== void 0) result = result.slice(0, Math.max(0, filter.limit));
			return result.map((record) => ({ ...record }));
		},
		registerUndo(target, handler) {
			if (handlers.has(target)) log.debug(`undo handler for ${target} replaced`);
			handlers.set(target, handler);
		},
		onUndone(listener) {
			undoneListeners.add(listener);
			return () => undoneListeners.delete(listener);
		},
		onChange(listener) {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
		load
	};
}
//#endregion
//#region src/core/leader.ts
var LEADER_CHANNEL = "maestro-leader";
var HEARTBEAT_MS = 1e4;
var STALE_MS = 3e4;
function browserChannel(name) {
	if (typeof BroadcastChannel === "undefined") return null;
	const channel = new BroadcastChannel(name);
	return {
		post: (message) => channel.postMessage(message),
		listen: (handler) => {
			channel.onmessage = (event) => handler(event.data);
		},
		close: () => channel.close()
	};
}
function defaultPage() {
	return typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
}
function parseLock(raw) {
	if (!raw || typeof raw !== "object") return null;
	const lock = raw;
	if (typeof lock.tabId !== "string" || typeof lock.heartbeatAt !== "number") return null;
	return {
		tabId: lock.tabId,
		heartbeatAt: lock.heartbeatAt
	};
}
function isMessage(value) {
	if (!value || typeof value !== "object") return false;
	const message = value;
	return (message.type === "claim" || message.type === "release") && typeof message.chatId === "string" && typeof message.tabId === "string";
}
function createLeader(host, files, bus, log, options = {}) {
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	const staleMs = options.staleMs ?? STALE_MS;
	const confirmDelay = options.confirmDelayMs ?? (() => 300 + Math.floor(Math.random() * 400));
	const tabId = options.tabId ?? currentTabId();
	const listeners = /* @__PURE__ */ new Set();
	let started = false;
	let leader = false;
	/** Chat whose lock this tab wrote last (and has not released). */
	let heldChat = null;
	let lastBeat = 0;
	let timer = null;
	let busy = null;
	let again = false;
	let channel = null;
	let page = null;
	const unsubscribers = [];
	const lockName = (chatId) => files.fileName("lock", chatId);
	const currentChat = () => host.isGroupChat() ? null : host.chatId();
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const setLeader = (value) => {
		if (leader === value) return;
		leader = value;
		log.info(value ? "this tab leads the chat" : "this tab no longer leads the chat");
		for (const listener of [...listeners]) try {
			listener(value);
		} catch (error) {
			log.error("leader listener failed", error);
		}
		bus.emit("leader:changed", { leader: value });
	};
	const post = (type, chatId, via = channel) => {
		try {
			via?.post({
				type,
				chatId,
				tabId
			});
		} catch (error) {
			log.debug("leader channel post failed", error);
		}
	};
	const release = async (chatId, via = channel) => {
		if (heldChat === chatId) heldChat = null;
		try {
			if (parseLock(await readFresh(files, lockName(chatId)))?.tabId === tabId) await files.remove(lockName(chatId));
		} catch (error) {
			log.debug("could not release the lock", error);
		}
		post("release", chatId, via);
	};
	const evaluateOnce = async () => {
		if (!started) return;
		const chatId = currentChat();
		if (heldChat && heldChat !== chatId) {
			setLeader(false);
			await release(heldChat);
		}
		if (!chatId) {
			setLeader(false);
			return;
		}
		const name = lockName(chatId);
		let lock;
		try {
			lock = parseLock(await readFresh(files, name));
		} catch (error) {
			log.warn("could not read the leader lock", error);
			if (leader && Date.now() - lastBeat > staleMs) setLeader(false);
			return;
		}
		const now = Date.now();
		const mine = lock?.tabId === tabId;
		if (lock && !mine && now - lock.heartbeatAt <= staleMs) {
			if (heldChat === chatId) heldChat = null;
			setLeader(false);
			return;
		}
		const continuing = leader && mine && heldChat === chatId;
		try {
			await files.write(name, {
				tabId,
				heartbeatAt: now,
				chatId
			});
		} catch (error) {
			log.warn("could not write the leader lock", error);
			if (leader && Date.now() - lastBeat > staleMs) setLeader(false);
			return;
		}
		lastBeat = Date.now();
		heldChat = chatId;
		if (continuing) return;
		await delay(confirmDelay());
		if (!started || currentChat() !== chatId) return;
		let check;
		try {
			check = parseLock(await readFresh(files, name));
		} catch (error) {
			log.warn("could not confirm the leader lock", error);
			return;
		}
		if (check?.tabId !== tabId) {
			if (heldChat === chatId) heldChat = null;
			setLeader(false);
			return;
		}
		setLeader(true);
		post("claim", chatId);
	};
	const evaluate = () => {
		if (busy) {
			again = true;
			return busy;
		}
		busy = (async () => {
			do {
				again = false;
				try {
					await evaluateOnce();
				} catch (error) {
					log.error("leader evaluation failed", error);
				}
			} while (again && started);
		})().finally(() => {
			busy = null;
		});
		return busy;
	};
	const onMessage = (raw) => {
		if (!isMessage(raw) || raw.tabId === tabId) return;
		if (raw.chatId !== currentChat()) return;
		if (raw.type === "release" ? !leader : leader) evaluate();
	};
	const onPageHide = () => {
		const chatId = heldChat;
		if (!chatId) return;
		post("release", chatId);
		files.remove(lockName(chatId)).catch(() => void 0);
	};
	const onPageShow = () => void evaluate();
	return {
		isLeader: () => leader,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh: evaluate,
		start() {
			if (started) return;
			started = true;
			const chatChanged = host.events.name("CHAT_CHANGED");
			if (chatChanged) unsubscribers.push(host.events.on(chatChanged, () => void evaluate()));
			else log.warn("CHAT_CHANGED is missing; leadership follows the heartbeat only");
			const makeChannel = options.channel === void 0 ? browserChannel : options.channel;
			try {
				channel = makeChannel ? makeChannel(LEADER_CHANNEL) : null;
				channel?.listen(onMessage);
			} catch (error) {
				log.debug("BroadcastChannel unavailable", error);
				channel = null;
			}
			page = options.page === void 0 ? defaultPage() : options.page;
			page?.addEventListener("pagehide", onPageHide);
			page?.addEventListener("pageshow", onPageShow);
			timer = setInterval(() => void evaluate(), heartbeatMs);
			evaluate();
		},
		stop() {
			if (!started) return;
			started = false;
			if (timer !== null) clearInterval(timer);
			timer = null;
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
			page?.removeEventListener("pagehide", onPageHide);
			page?.removeEventListener("pageshow", onPageShow);
			page = null;
			const held = heldChat;
			const closing = channel;
			channel = null;
			setLeader(false);
			const close = () => closing?.close();
			if (held) release(held, closing).finally(close);
			else close();
		}
	};
}
var BREAKER_OPEN_MS = 3e5;
var DEFAULT_BACKOFF_MS = [1e3, 3e3];
function createLlmClient(deps) {
	const { host, settings, cost, log } = deps;
	const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
	const now = deps.now ?? Date.now;
	const breakers = /* @__PURE__ */ new Map();
	function connectionManager() {
		const context = host.ctx();
		const service = context.ConnectionManagerRequestService;
		if (!service || typeof service.sendRequest !== "function") return void 0;
		const disabled = context.extensionSettings?.disabledExtensions;
		if (Array.isArray(disabled) && disabled.includes("connection-manager")) return void 0;
		return service;
	}
	function candidates(task) {
		const profiles = settings.core().profiles ?? {};
		const primary = nonEmpty(profiles[task]) ?? nonEmpty(profiles["default"]);
		const fallback = nonEmpty(profiles["fallback"]);
		const list = [];
		for (const id of [primary, fallback]) if (id && !list.includes(id)) list.push(id);
		return list;
	}
	function isOpen(profileId) {
		const state = breakers.get(profileId);
		return state !== void 0 && state.openUntil > now();
	}
	function failed(profileId) {
		const state = breakers.get(profileId) ?? {
			failures: 0,
			openUntil: 0
		};
		state.failures += 1;
		if (state.failures >= 3) {
			state.openUntil = now() + BREAKER_OPEN_MS;
			log.warn(`profile ${profileId} failed ${state.failures} times in a row; paused for 5 minutes`);
		}
		breakers.set(profileId, state);
	}
	function succeeded(profileId) {
		breakers.delete(profileId);
	}
	function recordCost(task, raw, spent) {
		const usage = readUsage(raw);
		const usd = usage?.usd ?? 0;
		const tokens = usage ? {
			prompt: usage.prompt,
			completion: usage.completion
		} : void 0;
		cost.record(dropUndefined({
			source: "maestro",
			task,
			usd,
			tokens,
			estimated: usage?.usd === void 0
		}));
		spent.any = true;
		spent.usd += usd;
		spent.prompt += tokens?.prompt ?? 0;
		spent.completion += tokens?.completion ?? 0;
	}
	async function sendOnce(service, profileId, request, useSchema, spent) {
		const controller = new AbortController();
		const outer = request.signal;
		const forward = () => controller.abort(outer?.reason);
		outer?.addEventListener("abort", forward, { once: true });
		cost.beginOwn?.(controller.signal);
		try {
			const raw = await service.sendRequest(profileId, buildMessages(request, useSchema), request.maxTokens, {
				stream: false,
				signal: controller.signal,
				extractData: false,
				includePreset: false,
				includeInstruct: true
			}, buildOverride(request, useSchema));
			recordCost(request.task, raw, spent);
			return {
				kind: "ok",
				raw
			};
		} catch (error) {
			if (outer?.aborted || isAbortError(error)) return { kind: "aborted" };
			return {
				kind: "error",
				error
			};
		} finally {
			cost.endOwn?.(controller.signal);
			outer?.removeEventListener("abort", forward);
		}
	}
	async function sendWithRetries(service, profileId, request, useSchema, spent) {
		for (let attempt = 0;; attempt++) {
			if (request.signal?.aborted) return { kind: "aborted" };
			const outcome = await sendOnce(service, profileId, request, useSchema, spent);
			if (outcome.kind !== "error") return outcome;
			const delay = backoff[attempt];
			if (delay === void 0 || !retryable(outcome.error, useSchema)) return outcome;
			log.debug(`request ${request.task} via ${profileId} failed, retry ${attempt + 1}`, errorText$2(outcome.error));
			if (!await sleep(delay, request.signal)) return { kind: "aborted" };
		}
	}
	/** One profile: transport retries, then the structured-output fallback. `final` = do not try another profile. */
	async function viaProfile(service, profileId, request, spent) {
		let useSchema = Boolean(request.schema);
		for (let pass = 0; pass < 2; pass++) {
			const sent = await sendWithRetries(service, profileId, request, useSchema, spent);
			if (sent.kind === "aborted") return {
				final: true,
				result: {
					ok: false,
					error: "aborted"
				}
			};
			if (sent.kind === "error") {
				if (useSchema && pass === 0 && schemaRejected(sent.error)) {
					log.debug(`profile ${profileId} rejected json_schema; asking with instructions only`);
					useSchema = false;
					continue;
				}
				failed(profileId);
				log.warn(`request ${request.task} via ${profileId} failed`, errorText$2(sent.error));
				return {
					final: false,
					result: {
						ok: false,
						error: `transport: ${errorText$2(sent.error)}`
					}
				};
			}
			const reply = extractReply(sent.raw);
			const text = stripThinking(reply.text).trim();
			if (request.tools && request.tools.length > 0 && reply.toolCalls.length > 0) {
				succeeded(profileId);
				return {
					final: true,
					result: dropUndefined({
						ok: true,
						text: text || void 0,
						toolCalls: reply.toolCalls
					})
				};
			}
			if (request.schema) {
				const parsed = parseStructured(reply, request.schema);
				if (parsed.ok) {
					succeeded(profileId);
					return {
						final: true,
						result: {
							ok: true,
							data: parsed.value,
							text
						}
					};
				}
				if (reply.refusal || looksLikeRefusal(text)) {
					succeeded(profileId);
					return {
						final: true,
						result: {
							ok: false,
							refusal: true,
							error: "refusal",
							text
						}
					};
				}
				if (pass === 0) {
					log.debug(`request ${request.task}: unparsable JSON, retrying without json_schema`);
					useSchema = false;
					continue;
				}
				failed(profileId);
				return {
					final: false,
					result: {
						ok: false,
						error: "parse",
						text
					}
				};
			}
			if (reply.refusal || looksLikeRefusal(text)) {
				succeeded(profileId);
				return {
					final: true,
					result: {
						ok: false,
						refusal: true,
						error: "refusal",
						text
					}
				};
			}
			if (!text) {
				failed(profileId);
				return {
					final: false,
					result: {
						ok: false,
						error: "empty"
					}
				};
			}
			succeeded(profileId);
			return {
				final: true,
				result: {
					ok: true,
					text,
					data: text
				}
			};
		}
		return {
			final: false,
			result: {
				ok: false,
				error: "parse"
			}
		};
	}
	return {
		async request(request) {
			if (cost.backgroundCapReached()) return {
				ok: false,
				error: "cap"
			};
			const service = connectionManager();
			if (!service) return {
				ok: false,
				error: "no-cm"
			};
			const profiles = candidates(request.task);
			if (profiles.length === 0) return {
				ok: false,
				error: "no-profile"
			};
			const usable = profiles.filter((id) => !isOpen(id));
			if (usable.length === 0) return {
				ok: false,
				error: "breaker-open"
			};
			const spent = {
				any: false,
				usd: 0,
				prompt: 0,
				completion: 0
			};
			let result = {
				ok: false,
				error: "breaker-open"
			};
			for (const profileId of usable) {
				const outcome = await viaProfile(service, profileId, request, spent);
				result = outcome.result;
				if (outcome.final || !isOpen(profileId)) break;
			}
			if (spent.any) {
				result.costUsd = spent.usd;
				result.tokens = {
					prompt: spent.prompt,
					completion: spent.completion
				};
			}
			return result;
		},
		available(task) {
			if (!connectionManager()) return false;
			return candidates(task).some((id) => !isOpen(id));
		},
		breaker(profileId) {
			const state = breakers.get(profileId);
			return state ? { ...state } : {
				failures: 0,
				openUntil: 0
			};
		},
		resetBreakers() {
			breakers.clear();
		}
	};
}
var SCHEMA_INSTRUCTION = "Reply with exactly one JSON value and nothing else: no prose, no markdown code fences. It must match this JSON schema:\n";
function buildMessages(request, useSchema) {
	const messages = request.messages.map(toWire);
	if (request.schema && !useSchema) messages.push({
		role: "system",
		content: SCHEMA_INSTRUCTION + JSON.stringify(request.schema.schema)
	});
	return messages;
}
function toWire(message) {
	return dropUndefined({
		role: message.role,
		content: message.content,
		tool_calls: message.tool_calls,
		tool_call_id: message.tool_call_id
	});
}
function buildOverride(request, useSchema) {
	const tools = request.tools && request.tools.length > 0 ? request.tools : void 0;
	return dropUndefined({
		temperature: request.temperature,
		json_schema: useSchema && request.schema ? {
			name: request.schema.name,
			strict: true,
			value: request.schema.schema
		} : void 0,
		tools,
		tool_choice: tools ? "auto" : void 0,
		custom_prompt_post_processing: tools ? "" : void 0
	});
}
/** Reads the raw response of ChatCompletionService/TextCompletionService (extractData: false). */
function extractReply(raw) {
	const reply = {
		text: "",
		toolCalls: [],
		toolInputs: [],
		refusal: false
	};
	if (typeof raw === "string") {
		reply.text = raw;
		return reply;
	}
	if (!isRecord(raw)) return reply;
	const choices = raw["choices"];
	const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : void 0;
	if (choice) {
		const message = isRecord(choice["message"]) ? choice["message"] : void 0;
		if (message) {
			reply.text = contentText(message["content"]);
			if (Array.isArray(message["tool_calls"])) reply.toolCalls = [...message["tool_calls"]];
			if (typeof message["refusal"] === "string" && message["refusal"].trim()) {
				reply.refusal = true;
				if (!reply.text) reply.text = message["refusal"];
			}
		}
		if (!reply.text && typeof choice["text"] === "string") reply.text = choice["text"];
		if (choice["finish_reason"] === "content_filter") reply.refusal = true;
		return reply;
	}
	if (Array.isArray(raw["content"])) {
		const blocks = raw["content"].filter(isRecord);
		reply.text = blocks.filter((block) => block["type"] === "text" && typeof block["text"] === "string").map((block) => String(block["text"])).join("\n\n");
		for (const block of blocks) {
			if (block["type"] !== "tool_use" || typeof block["name"] !== "string") continue;
			reply.toolInputs.push({
				name: block["name"],
				input: block["input"]
			});
			reply.toolCalls.push({
				id: block["id"],
				type: "function",
				function: {
					name: block["name"],
					arguments: JSON.stringify(block["input"] ?? {})
				}
			});
		}
		if (raw["stop_reason"] === "refusal") reply.refusal = true;
		return reply;
	}
	const message = isRecord(raw["message"]) ? raw["message"] : void 0;
	if (message) {
		reply.text = contentText(message["content"]);
		return reply;
	}
	const candidates = raw["candidates"];
	const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : void 0;
	const content = candidate && isRecord(candidate["content"]) ? candidate["content"] : void 0;
	if (content) reply.text = contentText(content["parts"]);
	if (typeof raw["text"] === "string" && !reply.text) reply.text = raw["text"];
	return reply;
}
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(isRecord).filter((part) => typeof part["text"] === "string" && (part["type"] === void 0 || part["type"] === "text")).map((part) => String(part["text"])).join("");
}
/** Removes reasoning blocks; text before a lone closing tag is reasoning too. */
function stripThinking(text) {
	let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
	const close = out.search(/<\/(think|thinking|reasoning)>/i);
	if (close >= 0) out = out.slice(out.indexOf(">", close) + 1);
	return out;
}
/** Parses a JSON value from model text: no fences, no reasoning, the outermost {…} (or […]). */
function parseJsonText(text) {
	const cleaned = stripThinking(text).replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
	if (!cleaned) return void 0;
	const attempts = [
		cleaned,
		outermost(cleaned, "{", "}"),
		outermost(cleaned, "[", "]")
	];
	for (const attempt of attempts) {
		if (!attempt) continue;
		try {
			return JSON.parse(attempt);
		} catch {}
	}
}
function outermost(text, open, close) {
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	return start >= 0 && end > start ? text.slice(start, end + 1) : void 0;
}
function parseStructured(reply, schema) {
	const fromTool = reply.toolInputs.find((tool) => tool.name === schema.name);
	if (fromTool && matchesSchema(fromTool.input, schema.schema)) return {
		ok: true,
		value: fromTool.input
	};
	const value = parseJsonText(reply.text);
	if (value !== void 0 && matchesSchema(value, schema.schema)) return {
		ok: true,
		value
	};
	return { ok: false };
}
/**
* A light JSON-schema check (type, enum, required, properties, items): enough to reject a wrong shape
* before a feature applies it. Unknown keywords are ignored.
*/
function matchesSchema(value, schema, depth = 0) {
	if (!isRecord(schema) || depth > 32) return true;
	const enumValues = schema["enum"];
	if (Array.isArray(enumValues) && !enumValues.some((item) => item === value)) return false;
	const type = schema["type"];
	if (typeof type === "string" && !matchesType(value, type)) return false;
	if (Array.isArray(type) && !type.some((item) => typeof item === "string" && matchesType(value, item))) return false;
	if (isRecord(value)) {
		const required = schema["required"];
		if (Array.isArray(required) && required.some((key) => typeof key === "string" && !(key in value))) return false;
		const properties = schema["properties"];
		if (isRecord(properties)) {
			for (const [key, sub] of Object.entries(properties)) if (key in value && !matchesSchema(value[key], sub, depth + 1)) return false;
		}
	}
	if (Array.isArray(value) && isRecord(schema["items"])) {
		const items = schema["items"];
		if (!value.every((item) => matchesSchema(item, items, depth + 1))) return false;
	}
	return true;
}
function matchesType(value, type) {
	switch (type) {
		case "object": return isRecord(value);
		case "array": return Array.isArray(value);
		case "string": return typeof value === "string";
		case "number": return typeof value === "number" && Number.isFinite(value);
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return true;
	}
}
var VERBS_EN = "help|assist|comply|provide|continue|create|write|fulfil|fulfill|generate|engage|produce|participate|do that|do this";
var REFUSAL_PATTERNS = [
	new RegExp(`\\b(?:i|we) (?:can't|cannot|can not|won't|will not) (?:${VERBS_EN})`),
	new RegExp(`\\bi(?:'m| am) (?:unable|not able) to (?:${VERBS_EN})`),
	/\bas an ai\b/,
	/\bi must (?:decline|refuse)\b/,
	/\bi(?:'m| am) sorry,? but i (?:can't|cannot|won't)\b/,
	/не могу (?:с этим )?(?:помочь|выполнить|продолжить|создать|написать|сгенерировать|участвовать)/,
	/(?:^|[^а-яё])я не могу(?:[^а-яё]|$)/,
	/(?:^|[^а-яё])как (?:ии|искусственный интеллект|языковая модель)(?:[^а-яё]|$)/,
	/вынужден[аы]? отказаться/,
	/извините, но я не/
];
/**
* Refusal heuristics (en/ru). A refusal opens the reply: the phrase must sit in the first 80 characters of a
* short reply with no quotation mark before it, so story text like `"I can't help it," she said` is not one.
*/
function looksLikeRefusal(text) {
	const normalized = text.trim().toLowerCase().replace(/[’`]/g, "'");
	if (!normalized || normalized.length > 1500) return false;
	const head = normalized.slice(0, 300);
	return REFUSAL_PATTERNS.some((pattern) => {
		const match = pattern.exec(head);
		return match !== null && match.index <= 80 && !/["«»“”„]/.test(head.slice(0, match.index));
	});
}
/** Messages of an error and its causes (ST wraps failures as Error('API request failed', { cause })). */
function errorText$2(error) {
	const parts = [];
	let current = error;
	for (let depth = 0; current !== void 0 && current !== null && depth < 5; depth++) if (current instanceof Error) {
		if (current.message) parts.push(current.message);
		current = current.cause;
	} else {
		parts.push(String(current));
		break;
	}
	return parts.join(": ") || "unknown error";
}
function isAbortError(error) {
	let current = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		if (current.name === "AbortError") return true;
		current = current.cause;
	}
	return false;
}
/** Configuration errors do not get better with retries. */
function retryable(error, useSchema) {
	const text = errorText$2(error);
	if (/Profile not found|Connection Manager is not available|does not support|Unknown API type/i.test(text)) return false;
	return !(useSchema && schemaRejected(error));
}
function schemaRejected(error) {
	return /json_schema|response_format|structured output|schema/i.test(errorText$2(error));
}
function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dropUndefined(value) {
	const out = { ...value };
	for (const key of Object.keys(out)) if (out[key] === void 0) delete out[key];
	return out;
}
//#endregion
//#region src/core/logger.ts
var ORDER = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
var MAX_LINES = 500;
/** Console logger with a ring buffer of warnings and errors (shown in the pult, exported for debugging). */
var ConsoleLogger = class ConsoleLogger {
	prefix;
	static threshold = "info";
	static lines = [];
	constructor(prefix = "Maestro") {
		this.prefix = prefix;
	}
	static setLevel(level) {
		ConsoleLogger.threshold = level;
	}
	static recent() {
		return [...ConsoleLogger.lines];
	}
	static clear() {
		ConsoleLogger.lines = [];
	}
	scope(name) {
		return new ConsoleLogger(`${this.prefix}:${name}`);
	}
	debug(...args) {
		this.write("debug", args);
	}
	info(...args) {
		this.write("info", args);
	}
	warn(...args) {
		this.write("warn", args);
	}
	error(...args) {
		this.write("error", args);
	}
	write(level, args) {
		if (ORDER[level] >= ORDER.warn) {
			ConsoleLogger.lines.push({
				at: Date.now(),
				level,
				scope: this.prefix,
				text: args.map(stringify).join(" ")
			});
			if (ConsoleLogger.lines.length > MAX_LINES) ConsoleLogger.lines.splice(0, ConsoleLogger.lines.length - MAX_LINES);
		}
		if (ORDER[level] < ORDER[ConsoleLogger.threshold]) return;
		const tag = `[${this.prefix}]`;
		if (level === "debug") console.debug(tag, ...args);
		else if (level === "info") console.info(tag, ...args);
		else if (level === "warn") console.warn(tag, ...args);
		else console.error(tag, ...args);
	}
};
function stringify(value) {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
function createLogger() {
	return new ConsoleLogger();
}
//#endregion
//#region src/core/settings.ts
var SETTINGS_KEY = "maestro";
function defaultCoreSettings() {
	return {
		schemaVersion: 1,
		mode: "balanced",
		debug: false,
		uiLanguage: "auto",
		profiles: {},
		backgroundDailyCapUsd: 0,
		dailyLimit: {
			enabled: false,
			usd: 0,
			action: "warn"
		},
		autonomy: {},
		modules: {},
		firstRunDone: false
	};
}
/** Fills missing keys from defaults without overwriting stored values (shallow per object level). */
function fillDefaults(stored, defaults) {
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return structuredClone(defaults);
	const result = structuredClone(defaults);
	for (const [key, value] of Object.entries(stored)) {
		const base = result[key];
		if (base && typeof base === "object" && !Array.isArray(base) && value && typeof value === "object" && !Array.isArray(value)) result[key] = fillDefaults(value, base);
		else result[key] = value;
	}
	return result;
}
/**
* Settings live in extensionSettings.maestro = { core, modules: { [key]: slice } }. The object stays the
* same reference so ST's own save picks up every change.
*/
var Settings = class {
	getStore;
	persist;
	log;
	moduleDefaults = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	root;
	constructor(getStore, persist, log) {
		this.getStore = getStore;
		this.persist = persist;
		this.log = log;
		this.root = this.load();
	}
	/** Re-reads extensionSettings (ST may replace the object after a settings reload). */
	reload() {
		this.root = this.load();
	}
	registerModule(key, defaults, enabledByDefault) {
		this.moduleDefaults.set(key, {
			defaults,
			enabledByDefault
		});
		const stored = this.root.modules[key];
		this.root.modules[key] = fillDefaults(stored, defaults());
	}
	core() {
		return this.root.core;
	}
	module(key) {
		let slice = this.root.modules[key];
		if (!slice) {
			const entry = this.moduleDefaults.get(key);
			slice = entry ? entry.defaults() : {};
			this.root.modules[key] = slice;
		}
		return slice;
	}
	isModuleEnabled(key) {
		const explicit = this.root.core.modules[key];
		if (typeof explicit === "boolean") return explicit;
		return this.moduleDefaults.get(key)?.enabledByDefault ?? false;
	}
	setModuleEnabled(key, enabled) {
		this.root.core.modules[key] = enabled;
		this.save();
		this.notify(`core.modules.${key}`);
	}
	save() {
		this.persist();
	}
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	notify(path) {
		for (const listener of [...this.listeners]) try {
			listener(path);
		} catch (error) {
			this.log.error("settings listener failed", error);
		}
	}
	/** Lifecycle `clean`: drop everything Maestro stored in settings. */
	reset() {
		const store = this.getStore();
		delete store[SETTINGS_KEY];
		this.root = this.load();
		this.save();
	}
	load() {
		const store = this.getStore();
		const raw = store["maestro"] ?? {};
		const root = {
			core: migrateCore(fillDefaults(raw.core, defaultCoreSettings())),
			modules: raw.modules && typeof raw.modules === "object" ? raw.modules : {}
		};
		store[SETTINGS_KEY] = root;
		return root;
	}
};
/** Core settings migrations: add steps as `if (settings.schemaVersion === n) { …; settings.schemaVersion = n + 1; }`. */
function migrateCore(settings) {
	if (!settings.schemaVersion || settings.schemaVersion < 1) settings.schemaVersion = 1;
	return settings;
}
//#endregion
//#region src/core/strings.ts
/** Strings of core services (`core.*`). Russian is the primary UI language. */
var CORE_STRINGS = {
	en: {
		"core.name": "Maestro",
		"core.autonomy.level.auto": "Auto",
		"core.autonomy.level.notify": "Notify",
		"core.autonomy.level.inbox": "Inbox",
		"core.autonomy.level.ask": "Ask",
		"core.autonomy.level.off": "Off",
		"core.autonomy.apply": "Apply",
		"core.autonomy.stale": "The suggestion is out of date: the data has changed since it was made.",
		"core.autonomy.failed": "Could not apply: {title}",
		"core.autonomy.promote": "You accepted “{kind}” suggestions {count} times in a row without changes. Apply them automatically from now on?",
		"core.autonomy.promoteAction": "Switch to Auto",
		"core.autonomy.promoted": "“{kind}” is now set to Auto. You can change this in the autonomy settings."
	},
	ru: {
		"core.name": "Maestro",
		"core.autonomy.level.auto": "Само",
		"core.autonomy.level.notify": "Уведомить",
		"core.autonomy.level.inbox": "Входящие",
		"core.autonomy.level.ask": "Спросить",
		"core.autonomy.level.off": "Выкл",
		"core.autonomy.apply": "Применить",
		"core.autonomy.stale": "Предложение устарело: данные изменились с тех пор, как оно появилось.",
		"core.autonomy.failed": "Не получилось применить: {title}",
		"core.autonomy.promote": "Ты принимаешь предложения «{kind}» без правок (подряд: {count}). Применять их дальше автоматически?",
		"core.autonomy.promoteAction": "Перевести в «Само»",
		"core.autonomy.promoted": "Теперь «{kind}» — в режиме «Само». Поменять можно в настройках автономии."
	}
};
//#endregion
//#region src/core/tasks.ts
var FILE_KIND = "tasks";
var POLL_MS$1 = 5e3;
var RETRY_DELAYS_MS = [
	2e3,
	1e4,
	3e4
];
var RUN_TIMEOUT_MS = 3e5;
var HISTORY_LIMIT = 50;
/** A task left 'running' longer than this (tab closed mid-run) goes back to the queue. */
var RUNNING_STALE_MS = 6e5;
/** Pending tasks older than this expire even without a ttl (their chat may never be opened again). */
var MAX_PENDING_AGE_MS = 12096e5;
var MAX_TASKS = 500;
/** With an empty queue the leader re-reads the file this often (tasks enqueued by other tabs). */
var IDLE_REFRESH_MS = 3e4;
function emptyFile() {
	return {
		schema: 1,
		version: 0,
		tasks: [],
		history: []
	};
}
function normalise(raw) {
	if (!raw || typeof raw !== "object") return emptyFile();
	const file = raw;
	return {
		schema: 1,
		version: typeof file.version === "number" ? file.version : 0,
		tasks: Array.isArray(file.tasks) ? file.tasks.filter(isTask) : [],
		history: Array.isArray(file.history) ? file.history.filter(isTask) : []
	};
}
function isTask(value) {
	if (!value || typeof value !== "object") return false;
	const task = value;
	return typeof task.id === "string" && typeof task.kind === "string" && typeof task.state === "string";
}
function errorText$1(error) {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : JSON.stringify(error);
}
function newId() {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function createTaskQueue(deps, options = {}) {
	const { host, files, leader, bus, log } = deps;
	const pollMs = options.pollMs ?? POLL_MS$1;
	const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
	const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
	const historyLimit = options.historyLimit ?? HISTORY_LIMIT;
	const fileName = files.fileName(FILE_KIND);
	const tabId = currentTabId();
	const runners = /* @__PURE__ */ new Map();
	const unsubscribers = [];
	let state = emptyFile();
	let lastRead = 0;
	let loaded = null;
	let chain = Promise.resolve();
	let started = false;
	let pumping = null;
	let running = null;
	let pollTimer = null;
	let kickTimer = null;
	const retryTimers = /* @__PURE__ */ new Set();
	/** Serialised read-modify-write of the queue file; writes only when `changed`. */
	const mutate = (change) => {
		const job = async () => {
			const file = normalise(await readFresh(files, fileName));
			lastRead = Date.now();
			const { changed, result } = change(file, Date.now());
			if (changed) {
				file.version++;
				await files.write(fileName, file);
			}
			state = file;
			return result;
		};
		const next = chain.then(job, job);
		chain = next.catch(() => void 0);
		return next;
	};
	const ensureLoaded = () => {
		loaded ??= mutate(() => ({
			changed: false,
			result: void 0
		})).catch((error) => {
			loaded = null;
			log.warn("could not load the task queue", error);
		});
		return loaded;
	};
	const toHistory = (file, task, stateName, now) => {
		const index = file.tasks.indexOf(task);
		if (index >= 0) file.tasks.splice(index, 1);
		task.state = stateName;
		task.finishedAt = now;
		task.updatedAt = now;
		delete task.runningBy;
		delete task.notBefore;
		file.history.push(task);
		if (file.history.length > historyLimit) file.history.splice(0, file.history.length - historyLimit);
	};
	/** Expires stale pending tasks and requeues tasks orphaned while running. */
	const housekeeping = (file, now) => {
		let changed = false;
		for (const task of [...file.tasks]) if (task.state === "pending") {
			if (task.ttlMs !== void 0 && task.attempts === 0 && now - task.createdAt > task.ttlMs || now - task.createdAt > MAX_PENDING_AGE_MS) {
				toHistory(file, task, "expired", now);
				changed = true;
			}
		} else if (task.state === "running" && now - (task.startedAt ?? task.updatedAt) > RUNNING_STALE_MS) {
			log.warn(`task ${task.kind} was left running; requeued`);
			if (task.attempts > retryDelays.length) {
				task.error = "interrupted";
				toHistory(file, task, "failed", now);
			} else {
				task.state = "pending";
				task.updatedAt = now;
				delete task.runningBy;
			}
			changed = true;
		}
		if (file.tasks.length > MAX_TASKS) {
			const overflow = file.tasks.filter((task) => task.state === "pending").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt - b.createdAt).slice(0, file.tasks.length - MAX_TASKS);
			for (const task of overflow) {
				task.error = "queue overflow";
				toHistory(file, task, "expired", now);
			}
			changed ||= overflow.length > 0;
		}
		return changed;
	};
	const pick = (file, chatId, now) => {
		return file.tasks.filter((task) => task.state === "pending" && task.chatId === chatId && runners.has(task.kind) && (task.notBefore ?? 0) <= now && (deps.canRun?.(task.kind) ?? true)).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt)[0];
	};
	const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`timed out after ${ms} ms`)), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(errorText$1(error)));
		});
	});
	const scheduleRetry = (ms) => {
		const timer = setTimeout(() => {
			retryTimers.delete(timer);
			kick();
		}, ms);
		retryTimers.add(timer);
	};
	const execute = async (task) => {
		const runner = runners.get(task.kind);
		if (!runner) {
			await mutate((file, now) => {
				const live = file.tasks.find((item) => item.id === task.id);
				if (!live) return {
					changed: false,
					result: void 0
				};
				live.state = "pending";
				live.attempts = Math.max(0, live.attempts - 1);
				live.updatedAt = now;
				delete live.runningBy;
				return {
					changed: true,
					result: void 0
				};
			});
			return;
		}
		const info = structuredClone({
			id: task.id,
			kind: task.kind,
			dedupeKey: task.dedupeKey,
			payload: task.payload,
			chatId: task.chatId,
			priority: task.priority,
			ttlMs: task.ttlMs,
			state: "running",
			attempts: task.attempts,
			createdAt: task.createdAt
		});
		try {
			await withTimeout(Promise.resolve().then(() => runner(structuredClone(task.payload), info)), runTimeoutMs);
			await mutate((file, now) => {
				const live = file.tasks.find((item) => item.id === task.id);
				if (!live) return {
					changed: false,
					result: void 0
				};
				delete live.error;
				toHistory(file, live, "done", now);
				return {
					changed: true,
					result: void 0
				};
			});
			log.debug(`task ${task.kind} done`);
		} catch (error) {
			const message = errorText$1(error);
			log.warn(`task ${task.kind} failed (attempt ${task.attempts})`, error);
			const retryIn = await mutate((file, now) => {
				const live = file.tasks.find((item) => item.id === task.id);
				if (!live) return {
					changed: false,
					result: null
				};
				live.error = message;
				if (live.attempts > retryDelays.length) {
					toHistory(file, live, "failed", now);
					return {
						changed: true,
						result: null
					};
				}
				const wait = retryDelays[live.attempts - 1] ?? retryDelays[retryDelays.length - 1] ?? 0;
				live.state = "pending";
				live.notBefore = now + wait;
				live.updatedAt = now;
				delete live.runningBy;
				return {
					changed: true,
					result: wait
				};
			});
			if (retryIn !== null) scheduleRetry(retryIn);
		}
	};
	const pumpOnce = async () => {
		if (!started || running) return;
		await ensureLoaded();
		if (!leader.isLeader() || !deps.isIdle()) return;
		const chatId = host.isGroupChat() ? null : host.chatId();
		if (!chatId) return;
		if (!state.tasks.some((task) => task.chatId === chatId || task.state === "running") && Date.now() - lastRead < IDLE_REFRESH_MS) return;
		const claimed = await mutate((file, now) => {
			const changed = housekeeping(file, now);
			const task = pick(file, chatId, now);
			if (!task) return {
				changed,
				result: null
			};
			task.state = "running";
			task.attempts++;
			task.startedAt = now;
			task.updatedAt = now;
			task.runningBy = tabId;
			return {
				changed: true,
				result: structuredClone(task)
			};
		});
		if (!claimed) return;
		running = execute(claimed).catch((error) => log.error(`task ${claimed.kind} bookkeeping failed`, error)).finally(() => {
			running = null;
			kick();
		});
	};
	const pump = () => {
		pumping ??= pumpOnce().catch((error) => log.warn("task queue pump failed", error)).finally(() => {
			pumping = null;
		});
		return pumping;
	};
	function kick() {
		if (!started || kickTimer !== null) return;
		kickTimer = setTimeout(() => {
			kickTimer = null;
			pump();
		}, 0);
	}
	return {
		register(kind, runner) {
			if (runners.has(kind)) log.warn(`task runner ${kind} replaced`);
			runners.set(kind, runner);
			kick();
			return () => {
				if (runners.get(kind) === runner) runners.delete(kind);
			};
		},
		async enqueue(spec) {
			const chatId = spec.chatId ?? host.chatId();
			if (!chatId) throw new Error(`cannot enqueue ${spec.kind}: no chat`);
			const payload = JSON.parse(JSON.stringify(spec.payload ?? {}));
			const id = await mutate((file, now) => {
				if (spec.dedupeKey !== void 0) {
					const existing = file.tasks.find((task) => task.state === "pending" && task.kind === spec.kind && task.chatId === chatId && task.dedupeKey === spec.dedupeKey);
					if (existing) {
						existing.payload = payload;
						existing.priority = spec.priority ?? 0;
						existing.ttlMs = spec.ttlMs;
						existing.createdAt = now;
						existing.updatedAt = now;
						existing.attempts = 0;
						delete existing.error;
						delete existing.notBefore;
						return {
							changed: true,
							result: existing.id
						};
					}
				}
				const task = {
					id: newId(),
					kind: spec.kind,
					dedupeKey: spec.dedupeKey,
					payload,
					chatId,
					priority: spec.priority ?? 0,
					ttlMs: spec.ttlMs,
					state: "pending",
					attempts: 0,
					createdAt: now,
					updatedAt: now
				};
				file.tasks.push(task);
				housekeeping(file, now);
				return {
					changed: true,
					result: task.id
				};
			});
			kick();
			return id;
		},
		list() {
			return structuredClone([...state.tasks, ...state.history]);
		},
		kick,
		start() {
			if (started) return;
			started = true;
			unsubscribers.push(bus.on("generation:ended", () => kick()), bus.on("leader:changed", () => kick()), bus.on("chat:changed", () => kick()));
			pollTimer = setInterval(() => kick(), pollMs);
			ensureLoaded().then(() => kick());
		},
		stop() {
			started = false;
			if (pollTimer !== null) clearInterval(pollTimer);
			pollTimer = null;
			if (kickTimer !== null) clearTimeout(kickTimer);
			kickTimer = null;
			for (const timer of retryTimers) clearTimeout(timer);
			retryTimers.clear();
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		},
		async idle() {
			while (pumping || running) {
				await pumping;
				await running;
			}
		}
	};
}
var COMMAND_RE = new RegExp(`(^|[^\\p{L}\\p{N}])!(${[
	"fullsheet",
	"quicksheet",
	"tagsheet",
	"memsheet",
	"updatesheet",
	"physheet"
].join("|")})(?![\\p{L}\\p{N}])`, "iu");
/** Returns the sheet command found in a user message, if any. */
function detectSheetCommand(text) {
	if (!text) return void 0;
	const match = COMMAND_RE.exec(text);
	return match?.[2] ? match[2].toLowerCase() : void 0;
}
//#endregion
//#region src/core/turn.ts
/** A generation that has not ended after this long is considered finished (lost GENERATION_ENDED). */
var GENERATION_STALE_MS = 3e5;
/**
* Translates SillyTavern events into Maestro's turn lifecycle (plan §5):
* - generate_interceptor (Maestro loads after Qvink, CK and NAI Studio) → ephemeral producers, `generation:before`,
*   intercept handlers — all before the WI scan and prompt assembly;
* - MESSAGE_SENT → `turn:committed` for the previous assistant reply (P14);
* - CHARACTER_MESSAGE_RENDERED (last listener, next tick) → `reply:ready`, after DES, DES-RU and NAI markers;
* - swipe / delete / edit → `message:invalidated`;
* - GENERATION_ENDED / STOPPED → ephemeral values cleared.
*/
var TurnPipeline = class {
	host;
	bus;
	ephemeral;
	log;
	handlers = /* @__PURE__ */ new Set();
	unsubscribers = [];
	generation = null;
	staleTimer = null;
	constructor(host, bus, ephemeral, log) {
		this.host = host;
		this.bus = bus;
		this.ephemeral = ephemeral;
		this.log = log;
	}
	install() {
		const on = (key, handler, order) => {
			const name = this.host.events.name(key);
			if (!name) {
				this.log.warn(`ST event ${key} is missing`);
				return;
			}
			this.unsubscribers.push(this.host.events.on(name, handler, order ? { order } : void 0));
		};
		on("CHAT_CHANGED", () => {
			this.generation = null;
			this.ephemeral.clearAll();
			this.bus.emit("chat:changed", { chatId: this.host.chatId() });
		});
		on("MESSAGE_SENT", (messageId) => {
			const index = Number(messageId);
			const committed = this.lastAssistantBefore(Number.isFinite(index) ? index : this.host.ctx().chat.length);
			if (committed >= 0) this.bus.emit("turn:committed", { messageIndex: committed });
		});
		on("CHARACTER_MESSAGE_RENDERED", (messageId, type) => {
			const index = Number(messageId);
			if (!Number.isFinite(index)) return;
			setTimeout(() => {
				this.bus.emit("reply:ready", {
					messageIndex: index,
					type: String(type ?? "normal")
				});
			}, 0);
		}, "last");
		const ended = (stopped) => () => {
			const type = this.generation?.type ?? "normal";
			this.generation = null;
			this.ephemeral.clearAll();
			this.bus.emit("generation:ended", {
				type,
				stopped
			});
		};
		on("GENERATION_ENDED", ended(false));
		on("GENERATION_STOPPED", ended(true));
		on("MESSAGE_SWIPED", (messageId) => this.invalidate(messageId, "swiped"));
		on("MESSAGE_DELETED", (messageId) => this.invalidate(messageId, "deleted"));
		on("MESSAGE_EDITED", (messageId) => this.invalidate(messageId, "edited"));
	}
	dispose() {
		if (this.staleTimer) clearTimeout(this.staleTimer);
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.handlers.clear();
		this.ephemeral.clearAll();
	}
	/** Body of the global generate_interceptor. */
	async intercept(chat, type) {
		const last = [...chat].reverse().find((message) => message.is_user);
		const info = {
			type: type || "normal",
			dryRun: false,
			quiet: type === "quiet",
			sheetCommand: type === "quiet" ? void 0 : detectSheetCommand(last?.mes)
		};
		if (!info.quiet) this.setGeneration(info);
		await this.ephemeral.run(info);
		await this.bus.emit("generation:before", info);
		for (const handler of [...this.handlers]) try {
			await handler(chat, info);
		} catch (error) {
			this.log.error("intercept handler failed", error);
		}
	}
	onIntercept(handler) {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}
	lastAssistantIndex() {
		return this.lastAssistantBefore(this.host.ctx().chat.length);
	}
	current() {
		return this.generation;
	}
	setGeneration(info) {
		this.generation = info;
		if (this.staleTimer) clearTimeout(this.staleTimer);
		this.staleTimer = setTimeout(() => {
			if (this.generation === info) {
				this.log.warn("generation end not reported, releasing");
				this.generation = null;
				this.ephemeral.clearAll();
			}
		}, GENERATION_STALE_MS);
	}
	lastAssistantBefore(index) {
		const chat = this.host.ctx().chat;
		for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) {
			const message = chat[i];
			if (message && !message.is_user && !message.is_system) return i;
		}
		return -1;
	}
	invalidate(messageId, reason) {
		const index = Number(messageId);
		if (!Number.isFinite(index)) return;
		this.bus.emit("message:invalidated", {
			messageIndex: index,
			reason
		});
	}
};
//#endregion
//#region src/host/caps.ts
function createCapabilities(log) {
	const entries = /* @__PURE__ */ new Map();
	let refreshed = false;
	async function run(id, entry) {
		const generation = entry.generation;
		let result;
		try {
			result = normalize(await entry.probe(), entry.detail);
		} catch (error) {
			result = {
				ok: false,
				detail: errorText(error)
			};
		}
		if (entries.get(id) !== entry || entry.generation !== generation) return;
		if (entry.result?.ok !== result.ok) log.debug(`capability ${id}: ${result.ok ? "yes" : "no"}`, result.detail ?? "");
		entry.result = result;
	}
	function add(id, probe, detail) {
		const entry = {
			probe,
			detail,
			generation: (entries.get(id)?.generation ?? 0) + 1
		};
		entries.set(id, entry);
		if (refreshed) run(id, entry);
	}
	return {
		register(id, probe, detail) {
			add(id, probe, detail);
		},
		probe(id, probe, detail) {
			add(id, probe, detail);
		},
		unregister(id) {
			entries.delete(id);
		},
		has(id) {
			return entries.get(id)?.result?.ok === true;
		},
		report() {
			return [...entries].map(([id, entry]) => {
				const detail = entry.result ? entry.result.detail : "not probed yet";
				return detail === void 0 ? {
					id,
					ok: entry.result?.ok === true
				} : {
					id,
					ok: entry.result?.ok === true,
					detail
				};
			});
		},
		async refresh() {
			refreshed = true;
			await Promise.all([...entries].map(([id, entry]) => run(id, entry)));
		}
	};
}
function normalize(outcome, fallbackDetail) {
	if (typeof outcome === "boolean") return fallbackDetail === void 0 ? { ok: outcome } : {
		ok: outcome,
		detail: fallbackDetail
	};
	if (outcome && typeof outcome === "object" && typeof outcome.ok === "boolean") {
		const detail = outcome.detail ?? fallbackDetail;
		return detail === void 0 ? { ok: outcome.ok } : {
			ok: outcome.ok,
			detail
		};
	}
	return {
		ok: false,
		detail: "probe returned no result"
	};
}
function errorText(error) {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}
function registerBuiltinProbes(caps, deps) {
	const { ctx, modules } = deps;
	const partial = () => ctx();
	const eventProbe = (key) => () => {
		const types = partial().eventTypes;
		const value = types && Object.prototype.hasOwnProperty.call(types, key) ? types[key] : void 0;
		return typeof value === "string" ? {
			ok: true,
			detail: value
		} : {
			ok: false,
			detail: `eventTypes.${key} is missing`
		};
	};
	const exportsProbe = (load, wanted) => async () => {
		const namespace = await load();
		const missing = Object.entries(wanted).filter(([name, kind]) => !hasExport(namespace, name, kind)).map(([name]) => name);
		return missing.length === 0 ? true : {
			ok: false,
			detail: `missing exports: ${missing.join(", ")}`
		};
	};
	for (const [id, key] of Object.entries({
		"st.events.scanDone": "WORLDINFO_SCAN_DONE",
		"st.events.entriesLoaded": "WORLDINFO_ENTRIES_LOADED",
		"st.events.wiActivated": "WORLD_INFO_ACTIVATED",
		"st.events.forceActivate": "WORLDINFO_FORCE_ACTIVATE",
		"st.events.ccPromptReady": "CHAT_COMPLETION_PROMPT_READY",
		"st.events.ccSettingsReady": "CHAT_COMPLETION_SETTINGS_READY",
		"st.events.presetChangedBefore": "OAI_PRESET_CHANGED_BEFORE"
	})) caps.probe(id, eventProbe(key));
	caps.probe("st.cm", () => {
		const context = partial();
		if (typeof context.ConnectionManagerRequestService?.sendRequest !== "function") return {
			ok: false,
			detail: "ConnectionManagerRequestService.sendRequest is missing"
		};
		const disabled = context.extensionSettings?.disabledExtensions;
		if (Array.isArray(disabled) && disabled.includes("connection-manager")) return {
			ok: false,
			detail: "the Connection Manager extension is disabled"
		};
		return true;
	});
	caps.probe("st.chatCompletion", () => {
		const api = partial().mainApi;
		return api === "openai" ? true : {
			ok: false,
			detail: `main API is ${String(api)}`
		};
	});
	caps.probe("st.messageFormatter", () => typeof partial().messageFormatter?.addHook === "function");
	caps.probe("st.files", () => true, "user files API (/api/files) is part of ST 1.19");
	caps.probe("st.wi.module", exportsProbe(() => modules.worldInfo(), {
		getSortedEntries: "function",
		checkWorldInfo: "function",
		world_info_position: "object"
	}));
	caps.probe("st.wi.navbarHandler", exportsProbe(() => modules.script(), { doNavbarIconClick: "function" }));
	caps.probe("st.oai.promptManager", exportsProbe(() => modules.openai(), {
		promptManager: "present",
		getChatCompletionPreset: "function"
	}));
	caps.probe("st.presetManager", exportsProbe(() => modules.presetManager(), { getPresetManager: "function" }));
	caps.probe("st.chats.hide", exportsProbe(() => modules.chats(), { hideChatMessageRange: "function" }));
	caps.probe("st.regex", exportsProbe(() => modules.regexEngine(), { getRegexScripts: "function" }));
	caps.probe("st.macros.newEngine", () => {
		const power = partial().powerUserSettings;
		const flag = power && typeof power === "object" ? power["experimental_macro_engine"] : void 0;
		if (flag === true) return true;
		return {
			ok: false,
			detail: flag === void 0 ? "this ST has no experimental_macro_engine setting" : "experimental_macro_engine is off"
		};
	});
	caps.probe("st.version.1.19", async () => {
		const version = await withTimeout(deps.version(), deps.versionTimeoutMs ?? 3e3);
		if (!version) return {
			ok: true,
			detail: "ST version unknown; assuming 1.19"
		};
		if (version.startsWith("1.19")) return {
			ok: true,
			detail: version
		};
		return {
			ok: false,
			detail: `ST ${version}; Maestro is tested with 1.19`
		};
	});
}
function hasExport(namespace, name, kind) {
	if (!(name in namespace)) return false;
	const value = namespace[name];
	if (kind === "function") return typeof value === "function";
	if (kind === "object") return value !== null && typeof value === "object";
	return true;
}
function withTimeout(promise, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(void 0), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, () => {
			clearTimeout(timer);
			resolve(void 0);
		});
	});
}
//#endregion
//#region src/host/events.ts
function createHostEvents(ctx, log) {
	const registrations = /* @__PURE__ */ new Set();
	const emitter = () => ctx().eventSource;
	function eventTypes() {
		return ctx().eventTypes ?? {};
	}
	function name(key) {
		const types = eventTypes();
		if (!Object.prototype.hasOwnProperty.call(types, key)) return void 0;
		const value = types[key];
		return typeof value === "string" ? value : void 0;
	}
	/** eventTypes key → raw name; anything else is taken as a raw name. */
	function resolve(event) {
		return name(event) ?? event;
	}
	/** `initial` = first registration; later calls (reassertOrder) only move an existing listener. */
	function placeFirst(es, event, listener, initial) {
		if (!initial && isAutoFire(es, event)) {
			const list = listenersOf(es, event);
			if (list) moveInList(list, listener, "first");
			return;
		}
		if (!initial) es.removeListener(event, listener);
		if (typeof es.makeFirst === "function") {
			es.makeFirst(event, listener);
			return;
		}
		es.on(event, listener);
		const list = listenersOf(es, event);
		if (list) moveInList(list, listener, "first");
		else log.debug(`eventSource has no makeFirst; the ${event} listener stays in registration order`);
	}
	function placeLast(es, event, listener, initial) {
		if (!initial && isAutoFire(es, event)) {
			const list = listenersOf(es, event);
			if (list) moveInList(list, listener, "last");
			return;
		}
		if (typeof es.makeLast === "function") {
			es.makeLast(event, listener);
			return;
		}
		es.removeListener(event, listener);
		es.on(event, listener);
	}
	return {
		on(event, handler, options) {
			const raw = resolve(event);
			const order = options?.order ?? "normal";
			const listener = (...args) => {
				try {
					const result = handler(...args);
					if (result instanceof Promise) return result.catch((error) => log.error(`listener for ${raw} failed`, error));
					return result;
				} catch (error) {
					log.error(`listener for ${raw} failed`, error);
					return;
				}
			};
			const registration = {
				event: raw,
				order,
				listener
			};
			const es = emitter();
			if (order === "first") placeFirst(es, raw, listener, true);
			else if (order === "last") placeLast(es, raw, listener, true);
			else es.on(raw, listener);
			registrations.add(registration);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				registrations.delete(registration);
				emitter().removeListener(raw, listener);
			};
		},
		reassertOrder() {
			const es = emitter();
			const byEvent = /* @__PURE__ */ new Map();
			for (const registration of registrations) {
				if (registration.order === "normal") continue;
				const list = byEvent.get(registration.event) ?? [];
				list.push(registration);
				byEvent.set(registration.event, list);
			}
			for (const [event, regs] of byEvent) {
				const firsts = regs.filter((r) => r.order === "first").map((r) => r.listener);
				const lasts = regs.filter((r) => r.order === "last").map((r) => r.listener);
				const list = listenersOf(es, event);
				if (list && inPlace(list, [...firsts].reverse(), lasts)) continue;
				try {
					for (const listener of firsts) placeFirst(es, event, listener, false);
					for (const listener of lasts) placeLast(es, event, listener, false);
				} catch (error) {
					log.warn(`could not reassert listener order for ${event}`, error);
				}
			}
		},
		emit(event, ...args) {
			return emitter().emit(resolve(event), ...args);
		},
		name,
		dispose() {
			const es = emitter();
			for (const registration of [...registrations]) try {
				es.removeListener(registration.event, registration.listener);
			} catch (error) {
				log.warn(`could not remove ${registration.event} listener`, error);
			}
			registrations.clear();
		}
	};
}
/** The live listener array of an event, when the emitter exposes it. */
function listenersOf(es, event) {
	const store = es.events;
	let list;
	if (store instanceof Map) list = store.get(event);
	else if (store && typeof store === "object") list = store[event];
	return Array.isArray(list) ? list : void 0;
}
function isAutoFire(es, event) {
	const auto = es.autoFireAfterEmit;
	return auto instanceof Set && auto.has(event);
}
function moveInList(list, listener, where) {
	const index = list.indexOf(listener);
	if (index >= 0) list.splice(index, 1);
	if (where === "first") list.unshift(listener);
	else list.push(listener);
}
function inPlace(list, head, tail) {
	if (list.length < head.length + tail.length) return false;
	for (let i = 0; i < head.length; i++) if (list[i] !== head[i]) return false;
	const offset = list.length - tail.length;
	for (let i = 0; i < tail.length; i++) if (list[offset + i] !== tail[i]) return false;
	return true;
}
//#endregion
//#region src/host/fetch-gate.ts
/** Marks Maestro's wrapper so diagnostics can tell who owns window.fetch. */
var MAESTRO_FETCH = Symbol.for("maestro.fetchGate");
/** Statuses whose responses must not carry a body (new Response(body, {status}) throws for them). */
var NULL_BODY_STATUS = /* @__PURE__ */ new Set([
	101,
	103,
	204,
	205,
	304
]);
function createFetchGate(log, target = globalThis) {
	const before = /* @__PURE__ */ new Set();
	const after = /* @__PURE__ */ new Set();
	let original;
	let wrapper;
	let passThrough = false;
	async function gated(input, init) {
		const base = original;
		if (!base) throw new Error("Maestro fetch gate has no original fetch");
		if (passThrough) return base.call(globalThis, input, init);
		const url = requestUrl(input);
		for (const hook of [...before]) {
			if (!matches(hook.match, url)) continue;
			try {
				const result = await hook.fn(url, init);
				if (result instanceof Response) return result;
			} catch (error) {
				log.warn("fetch beforeRequest hook failed", error);
			}
		}
		const response = await base.call(globalThis, input, init);
		if (passThrough) return response;
		const hooks = [...after].filter((hook) => matches(hook.match, url));
		if (hooks.length === 0) return response;
		return deliver(response, url, init, hooks);
	}
	function deliver(response, url, init, hooks) {
		let forCaller = response;
		let forHooks;
		try {
			if (response.body && isStreaming(response, init) && !NULL_BODY_STATUS.has(response.status) && response.status >= 200) {
				const [callerBranch, hookBranch] = response.body.tee();
				const options = {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				};
				forCaller = new Response(callerBranch, options);
				forHooks = new Response(hookBranch, options);
			} else forHooks = response.clone();
		} catch (error) {
			log.warn("fetch gate could not copy a response for hooks", error);
			return response;
		}
		const copies = hooks.map((_, index) => index < hooks.length - 1 ? forHooks.clone() : forHooks);
		hooks.forEach((hook, index) => {
			const copy = copies[index];
			try {
				const result = hook.fn(url, copy, init);
				if (result instanceof Promise) result.catch((error) => log.warn("fetch afterResponse hook failed", error));
			} catch (error) {
				log.warn("fetch afterResponse hook failed", error);
			}
			release(copy);
		});
		return forCaller;
	}
	return {
		beforeRequest(match, hook) {
			const entry = {
				match,
				fn: hook
			};
			before.add(entry);
			return () => {
				before.delete(entry);
			};
		},
		afterResponse(match, hook) {
			const entry = {
				match,
				fn: hook
			};
			after.add(entry);
			return () => {
				after.delete(entry);
			};
		},
		install() {
			if (wrapper) return;
			const current = target.fetch;
			if (typeof current !== "function") {
				log.warn("window.fetch is missing; the fetch gate is not installed");
				return;
			}
			original = current;
			passThrough = false;
			const fn = function maestroFetch(input, init) {
				return gated(input, init);
			};
			Object.defineProperty(fn, MAESTRO_FETCH, { value: true });
			wrapper = fn;
			target.fetch = fn;
		},
		dispose() {
			before.clear();
			after.clear();
			if (!wrapper) return;
			if (target.fetch === wrapper && original) target.fetch = original;
			else {
				passThrough = true;
				log.debug("window.fetch was re-wrapped by someone else; the gate stays as a pass-through");
			}
			wrapper = void 0;
		},
		installed() {
			return wrapper !== void 0 && !passThrough;
		},
		original() {
			return original;
		}
	};
}
function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
function matches(pattern, url) {
	pattern.lastIndex = 0;
	return pattern.test(url);
}
/**
* ST's generate endpoint pipes the provider stream without a content type (src/util.js forwardFetchResponse),
* so the request body's `"stream": true` is the reliable sign of a streamed response.
*/
function isStreaming(response, init) {
	const type = response.headers.get("content-type") ?? "";
	if (/event-stream|ndjson/i.test(type)) return true;
	if (/json/i.test(type)) return false;
	return typeof init?.body === "string" && /"stream"\s*:\s*true/.test(init.body);
}
/**
* A copy nobody started reading would buffer the whole body in memory: cancel it. Hooks must call
* .text()/.json()/.body.getReader() before their first await.
*/
function release(copy) {
	const body = copy.body;
	if (!body || copy.bodyUsed || body.locked) return;
	body.cancel().catch(() => {});
}
//#endregion
//#region src/host/modules.ts
/** Module paths, relative to the ST web root (public/). */
var ST_MODULE_PATHS = {
	worldInfo: "/scripts/world-info.js",
	script: "/script.js",
	openai: "/scripts/openai.js",
	presetManager: "/scripts/preset-manager.js",
	chats: "/scripts/chats.js",
	regexEngine: "/scripts/extensions/regex/engine.js",
	utils: "/scripts/utils.js"
};
var importByUrl = async (url) => await import(
	/* @vite-ignore */
	url
);
function pageOrigin() {
	return window.location.origin;
}
/**
* @param importer replaced in tests; the default is a native dynamic import.
* @param origin page origin (window.location.origin).
*/
function createHostModules(log, importer = importByUrl, origin = pageOrigin) {
	const cache = /* @__PURE__ */ new Map();
	function url(path) {
		const base = origin();
		const normalized = path.startsWith("/") ? path : path.startsWith("scripts/") ? `/${path}` : `/scripts/${path}`;
		const resolved = new URL(normalized, base);
		if (resolved.origin !== new URL(base).origin) throw new Error(`refusing to import a module from another origin: ${path}`);
		return resolved.href;
	}
	function load(path) {
		let href;
		try {
			href = url(path);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const cached = cache.get(href);
		if (cached) return cached;
		const pending = importer(href).catch((error) => {
			cache.delete(href);
			log.warn(`could not import ST module ${path}`, error);
			throw error;
		});
		cache.set(href, pending);
		return pending;
	}
	return {
		worldInfo: () => load(ST_MODULE_PATHS.worldInfo),
		script: () => load(ST_MODULE_PATHS.script),
		openai: () => load(ST_MODULE_PATHS.openai),
		presetManager: () => load(ST_MODULE_PATHS.presetManager),
		chats: () => load(ST_MODULE_PATHS.chats),
		regexEngine: () => load(ST_MODULE_PATHS.regexEngine),
		utils: () => load(ST_MODULE_PATHS.utils),
		load,
		url
	};
}
//#endregion
//#region src/host/index.ts
/** Never cache the result: getContext() builds a new object on every call and chatMetadata is reassigned on chat load. */
function context() {
	return SillyTavern.getContext();
}
function createHost(log) {
	const events = createHostEvents(context, log.scope("events"));
	const modules = createHostModules(log.scope("modules"));
	const caps = createCapabilities(log.scope("caps"));
	const fetchGate = createFetchGate(log.scope("fetch"));
	let version;
	let versionPromise = null;
	let installed = false;
	async function loadVersion() {
		try {
			const response = await fetch("/version", { cache: "no-cache" });
			if (!response.ok) return void 0;
			const data = await response.json();
			const pkgVersion = data && typeof data === "object" ? data["pkgVersion"] : void 0;
			if (typeof pkgVersion === "string" && pkgVersion && pkgVersion !== "UNKNOWN") version = pkgVersion;
		} catch (error) {
			log.debug("could not read the ST version", error);
		}
		return version;
	}
	const host = {
		ctx: context,
		events,
		modules,
		caps,
		fetchGate,
		version() {
			return version;
		},
		chatId() {
			return context().getCurrentChatId() ?? null;
		},
		isGroupChat() {
			return Boolean(context().groupId);
		},
		isChatCompletion() {
			return context().mainApi === "openai";
		},
		install() {
			if (installed) return;
			installed = true;
			fetchGate.install();
			versionPromise = loadVersion();
			registerBuiltinProbes(caps, {
				ctx: context,
				modules,
				version: () => host.versionReady()
			});
		},
		dispose() {
			fetchGate.dispose();
			events.dispose();
			installed = false;
		},
		versionReady() {
			return versionPromise ?? Promise.resolve(version);
		}
	};
	return host;
}
//#endregion
//#region src/ui/components/dom.ts
function classNames(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	return value.filter((item) => typeof item === "string" && item.length > 0).join(" ");
}
function append(parent, children) {
	if (children === void 0) return;
	const list = Array.isArray(children) ? children : [children];
	for (const child of list) {
		if (child === null || child === void 0 || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}
function el(tag, props = {}, children) {
	const element = document.createElement(tag);
	const className = classNames(props.class);
	if (className) element.className = className;
	if (props.text !== void 0) element.textContent = props.text;
	if (props.title !== void 0) element.setAttribute("title", props.title);
	if (props.data) for (const [key, value] of Object.entries(props.data)) element.dataset[key] = String(value);
	if (props.attrs) for (const [key, value] of Object.entries(props.attrs)) {
		if (value === false || value === null || value === void 0) continue;
		element.setAttribute(key, value === true ? "" : String(value));
	}
	if (props.on) {
		for (const [name, handler] of Object.entries(props.on)) if (handler) element.addEventListener(name, handler);
	}
	append(element, children);
	return element;
}
function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}
/** Font Awesome icon (ST ships FA 6). */
function icon(name, extra) {
	return el("i", {
		class: [
			"fa-solid",
			name.startsWith("fa-") ? name : `fa-${name}`,
			"fa-fw",
			extra
		],
		attrs: { "aria-hidden": "true" }
	});
}
var reportButtonError = (error) => console.error("[Maestro:ui]", error);
/** Where failures of async button handlers go (the UI routes them to its logger and notices). */
function setButtonErrorHandler(handler) {
	reportButtonError = handler;
}
/**
* A ST-styled button. Async handlers disable the button while they run so a double tap on a phone does not
* accept a card twice.
*/
function button(options) {
	const node = el("button", {
		class: [
			"menu_button",
			"maestro-btn",
			options.kind && options.kind !== "default" ? `maestro-btn-${options.kind}` : null,
			options.className
		],
		title: options.title,
		attrs: {
			type: "button",
			disabled: options.disabled === true,
			"aria-label": options.label ? void 0 : options.title
		}
	}, [options.icon ? icon(options.icon) : null, options.label ? el("span", { text: options.label }) : null]);
	if (options.onClick) {
		const handler = options.onClick;
		node.addEventListener("click", (event) => {
			if (node.disabled) return;
			let result;
			try {
				result = handler(event);
			} catch (error) {
				reportButtonError(error);
				return;
			}
			if (result instanceof Promise) {
				node.disabled = true;
				node.classList.add("maestro-busy");
				result.catch((error) => reportButtonError(error)).finally(() => {
					node.disabled = options.disabled === true;
					node.classList.remove("maestro-busy");
				});
			}
		});
	}
	return node;
}
function prefersReducedMotion() {
	try {
		return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	} catch {
		return false;
	}
}
//#endregion
//#region src/ui/views/entry-points.ts
var TOP_ID = "maestro-topbar";
var EXT_ID = "maestro-ext-settings";
var WAND_ID = "maestro-wand";
var ICON = "fa-wand-magic-sparkles";
function activate(node, run) {
	node.addEventListener("click", run);
	node.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		run();
	});
}
var EntryPoints = class {
	deps;
	top = null;
	ext = null;
	wand = null;
	badge = {
		count: 0,
		urgent: false
	};
	constructor(deps) {
		this.deps = deps;
	}
	/** Idempotent: mounts whatever is missing (ST builds the wand menu late, so APP_READY calls this again). */
	mount() {
		if (!this.top?.root.isConnected) this.mountTop();
		if (!this.ext?.root.isConnected) this.mountExtensions();
		if (!this.wand?.root.isConnected) this.mountWand();
		this.setBadge(this.badge.count, this.badge.urgent);
	}
	setBadge(count, urgent) {
		this.badge = {
			count,
			urgent
		};
		if (!this.top) return;
		const { badge, toggle } = this.top;
		badge.textContent = count > 99 ? "99+" : String(count);
		badge.hidden = count <= 0;
		badge.classList.toggle("maestro-urgent", urgent);
		const label = count > 0 ? this.deps.i18n.t("ui.entry.topTitleCount", { count }) : this.deps.i18n.t("ui.entry.topTitle");
		toggle.title = label;
		toggle.setAttribute("aria-label", label);
	}
	relocalize() {
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		if (this.ext) {
			this.ext.title.textContent = t("ui.title");
			this.ext.text.textContent = t("ui.entry.description");
			this.ext.open.textContent = t("ui.entry.open");
		}
		if (this.wand) {
			this.wand.label.textContent = t("ui.title");
			this.wand.item.title = t("ui.entry.wandTitle");
		}
		this.setBadge(this.badge.count, this.badge.urgent);
	}
	dispose() {
		this.top?.root.remove();
		this.ext?.root.remove();
		this.wand?.root.remove();
		this.top = null;
		this.ext = null;
		this.wand = null;
	}
	mountTop() {
		const holder = document.querySelector("#top-settings-holder");
		if (!holder) {
			this.deps.log.debug("top bar not found");
			return;
		}
		document.getElementById(TOP_ID)?.remove();
		const badge = el("span", {
			class: "maestro-topbar-badge",
			attrs: { "aria-hidden": "true" }
		});
		badge.hidden = true;
		const toggle = el("div", {
			class: "maestro-topbar-toggle",
			attrs: {
				role: "button",
				tabindex: "0"
			}
		}, [el("div", { class: [
			"drawer-icon",
			"fa-solid",
			ICON,
			"fa-fw",
			"closedIcon"
		] }), badge]);
		activate(toggle, () => this.deps.open());
		const root = el("div", {
			class: "drawer maestro-topbar",
			attrs: { id: TOP_ID }
		}, [toggle]);
		const extensions = document.getElementById("extensions-settings-button");
		if (extensions?.parentElement === holder) extensions.after(root);
		else holder.appendChild(root);
		this.top = {
			root,
			toggle,
			badge
		};
	}
	mountExtensions() {
		const container = document.querySelector("#extensions_settings2") ?? document.querySelector("#extensions_settings");
		if (!container) {
			this.deps.log.debug("extensions panel not found");
			return;
		}
		document.getElementById(EXT_ID)?.remove();
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		const title = el("b", { text: t("ui.title") });
		const text = el("div", {
			class: "maestro-ext-text",
			text: t("ui.entry.description")
		});
		const open = el("div", {
			class: "menu_button maestro-ext-open",
			text: t("ui.entry.open"),
			attrs: {
				role: "button",
				tabindex: "0"
			}
		});
		activate(open, () => this.deps.open());
		const root = el("div", {
			class: "extension_container maestro-ext",
			attrs: { id: EXT_ID }
		}, [el("div", { class: "inline-drawer" }, [el("div", { class: "inline-drawer-toggle inline-drawer-header" }, [title, el("div", { class: "inline-drawer-icon fa-solid fa-circle-chevron-down down" })]), el("div", { class: "inline-drawer-content maestro-ext-content" }, [text, open])])]);
		container.appendChild(root);
		this.ext = {
			root,
			title,
			text,
			open
		};
	}
	mountWand() {
		const menu = document.querySelector("#extensionsMenu");
		if (!menu) {
			this.deps.log.debug("wand menu not found");
			return;
		}
		document.getElementById(WAND_ID)?.remove();
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		const label = el("span", { text: t("ui.title") });
		const item = el("div", {
			class: "list-group-item flex-container flexGap5 interactable",
			title: t("ui.entry.wandTitle"),
			attrs: {
				role: "button",
				tabindex: "0"
			}
		}, [el("div", { class: [
			"fa-solid",
			ICON,
			"extensionsMenuExtensionButton"
		] }), label]);
		activate(item, () => this.deps.open());
		const root = el("div", {
			class: "extension_container maestro-wand",
			attrs: { id: WAND_ID }
		}, [item]);
		menu.appendChild(root);
		this.wand = {
			root,
			label,
			item
		};
	}
};
//#endregion
//#region src/ui/components/card.ts
function card(options) {
	return el("div", { class: [
		"maestro-card",
		options.level ? `maestro-level-${options.level}` : null,
		options.className
	] }, [
		options.title || options.subtitle ? el("div", { class: "maestro-card-head" }, [options.title ? el("div", {
			class: "maestro-card-title",
			text: options.title
		}) : null, options.subtitle ? el("div", { class: "maestro-card-subtitle" }, options.subtitle) : null]) : null,
		options.body !== void 0 ? el("div", { class: "maestro-card-body" }, options.body) : null,
		options.actions !== void 0 ? el("div", { class: "maestro-card-actions" }, options.actions) : null
	]);
}
/** A titled block inside a tab, with optional header actions. */
function section(title, children, actions) {
	return el("section", { class: "maestro-section" }, [el("div", { class: "maestro-section-head" }, [el("h4", {
		class: "maestro-section-title",
		text: title
	}), actions !== void 0 ? el("div", { class: "maestro-section-actions" }, actions) : null]), el("div", { class: "maestro-section-body" }, children)]);
}
function emptyState(text, iconName = "fa-circle-check") {
	return el("div", { class: "maestro-empty" }, [icon(iconName), el("span", { text })]);
}
function badge(value, level = "info") {
	return el("span", {
		class: ["maestro-badge-pill", `maestro-level-${level}`],
		text: String(value)
	});
}
/** A coloured dot with an accessible label. */
function lamp(state, label) {
	return el("span", {
		class: ["maestro-lamp", `maestro-lamp-${state}`],
		title: label,
		attrs: {
			role: "img",
			"aria-label": label
		}
	});
}
/** Inline banner (group chat, Text Completion, stale card…). */
function banner(text, level = "warn", iconName = "fa-triangle-exclamation") {
	return el("div", {
		class: ["maestro-banner", `maestro-level-${level}`],
		attrs: { role: "status" }
	}, [icon(iconName), el("span", { text })]);
}
//#endregion
//#region src/ui/components/table.ts
function table(columns, rows, options = {}) {
	if (!rows.length && options.empty) return emptyState(options.empty, "fa-inbox");
	const head = el("tr", {}, columns.map((column) => el("th", {
		class: [column.className, column.numeric ? "maestro-num" : null],
		text: column.label,
		attrs: { scope: "col" }
	})));
	const body = rows.map((row, index) => el("tr", {}, columns.map((column) => el("td", {
		class: [column.className, column.numeric ? "maestro-num" : null],
		data: { label: column.label }
	}, column.cell(row, index)))));
	return el("div", { class: ["maestro-table-wrap", options.className] }, [el("table", { class: "maestro-table" }, [
		options.caption ? el("caption", {
			class: "maestro-sr-only",
			text: options.caption
		}) : null,
		el("thead", {}, [head]),
		el("tbody", {}, body)
	])]);
}
//#endregion
//#region src/ui/views/format.ts
function intlLocale(i18n) {
	return i18n.locale() === "ru" ? "ru-RU" : "en-US";
}
/** "14:05" for today, "3 окт., 14:05" for other days. */
function formatTime(at, i18n, now = Date.now()) {
	const date = new Date(at);
	const today = new Date(now);
	const options = date.toDateString() === today.toDateString() ? {
		hour: "2-digit",
		minute: "2-digit"
	} : {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit"
	};
	try {
		return new Intl.DateTimeFormat(intlLocale(i18n), options).format(date);
	} catch {
		return date.toISOString();
	}
}
/** US dollars with precision that stays readable for cents and fractions of a cent. */
function formatUsd(value, i18n) {
	const digits = value !== 0 && Math.abs(value) < .01 ? 4 : 2;
	try {
		return new Intl.NumberFormat(intlLocale(i18n), {
			style: "currency",
			currency: "USD",
			minimumFractionDigits: digits,
			maximumFractionDigits: digits
		}).format(value);
	} catch {
		return `$${value.toFixed(digits)}`;
	}
}
/** Translated key, or the fallback when the key has no translation (I18n returns the key itself then). */
function tOr(i18n, key, fallback, params) {
	const text = i18n.t(key, params);
	return text === key ? fallback : text;
}
/** Module title by plan id ('M1') or settings key ('loreJournal'); unknown ids are shown as is. */
function moduleTitle(modules, i18n, id) {
	const entry = modules?.list().find((item) => item.module.id === id || item.module.key === id);
	return entry ? i18n.t(entry.module.titleKey) : id;
}
/**
* Coalesces bursts of calls (cost meter ticks, inbox changes) into one call after `ms`.
* `cancel()` drops a pending call (view unmounted).
*/
function coalesce(run, ms = 100) {
	let timer = null;
	const call = (() => {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			run();
		}, ms);
	});
	call.cancel = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return call;
}
//#endregion
//#region src/ui/views/health.ts
var HEALTH_TAB = "health";
var LAMP = {
	ok: "ok",
	warn: "warn",
	error: "error",
	skip: "off",
	running: "off"
};
function healthTab(env) {
	const { i18n, shell } = env;
	const t = i18n.t.bind(i18n);
	return {
		id: HEALTH_TAB,
		titleKey: "ui.tab.health",
		icon: "fa-heart-pulse",
		order: 70,
		render(container) {
			let alive = true;
			const results = /* @__PURE__ */ new Map();
			const runCheck = async (check) => {
				results.set(check.id, { status: "running" });
				draw();
				try {
					const result = await check.run();
					results.set(check.id, result);
				} catch (error) {
					shell.log.error(`health check ${check.id} failed`, error);
					results.set(check.id, {
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				}
				if (alive) draw();
			};
			const runAll = async () => {
				await Promise.all(shell.healthChecks().map(runCheck));
			};
			const checksView = () => {
				const checks = shell.healthChecks();
				if (!checks.length) return emptyState(t("ui.health.noChecks"), "fa-stethoscope");
				return el("div", { class: "maestro-checks" }, checks.map((check) => {
					const result = results.get(check.id);
					const status = result?.status ?? "running";
					const fix = result?.fix;
					return el("div", { class: ["maestro-check", `maestro-check-${status}`] }, [
						lamp(LAMP[status], t(`ui.health.status.${status}`)),
						el("div", { class: "maestro-check-main" }, [
							el("div", {
								class: "maestro-check-title",
								text: t(check.titleKey)
							}),
							el("div", {
								class: "maestro-muted",
								text: `${moduleTitle(env.modules, i18n, check.module)} · ${t(`ui.health.status.${status}`)}`
							}),
							result?.message ? el("div", {
								class: "maestro-check-message",
								text: result.message
							}) : null
						]),
						fix ? button({
							label: t("ui.health.fix"),
							icon: "fa-screwdriver-wrench",
							kind: "primary",
							onClick: async () => {
								await fix();
								await runCheck(check);
							}
						}) : null
					]);
				}));
			};
			const capsView = () => table([
				{
					key: "state",
					label: t("ui.health.state"),
					cell: (row) => lamp(row.ok ? "ok" : "error", t(row.ok ? "ui.lamp.ok" : "ui.lamp.error"))
				},
				{
					key: "id",
					label: t("ui.health.capability"),
					cell: (row) => row.id
				},
				{
					key: "detail",
					label: t("ui.health.detail"),
					cell: (row) => row.detail ?? ""
				}
			], [...env.caps.report()].sort((a, b) => Number(a.ok) - Number(b.ok) || a.id.localeCompare(b.id)), { empty: t("ui.overview.stackEmpty") });
			const logView = () => {
				const lines = ConsoleLogger.recent().slice(-20).reverse();
				if (!lines.length) return emptyState(t("ui.health.logEmpty"));
				return el("ul", { class: "maestro-log" }, lines.map((line) => el("li", { class: ["maestro-log-line", `maestro-level-${line.level === "error" ? "error" : "warn"}`] }, [
					el("span", {
						class: "maestro-notice-time",
						text: formatTime(line.at, i18n)
					}),
					el("span", {
						class: "maestro-muted",
						text: line.scope
					}),
					el("span", { text: line.text })
				])));
			};
			function draw() {
				if (!alive) return;
				clear(container);
				container.append(el("div", { class: "maestro-view maestro-health" }, [
					section(t("ui.health.checks"), checksView(), button({
						label: t("ui.health.runAll"),
						icon: "fa-play",
						onClick: runAll
					})),
					section(t("ui.health.capabilities"), capsView(), button({
						label: t("ui.health.recheck"),
						icon: "fa-arrows-rotate",
						onClick: async () => {
							await env.caps.refresh();
							draw();
						}
					})),
					section(t("ui.health.log"), logView())
				]));
			}
			draw();
			runAll();
			return () => {
				alive = false;
			};
		}
	};
}
//#endregion
//#region src/ui/components/diff.ts
/** Words (letters/digits, any script), runs of whitespace and single punctuation marks. */
var TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
function tokenize(text) {
	return text.match(TOKEN) ?? [];
}
function push(parts, kind, text) {
	if (!text) return;
	const last = parts[parts.length - 1];
	if (last && last.kind === kind) last.text += text;
	else parts.push({
		kind,
		text
	});
}
/**
* Word-level diff (LCS over tokens). Common prefix and suffix are trimmed first; if the remaining middle is
* too large for the O(n·m) table, it is shown as one removed and one added block.
*/
function wordDiff(before, after, maxCells = 25e4) {
	const a = tokenize(before);
	const b = tokenize(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const parts = [];
	push(parts, "same", a.slice(0, start).join(""));
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length * midB.length > maxCells) {
		push(parts, "removed", midA.join(""));
		push(parts, "added", midB.join(""));
	} else lcsDiff(midA, midB, parts);
	push(parts, "same", a.slice(endA).join(""));
	return parts;
}
function lcsDiff(a, b, parts) {
	const n = a.length;
	const m = b.length;
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const tokenA = a[i] ?? "";
		const tokenB = b[j] ?? "";
		if (tokenA === tokenB) {
			push(parts, "same", tokenA);
			i++;
			j++;
		} else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
			push(parts, "removed", tokenA);
			i++;
		} else {
			push(parts, "added", tokenB);
			j++;
		}
	}
	while (i < n) push(parts, "removed", a[i++] ?? "");
	while (j < m) push(parts, "added", b[j++] ?? "");
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** JSON with sorted keys, so field order does not count as a change. */
function stableStringify(value) {
	if (value === void 0) return "undefined";
	return JSON.stringify(value, (_key, item) => {
		if (!isPlainObject(item)) return item;
		return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
	});
}
/** Field-by-field diff of two JSON values; nested objects recurse, arrays compare as whole values. */
function jsonDiff(before, after, path = "") {
	if (isPlainObject(before) && isPlainObject(after)) return [...Object.keys(before), ...Object.keys(after).filter((key) => !Object.hasOwn(before, key))].flatMap((key) => jsonDiff(before[key], after[key], path ? `${path}.${key}` : key));
	if (before === void 0 && after !== void 0) return [{
		path,
		kind: "added",
		after
	}];
	if (after === void 0 && before !== void 0) return [{
		path,
		kind: "removed",
		before
	}];
	return [{
		path,
		kind: stableStringify(before) === stableStringify(after) ? "same" : "changed",
		before,
		after
	}];
}
function isPrimitive(value) {
	return value === null || [
		"string",
		"number",
		"boolean"
	].includes(typeof value);
}
/** Lists of keys, tags, aliases: short arrays of primitives. */
function isPrimitiveArray(value) {
	return Array.isArray(value) && value.every(isPrimitive);
}
/** Item-level diff of two primitive lists (order kept: before's items first, then new ones). */
function listDiff(before, after) {
	const kept = new Set(after.map((item) => JSON.stringify(item)));
	const old = new Set(before.map((item) => JSON.stringify(item)));
	return [...before.map((value) => ({
		kind: kept.has(JSON.stringify(value)) ? "same" : "removed",
		value
	})), ...after.filter((value) => !old.has(JSON.stringify(value))).map((value) => ({
		kind: "added",
		value
	}))];
}
function formatValue(value) {
	if (value === void 0 || value === null) return "—";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (isPrimitiveArray(value)) return value.map((item) => item === null ? "—" : String(item)).join(", ");
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
/** Renders word-diff parts as <del>/<ins> inline. */
function renderParts(parts, t) {
	return el("div", { class: "maestro-diff-text" }, parts.map((part) => {
		if (part.kind === "added") return el("ins", {
			class: "maestro-diff-add",
			title: t("ui.diff.added"),
			text: part.text
		});
		if (part.kind === "removed") return el("del", {
			class: "maestro-diff-del",
			title: t("ui.diff.removed"),
			text: part.text
		});
		return el("span", { text: part.text });
	}));
}
function isTextual(value) {
	return typeof value === "string" || value === void 0 || value === null;
}
/** Diff view for any pair of values: strings → word diff, objects → field table, other → before/after. */
function diffView(before, after, t) {
	if (isTextual(before) && isTextual(after) && (typeof before === "string" || typeof after === "string")) {
		const a = typeof before === "string" ? before : "";
		const b = typeof after === "string" ? after : "";
		if (a === b) return el("div", {
			class: "maestro-diff maestro-diff-none",
			text: t("ui.diff.noChanges")
		});
		return el("div", { class: "maestro-diff" }, [renderParts(wordDiff(a, b), t)]);
	}
	if (isPrimitiveArray(before) && isPrimitiveArray(after)) {
		if (stableStringify(before) === stableStringify(after)) return el("div", {
			class: "maestro-diff maestro-diff-none",
			text: t("ui.diff.noChanges")
		});
		return el("div", { class: "maestro-diff" }, [renderList(before, after)]);
	}
	if (isPlainObject(before) || isPlainObject(after)) return fieldTable(jsonDiff(isPlainObject(before) ? before : {}, isPlainObject(after) ? after : {}), t);
	if (stableStringify(before) === stableStringify(after)) return el("div", {
		class: "maestro-diff maestro-diff-none",
		text: t("ui.diff.noChanges")
	});
	return el("div", { class: "maestro-diff maestro-diff-pair" }, [valueBlock(t("ui.diff.before"), before, "maestro-diff-del"), valueBlock(t("ui.diff.after"), after, "maestro-diff-add")]);
}
function valueBlock(label, value, className) {
	return el("div", { class: "maestro-diff-side" }, [el("div", {
		class: "maestro-diff-label",
		text: label
	}), el("pre", {
		class: ["maestro-diff-value", className],
		text: formatValue(value)
	})]);
}
function fieldCell(field, t) {
	if (field.kind === "added") return el("ins", {
		class: "maestro-diff-add",
		text: formatValue(field.after)
	});
	if (field.kind === "removed") return el("del", {
		class: "maestro-diff-del",
		text: formatValue(field.before)
	});
	if (typeof field.before === "string" && typeof field.after === "string") return renderParts(wordDiff(field.before, field.after), t);
	if (isPrimitiveArray(field.before) && isPrimitiveArray(field.after)) return renderList(field.before, field.after);
	return el("span", { class: "maestro-diff-change" }, [
		el("del", {
			class: "maestro-diff-del",
			text: formatValue(field.before)
		}),
		el("span", {
			class: "maestro-diff-arrow",
			text: " → "
		}),
		el("ins", {
			class: "maestro-diff-add",
			text: formatValue(field.after)
		})
	]);
}
function renderList(before, after) {
	const items = listDiff(before, after);
	const nodes = [];
	items.forEach((item, index) => {
		if (index) nodes.push(", ");
		const text = item.value === null ? "—" : String(item.value);
		if (item.kind === "added") nodes.push(el("ins", {
			class: "maestro-diff-add",
			text
		}));
		else if (item.kind === "removed") nodes.push(el("del", {
			class: "maestro-diff-del",
			text
		}));
		else nodes.push(el("span", { text }));
	});
	return el("span", { class: "maestro-diff-list" }, nodes);
}
function fieldTable(fields, t) {
	const changed = fields.filter((field) => field.kind !== "same");
	const same = fields.filter((field) => field.kind === "same");
	const row = (field) => el("div", { class: ["maestro-diff-row", `maestro-diff-${field.kind}`] }, [el("div", {
		class: "maestro-diff-path",
		text: field.path || t("ui.diff.value")
	}), el("div", { class: "maestro-diff-cell" }, [field.kind === "same" ? el("span", { text: formatValue(field.after) }) : fieldCell(field, t)])]);
	return el("div", { class: "maestro-diff maestro-diff-fields" }, [
		changed.length ? null : el("div", {
			class: "maestro-diff-none",
			text: t("ui.diff.noChanges")
		}),
		...changed.map(row),
		same.length ? el("details", { class: "maestro-diff-same" }, [el("summary", { text: t("ui.diff.unchanged", { count: same.length }) }), ...same.map(row)]) : null
	]);
}
/** One journal/inbox change: target and locator, then the diff. */
function changeView(change, t) {
	const ref = Object.entries(change.ref).filter(([, value]) => value !== void 0 && value !== null && typeof value !== "object").map(([key, value]) => `${key}: ${String(value)}`).join(", ");
	return el("div", { class: "maestro-change" }, [el("div", { class: "maestro-change-head" }, [el("span", {
		class: "maestro-change-target",
		text: change.target
	}), ref ? el("span", {
		class: "maestro-change-ref",
		text: ref
	}) : null]), diffView(change.before, change.after, t)]);
}
//#endregion
//#region src/ui/views/inbox.ts
var INBOX_TAB = "inbox";
var SNOOZE_MS = 864e5;
function inboxTab(env) {
	const { i18n, shell } = env;
	const t = i18n.t.bind(i18n);
	const accept = async (item) => {
		const ok = await env.inbox.accept(item.id);
		if (!ok) shell.notice(t("ui.inbox.stale", { title: item.title }), { level: "warn" });
		return ok;
	};
	const cardView = (item) => {
		const meta = [el("span", {
			class: "maestro-muted",
			text: `${moduleTitle(env.modules, i18n, item.module)} · ${item.kind} · ${formatTime(item.createdAt, i18n)}`
		})];
		if (item.deferred) meta.push(badge(t("ui.inbox.deferred"), "muted"));
		if (item.expiresAt) meta.push(badge(t("ui.inbox.expires", { time: formatTime(item.expiresAt, i18n) }), "muted"));
		const source = item.sourceMessage !== void 0 ? button({
			label: t("ui.inbox.source", { index: item.sourceMessage }),
			icon: "fa-message",
			kind: "ghost",
			onClick: () => shell.scrollToMessage(item.sourceMessage ?? 0)
		}) : null;
		return card({
			title: item.title,
			subtitle: meta,
			className: "maestro-inbox-card",
			body: [item.description ? el("div", {
				class: "maestro-card-text",
				text: item.description
			}) : null, ...item.changes.map((change) => changeView(change, t))],
			actions: [
				source,
				el("span", { class: "maestro-grow" }),
				button({
					label: t("ui.inbox.snooze"),
					icon: "fa-clock",
					kind: "ghost",
					onClick: () => env.inbox.snooze(item.id, SNOOZE_MS)
				}),
				button({
					label: t("ui.inbox.reject"),
					icon: "fa-xmark",
					kind: "danger",
					onClick: () => env.inbox.reject(item.id)
				}),
				button({
					label: t("ui.inbox.accept"),
					icon: "fa-check",
					kind: "primary",
					disabled: item.deferred === true,
					title: item.deferred ? t("ui.inbox.deferredHint") : void 0,
					onClick: async () => {
						await accept(item);
					}
				})
			]
		});
	};
	return {
		id: INBOX_TAB,
		titleKey: "ui.tab.inbox",
		icon: "fa-inbox",
		order: 30,
		badge: () => env.inbox.count(),
		render(container) {
			const draw = () => {
				clear(container);
				const cards = [...env.inbox.list()].sort((a, b) => b.createdAt - a.createdAt);
				const actionable = cards.filter((item) => !item.deferred);
				const acceptAll = button({
					label: t("ui.inbox.acceptAll", { count: actionable.length }),
					icon: "fa-check-double",
					disabled: actionable.length === 0,
					onClick: async () => {
						let failed = 0;
						for (const item of actionable) try {
							if (!await env.inbox.accept(item.id)) failed++;
						} catch (error) {
							failed++;
							shell.log.error("accept failed", item.id, error);
						}
						const accepted = actionable.length - failed;
						shell.notice(failed ? t("ui.inbox.acceptAllPartial", {
							accepted,
							failed
						}) : t("ui.inbox.acceptAllDone", { accepted }), { level: failed ? "warn" : "info" });
					}
				});
				container.append(el("div", { class: "maestro-view maestro-inbox" }, [section(t("ui.inbox.title"), cards.length ? el("div", { class: "maestro-cards" }, cards.map(cardView)) : emptyState(t("ui.inbox.empty")), cards.length ? acceptAll : void 0)]));
			};
			draw();
			const later = coalesce(draw, 50);
			const unsubscribe = env.inbox.onChange(later);
			return () => {
				later.cancel();
				unsubscribe();
			};
		}
	};
}
//#endregion
//#region src/ui/components/controls.ts
var nextId = 0;
/** Unique id for label/for pairs (several pults never coexist, but views re-render). */
function uid(prefix = "maestro") {
	nextId += 1;
	return `${prefix}-${nextId}`;
}
function toggle(options) {
	const id = uid("maestro-toggle");
	const input = el("input", { attrs: {
		type: "checkbox",
		id,
		disabled: options.disabled === true
	} });
	input.checked = options.checked;
	input.addEventListener("change", () => {
		options.onChange(input.checked);
	});
	return el("label", {
		class: "checkbox_label maestro-toggle",
		attrs: { for: id },
		title: options.hint
	}, [input, el("span", { text: options.label })]);
}
function select(options) {
	const node = el("select", {
		class: "text_pole maestro-select",
		attrs: {
			"aria-label": options.label,
			disabled: options.disabled === true
		}
	});
	for (const option of options.options) node.appendChild(el("option", {
		text: option.label,
		attrs: { value: option.value }
	}));
	node.value = options.options.some((option) => option.value === options.value) ? options.value : options.options[0]?.value ?? "";
	node.addEventListener("change", () => {
		const chosen = options.options.find((option) => option.value === node.value);
		if (chosen) options.onChange(chosen.value);
	});
	return node;
}
/** Number input that commits on change (not on every keystroke) and clamps to min/max. */
function numberInput(options) {
	const node = el("input", {
		class: "text_pole maestro-number",
		attrs: {
			type: "number",
			inputmode: "decimal",
			min: options.min,
			max: options.max,
			step: options.step ?? "any",
			"aria-label": options.label,
			disabled: options.disabled === true
		}
	});
	node.value = String(options.value);
	node.addEventListener("change", () => {
		let value = Number(node.value);
		if (!Number.isFinite(value)) value = options.value;
		if (options.min !== void 0) value = Math.max(options.min, value);
		if (options.max !== void 0) value = Math.min(options.max, value);
		node.value = String(value);
		options.onChange(value);
	});
	return node;
}
/** A labelled row: label on the left (top on phones), control on the right, optional hint below. */
function field(label, control, hint) {
	return el("div", { class: "maestro-field" }, [
		el("div", {
			class: "maestro-field-label",
			text: label
		}),
		el("div", { class: "maestro-field-control" }, [control]),
		hint ? el("div", {
			class: "maestro-field-hint",
			text: hint
		}) : null
	]);
}
/** Radio-like button group (mode switch). */
function segmented(options) {
	const group = el("div", {
		class: "maestro-segmented",
		attrs: {
			role: "radiogroup",
			"aria-label": options.label
		}
	});
	const buttons = [];
	const mark = (value) => {
		for (const node of buttons) {
			const on = node.dataset.value === value;
			node.classList.toggle("maestro-on", on);
			node.setAttribute("aria-checked", on ? "true" : "false");
		}
	};
	for (const option of options.options) {
		const node = el("button", {
			class: "menu_button maestro-btn maestro-segment",
			text: option.label,
			data: { value: option.value },
			attrs: {
				type: "button",
				role: "radio"
			}
		});
		node.addEventListener("click", () => {
			mark(option.value);
			options.onChange(option.value);
		});
		buttons.push(node);
		group.appendChild(node);
	}
	mark(options.value);
	return group;
}
//#endregion
//#region src/ui/views/journal.ts
var JOURNAL_TAB = "journal";
var LIMIT = 300;
function journalTab(env) {
	const { i18n, shell } = env;
	const t = i18n.t.bind(i18n);
	const recordView = (record, redraw) => el("div", { class: ["maestro-journal-row", record.undone ? "maestro-undone" : null] }, [el("div", { class: "maestro-journal-main" }, [
		el("div", {
			class: "maestro-journal-summary",
			text: record.summary
		}),
		el("div", {
			class: "maestro-muted",
			text: `${formatTime(record.at, i18n)} · ${moduleTitle(env.modules, i18n, record.module)} · ${record.kind}`
		}),
		record.changes.length ? el("details", { class: "maestro-journal-changes" }, [el("summary", { text: t("ui.journal.changes", { count: record.changes.length }) }), ...record.changes.map((change) => changeView(change, t))]) : null
	]), button({
		label: record.undone ? t("ui.journal.undoneLabel") : t("ui.journal.undo"),
		icon: "fa-rotate-left",
		disabled: record.undone === true,
		onClick: async () => {
			const ok = await env.journal.undo(record.id);
			shell.notice(ok ? t("ui.journal.undoDone", { summary: record.summary }) : t("ui.journal.undoFailed", { summary: record.summary }), { level: ok ? "info" : "warn" });
			redraw();
		}
	})]);
	const statsView = () => {
		const stats = [...env.autonomy.stats()].sort((a, b) => a.kind.localeCompare(b.kind));
		return section(t("ui.journal.stats"), table([
			{
				key: "kind",
				label: t("ui.journal.kind"),
				cell: (row) => row.kind
			},
			{
				key: "accepted",
				label: t("ui.journal.accepted"),
				numeric: true,
				cell: (row) => String(row.accepted)
			},
			{
				key: "edited",
				label: t("ui.journal.edited"),
				numeric: true,
				cell: (row) => String(row.edited)
			},
			{
				key: "rejected",
				label: t("ui.journal.rejected"),
				numeric: true,
				cell: (row) => String(row.rejected)
			},
			{
				key: "undone",
				label: t("ui.journal.undoneCount"),
				numeric: true,
				cell: (row) => String(row.undone)
			},
			{
				key: "streak",
				label: t("ui.journal.streak"),
				numeric: true,
				cell: (row) => String(row.streak)
			}
		], stats, { empty: t("ui.journal.statsEmpty") }));
	};
	return {
		id: JOURNAL_TAB,
		titleKey: "ui.tab.journal",
		icon: "fa-clock-rotate-left",
		order: 80,
		render(container) {
			let filter = "";
			const draw = () => {
				clear(container);
				const records = [...env.journal.list({
					module: filter || void 0,
					limit: LIMIT
				})].sort((a, b) => b.at - a.at);
				const modules = [...new Set(env.journal.list({ limit: LIMIT }).map((record) => record.module))].sort();
				const filterSelect = select({
					value: filter,
					label: t("ui.journal.filter"),
					options: [{
						value: "",
						label: t("ui.journal.allModules")
					}, ...modules.map((id) => ({
						value: id,
						label: moduleTitle(env.modules, i18n, id)
					}))],
					onChange: (value) => {
						filter = value;
						draw();
					}
				});
				container.append(el("div", { class: "maestro-view maestro-journal" }, [section(t("ui.journal.title"), records.length ? el("div", { class: "maestro-journal-list" }, records.map((record) => recordView(record, draw))) : emptyState(t("ui.journal.empty"), "fa-feather"), [filterSelect, button({
					icon: "fa-arrows-rotate",
					title: t("ui.refresh"),
					kind: "ghost",
					onClick: draw
				})]), statsView()]));
			};
			draw();
		}
	};
}
//#endregion
//#region src/ui/views/message-badges.ts
/** ST events after which message DOM may have been rebuilt. Keys of eventTypes (see HostEvents.on). */
var RERENDER_EVENTS = [
	"CHARACTER_MESSAGE_RENDERED",
	"USER_MESSAGE_RENDERED",
	"MESSAGE_UPDATED",
	"MESSAGE_EDITED",
	"MESSAGE_SWIPED",
	"MORE_MESSAGES_LOADED",
	"CHAT_CHANGED"
];
var MessageBadges = class {
	host;
	log;
	entries = /* @__PURE__ */ new Map();
	unsubscribers = [];
	listening = false;
	timer = null;
	constructor(host, log) {
		this.host = host;
		this.log = log;
	}
	add(index, spec) {
		const key = `${index}:${spec.id}`;
		this.removeNode(this.entries.get(key));
		const entry = {
			...spec,
			key,
			index,
			chatId: this.currentChat()
		};
		this.entries.set(key, entry);
		this.listen();
		this.apply(entry);
		return () => {
			if (this.entries.get(key) !== entry) return;
			this.entries.delete(key);
			this.removeNode(entry);
		};
	}
	/** Re-applies every badge of the current chat (idempotent). */
	applyAll() {
		for (const entry of this.entries.values()) this.apply(entry);
	}
	dispose() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.listening = false;
		for (const entry of this.entries.values()) this.removeNode(entry);
		this.entries.clear();
	}
	currentChat() {
		try {
			return this.host.chatId();
		} catch {
			return null;
		}
	}
	listen() {
		if (this.listening) return;
		this.listening = true;
		for (const event of RERENDER_EVENTS) try {
			this.unsubscribers.push(this.host.events.on(event, () => this.schedule()));
		} catch (error) {
			this.log.debug(`message badges: no event ${event}`, error);
		}
	}
	/** Applies now and once more after ST finishes its own post-render work. */
	schedule() {
		this.applyAll();
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.applyAll();
		}, 50);
	}
	findMessage(index) {
		return document.querySelector(`#chat .mes[mesid="${index}"]`);
	}
	existing(message, entry) {
		return [...message.querySelectorAll(".maestro-badge")].find((node) => node.dataset.maestroBadge === entry.id) ?? null;
	}
	apply(entry) {
		const message = this.findMessage(entry.index);
		const ours = entry.chatId === this.currentChat();
		if (!message) return;
		const present = this.existing(message, entry);
		if (!ours) {
			present?.remove();
			return;
		}
		if (present) return;
		const node = this.build(entry);
		const buttons = message.querySelector(".mes_buttons");
		if (buttons) {
			buttons.insertBefore(node, buttons.firstChild);
			return;
		}
		const text = message.querySelector(".mes_text");
		if (text) text.after(node);
		else message.appendChild(node);
	}
	build(entry) {
		const node = el("div", {
			class: "maestro-badge",
			data: { maestroBadge: entry.id },
			title: entry.text
		}, [icon("fa-wand-magic-sparkles"), el("span", {
			class: "maestro-badge-text",
			text: entry.text
		})]);
		if (entry.action) {
			const action = entry.action;
			const run = el("button", {
				class: "maestro-badge-action",
				text: action.label,
				attrs: { type: "button" }
			});
			run.addEventListener("click", (event) => {
				event.stopPropagation();
				try {
					action.run();
				} catch (error) {
					this.log.error(`message badge action "${entry.id}" failed`, error);
				}
			});
			node.appendChild(run);
		}
		return node;
	}
	removeNode(entry) {
		if (!entry) return;
		const message = this.findMessage(entry.index);
		if (message) this.existing(message, entry)?.remove();
	}
};
//#endregion
//#region src/ui/views/overview.ts
var OVERVIEW_TAB = "overview";
var MODES = [
	"economy",
	"balanced",
	"cinema"
];
/** Groups capability ids by neighbour prefix: 'des.tracker' → 'des'. */
function groupCapabilities(report) {
	const groups = /* @__PURE__ */ new Map();
	for (const item of report) {
		const prefix = item.id.includes(".") ? item.id.slice(0, item.id.indexOf(".")) : item.id;
		const list = groups.get(prefix) ?? [];
		list.push(item);
		groups.set(prefix, list);
	}
	return groups;
}
function overviewTab(env) {
	const { i18n, shell } = env;
	const t = i18n.t.bind(i18n);
	const banners = () => {
		const result = [];
		try {
			if (shell.host.isGroupChat()) result.push(banner(t("ui.overview.groupChat"), "warn", "fa-users"));
			else if (shell.host.chatId() !== null && !shell.host.isChatCompletion()) result.push(banner(t("ui.overview.textCompletion"), "info", "fa-circle-info"));
		} catch (error) {
			shell.log.debug("overview banners", error);
		}
		return result;
	};
	const inboxBlock = () => {
		const count = env.inbox.count();
		return section(t("ui.overview.inbox"), count ? el("div", { class: "maestro-row" }, [el("span", { text: t("ui.overview.inboxCount", { count }) }), button({
			label: t("ui.overview.openInbox"),
			icon: "fa-inbox",
			onClick: () => shell.openPult("inbox")
		})]) : emptyState(t("ui.overview.inboxEmpty")));
	};
	const modeBlock = () => {
		const core = env.settings.core();
		return section(t("ui.overview.mode"), [segmented({
			value: core.mode,
			label: t("ui.overview.mode"),
			options: MODES.map((mode) => ({
				value: mode,
				label: t(`ui.mode.${mode}`)
			})),
			onChange: (mode) => {
				env.settings.core().mode = mode;
				env.settings.save();
				env.settings.notify("core.mode");
			}
		}), el("div", {
			class: "maestro-hint",
			text: t(`ui.mode.${core.mode}Hint`)
		})]);
	};
	const costBlock = () => {
		const summary = env.cost.summary();
		const cap = env.settings.core().backgroundDailyCapUsd;
		const sources = Object.entries(summary.todayBySource).filter(([, usd]) => usd > 0);
		const children = [
			el("div", { class: "maestro-kv" }, [el("span", { text: t("ui.cost.today") }), el("strong", { text: formatUsd(summary.todayUsd, i18n) })]),
			el("div", { class: "maestro-kv" }, [el("span", { text: t("ui.cost.background") }), el("strong", { text: cap > 0 ? t("ui.cost.backgroundOfCap", {
				spent: formatUsd(summary.backgroundTodayUsd, i18n),
				cap: formatUsd(cap, i18n)
			}) : t("ui.cost.backgroundNoCap", { spent: formatUsd(summary.backgroundTodayUsd, i18n) }) })]),
			summary.anlasToday > 0 ? el("div", { class: "maestro-kv" }, [el("span", { text: t("ui.cost.anlas") }), el("strong", { text: String(summary.anlasToday) })]) : null,
			env.cost.backgroundCapReached() ? banner(t("ui.cost.capReached"), "error", "fa-hand") : null,
			sources.length ? table([{
				key: "source",
				label: t("ui.cost.source"),
				cell: ([source]) => tOr(i18n, `ui.cost.source.${source}`, source)
			}, {
				key: "usd",
				label: t("ui.cost.usd"),
				numeric: true,
				cell: ([, usd]) => formatUsd(usd, i18n)
			}], sources, { caption: t("ui.cost.bySource") }) : null
		];
		return section(t("ui.overview.cost"), children);
	};
	const stackBlock = () => {
		const groups = groupCapabilities(env.caps.report());
		if (!groups.size) return section(t("ui.overview.stack"), emptyState(t("ui.overview.stackEmpty"), "fa-plug"));
		const rows = [...groups.entries()].map(([prefix, items]) => {
			const ok = items.filter((item) => item.ok).length;
			const state = ok === items.length ? "ok" : ok === 0 ? "error" : "warn";
			const failing = items.filter((item) => !item.ok);
			const name = tOr(i18n, `ui.stack.${prefix}`, prefix);
			return el("div", { class: "maestro-stack-row" }, [
				lamp(state, t(`ui.lamp.${state}`)),
				el("span", {
					class: "maestro-stack-name",
					text: name
				}),
				el("span", {
					class: "maestro-muted",
					text: t("ui.overview.capsCount", {
						ok,
						total: items.length
					})
				}),
				failing.length ? el("details", { class: "maestro-stack-missing" }, [el("summary", { text: t("ui.overview.capsMissing", { count: failing.length }) }), el("ul", {}, failing.map((item) => el("li", { text: item.detail ? `${item.id} — ${item.detail}` : item.id })))]) : null
			]);
		});
		return section(t("ui.overview.stack"), el("div", { class: "maestro-stack" }, rows));
	};
	const modulesBlock = () => {
		const list = env.modules.list().sort((a, b) => a.module.stage - b.module.stage || a.module.id.localeCompare(b.module.id));
		const status = (item) => {
			if (item.running) return badge(t("ui.modules.running"), "ok");
			if (!item.enabled) return badge(t("ui.modules.off"), "muted");
			if (item.missing.length) return badge(t("ui.modules.blocked"), "warn");
			return badge(t("ui.modules.stopped"), "warn");
		};
		return section(t("ui.overview.modules"), table([
			{
				key: "stage",
				label: t("ui.modules.stage"),
				numeric: true,
				cell: (item) => String(item.module.stage)
			},
			{
				key: "title",
				label: t("ui.modules.module"),
				cell: (item) => [el("span", { text: t(item.module.titleKey) }), el("span", {
					class: "maestro-muted",
					text: ` ${item.module.id}`
				})]
			},
			{
				key: "status",
				label: t("ui.modules.status"),
				cell: status
			},
			{
				key: "missing",
				label: t("ui.modules.missing"),
				cell: (item) => item.missing.length ? el("span", {
					class: "maestro-warn-text",
					text: item.missing.join(", ")
				}) : "—"
			}
		], list, { empty: t("ui.modules.none") }));
	};
	const noticesBlock = () => {
		const notices = [...shell.notices()].reverse().slice(0, 15);
		const list = notices.length ? el("ul", { class: "maestro-notices" }, notices.map((notice) => el("li", { class: [
			"maestro-notice",
			`maestro-level-${notice.level}`,
			notice.urgent ? "maestro-urgent" : null
		] }, [
			el("span", {
				class: "maestro-notice-time",
				text: formatTime(notice.at, i18n)
			}),
			el("span", {
				class: "maestro-notice-text",
				text: notice.text
			}),
			notice.action ? button({
				label: notice.action.label,
				kind: "primary",
				onClick: () => notice.action?.run()
			}) : null
		]))) : emptyState(t("ui.overview.noticesEmpty"), "fa-bell-slash");
		return section(t("ui.overview.notices"), list, notices.length ? button({
			label: t("ui.overview.clearNotices"),
			icon: "fa-broom",
			kind: "ghost",
			onClick: () => {
				shell.clearNotices();
				shell.refresh();
			}
		}) : void 0);
	};
	return {
		id: OVERVIEW_TAB,
		titleKey: "ui.tab.overview",
		icon: "fa-gauge-high",
		order: 10,
		badge: () => shell.notices().filter((notice) => notice.urgent && !notice.seen).length,
		render(container) {
			const draw = () => {
				clear(container);
				container.append(el("div", { class: "maestro-view maestro-overview" }, [
					...banners(),
					el("div", { class: "maestro-grid" }, [
						inboxBlock(),
						modeBlock(),
						costBlock(),
						stackBlock()
					]),
					modulesBlock(),
					noticesBlock()
				]));
			};
			draw();
			shell.markNoticesSeen();
			const later = coalesce(draw, 250);
			const unsubscribers = [
				env.cost.onChange(later),
				env.inbox.onChange(later),
				env.settings.onChange((path) => {
					if (path === "core.mode" || path.startsWith("core.modules") || path === "core.backgroundDailyCapUsd") later();
				})
			];
			return () => {
				later.cancel();
				for (const unsubscribe of unsubscribers) unsubscribe();
			};
		}
	};
}
//#endregion
//#region src/ui/components/tabs.ts
function tabs(options) {
	const list = el("div", {
		class: "maestro-tabs",
		attrs: {
			role: "tablist",
			"aria-orientation": "vertical",
			"aria-label": options.label
		}
	});
	const picker = el("select", {
		class: "text_pole maestro-tabs-picker",
		attrs: { "aria-label": options.label }
	});
	let items = [];
	let current = options.active ?? null;
	const buttonOf = (id) => [...list.querySelectorAll(".maestro-tab")].find((node) => node.dataset.tab === id) ?? null;
	const pickerLabel = (item) => item.badge ? `${item.label} (${item.badge})` : item.label;
	const render = () => {
		list.replaceChildren();
		picker.replaceChildren();
		for (const item of items) {
			const badge = el("span", {
				class: "maestro-tab-badge",
				text: item.badge ? String(item.badge) : ""
			});
			badge.hidden = !item.badge;
			const node = el("button", {
				class: "maestro-tab",
				data: { tab: item.id },
				attrs: {
					type: "button",
					role: "tab",
					"aria-selected": "false",
					tabindex: "-1"
				}
			}, [
				item.icon ? icon(item.icon) : null,
				el("span", {
					class: "maestro-tab-label",
					text: item.label
				}),
				badge
			]);
			node.addEventListener("click", () => choose(item.id));
			list.appendChild(node);
			picker.appendChild(el("option", {
				text: pickerLabel(item),
				attrs: { value: item.id }
			}));
		}
		mark();
	};
	const mark = () => {
		if (current === null || !items.some((item) => item.id === current)) current = items[0]?.id ?? null;
		for (const node of list.querySelectorAll(".maestro-tab")) {
			const on = node.dataset.tab === current;
			node.classList.toggle("maestro-on", on);
			node.setAttribute("aria-selected", on ? "true" : "false");
			node.setAttribute("tabindex", on ? "0" : "-1");
		}
		if (current !== null) picker.value = current;
	};
	const choose = (id) => {
		if (!items.some((item) => item.id === id)) return;
		current = id;
		mark();
		options.onSelect(id);
	};
	list.addEventListener("keydown", (event) => {
		if (![
			"ArrowDown",
			"ArrowUp",
			"ArrowLeft",
			"ArrowRight",
			"Home",
			"End"
		].includes(event.key) || !items.length) return;
		event.preventDefault();
		const index = Math.max(0, items.findIndex((item) => item.id === current));
		let next;
		if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % items.length;
		else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") next = 0;
		else next = items.length - 1;
		const target = items[next];
		if (!target) return;
		choose(target.id);
		buttonOf(target.id)?.focus();
	});
	picker.addEventListener("change", () => choose(picker.value));
	const handle = {
		list,
		picker,
		setItems(next) {
			items = [...next];
			render();
		},
		setActive(id) {
			if (!items.some((item) => item.id === id)) return;
			current = id;
			mark();
		},
		setBadge(id, value) {
			const item = items.find((entry) => entry.id === id);
			if (!item || (item.badge ?? 0) === value) return;
			item.badge = value;
			const badge = buttonOf(id)?.querySelector(".maestro-tab-badge");
			if (badge) {
				badge.textContent = value ? String(value) : "";
				badge.hidden = !value;
			}
			const option = [...picker.options].find((entry) => entry.value === id);
			if (option) option.textContent = pickerLabel(item);
		},
		active: () => current
	};
	handle.setItems(options.items);
	return handle;
}
//#endregion
//#region src/ui/views/pult.ts
var Pult = class {
	deps;
	registry = /* @__PURE__ */ new Map();
	popup = null;
	nav = null;
	body = null;
	chrome = null;
	activeId = null;
	lastTab = null;
	cleanup = null;
	constructor(deps) {
		this.deps = deps;
	}
	add(tab) {
		if (this.registry.has(tab.id)) this.deps.log.warn(`pult tab "${tab.id}" replaced`);
		this.registry.set(tab.id, tab);
		this.syncTabs();
		if (this.isOpen() && this.activeId === tab.id) this.rerender();
		if (this.isOpen() && this.activeId === null) this.select(tab.id);
		this.deps.onBadgesChanged();
		return () => {
			if (this.registry.get(tab.id) !== tab) return;
			this.registry.delete(tab.id);
			if (this.activeId === tab.id) {
				this.unmountActive();
				this.activeId = null;
			}
			this.syncTabs();
			if (this.isOpen() && this.activeId === null) {
				const first = this.tabs()[0];
				if (first) this.select(first.id);
				else this.renderEmpty();
			}
			this.deps.onBadgesChanged();
		};
	}
	/** Registered tabs sorted by order (then id, for a stable order). */
	tabs() {
		return [...this.registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	}
	isOpen() {
		return this.popup !== null;
	}
	activeTab() {
		return this.activeId;
	}
	open(tabId) {
		const target = this.pick(tabId);
		if (this.popup) {
			if (target) this.select(target);
			return;
		}
		const c = this.deps.host.ctx();
		if (typeof c.Popup !== "function") {
			this.deps.log.error("ST Popup is not available; cannot open the pult");
			return;
		}
		const root = this.buildChrome();
		const popup = new c.Popup(root, c.POPUP_TYPE.DISPLAY, "", {
			wide: true,
			large: true,
			allowVerticalScrolling: false,
			animation: prefersReducedMotion() ? "none" : "fast"
		});
		popup.dlg.classList.add("maestro-pult-dialog");
		this.popup = popup;
		popup.show().then(() => this.handleClosed(popup), () => this.handleClosed(popup));
		if (target) this.select(target);
		else this.renderEmpty();
	}
	close() {
		const popup = this.popup;
		if (!popup) return;
		this.handleClosed(popup);
		popup.completeCancelled().catch((error) => this.deps.log.debug("pult close", error));
	}
	select(id) {
		if (!this.registry.has(id) || !this.popup) return;
		this.unmountActive();
		this.activeId = id;
		this.lastTab = id;
		this.nav?.setActive(id);
		this.renderActive();
	}
	/** Re-renders the active tab unless the user is typing in it (a refresh must not eat input). */
	rerender() {
		if (!this.popup || !this.activeId || !this.body) return;
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && this.body.contains(focused) && focused.matches("input:not([type=checkbox]), textarea")) return;
		this.unmountActive();
		this.renderActive();
	}
	updateBadges() {
		if (!this.nav) return;
		for (const tab of this.registry.values()) this.nav.setBadge(tab.id, this.badgeOf(tab));
	}
	totalBadge() {
		let total = 0;
		for (const tab of this.registry.values()) total += this.badgeOf(tab);
		return total;
	}
	/** Language changed: rebuild tab titles and the active view. */
	relocalize() {
		if (!this.popup || !this.chrome) return;
		this.chrome.title.textContent = this.deps.i18n.t("ui.title");
		this.chrome.close.title = this.deps.i18n.t("ui.pult.close");
		this.chrome.close.setAttribute("aria-label", this.deps.i18n.t("ui.pult.close"));
		this.syncTabs();
		this.rerender();
	}
	dispose() {
		this.close();
		this.registry.clear();
	}
	pick(tabId) {
		if (tabId && this.registry.has(tabId)) return tabId;
		if (tabId) this.deps.log.warn(`unknown pult tab "${tabId}"`);
		if (this.activeId && this.registry.has(this.activeId)) return this.activeId;
		if (this.lastTab && this.registry.has(this.lastTab)) return this.lastTab;
		return this.tabs()[0]?.id ?? null;
	}
	badgeOf(tab) {
		if (!tab.badge) return 0;
		try {
			const value = tab.badge();
			return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
		} catch (error) {
			this.deps.log.warn(`badge of tab "${tab.id}" failed`, error);
			return 0;
		}
	}
	buildChrome() {
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		this.nav = tabs({
			items: [],
			label: t("ui.pult.tabs"),
			onSelect: (id) => this.select(id)
		});
		this.body = el("div", {
			class: "maestro-pult-body",
			attrs: {
				role: "tabpanel",
				tabindex: "-1"
			}
		});
		const title = el("h3", {
			class: "maestro-pult-title",
			text: t("ui.title")
		});
		const close = button({
			icon: "fa-xmark",
			title: t("ui.pult.close"),
			kind: "ghost",
			className: "maestro-pult-close",
			onClick: () => this.close()
		});
		this.chrome = {
			title,
			close
		};
		this.syncTabs();
		return el("div", { class: "maestro-pult maestro-theme" }, [el("div", { class: "maestro-pult-header" }, [
			el("div", { class: "maestro-pult-brand" }, [icon("fa-wand-magic-sparkles"), title]),
			this.nav.picker,
			close
		]), el("div", { class: "maestro-pult-main" }, [this.nav.list, this.body])]);
	}
	syncTabs() {
		if (!this.nav) return;
		this.nav.setItems(this.tabs().map((tab) => ({
			id: tab.id,
			label: this.deps.i18n.t(tab.titleKey),
			icon: tab.icon,
			badge: this.badgeOf(tab)
		})));
		if (this.activeId) this.nav.setActive(this.activeId);
	}
	renderActive() {
		const body = this.body;
		const tab = this.activeId ? this.registry.get(this.activeId) : void 0;
		if (!body || !tab) return;
		clear(body);
		body.dataset.tab = tab.id;
		body.scrollTop = 0;
		try {
			const result = tab.render(body);
			this.cleanup = typeof result === "function" ? result : null;
		} catch (error) {
			this.deps.log.error(`render of tab "${tab.id}" failed`, error);
			clear(body);
			body.appendChild(emptyState(this.deps.i18n.t("ui.pult.renderFailed"), "fa-bug"));
		}
		this.updateBadges();
	}
	renderEmpty() {
		if (!this.body) return;
		clear(this.body);
		this.body.appendChild(emptyState(this.deps.i18n.t("ui.pult.noTabs"), "fa-wand-magic-sparkles"));
	}
	unmountActive() {
		const cleanup = this.cleanup;
		this.cleanup = null;
		if (cleanup) try {
			cleanup();
		} catch (error) {
			this.deps.log.warn("tab cleanup failed", error);
		}
		if (this.body) clear(this.body);
	}
	handleClosed(popup) {
		if (this.popup !== popup) return;
		this.unmountActive();
		this.popup = null;
		this.nav = null;
		this.body = null;
		this.chrome = null;
		this.activeId = null;
	}
};
//#endregion
//#region src/ui/views/registries.ts
/** Buttons the Settings tab always shows; they call the handler registered under the same id. */
var BUILTIN_SETTINGS_ACTIONS = [
	{
		id: "export",
		labelKey: "ui.settings.export",
		icon: "fa-file-export"
	},
	{
		id: "import",
		labelKey: "ui.settings.import",
		icon: "fa-file-import"
	},
	{
		id: "prepareDisable",
		labelKey: "ui.settings.prepareDisable",
		icon: "fa-power-off",
		danger: true
	}
];
/** Profile rows the Settings tab always shows. */
var BUILTIN_PROFILE_TASKS = [{
	id: "default",
	labelKey: "ui.settings.profileDefault"
}, {
	id: "fallback",
	labelKey: "ui.settings.profileFallback"
}];
var actions = /* @__PURE__ */ new Map();
var profileTaskMap = /* @__PURE__ */ new Map();
var listeners = /* @__PURE__ */ new Set();
function settingsAction(id) {
	return actions.get(id);
}
function settingsActions() {
	return [...actions.values()];
}
function profileTasks() {
	return [...profileTaskMap.entries()].map(([id, labelKey]) => ({
		id,
		labelKey
	}));
}
function onRegistryChange(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
//#endregion
//#region src/ui/views/settings.ts
var SETTINGS_TAB = "settings";
var AUTONOMY_LEVELS = [
	"auto",
	"notify",
	"inbox",
	"ask",
	"off"
];
var LANGUAGES = [
	"auto",
	"ru",
	"en"
];
/** What an empty choice means: no main profile, no fallback, or "same as main" for task kinds. */
var EMPTY_PROFILE_LABEL = {
	default: "ui.settings.profileNone",
	fallback: "ui.settings.profileNoFallback"
};
var LIMIT_ACTIONS = [
	"warn",
	"economy",
	"stopBackground"
];
function settingsTab(env) {
	const { i18n, shell, settings } = env;
	const t = i18n.t.bind(i18n);
	const core = () => settings.core();
	const commit = (path) => {
		settings.save();
		settings.notify(path);
	};
	const generalBlock = () => section(t("ui.settings.general"), [
		field(t("ui.settings.language"), select({
			value: core().uiLanguage,
			label: t("ui.settings.language"),
			options: LANGUAGES.map((value) => ({
				value,
				label: t(`ui.settings.language.${value}`)
			})),
			onChange: (value) => {
				core().uiLanguage = value;
				commit("core.uiLanguage");
				shell.relocalize();
			}
		})),
		field(t("ui.settings.mode"), select({
			value: core().mode,
			label: t("ui.settings.mode"),
			options: MODES.map((value) => ({
				value,
				label: t(`ui.mode.${value}`)
			})),
			onChange: (value) => {
				core().mode = value;
				commit("core.mode");
			}
		}), t("ui.settings.modeHint")),
		toggle({
			label: t("ui.settings.debug"),
			hint: t("ui.settings.debugHint"),
			checked: core().debug,
			onChange: (checked) => {
				core().debug = checked;
				ConsoleLogger.setLevel(checked ? "debug" : "info");
				commit("core.debug");
			}
		})
	]);
	const budgetBlock = () => {
		const limit = core().dailyLimit;
		return section(t("ui.settings.budget"), [
			field(t("ui.settings.backgroundCap"), numberInput({
				value: core().backgroundDailyCapUsd,
				min: 0,
				step: .05,
				label: t("ui.settings.backgroundCap"),
				onChange: (value) => {
					core().backgroundDailyCapUsd = value;
					commit("core.backgroundDailyCapUsd");
				}
			}), t("ui.settings.backgroundCapHint")),
			toggle({
				label: t("ui.settings.dailyLimit"),
				hint: t("ui.settings.dailyLimitHint"),
				checked: limit.enabled,
				onChange: (checked) => {
					core().dailyLimit.enabled = checked;
					commit("core.dailyLimit.enabled");
				}
			}),
			field(t("ui.settings.dailyLimitUsd"), numberInput({
				value: limit.usd,
				min: 0,
				step: .5,
				label: t("ui.settings.dailyLimitUsd"),
				onChange: (value) => {
					core().dailyLimit.usd = value;
					commit("core.dailyLimit.usd");
				}
			})),
			field(t("ui.settings.dailyLimitAction"), select({
				value: limit.action,
				label: t("ui.settings.dailyLimitAction"),
				options: LIMIT_ACTIONS.map((value) => ({
					value,
					label: t(`ui.settings.limitAction.${value}`)
				})),
				onChange: (value) => {
					core().dailyLimit.action = value;
					commit("core.dailyLimit.action");
				}
			}))
		]);
	};
	const supportedProfiles = () => {
		try {
			const service = shell.host.ctx().ConnectionManagerRequestService;
			if (!service?.getSupportedProfiles) return null;
			return service.getSupportedProfiles();
		} catch (error) {
			shell.log.debug("connection profiles unavailable", error);
			return null;
		}
	};
	const profilesBlock = () => {
		const profiles = supportedProfiles();
		if (!profiles) return section(t("ui.settings.profiles"), banner(t("ui.settings.noConnectionManager"), "warn", "fa-plug-circle-xmark"));
		const stored = core().profiles;
		const tasks = [...BUILTIN_PROFILE_TASKS, ...profileTasks().filter((task) => !BUILTIN_PROFILE_TASKS.some((builtin) => builtin.id === task.id))];
		for (const id of Object.keys(stored)) if (!tasks.some((task) => task.id === id)) tasks.push({
			id,
			labelKey: id
		});
		const rows = tasks.map((task) => {
			const current = stored[task.id] ?? "";
			const options = [{
				value: "",
				label: t(EMPTY_PROFILE_LABEL[task.id] ?? "ui.settings.profileInherit")
			}, ...profiles.map((profile) => ({
				value: profile.id,
				label: profile.name
			}))];
			if (current && !profiles.some((profile) => profile.id === current)) options.push({
				value: current,
				label: t("ui.settings.profileMissing", { id: current })
			});
			const label = task.labelKey === task.id ? task.id : t(task.labelKey);
			return field(label, select({
				value: current,
				label,
				options,
				onChange: (value) => {
					if (value) core().profiles[task.id] = value;
					else delete core().profiles[task.id];
					commit(`core.profiles.${task.id}`);
				}
			}));
		});
		return section(t("ui.settings.profiles"), [el("div", {
			class: "maestro-hint",
			text: t("ui.settings.profilesHint")
		}), ...rows]);
	};
	const autonomyBlock = () => {
		const stored = core().autonomy;
		const kinds = [.../* @__PURE__ */ new Set([...env.autonomy.stats().map((stat) => stat.kind), ...Object.keys(stored)])].sort();
		if (!kinds.length) return section(t("ui.settings.autonomy"), emptyState(t("ui.settings.autonomyEmpty"), "fa-scale-balanced"));
		const options = [{
			value: "",
			label: t("ui.settings.autonomyDefault")
		}, ...AUTONOMY_LEVELS.map((level) => ({
			value: level,
			label: t(`ui.autonomy.${level}`)
		}))];
		return section(t("ui.settings.autonomy"), [el("div", {
			class: "maestro-hint",
			text: t("ui.settings.autonomyHint")
		}), ...kinds.map((kind) => field(kind, select({
			value: stored[kind] ?? "",
			label: kind,
			options,
			onChange: (value) => {
				if (value) core().autonomy[kind] = value;
				else delete core().autonomy[kind];
				commit(`core.autonomy.${kind}`);
			}
		})))]);
	};
	const modulesBlock = (redraw) => {
		const list = env.modules.list().sort((a, b) => a.module.stage - b.module.stage || a.module.id.localeCompare(b.module.id));
		if (!list.length) return section(t("ui.settings.modules"), emptyState(t("ui.modules.none"), "fa-puzzle-piece"));
		return section(t("ui.settings.modules"), list.map((item) => el("div", { class: "maestro-module-row" }, [toggle({
			label: `${t(item.module.titleKey)} (${item.module.id})`,
			checked: item.enabled,
			onChange: async (checked) => {
				try {
					if (checked) await env.modules.enable(item.module.key);
					else await env.modules.disable(item.module.key);
				} catch (error) {
					shell.log.error(`module ${item.module.key} toggle failed`, error);
					shell.notice(t("ui.settings.moduleToggleFailed", { title: t(item.module.titleKey) }), { level: "error" });
				}
				redraw();
				shell.updateBadges();
			}
		}), item.missing.length ? el("div", {
			class: "maestro-field-hint maestro-warn-text",
			text: t("ui.settings.moduleMissing", { caps: item.missing.join(", ") })
		}) : null])));
	};
	const runAction = async (id) => {
		const action = settingsAction(id);
		if (!action) {
			shell.notice(t("ui.settings.actionUnavailable"), {
				level: "info",
				urgent: true
			});
			return;
		}
		await action.run();
	};
	const dataBlock = () => {
		const builtin = BUILTIN_SETTINGS_ACTIONS.map((action) => button({
			label: t(action.labelKey),
			icon: action.icon,
			kind: action.danger ? "danger" : "default",
			onClick: () => runAction(action.id)
		}));
		const extra = settingsActions().filter((action) => !BUILTIN_SETTINGS_ACTIONS.some((builtinAction) => builtinAction.id === action.id)).map((action) => button({
			label: t(action.labelKey),
			icon: action.icon ?? "fa-gear",
			kind: action.danger ? "danger" : "default",
			onClick: () => runAction(action.id)
		}));
		return section(t("ui.settings.data"), [
			el("div", { class: "maestro-actions" }, [...builtin, ...extra]),
			el("div", {
				class: "maestro-hint",
				text: t("ui.settings.prepareDisableHint")
			}),
			el("div", { class: "maestro-actions" }, [button({
				label: t("ui.settings.runWizard"),
				icon: "fa-hat-wizard",
				onClick: () => shell.runWizard()
			})])
		]);
	};
	return {
		id: SETTINGS_TAB,
		titleKey: "ui.tab.settings",
		icon: "fa-gear",
		order: 90,
		render(container) {
			const draw = () => {
				clear(container);
				container.append(el("div", { class: "maestro-view maestro-settings" }, [
					generalBlock(),
					budgetBlock(),
					profilesBlock(),
					autonomyBlock(),
					modulesBlock(draw),
					dataBlock()
				]));
			};
			draw();
			return shell.onRegistryChange(draw);
		}
	};
}
//#endregion
//#region src/ui/views/slash-commands.ts
/** By convention an argument named `value` is the unnamed argument (the text after the command). */
var UNNAMED_ARGUMENT = "value";
/** Page-wide: survives a UI rebuild (disable → activate without reload) so ST never sees a duplicate. */
var slots = /* @__PURE__ */ new Map();
function unnamedText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : String(item)).join(" ");
	if (value === void 0 || value === null) return "";
	return String(value);
}
function namedArgs(named) {
	if (!named || typeof named !== "object") return {};
	return Object.fromEntries(Object.entries(named).filter(([key]) => !key.startsWith("_")));
}
var SlashCommands = class {
	host;
	i18n;
	log;
	owned = /* @__PURE__ */ new Set();
	constructor(host, i18n, log) {
		this.host = host;
		this.i18n = i18n;
		this.log = log;
	}
	add(spec) {
		const name = spec.name.replace(/^\//, "");
		let slot = slots.get(name);
		if (slot) {
			slot.spec = spec;
			slot.state = "active";
			slot.i18n = this.i18n;
			slot.log = this.log;
			slot.owner = this;
		} else {
			slot = {
				spec,
				state: "active",
				i18n: this.i18n,
				log: this.log,
				owner: this
			};
			if (!this.register(name, spec)) return () => {};
			slots.set(name, slot);
		}
		this.owned.add(name);
		const current = slot;
		return () => {
			if (current.spec !== spec || current.state !== "active") return;
			current.state = "moduleOff";
		};
	}
	/** Maestro is going away: every command it owns answers "Maestro is disabled". */
	dispose() {
		for (const name of this.owned) {
			const slot = slots.get(name);
			if (slot && slot.owner === this) slot.state = "maestroOff";
		}
		this.owned.clear();
	}
	register(name, spec) {
		const c = this.host.ctx();
		if (!c.SlashCommandParser?.addCommandObject || !c.SlashCommand?.fromProps) {
			this.log.warn(`slash commands unavailable; /${name} not registered`);
			return false;
		}
		const t = this.i18n.t.bind(this.i18n);
		const stringType = c.ARGUMENT_TYPE?.STRING ?? "string";
		const args = spec.args ?? [];
		const unnamed = args.filter((arg) => arg.name === UNNAMED_ARGUMENT);
		const named = args.filter((arg) => arg.name !== UNNAMED_ARGUMENT);
		const props = {
			name,
			helpString: t(spec.helpKey),
			returns: "string",
			callback: (namedArguments, unnamedArgument) => run(name, namedArguments, unnamedArgument)
		};
		if (unnamed.length && c.SlashCommandArgument?.fromProps) props.unnamedArgumentList = unnamed.map((arg) => c.SlashCommandArgument.fromProps({
			description: t(arg.descriptionKey),
			typeList: [stringType],
			isRequired: !arg.optional
		}));
		if (named.length && c.SlashCommandNamedArgument?.fromProps) props.namedArgumentList = named.map((arg) => c.SlashCommandNamedArgument.fromProps({
			name: arg.name,
			description: t(arg.descriptionKey),
			typeList: [stringType],
			isRequired: !arg.optional
		}));
		try {
			c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps(props));
			return true;
		} catch (error) {
			this.log.error(`failed to register /${name}`, error);
			return false;
		}
	}
};
async function run(name, named, unnamed) {
	const slot = slots.get(name);
	if (!slot) return "";
	if (slot.state === "maestroOff") return slot.i18n.t("ui.slash.maestroOff");
	if (slot.state === "moduleOff") return slot.i18n.t("ui.slash.moduleOff", { name });
	try {
		return await slot.spec.callback(namedArgs(named), unnamedText(unnamed));
	} catch (error) {
		slot.log.error(`/${name} failed`, error);
		return slot.i18n.t("ui.slash.failed", {
			name,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}
//#endregion
//#region src/ui/views/strings.ts
/** Strings of the UI shell and core views (`ui.*`). Russian is the primary UI language. */
var UI_STRINGS = {
	en: {
		"ui.title": "Maestro",
		"ui.refresh": "Refresh",
		"ui.actionFailed": "Action failed: {error}",
		"ui.notice.tapTo": "(click: {label})",
		"ui.confirm.yes": "Yes",
		"ui.confirm.no": "No",
		"ui.entry.topTitle": "Maestro — open the control panel",
		"ui.entry.topTitleCount": "Maestro — {count} waiting",
		"ui.entry.wandTitle": "Open the Maestro control panel",
		"ui.entry.description": "Conductor of the extension stack: one canon, one prompt, one panel. Everything lives in the control panel.",
		"ui.entry.open": "Open Maestro",
		"ui.pult.tabs": "Maestro sections",
		"ui.pult.close": "Close",
		"ui.pult.noTabs": "Nothing here yet.",
		"ui.pult.renderFailed": "This section failed to open. Details are in the browser console.",
		"ui.tab.overview": "Overview",
		"ui.tab.inbox": "Inbox",
		"ui.tab.health": "Health",
		"ui.tab.tasks": "Tasks",
		"ui.tab.journal": "Journal",
		"ui.tab.settings": "Settings",
		"ui.lamp.ok": "Works",
		"ui.lamp.warn": "Partly works",
		"ui.lamp.error": "Not available",
		"ui.mode.economy": "Economy",
		"ui.mode.balanced": "Balanced",
		"ui.mode.cinema": "Cinema",
		"ui.mode.economyHint": "Minimum background AI: cheap checks only, no director or backstage.",
		"ui.mode.balancedHint": "Revisions on signals, AI judge only when in doubt. The default.",
		"ui.mode.cinemaHint": "More director, backstage and pictures; costs more.",
		"ui.overview.groupChat": "Group chats are not supported: Maestro sleeps in this chat.",
		"ui.overview.textCompletion": "Text Completion API: studios and generation scenarios fall back to the classic windows.",
		"ui.overview.inbox": "Inbox",
		"ui.overview.inboxCount": "Proposals waiting: {count}",
		"ui.overview.inboxEmpty": "Nothing waiting for a decision.",
		"ui.overview.openInbox": "Open",
		"ui.overview.mode": "Mode",
		"ui.overview.cost": "Spend today",
		"ui.overview.stack": "Extension stack",
		"ui.overview.stackEmpty": "No capability checks yet.",
		"ui.overview.capsCount": "{ok} of {total}",
		"ui.overview.capsMissing": "Missing: {count}",
		"ui.overview.modules": "Modules",
		"ui.overview.notices": "Notices",
		"ui.overview.noticesEmpty": "No notices.",
		"ui.overview.clearNotices": "Clear",
		"ui.stack.st": "SillyTavern",
		"ui.stack.des": "Doom's Enhancement Suite",
		"ui.stack.desru": "DES-RU",
		"ui.stack.ck": "CarrotKernel",
		"ui.stack.bunnymo": "BunnyMo",
		"ui.stack.qvink": "Qvink Memory",
		"ui.stack.nai": "NAI Studio",
		"ui.stack.localizer": "Lorebook Localizer",
		"ui.stack.preset": "Preset",
		"ui.cost.today": "Total",
		"ui.cost.background": "Maestro background",
		"ui.cost.backgroundOfCap": "{spent} of {cap}",
		"ui.cost.backgroundNoCap": "{spent} (no cap)",
		"ui.cost.anlas": "Anlas",
		"ui.cost.capReached": "The background cap is reached: background tasks wait until tomorrow or until the cap is raised.",
		"ui.cost.bySource": "Spend by source",
		"ui.cost.source": "Source",
		"ui.cost.usd": "USD",
		"ui.cost.source.main": "Main chat",
		"ui.cost.source.qvink": "Qvink summaries",
		"ui.cost.source.maestro": "Maestro",
		"ui.cost.source.nai": "NovelAI",
		"ui.cost.source.other": "Other",
		"ui.modules.stage": "Stage",
		"ui.modules.module": "Module",
		"ui.modules.status": "Status",
		"ui.modules.missing": "Missing",
		"ui.modules.running": "Running",
		"ui.modules.off": "Off",
		"ui.modules.blocked": "Waiting for capabilities",
		"ui.modules.stopped": "Not running",
		"ui.modules.none": "No modules yet: they arrive with the next stages.",
		"ui.inbox.title": "Proposals",
		"ui.inbox.empty": "Inbox is empty.",
		"ui.inbox.accept": "Accept",
		"ui.inbox.reject": "Reject",
		"ui.inbox.snooze": "Tomorrow",
		"ui.inbox.acceptAll": "Accept all ({count})",
		"ui.inbox.acceptAllDone": "Accepted: {accepted}.",
		"ui.inbox.acceptAllPartial": "Accepted: {accepted}; out of date and skipped: {failed}.",
		"ui.inbox.stale": "“{title}” is out of date: the data changed since the proposal.",
		"ui.inbox.deferred": "Waits for a module",
		"ui.inbox.deferredHint": "This proposal needs a module of a later stage.",
		"ui.inbox.expires": "until {time}",
		"ui.inbox.source": "Message #{index}",
		"ui.diff.before": "Before",
		"ui.diff.after": "After",
		"ui.diff.added": "Added",
		"ui.diff.removed": "Removed",
		"ui.diff.value": "Value",
		"ui.diff.noChanges": "No changes.",
		"ui.diff.unchanged": "Unchanged fields: {count}",
		"ui.journal.title": "Actions",
		"ui.journal.empty": "No actions yet.",
		"ui.journal.filter": "Module filter",
		"ui.journal.allModules": "All modules",
		"ui.journal.changes": "Changes: {count}",
		"ui.journal.undo": "Undo",
		"ui.journal.undoneLabel": "Undone",
		"ui.journal.undoDone": "Undone: {summary}",
		"ui.journal.undoFailed": "Could not undo: {summary}",
		"ui.journal.stats": "Decision stats",
		"ui.journal.statsEmpty": "No decisions yet.",
		"ui.journal.kind": "Action kind",
		"ui.journal.accepted": "Accepted",
		"ui.journal.edited": "Edited",
		"ui.journal.rejected": "Rejected",
		"ui.journal.undoneCount": "Undone",
		"ui.journal.streak": "In a row",
		"ui.health.checks": "Checks",
		"ui.health.noChecks": "No checks registered yet.",
		"ui.health.runAll": "Run again",
		"ui.health.fix": "Fix",
		"ui.health.status.ok": "OK",
		"ui.health.status.warn": "Warning",
		"ui.health.status.error": "Problem",
		"ui.health.status.skip": "Skipped",
		"ui.health.status.running": "Checking…",
		"ui.health.capabilities": "Capabilities",
		"ui.health.recheck": "Recheck",
		"ui.health.state": "State",
		"ui.health.capability": "Capability",
		"ui.health.detail": "Details",
		"ui.health.log": "Recent warnings and errors",
		"ui.health.logEmpty": "No warnings.",
		"ui.tasks.title": "Background tasks",
		"ui.tasks.empty": "The queue is empty.",
		"ui.tasks.kind": "Task",
		"ui.tasks.state": "State",
		"ui.tasks.attempts": "Attempts",
		"ui.tasks.created": "Created",
		"ui.tasks.error": "Error",
		"ui.tasks.kick": "Run now",
		"ui.tasks.hint": "Tasks run only in the leading tab and never during a generation.",
		"ui.tasks.state.pending": "Waiting",
		"ui.tasks.state.running": "Running",
		"ui.tasks.state.done": "Done",
		"ui.tasks.state.failed": "Failed",
		"ui.tasks.state.expired": "Expired",
		"ui.settings.general": "General",
		"ui.settings.language": "Interface language",
		"ui.settings.language.auto": "As in SillyTavern",
		"ui.settings.language.ru": "Русский",
		"ui.settings.language.en": "English",
		"ui.settings.mode": "Mode",
		"ui.settings.modeHint": "Each module can still be switched on or off on top of the mode.",
		"ui.settings.debug": "Debug mode",
		"ui.settings.debugHint": "Detailed log in the browser console.",
		"ui.settings.budget": "Budget",
		"ui.settings.backgroundCap": "Background cap per day, USD",
		"ui.settings.backgroundCapHint": "Maestro's own background AI spend; 0 means no cap.",
		"ui.settings.dailyLimit": "Overall daily limit",
		"ui.settings.dailyLimitHint": "Counts the main chat too. Off by default.",
		"ui.settings.dailyLimitUsd": "Limit per day, USD",
		"ui.settings.dailyLimitAction": "When reached",
		"ui.settings.limitAction.warn": "Warn",
		"ui.settings.limitAction.economy": "Switch to Economy",
		"ui.settings.limitAction.stopBackground": "Stop background tasks",
		"ui.settings.profiles": "Connection profiles",
		"ui.settings.profilesHint": "Background tasks go through saved Connection Manager profiles; the active connection is not switched.",
		"ui.settings.profileDefault": "Main background profile",
		"ui.settings.profileFallback": "Fallback profile",
		"ui.settings.profileNone": "Not selected",
		"ui.settings.profileInherit": "Same as main",
		"ui.settings.profileNoFallback": "No fallback",
		"ui.settings.profileMissing": "Missing profile ({id})",
		"ui.settings.noConnectionManager": "Connection Manager is off: background tasks are not possible.",
		"ui.settings.autonomy": "Autonomy levels",
		"ui.settings.autonomyHint": "How Maestro handles each kind of action.",
		"ui.settings.autonomyEmpty": "Action kinds appear here once modules start proposing changes.",
		"ui.settings.autonomyDefault": "Module default",
		"ui.autonomy.auto": "Auto",
		"ui.autonomy.notify": "Notify",
		"ui.autonomy.inbox": "Inbox",
		"ui.autonomy.ask": "Ask",
		"ui.autonomy.off": "Off",
		"ui.settings.modules": "Modules",
		"ui.settings.moduleMissing": "Missing capabilities: {caps}",
		"ui.settings.moduleToggleFailed": "Could not switch “{title}”.",
		"ui.settings.data": "Data",
		"ui.settings.export": "Export Maestro data",
		"ui.settings.import": "Import",
		"ui.settings.prepareDisable": "Prepare to disable",
		"ui.settings.prepareDisableHint": "“Prepare to disable” moves chat canon into regular lorebooks and leaves the stack working without Maestro.",
		"ui.settings.actionUnavailable": "Not available yet: this action arrives in a later version.",
		"ui.settings.runWizard": "Run the first-run wizard again",
		"ui.slash.maestroOff": "Maestro is disabled.",
		"ui.slash.moduleOff": "/{name} is unavailable: its Maestro module is off.",
		"ui.slash.failed": "/{name} failed: {error}",
		"ui.wizard.welcomeTitle": "Welcome to Maestro",
		"ui.wizard.welcome1": "Maestro conducts your extension stack: it watches the lore, the prompt and the neighbours, fixes what breaks and keeps a canon for each chat.",
		"ui.wizard.welcome2": "Nothing important happens silently: proposals land in the Inbox, every action goes to the journal and can be undone.",
		"ui.wizard.welcome3": "The control panel opens with the wand icon in the top bar. A few setup steps follow.",
		"ui.wizard.stepOf": "Step {step} of {total}",
		"ui.wizard.back": "Back",
		"ui.wizard.next": "Next",
		"ui.wizard.skipStep": "Skip",
		"ui.wizard.finish": "Finish",
		"ui.wizard.skipAll": "Skip setup",
		"ui.wizard.stepFailed": "This step failed to open. It can be skipped.",
		"ui.wizard.finished": "Setup complete."
	},
	ru: {
		"ui.title": "Maestro",
		"ui.refresh": "Обновить",
		"ui.actionFailed": "Не получилось: {error}",
		"ui.notice.tapTo": "(по нажатию: {label})",
		"ui.confirm.yes": "Да",
		"ui.confirm.no": "Нет",
		"ui.entry.topTitle": "Maestro — открыть пульт",
		"ui.entry.topTitleCount": "Maestro — ждут решения: {count}",
		"ui.entry.wandTitle": "Открыть пульт Maestro",
		"ui.entry.description": "Дирижёр стека расширений: один канон, один промпт, один пульт. Всё управление — в пульте.",
		"ui.entry.open": "Открыть Maestro",
		"ui.pult.tabs": "Разделы Maestro",
		"ui.pult.close": "Закрыть",
		"ui.pult.noTabs": "Здесь пока пусто.",
		"ui.pult.renderFailed": "Раздел не открылся. Подробности — в консоли браузера.",
		"ui.tab.overview": "Обзор",
		"ui.tab.inbox": "Входящие",
		"ui.tab.health": "Здоровье",
		"ui.tab.tasks": "Задачи",
		"ui.tab.journal": "Журнал",
		"ui.tab.settings": "Настройки",
		"ui.lamp.ok": "Работает",
		"ui.lamp.warn": "Работает частично",
		"ui.lamp.error": "Недоступно",
		"ui.mode.economy": "Экономный",
		"ui.mode.balanced": "Сбалансированный",
		"ui.mode.cinema": "Кино",
		"ui.mode.economyHint": "Минимум фонового ИИ: только дешёвые проверки, без режиссёра и закулисья.",
		"ui.mode.balancedHint": "Ревизия по сигналам, ИИ-судья — только при подозрении. Режим по умолчанию.",
		"ui.mode.cinemaHint": "Больше режиссёра, закулисья и картинок; дороже.",
		"ui.overview.groupChat": "Групповые чаты не поддерживаются: в этом чате Maestro спит.",
		"ui.overview.textCompletion": "Text Completion: студии и сценарии генерации уступают место классическим окнам.",
		"ui.overview.inbox": "Входящие",
		"ui.overview.inboxCount": "Ждут решения: {count}",
		"ui.overview.inboxEmpty": "Решений не ждёт ничего.",
		"ui.overview.openInbox": "Открыть",
		"ui.overview.mode": "Режим",
		"ui.overview.cost": "Расходы за сегодня",
		"ui.overview.stack": "Стек расширений",
		"ui.overview.stackEmpty": "Проверок возможностей пока нет.",
		"ui.overview.capsCount": "{ok} из {total}",
		"ui.overview.capsMissing": "Не хватает: {count}",
		"ui.overview.modules": "Модули",
		"ui.overview.notices": "Уведомления",
		"ui.overview.noticesEmpty": "Уведомлений нет.",
		"ui.overview.clearNotices": "Очистить",
		"ui.stack.st": "SillyTavern",
		"ui.stack.des": "Doom's Enhancement Suite",
		"ui.stack.desru": "DES-RU",
		"ui.stack.ck": "CarrotKernel",
		"ui.stack.bunnymo": "BunnyMo",
		"ui.stack.qvink": "Qvink Memory",
		"ui.stack.nai": "NAI Studio",
		"ui.stack.localizer": "Lorebook Localizer",
		"ui.stack.preset": "Пресет",
		"ui.cost.today": "Всего",
		"ui.cost.background": "Фон Maestro",
		"ui.cost.backgroundOfCap": "{spent} из {cap}",
		"ui.cost.backgroundNoCap": "{spent} (без потолка)",
		"ui.cost.anlas": "Anlas",
		"ui.cost.capReached": "Потолок фоновых расходов достигнут: фоновые задачи ждут завтрашнего дня или повышения потолка.",
		"ui.cost.bySource": "Расходы по источникам",
		"ui.cost.source": "Источник",
		"ui.cost.usd": "USD",
		"ui.cost.source.main": "Основной чат",
		"ui.cost.source.qvink": "Пересказы Qvink",
		"ui.cost.source.maestro": "Maestro",
		"ui.cost.source.nai": "NovelAI",
		"ui.cost.source.other": "Прочее",
		"ui.modules.stage": "Этап",
		"ui.modules.module": "Модуль",
		"ui.modules.status": "Состояние",
		"ui.modules.missing": "Не хватает",
		"ui.modules.running": "Работает",
		"ui.modules.off": "Выключен",
		"ui.modules.blocked": "Ждёт возможностей",
		"ui.modules.stopped": "Не запущен",
		"ui.modules.none": "Модулей пока нет — они появятся на следующих этапах.",
		"ui.inbox.title": "Предложения",
		"ui.inbox.empty": "Во «Входящих» пусто.",
		"ui.inbox.accept": "Принять",
		"ui.inbox.reject": "Отклонить",
		"ui.inbox.snooze": "Завтра",
		"ui.inbox.acceptAll": "Принять все ({count})",
		"ui.inbox.acceptAllDone": "Принято: {accepted}.",
		"ui.inbox.acceptAllPartial": "Принято: {accepted}; устарели и пропущены: {failed}.",
		"ui.inbox.stale": "«{title}» устарело: данные изменились после предложения.",
		"ui.inbox.deferred": "Ждёт модуля",
		"ui.inbox.deferredHint": "Для этого предложения нужен модуль следующего этапа.",
		"ui.inbox.expires": "до {time}",
		"ui.inbox.source": "Сообщение №{index}",
		"ui.diff.before": "Было",
		"ui.diff.after": "Стало",
		"ui.diff.added": "Добавлено",
		"ui.diff.removed": "Удалено",
		"ui.diff.value": "Значение",
		"ui.diff.noChanges": "Изменений нет.",
		"ui.diff.unchanged": "Без изменений: {count}",
		"ui.journal.title": "Действия",
		"ui.journal.empty": "Действий пока нет.",
		"ui.journal.filter": "Фильтр по модулю",
		"ui.journal.allModules": "Все модули",
		"ui.journal.changes": "Изменения: {count}",
		"ui.journal.undo": "Откатить",
		"ui.journal.undoneLabel": "Откачено",
		"ui.journal.undoDone": "Откачено: {summary}",
		"ui.journal.undoFailed": "Откатить не удалось: {summary}",
		"ui.journal.stats": "Статистика решений",
		"ui.journal.statsEmpty": "Решений пока нет.",
		"ui.journal.kind": "Вид действия",
		"ui.journal.accepted": "Принято",
		"ui.journal.edited": "Исправлено",
		"ui.journal.rejected": "Отклонено",
		"ui.journal.undoneCount": "Откачено",
		"ui.journal.streak": "Подряд",
		"ui.health.checks": "Проверки",
		"ui.health.noChecks": "Проверок пока нет.",
		"ui.health.runAll": "Проверить снова",
		"ui.health.fix": "Исправить",
		"ui.health.status.ok": "В порядке",
		"ui.health.status.warn": "Предупреждение",
		"ui.health.status.error": "Проблема",
		"ui.health.status.skip": "Пропущено",
		"ui.health.status.running": "Проверяется…",
		"ui.health.capabilities": "Возможности",
		"ui.health.recheck": "Перепроверить",
		"ui.health.state": "Состояние",
		"ui.health.capability": "Возможность",
		"ui.health.detail": "Подробности",
		"ui.health.log": "Последние предупреждения и ошибки",
		"ui.health.logEmpty": "Предупреждений нет.",
		"ui.tasks.title": "Фоновые задачи",
		"ui.tasks.empty": "Очередь пуста.",
		"ui.tasks.kind": "Задача",
		"ui.tasks.state": "Состояние",
		"ui.tasks.attempts": "Попытки",
		"ui.tasks.created": "Создана",
		"ui.tasks.error": "Ошибка",
		"ui.tasks.kick": "Запустить сейчас",
		"ui.tasks.hint": "Задачи выполняет только ведущая вкладка и никогда — во время генерации.",
		"ui.tasks.state.pending": "Ждёт",
		"ui.tasks.state.running": "Выполняется",
		"ui.tasks.state.done": "Готово",
		"ui.tasks.state.failed": "Сбой",
		"ui.tasks.state.expired": "Устарела",
		"ui.settings.general": "Общие",
		"ui.settings.language": "Язык интерфейса",
		"ui.settings.language.auto": "Как в SillyTavern",
		"ui.settings.language.ru": "Русский",
		"ui.settings.language.en": "English",
		"ui.settings.mode": "Режим",
		"ui.settings.modeHint": "Любой модуль можно включить или выключить отдельно поверх режима.",
		"ui.settings.debug": "Режим отладки",
		"ui.settings.debugHint": "Подробный журнал в консоли браузера.",
		"ui.settings.budget": "Бюджет",
		"ui.settings.backgroundCap": "Потолок фона в день, USD",
		"ui.settings.backgroundCapHint": "Собственные фоновые запросы Maestro к ИИ; 0 — без потолка.",
		"ui.settings.dailyLimit": "Общий дневной лимит",
		"ui.settings.dailyLimitHint": "Учитывает и основной чат. По умолчанию выключен.",
		"ui.settings.dailyLimitUsd": "Лимит в день, USD",
		"ui.settings.dailyLimitAction": "Когда достигнут",
		"ui.settings.limitAction.warn": "Предупредить",
		"ui.settings.limitAction.economy": "Перейти в «Экономный»",
		"ui.settings.limitAction.stopBackground": "Остановить фоновые задачи",
		"ui.settings.profiles": "Профили подключения",
		"ui.settings.profilesHint": "Фоновые задачи идут через сохранённые профили Connection Manager; активное подключение не переключается.",
		"ui.settings.profileDefault": "Основной фоновый профиль",
		"ui.settings.profileFallback": "Запасной профиль",
		"ui.settings.profileNone": "Не выбран",
		"ui.settings.profileInherit": "Как основной",
		"ui.settings.profileNoFallback": "Без запасного",
		"ui.settings.profileMissing": "Профиль не найден ({id})",
		"ui.settings.noConnectionManager": "Connection Manager выключен: фоновые задачи невозможны.",
		"ui.settings.autonomy": "Уровни автономии",
		"ui.settings.autonomyHint": "Как Maestro поступает с каждым видом действий.",
		"ui.settings.autonomyEmpty": "Виды действий появятся здесь, когда модули начнут что-то предлагать.",
		"ui.settings.autonomyDefault": "Как задано в модуле",
		"ui.autonomy.auto": "Само",
		"ui.autonomy.notify": "Уведомить",
		"ui.autonomy.inbox": "Входящие",
		"ui.autonomy.ask": "Спросить",
		"ui.autonomy.off": "Выкл",
		"ui.settings.modules": "Модули",
		"ui.settings.moduleMissing": "Не хватает возможностей: {caps}",
		"ui.settings.moduleToggleFailed": "Не удалось переключить «{title}».",
		"ui.settings.data": "Данные",
		"ui.settings.export": "Экспорт данных Maestro",
		"ui.settings.import": "Импорт",
		"ui.settings.prepareDisable": "Подготовить к отключению",
		"ui.settings.prepareDisableHint": "«Подготовить к отключению» переносит канон чатов в обычные лорбуки и оставляет стек рабочим без Maestro.",
		"ui.settings.actionUnavailable": "Пока недоступно: это действие появится в следующих версиях.",
		"ui.settings.runWizard": "Запустить мастер первого запуска снова",
		"ui.slash.maestroOff": "Maestro отключён.",
		"ui.slash.moduleOff": "/{name} недоступна: её модуль Maestro выключен.",
		"ui.slash.failed": "/{name}: ошибка — {error}",
		"ui.wizard.welcomeTitle": "Добро пожаловать в Maestro",
		"ui.wizard.welcome1": "Maestro дирижирует стеком расширений: следит за лором, промптом и соседями, чинит то, что ломается, и ведёт канон каждого чата.",
		"ui.wizard.welcome2": "Важное не делается молча: предложения попадают во «Входящие», каждое действие пишется в журнал и откатывается.",
		"ui.wizard.welcome3": "Пульт открывается значком волшебной палочки в верхней панели. Дальше — несколько шагов настройки.",
		"ui.wizard.stepOf": "Шаг {step} из {total}",
		"ui.wizard.back": "Назад",
		"ui.wizard.next": "Далее",
		"ui.wizard.skipStep": "Пропустить",
		"ui.wizard.finish": "Готово",
		"ui.wizard.skipAll": "Пропустить настройку",
		"ui.wizard.stepFailed": "Шаг не открылся. Его можно пропустить.",
		"ui.wizard.finished": "Настройка завершена."
	}
};
//#endregion
//#region src/ui/views/tasks.ts
var TASKS_TAB = "tasks";
var POLL_MS = 3e3;
var STATE_ORDER = {
	running: 0,
	pending: 1,
	failed: 2,
	expired: 3,
	done: 4
};
var STATE_LEVEL = {
	running: "info",
	pending: "muted",
	failed: "error",
	expired: "warn",
	done: "ok"
};
function tasksTab(env) {
	const { i18n } = env;
	const t = i18n.t.bind(i18n);
	return {
		id: TASKS_TAB,
		titleKey: "ui.tab.tasks",
		icon: "fa-list-check",
		order: 75,
		render(container) {
			const draw = () => {
				clear(container);
				const list = [...env.tasks.list()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.createdAt - a.createdAt);
				container.append(el("div", { class: "maestro-view maestro-tasks" }, [section(t("ui.tasks.title"), table([
					{
						key: "kind",
						label: t("ui.tasks.kind"),
						cell: (task) => task.kind
					},
					{
						key: "state",
						label: t("ui.tasks.state"),
						cell: (task) => badge(t(`ui.tasks.state.${task.state}`), STATE_LEVEL[task.state])
					},
					{
						key: "attempts",
						label: t("ui.tasks.attempts"),
						numeric: true,
						cell: (task) => String(task.attempts)
					},
					{
						key: "created",
						label: t("ui.tasks.created"),
						cell: (task) => formatTime(task.createdAt, i18n)
					},
					{
						key: "error",
						label: t("ui.tasks.error"),
						cell: (task) => task.error ? el("span", {
							class: "maestro-error-text",
							text: task.error
						}) : ""
					}
				], list, { empty: t("ui.tasks.empty") }), [button({
					label: t("ui.tasks.kick"),
					icon: "fa-play",
					onClick: () => env.tasks.kick()
				}), button({
					icon: "fa-arrows-rotate",
					title: t("ui.refresh"),
					kind: "ghost",
					onClick: draw
				})]), el("div", {
					class: "maestro-hint",
					text: t("ui.tasks.hint")
				})]));
			};
			draw();
			const timer = setInterval(draw, POLL_MS);
			return () => clearInterval(timer);
		}
	};
}
//#endregion
//#region src/ui/views/wizard.ts
var WELCOME_STEP_ID = "welcome";
function welcomeStep(i18n) {
	return {
		id: WELCOME_STEP_ID,
		order: Number.NEGATIVE_INFINITY,
		titleKey: "ui.wizard.welcomeTitle",
		render(container, done) {
			const t = i18n.t.bind(i18n);
			container.append(el("div", { class: "maestro-wizard-welcome" }, [
				el("div", { class: "maestro-wizard-hero" }, [icon("fa-wand-magic-sparkles")]),
				el("p", { text: t("ui.wizard.welcome1") }),
				el("p", { text: t("ui.wizard.welcome2") }),
				el("p", { text: t("ui.wizard.welcome3") })
			]));
			done();
		}
	};
}
var Wizard = class {
	deps;
	registry = /* @__PURE__ */ new Map();
	popup = null;
	index = 0;
	completed = /* @__PURE__ */ new Set();
	nodes = null;
	constructor(deps) {
		this.deps = deps;
	}
	add(step) {
		if (step.id === "welcome") this.deps.log.warn("wizard step id \"welcome\" is reserved");
		this.registry.set(step.id, step);
		return () => {
			if (this.registry.get(step.id) === step) this.registry.delete(step.id);
		};
	}
	/** Welcome first, then registered steps by order. */
	steps() {
		const registered = [...this.registry.values()].filter((step) => step.id !== WELCOME_STEP_ID).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		return [welcomeStep(this.deps.i18n), ...registered];
	}
	isOpen() {
		return this.popup !== null;
	}
	/** Opens the wizard when the first run has not been completed yet. */
	maybeRun() {
		if (this.deps.settings.core().firstRunDone || this.isOpen()) return false;
		this.open();
		return this.isOpen();
	}
	open() {
		if (this.popup) return;
		const c = this.deps.host.ctx();
		if (typeof c.Popup !== "function") {
			this.deps.log.error("ST Popup is not available; cannot open the wizard");
			return;
		}
		this.index = 0;
		this.completed = /* @__PURE__ */ new Set();
		const root = this.build();
		const popup = new c.Popup(root, c.POPUP_TYPE.DISPLAY, "", {
			wide: true,
			allowVerticalScrolling: true,
			animation: prefersReducedMotion() ? "none" : "fast"
		});
		popup.dlg.classList.add("maestro-wizard-dialog");
		this.popup = popup;
		popup.show().then(() => this.handleClosed(popup), () => this.handleClosed(popup));
		this.renderStep();
	}
	close() {
		const popup = this.popup;
		if (!popup) return;
		this.handleClosed(popup);
		popup.completeCancelled().catch((error) => this.deps.log.debug("wizard close", error));
	}
	dispose() {
		this.close();
		this.registry.clear();
	}
	/** Test/inspection helper: id of the step on screen. */
	currentStep() {
		return this.popup ? this.steps()[this.index]?.id ?? null : null;
	}
	next() {
		const steps = this.steps();
		if (this.index >= steps.length - 1) {
			this.finish(false);
			return;
		}
		this.index += 1;
		this.renderStep();
	}
	back() {
		if (this.index === 0) return;
		this.index -= 1;
		this.renderStep();
	}
	finish(skipped) {
		const core = this.deps.settings.core();
		core.firstRunDone = true;
		this.deps.settings.save();
		this.deps.settings.notify("core.firstRunDone");
		this.close();
		this.deps.onFinished?.(skipped);
	}
	build() {
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		const progress = el("div", { class: "maestro-wizard-progress-bar" });
		const title = el("h3", { class: "maestro-wizard-title" });
		const counter = el("div", { class: "maestro-muted maestro-wizard-counter" });
		const body = el("div", { class: "maestro-wizard-body" });
		const back = button({
			label: t("ui.wizard.back"),
			icon: "fa-arrow-left",
			kind: "ghost",
			onClick: () => this.back()
		});
		const next = button({
			label: t("ui.wizard.next"),
			icon: "fa-arrow-right",
			kind: "primary",
			className: "maestro-wizard-next",
			onClick: () => this.next()
		});
		const root = el("div", { class: "maestro-wizard maestro-theme" }, [
			el("div", { class: "maestro-wizard-head" }, [
				counter,
				title,
				el("div", { class: "maestro-wizard-progress" }, [progress])
			]),
			body,
			el("div", { class: "maestro-wizard-foot" }, [
				button({
					label: t("ui.wizard.skipAll"),
					kind: "ghost",
					onClick: () => this.finish(true)
				}),
				el("span", { class: "maestro-grow" }),
				back,
				next
			])
		]);
		this.nodes = {
			root,
			progress,
			title,
			counter,
			body,
			back,
			next
		};
		return root;
	}
	renderStep() {
		const nodes = this.nodes;
		if (!nodes || !this.popup) return;
		const t = this.deps.i18n.t.bind(this.deps.i18n);
		const steps = this.steps();
		const step = steps[this.index];
		if (!step) return;
		const last = this.index === steps.length - 1;
		nodes.title.textContent = t(step.titleKey);
		nodes.counter.textContent = t("ui.wizard.stepOf", {
			step: this.index + 1,
			total: steps.length
		});
		nodes.progress.style.width = `${Math.round((this.index + 1) / steps.length * 100)}%`;
		nodes.back.disabled = this.index === 0;
		const updateNext = () => {
			const isDone = this.completed.has(step.id);
			const label = last ? t("ui.wizard.finish") : isDone ? t("ui.wizard.next") : t("ui.wizard.skipStep");
			const span = nodes.next.querySelector("span");
			if (span) span.textContent = label;
			nodes.next.classList.toggle("maestro-btn-primary", isDone || last);
		};
		clear(nodes.body);
		const target = el("div", {
			class: "maestro-wizard-step",
			data: { step: step.id }
		});
		nodes.body.appendChild(target);
		const stepIndex = this.index;
		try {
			step.render(target, () => {
				this.completed.add(step.id);
				if (this.index === stepIndex) updateNext();
			});
		} catch (error) {
			this.deps.log.error(`wizard step ${step.id} failed`, error);
			clear(target);
			target.appendChild(emptyState(t("ui.wizard.stepFailed"), "fa-bug"));
		}
		updateNext();
	}
	handleClosed(popup) {
		if (this.popup !== popup) return;
		this.popup = null;
		this.nodes = null;
	}
};
//#endregion
//#region src/ui/index.ts
var MAX_NOTICES = 50;
/** Lets modules register their wizard steps (modules start after mount) before the wizard opens. */
var WIZARD_DELAY_MS = 1500;
var TOAST = {
	info: "info",
	warn: "warning",
	error: "error"
};
var MaestroUi = class {
	host;
	log;
	i18n;
	settings;
	pult;
	wizard;
	entries;
	badges;
	slash;
	checks = /* @__PURE__ */ new Map();
	styles = /* @__PURE__ */ new Map();
	noticeList = [];
	unsubscribers = [];
	coreTabs = [];
	wizardTimer = null;
	/** The first-run check already ran (explicitly or by the timer): never auto-open twice per page. */
	wizardChecked = false;
	nextNotice = 1;
	mounted = false;
	disposed = false;
	constructor(deps) {
		this.host = deps.host;
		this.log = deps.log;
		this.i18n = deps.i18n;
		this.settings = deps.settings;
		this.pult = new Pult({
			host: this.host,
			i18n: this.i18n,
			log: this.log,
			onBadgesChanged: () => this.updateBadges()
		});
		this.wizard = new Wizard({
			host: this.host,
			i18n: this.i18n,
			log: this.log,
			settings: this.settings,
			onFinished: (skipped) => {
				if (!skipped) this.notice(this.i18n.t("ui.wizard.finished"), { level: "info" });
			}
		});
		this.entries = new EntryPoints({
			i18n: this.i18n,
			log: this.log,
			open: () => this.openPult()
		});
		this.badges = new MessageBadges(this.host, this.log);
		this.slash = new SlashCommands(this.host, this.i18n, this.log);
		setButtonErrorHandler((error) => {
			this.log.error("action failed", error);
			this.notice(this.i18n.t("ui.actionFailed", { error: error instanceof Error ? error.message : String(error) }), { level: "error" });
		});
	}
	mount() {
		if (this.mounted || this.disposed) return;
		this.mounted = true;
		this.entries.mount();
		this.updateBadges();
		this.listen("APP_READY", () => {
			this.entries.mount();
			this.updateBadges();
			if (this.wizardTimer === null && !this.wizardChecked && !this.settings.core().firstRunDone) this.wizardTimer = setTimeout(() => {
				this.wizardTimer = null;
				if (!this.disposed) this.runFirstRunWizardIfNeeded();
			}, WIZARD_DELAY_MS);
		});
	}
	registerCoreViews(deps) {
		for (const unsubscribe of this.coreTabs.splice(0)) unsubscribe();
		const env = {
			...deps,
			shell: this
		};
		for (const tab of [
			overviewTab(env),
			inboxTab(env),
			healthTab(env),
			tasksTab(env),
			journalTab(env),
			settingsTab(env)
		]) this.coreTabs.push(this.addTab(tab));
		this.coreTabs.push(deps.inbox.onChange(() => this.updateBadges()));
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.wizardTimer !== null) clearTimeout(this.wizardTimer);
		this.wizardTimer = null;
		for (const unsubscribe of [...this.coreTabs.splice(0), ...this.unsubscribers.splice(0)]) try {
			unsubscribe();
		} catch (error) {
			this.log.warn("ui dispose", error);
		}
		this.wizard.dispose();
		this.pult.dispose();
		this.entries.dispose();
		this.badges.dispose();
		this.slash.dispose();
		for (const node of this.styles.values()) node.remove();
		this.styles.clear();
		this.checks.clear();
		this.noticeList.length = 0;
	}
	addTab(tab) {
		return this.pult.add(tab);
	}
	addHealthCheck(check) {
		this.checks.set(check.id, check);
		return () => {
			if (this.checks.get(check.id) === check) this.checks.delete(check.id);
		};
	}
	addWizardStep(step) {
		return this.wizard.add(step);
	}
	addSlashCommand(command) {
		if (this.disposed) return () => {};
		return this.slash.add(command);
	}
	openPult(tabId) {
		if (this.disposed) return;
		this.pult.open(tabId);
	}
	closePult() {
		this.pult.close();
	}
	refresh() {
		this.updateBadges();
		this.pult.rerender();
	}
	notice(text, options = {}) {
		const level = options.level ?? "info";
		const urgent = options.urgent === true;
		const entry = {
			id: this.nextNotice++,
			at: Date.now(),
			text,
			level,
			urgent,
			action: options.action,
			seen: !urgent
		};
		this.noticeList.push(entry);
		if (this.noticeList.length > MAX_NOTICES) this.noticeList.splice(0, this.noticeList.length - MAX_NOTICES);
		if (level === "error") this.log.warn("notice:", text);
		else this.log.info("notice:", text);
		if (urgent) this.toast(entry);
		this.updateBadges();
		if (this.pult.activeTab() === "overview") this.pult.rerender();
	}
	async confirm(title, body) {
		try {
			const c = this.host.ctx();
			const content = el("div", { class: "maestro-confirm" }, [el("h3", {
				class: "maestro-confirm-title",
				text: title
			}), typeof body === "string" ? el("div", {
				class: "maestro-confirm-body",
				text: body
			}) : body]);
			return await c.callGenericPopup(content, c.POPUP_TYPE.CONFIRM, "", {
				okButton: this.i18n.t("ui.confirm.yes"),
				cancelButton: this.i18n.t("ui.confirm.no"),
				leftAlign: true
			}) === c.POPUP_RESULT.AFFIRMATIVE;
		} catch (error) {
			this.log.error("confirm failed", error);
			return false;
		}
	}
	messageBadge(messageIndex, badge) {
		if (this.disposed) return () => {};
		return this.badges.add(messageIndex, badge);
	}
	style(id, css) {
		if (this.disposed) return () => {};
		let node = this.styles.get(id);
		if (!node || !node.isConnected) {
			node = el("style", { attrs: { "data-maestro-style": id } });
			document.head.appendChild(node);
			this.styles.set(id, node);
		}
		node.textContent = css;
		const owned = node;
		return () => {
			if (this.styles.get(id) !== owned) return;
			owned.remove();
			this.styles.delete(id);
		};
	}
	updateBadges() {
		this.pult.updateBadges();
		const urgent = this.noticeList.some((entry) => entry.urgent && !entry.seen);
		this.entries.setBadge(this.pult.totalBadge(), urgent);
	}
	notices() {
		return this.noticeList;
	}
	markNoticesSeen() {
		let changed = false;
		for (const entry of this.noticeList) if (!entry.seen) {
			entry.seen = true;
			changed = true;
		}
		if (changed) this.updateBadges();
	}
	clearNotices() {
		this.noticeList.length = 0;
		this.updateBadges();
	}
	healthChecks() {
		return [...this.checks.values()];
	}
	runWizard() {
		if (this.disposed) return;
		this.wizard.open();
	}
	runFirstRunWizardIfNeeded() {
		if (this.disposed) return false;
		if (this.wizardTimer !== null) clearTimeout(this.wizardTimer);
		this.wizardTimer = null;
		this.wizardChecked = true;
		return this.wizard.maybeRun();
	}
	scrollToMessage(index) {
		this.pult.close();
		const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
		if (node) {
			this.flash(node);
			return;
		}
		const c = this.host.ctx();
		if (typeof c.executeSlashCommandsWithOptions !== "function") return;
		c.executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true }).then(() => {
			const loaded = document.querySelector(`#chat .mes[mesid="${index}"]`);
			if (loaded) this.flash(loaded);
		}).catch((error) => this.log.warn("chat-jump failed", error));
	}
	relocalize() {
		this.entries.relocalize();
		this.pult.relocalize();
	}
	onRegistryChange(listener) {
		return onRegistryChange(listener);
	}
	listen(event, handler) {
		try {
			this.unsubscribers.push(this.host.events.on(event, handler));
		} catch (error) {
			this.log.debug(`ui: cannot listen to ${event}`, error);
		}
	}
	toast(entry) {
		const notifier = globalThis.toastr;
		if (!notifier) return;
		const title = this.i18n.t("ui.title");
		const action = entry.action;
		const text = action ? `${entry.text} ${this.i18n.t("ui.notice.tapTo", { label: action.label })}` : entry.text;
		const options = {
			timeOut: entry.level === "error" ? 15e3 : 8e3,
			extendedTimeOut: 5e3
		};
		if (action) options.onclick = () => {
			try {
				action.run();
			} catch (error) {
				this.log.error("notice action failed", error);
			}
		};
		else options.onclick = () => this.openPult("overview");
		notifier[TOAST[entry.level]](text, title, options);
	}
	flash(node) {
		node.scrollIntoView({
			behavior: prefersReducedMotion() ? "auto" : "smooth",
			block: "center"
		});
		node.classList.add("maestro-flash");
		setTimeout(() => node.classList.remove("maestro-flash"), 1600);
	}
};
function createUi(deps) {
	deps.i18n.register(UI_STRINGS);
	return new MaestroUi(deps);
}
//#endregion
//#region src/app/module-manager.ts
/**
* Starts and stops plan modules. Everything a module registers through `own()` is released on disable,
* so a disabled module leaves no trace (P11).
*/
var Modules = class {
	settings;
	log;
	entries = /* @__PURE__ */ new Map();
	apis = /* @__PURE__ */ new Map();
	app = null;
	constructor(settings, log) {
		this.settings = settings;
		this.log = log;
	}
	register(modules, registerStrings) {
		for (const module of modules) {
			if (this.entries.has(module.key)) throw new Error(`duplicate module key ${module.key}`);
			this.entries.set(module.key, {
				module,
				running: false,
				disposers: []
			});
			this.settings.registerModule(module.key, module.defaults, module.enabledByDefault);
			registerStrings(module);
		}
	}
	/** Starts every enabled module whose capabilities are present, in stage order. */
	async startAll(app) {
		this.app = app;
		const ordered = [...this.entries.values()].sort((a, b) => a.module.stage - b.module.stage);
		for (const entry of ordered) if (this.settings.isModuleEnabled(entry.module.key)) await this.start(entry);
	}
	async stopAll() {
		const ordered = [...this.entries.values()].sort((a, b) => b.module.stage - a.module.stage);
		for (const entry of ordered) await this.stop(entry);
	}
	list() {
		return [...this.entries.values()].map((entry) => ({
			module: entry.module,
			enabled: this.settings.isModuleEnabled(entry.module.key),
			running: entry.running,
			missing: this.missing(entry.module)
		}));
	}
	async enable(key) {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.settings.setModuleEnabled(key, true);
		await this.start(entry);
	}
	async disable(key) {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.settings.setModuleEnabled(key, false);
		await this.stop(entry);
	}
	api(key) {
		return this.apis.get(key);
	}
	expose(key, api) {
		this.apis.set(key, api);
	}
	missing(module) {
		if (!this.app) return [];
		return (module.requires ?? []).filter((id) => !this.app?.host.caps.has(id));
	}
	async start(entry) {
		const app = this.app;
		if (!app || entry.running) return;
		const missing = this.missing(entry.module);
		if (missing.length) {
			this.log.warn(`module ${entry.module.key} not started, missing: ${missing.join(", ")}`);
			return;
		}
		const log = this.log.scope(entry.module.id);
		try {
			await entry.module.init({
				app,
				settings: this.settings.module(entry.module.key),
				log,
				own: (dispose) => entry.disposers.push(dispose)
			});
			entry.running = true;
			log.debug("started");
		} catch (error) {
			log.error("init failed", error);
			await this.release(entry);
		}
	}
	async stop(entry) {
		if (!entry.running) return;
		try {
			await entry.module.dispose?.();
		} catch (error) {
			this.log.error(`dispose of ${entry.module.key} failed`, error);
		}
		await this.release(entry);
		this.apis.delete(entry.module.key);
		entry.running = false;
	}
	async release(entry) {
		for (const dispose of entry.disposers.splice(0).reverse()) try {
			await dispose();
		} catch (error) {
			this.log.error(`release in ${entry.module.key} failed`, error);
		}
	}
};
//#endregion
//#region src/app/registry.ts
var MODULES = [];
//#endregion
//#region src/app/app.ts
async function startMaestro() {
	const log = createLogger();
	const host = createHost(log.scope("host"));
	const settings = new Settings(() => host.ctx().extensionSettings, () => host.ctx().saveSettingsDebounced(), log.scope("settings"));
	ConsoleLogger.setLevel(settings.core().debug ? "debug" : "info");
	const i18n = createI18n(() => {
		const choice = settings.core().uiLanguage;
		if (choice === "ru" || choice === "en") return choice;
		return hostLocale(() => host.ctx().getCurrentLocale?.());
	});
	i18n.register(CORE_STRINGS);
	const bus = createBus(log.scope("bus"));
	const files = createFileStore(host, log.scope("files"));
	const chat = createChatStore(host, files, log.scope("chat"));
	const leader = createLeader(host, files, bus, log.scope("leader"));
	const cost = createCostMeter({
		host,
		settings,
		files,
		bus,
		log: log.scope("cost")
	});
	const llm = createLlmClient({
		host,
		settings,
		cost,
		log: log.scope("llm")
	});
	const journal = createJournal({
		host,
		chat,
		log: log.scope("journal")
	});
	const autonomy = createAutonomy({
		settings,
		journal,
		files,
		log: log.scope("autonomy")
	});
	const inbox = createInbox({
		chat,
		journal,
		autonomy,
		bus,
		log: log.scope("inbox")
	});
	const ephemeral = createEphemeral({
		host,
		log: log.scope("ephemeral")
	});
	const turn = new TurnPipeline(host, bus, ephemeral, log.scope("turn"));
	const tasks = createTaskQueue({
		host,
		chat,
		files,
		leader,
		bus,
		log: log.scope("tasks"),
		isIdle: () => turn.current() === null
	});
	const ui = createUi({
		host,
		i18n,
		settings,
		log: log.scope("ui")
	});
	autonomy.bind({
		inbox,
		ui,
		i18n
	});
	const adapters = createAdapters(host, log.scope("adapters"));
	const modules = new Modules(settings, log.scope("modules"));
	const app = {
		host,
		turn,
		log,
		i18n,
		settings,
		files,
		chat,
		leader,
		tasks,
		llm,
		cost,
		journal,
		autonomy,
		inbox,
		ephemeral,
		bus,
		ui,
		adapters,
		modules
	};
	modules.register(MODULES, (module) => {
		if (module.i18n) i18n.register(module.i18n);
	});
	host.install();
	await Promise.all(Object.values(adapters).map((adapter) => adapter.ready().catch((error) => log.warn(`adapter ${adapter.id} not ready`, error))));
	await host.caps.refresh();
	turn.install();
	leader.start();
	tasks.start();
	cost.install();
	ui.mount();
	ui.registerCoreViews({
		inbox,
		journal,
		autonomy,
		cost,
		modules,
		settings,
		caps: host.caps,
		tasks,
		i18n
	});
	await modules.startAll(app);
	ui.runFirstRunWizardIfNeeded();
	const appReady = host.events.name("APP_READY");
	const offAppReady = appReady ? host.events.on(appReady, () => {
		host.caps.refresh();
	}) : () => {};
	return {
		app,
		turn,
		settings,
		modules,
		async stop() {
			offAppReady();
			await modules.stopAll();
			ui.dispose();
			cost.dispose();
			tasks.stop();
			leader.stop();
			turn.dispose();
			await autonomy.flush();
			autonomy.dispose();
			inbox.dispose();
			chat.dispose();
			host.dispose();
		}
	};
}
//#endregion
//#region src/index.ts
var INTERCEPTOR = "MAESTRO_Intercept";
var runtime = null;
var starting = null;
function installInterceptor(rt) {
	const fn = async (chat, _contextSize, _abort, type) => {
		await rt.turn.intercept(chat, type);
	};
	globalThis[INTERCEPTOR] = fn;
}
function removeInterceptor() {
	delete globalThis[INTERCEPTOR];
}
/** hooks.activate */
async function onActivate() {
	if (runtime || starting) return;
	starting = startMaestro();
	try {
		runtime = await starting;
		installInterceptor(runtime);
		console.info("[Maestro] activated");
	} catch (error) {
		console.error("[Maestro] activation failed", error);
	} finally {
		starting = null;
	}
}
/** hooks.disable: quick cleanup within ST's 5 s window (plan §4.9). */
async function onDisable() {
	removeInterceptor();
	const current = runtime;
	runtime = null;
	await current?.stop();
}
/** hooks.enable */
async function onEnable() {}
/** hooks.install */
async function onInstall() {}
/** hooks.update */
async function onUpdate() {}
/** hooks.delete */
async function onDelete() {
	await onDisable();
}
/** hooks.clean: removes Maestro settings; Maestro files are removed by "Prepare to disable" after export. */
async function onClean() {
	const current = runtime;
	await onDisable();
	current?.settings.reset();
}
//#endregion
export { onActivate, onClean, onDelete, onDisable, onEnable, onInstall, onUpdate };

//# sourceMappingURL=index.js.map