#!/usr/bin/env node
// Maestro local test bench: SillyTavern 1.19 (from a local source tree, no Docker) + pinned neighbours +
// fixtures + the mock LLM. Everything it creates lives in tools/stand/runtime/ (gitignored).
//
//   node tools/stand/stand.mjs <command> [options]     (or: npm run stand -- <command>)
//
// Commands: setup | start | run | stop | restart | reset | status | logs — see `help` and README.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    copyTree,
    countFiles,
    ensureDir,
    exists,
    isLink,
    linkDir,
    readJson,
    removeTree,
    writeJson,
} from './lib/fsutil.mjs';
import { ensureClone, exportCommit, exportWorktree, isGitRepo, resolveCommit, worktreeStatus } from './lib/git.mjs';
import { EXTRA_FILES, manifestRoots, readManifest } from './lib/maestro.mjs';
import { encodeCardPng, encodePng } from './lib/png.mjs';
import { setYaml } from './lib/yaml.mjs';
import { BUNNYMO, CONNECTION, MAESTRO, NEIGHBOURS } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, '..');
const REPO = path.resolve(TOOLS, '..');
const env = process.env;

const RUNTIME = path.resolve(env.STAND_RUNTIME ?? path.join(HERE, 'runtime'));
const DATA = path.join(RUNTIME, 'data');
const USER = path.join(DATA, 'default-user');
const EXT_DIR = path.join(USER, 'extensions');
const CONFIG_DIR = path.join(RUNTIME, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const VENDOR = path.join(RUNTIME, 'vendor');
const REQUESTS = path.join(RUNTIME, 'requests');
const LOGS = path.join(RUNTIME, 'logs');
const PIDS = path.join(RUNTIME, 'pids.json');
const STATE = path.join(RUNTIME, 'stand.json');
const FIXTURES = path.join(TOOLS, 'fixtures');

const NEIGHBOURS_ROOT = path.resolve(env.STAND_NEIGHBOURS_ROOT ?? path.join(REPO, '..'));
const ST_DIR = path.resolve(env.STAND_ST_DIR ?? path.join(NEIGHBOURS_ROOT, 'st-local-docker', 'src-1.19.0'));
const ST_PORT = Number(env.STAND_ST_PORT ?? CONNECTION.stPort);
const MOCK_PORT = Number(env.STAND_MOCK_PORT ?? CONNECTION.mockPort);
const ST_URL = `http://127.0.0.1:${ST_PORT}/`;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

const HELP = `Maestro test bench

Usage: node tools/stand/stand.mjs <command> [options]

  setup     create tools/stand/runtime/ (config, data, neighbours, fixtures, Maestro link)
              --force            also rewrite default-user/settings.json (otherwise kept if present)
              --maestro=copy     copy manifest.json + dist/ instead of linking dist/ (default: link)
              --no-neighbours    skip the neighbour extensions
              --preset <file>    apply a Chat Completion preset (e.g. Marinara) and select it
  start     start the mock LLM (:${MOCK_PORT}) and SillyTavern (:${ST_PORT}) in the background
  run       the same in the foreground with merged logs (Ctrl+C stops both)
  stop      stop both
  restart   stop + start
  reset     stop and wipe runtime data, config, requests and logs (the vendor cache stays)
  status    what is installed and running
  logs [st|mock] [-n 80]   tail of the logs

Environment: STAND_ST_DIR (SillyTavern 1.19 source tree), STAND_NEIGHBOURS_ROOT, STAND_ST_PORT,
STAND_MOCK_PORT, STAND_REF_<ID>=<commit|HEAD|WORKTREE> (ids: ${NEIGHBOURS.map((n) => n.id).join(', ')}).
Paths: ST ${ST_DIR}
       runtime ${RUNTIME}`;

/* ------------------------------------------------------------------ output */

const say = (line = '') => console.log(line);
const ok = (line) => console.log(`  ok    ${line}`);
const warn = (line) => console.log(`  warn  ${line}`);
const fail = (line) => console.log(`  FAIL  ${line}`);

function die(message) {
    console.error(`stand: ${message}`);
    process.exit(1);
}

/* ------------------------------------------------------------------ helpers */

function parseOptions(argv) {
    const options = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) {
            options._.push(arg);
            continue;
        }
        const [flag, inline] = arg.replace(/^--?/, '').split('=', 2);
        if (flag.startsWith('no-')) options[flag.slice(3)] = false;
        else if (inline !== undefined) options[flag] = inline;
        else if (['preset', 'maestro', 'n'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('-'))
            options[flag] = argv[++i];
        else options[flag] = true;
    }
    return options;
}

function httpGet(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, body: '' });
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function killTree(pid) {
    if (!isAlive(pid)) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // already gone
            }
        }
    }
}

function tail(file, lines = 40) {
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
}

/* ------------------------------------------------------------------ setup pieces */

function checkSillyTavern() {
    const required = [
        'server.js',
        'default/config.yaml',
        'default/content/settings.json',
        'node_modules',
        'package.json',
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(ST_DIR, file)));
    if (missing.length)
        die(`SillyTavern source tree not usable at ${ST_DIR} (missing: ${missing.join(', ')}). Set STAND_ST_DIR.`);
    const version = readJson(path.join(ST_DIR, 'package.json')).version;
    if (!String(version).startsWith('1.19')) warn(`SillyTavern ${version} found, the bench targets 1.19.x`);
    return version;
}

function writeConfig() {
    let text = fs.readFileSync(path.join(ST_DIR, 'default', 'config.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const edits = [
        [['dataRoot'], DATA],
        [['listen'], false],
        [['port'], ST_PORT],
        [['browserLaunch', 'enabled'], false],
        [['whitelistMode'], true],
        [['basicAuthMode'], false],
        [['enableUserAccounts'], false],
        [['logging', 'enableAccessLog'], false],
        [['backups', 'chat', 'enabled'], false],
        [['extensions', 'enabled'], true],
        [['extensions', 'autoUpdate'], false],
        [['extensions', 'models', 'autoDownload'], false],
        [['enableDownloadableTokenizers'], false],
        [['enableServerPlugins'], false],
    ];
    for (const [keys, value] of edits) {
        const next = setYaml(text, keys, value);
        if (next === null) warn(`config.yaml: key ${keys.join('.')} not found (different ST version?)`);
        else text = next;
    }
    // The whitelist already holds ::1 and 127.0.0.1 in the default config.
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(CONFIG_FILE, text, 'utf8');
    ok(
        `config.yaml -> ${path.relative(REPO, CONFIG_FILE)} (port ${ST_PORT}, listen false, whitelist on, basic auth off)`,
    );
}

/** Keys of a preset that describe the connection, not the prompt: never taken from a preset. */
const CONNECTION_KEYS =
    /^(chat_completion_source|custom_.*|.*_model|reverse_proxy|proxy_password|bind_preset_to_connection|api_url_scale|.*_region|.*_url)$/;

function buildSettings(manifest, presetName, preset) {
    const settings = readJson(path.join(ST_DIR, 'default', 'content', 'settings.json'));
    const character = manifest.characters[0];
    const globals = [
        ...manifest.worlds.filter((w) => w.global).map((w) => w.name),
        ...BUNNYMO.books.filter((b) => b.global).map((b) => path.basename(b.path, '.json')),
    ];
    const repos = manifest.worlds.filter((w) => w.ckRepo).map((w) => w.name);

    settings.firstRun = false;
    settings.username = manifest.user?.name ?? CONNECTION.userName;
    settings.main_api = 'openai';
    settings.active_character = character.avatar;
    settings.power_user = {
        ...settings.power_user,
        auto_load_chat: true,
        // Connect to the mock on page load, otherwise the first Send fails with "not connected".
        auto_connect: true,
        personas: { 'user-default.png': settings.username },
        default_persona: 'user-default.png',
        persona_descriptions: {
            'user-default.png': { description: 'Странствующий наёмник, немногословный и наблюдательный.', position: 0 },
        },
    };
    const oai = { ...settings.oai_settings };
    if (preset) {
        for (const [key, value] of Object.entries(preset)) if (!CONNECTION_KEYS.test(key)) oai[key] = value;
        oai.preset_settings_openai = presetName;
    }
    Object.assign(oai, {
        chat_completion_source: 'custom',
        custom_url: MOCK_URL,
        custom_model: CONNECTION.model,
        custom_include_body: '',
        custom_exclude_body: '',
        custom_include_headers: '',
        stream_openai: true,
        max_context_unlocked: true,
        openai_max_context: 65536,
        openai_max_tokens: preset?.openai_max_tokens ?? 1200,
    });
    settings.oai_settings = oai;
    settings.world_info_settings = {
        ...settings.world_info_settings,
        world_info: { ...(settings.world_info_settings?.world_info ?? {}), globalSelect: globals },
    };
    settings.extension_settings = {
        ...settings.extension_settings,
        // The archive must be a CarrotKernel "character repo" to act as one; displayMode none like the
        // production setup (CK's thinking-mode dump would otherwise land in every reply).
        CarrotKernel: { characterRepoBooks: repos, selectedLorebooks: repos, displayMode: 'none' },
        // DES merges a partial object over its defaults (enabled/autoUpdate are validated, the values below
        // are its defaults). whatsNewSeenVersion hides the first-run "What's new" overlay that covers the UI.
        [`third-party/${NEIGHBOURS.find((n) => n.id === 'des').folder}`]: {
            enabled: true,
            autoUpdate: false,
            whatsNewSeenVersion: NEIGHBOURS.find((n) => n.id === 'des').version,
        },
    };
    return settings;
}

function exportNeighbour(neighbour) {
    const override = env[`STAND_REF_${neighbour.id.toUpperCase()}`];
    const ref = override || neighbour.ref;
    const pinned = /^[0-9a-f]{40}$/.test(ref);
    const exportsDir = path.join(VENDOR, 'exports');
    // A pinned commit exported before needs no git at all (offline re-setup after `reset`).
    if (pinned) {
        const cached = path.join(exportsDir, `${neighbour.folder}@${ref.slice(0, 10)}`);
        if (fs.existsSync(path.join(cached, '.stand-export.json'))) return { dir: cached, commit: ref, cached: true };
    }
    let repoDir;
    if (neighbour.url) {
        repoDir = path.join(VENDOR, neighbour.cache);
        if (ref !== 'WORKTREE') ensureClone(neighbour.url, repoDir, ref === 'HEAD' ? 'HEAD' : ref);
    } else {
        repoDir = path.join(NEIGHBOURS_ROOT, neighbour.repo);
    }
    if (!isGitRepo(repoDir)) throw new Error(`not a git repository: ${repoDir}`);
    if (ref === 'WORKTREE') {
        const dir = path.join(exportsDir, `${neighbour.folder}@worktree`);
        exportWorktree(repoDir, dir);
        writeJson(path.join(dir, '.stand-export.json'), { repo: repoDir, ref, at: new Date().toISOString() });
        return { dir, commit: 'WORKTREE', dirty: worktreeStatus(repoDir) };
    }
    const commit = resolveCommit(repoDir, ref);
    const dir = path.join(exportsDir, `${neighbour.folder}@${commit.slice(0, 10)}`);
    if (!fs.existsSync(path.join(dir, '.stand-export.json'))) {
        exportCommit(repoDir, commit, dir);
        writeJson(path.join(dir, '.stand-export.json'), { repo: repoDir, ref, commit, at: new Date().toISOString() });
    }
    return { dir, commit, dirty: ref === 'HEAD' ? worktreeStatus(repoDir) : '' };
}

function installNeighbours() {
    const installed = [];
    for (const neighbour of NEIGHBOURS) {
        try {
            const source = exportNeighbour(neighbour);
            const missing = (neighbour.requires ?? []).filter((file) => !fs.existsSync(path.join(source.dir, file)));
            if (missing.length) throw new Error(`export lacks ${missing.join(', ')}`);
            const manifest = readJson(path.join(source.dir, 'manifest.json'), {});
            const dest = path.join(EXT_DIR, neighbour.folder);
            removeTree(dest);
            copyTree(source.dir, dest);
            const version = manifest.version ?? '?';
            const short = source.commit === 'WORKTREE' ? 'worktree' : source.commit.slice(0, 7);
            if (neighbour.version && version !== neighbour.version) {
                warn(`${neighbour.folder}: manifest says ${version}, pinned ${neighbour.version}`);
            }
            if (source.dirty) warn(`${neighbour.folder}: working tree has uncommitted changes (installed ${short})`);
            ok(`${neighbour.folder} ${version} @${short}${source.cached ? ' (cache)' : ''}`);
            installed.push({ id: neighbour.id, folder: neighbour.folder, version, commit: source.commit });
        } catch (error) {
            fail(`${neighbour.folder}: ${error.message}`);
            installed.push({ id: neighbour.id, folder: neighbour.folder, error: error.message });
        }
    }
    return installed;
}

function installBunnyMo() {
    const wanted = new Set(BUNNYMO.books.map((b) => b.path));
    const dir = path.join(VENDOR, 'exports', `BunnyMo@${BUNNYMO.ref.slice(0, 10)}`);
    try {
        if (!fs.existsSync(path.join(dir, '.stand-export.json'))) {
            const repo = path.join(NEIGHBOURS_ROOT, BUNNYMO.repo);
            const commit = resolveCommit(repo, BUNNYMO.ref);
            exportCommit(repo, commit, dir, (file) => wanted.has(file));
            writeJson(path.join(dir, '.stand-export.json'), { repo, commit, at: new Date().toISOString() });
        }
        const worlds = ensureDir(path.join(USER, 'worlds'));
        let count = 0;
        for (const book of BUNNYMO.books) {
            const from = path.join(dir, ...book.path.split('/'));
            if (!fs.existsSync(from)) {
                warn(`BunnyMo: ${book.path} missing in ${BUNNYMO.ref.slice(0, 7)}`);
                continue;
            }
            fs.copyFileSync(from, path.join(worlds, path.basename(book.path)));
            count++;
        }
        ok(
            `BunnyMo ${BUNNYMO.version} @${BUNNYMO.ref.slice(0, 7)}: ${count} lorebooks (${BUNNYMO.books.filter((b) => b.global).length} global)`,
        );
        return { version: BUNNYMO.version, commit: BUNNYMO.ref, books: count };
    } catch (error) {
        fail(`BunnyMo: ${error.message}`);
        return { error: error.message };
    }
}

function loadFixtureManifest() {
    const file = path.join(FIXTURES, 'fixtures.json');
    if (!fs.existsSync(file)) {
        say('  ...   fixtures.json missing, generating fixtures');
        const result = spawnSync(process.execPath, [path.join(FIXTURES, 'make-fixtures.mjs')], { stdio: 'inherit' });
        if (result.status !== 0) die('fixture generation failed');
    }
    return readJson(file);
}

function installFixtures(manifest) {
    const worlds = ensureDir(path.join(USER, 'worlds'));
    for (const world of manifest.worlds) {
        fs.copyFileSync(path.join(FIXTURES, world.file), path.join(worlds, `${world.name}.json`));
    }
    for (const character of manifest.characters) {
        const card = readJson(path.join(FIXTURES, character.card));
        const avatar = path.join(ensureDir(path.join(USER, 'characters')), character.avatar);
        fs.writeFileSync(avatar, encodeCardPng(card, character.colors ?? {}));
        const chatDir = ensureDir(path.join(USER, 'chats', path.basename(character.avatar, '.png')));
        for (const chat of character.chats) {
            fs.copyFileSync(path.join(FIXTURES, chat.file), path.join(chatDir, `${chat.name}.jsonl`));
        }
    }
    for (const image of manifest.images ?? []) {
        const file = path.join(USER, ...image.path.split('/'));
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, encodePng(image));
    }
    const chats = manifest.characters.flatMap((c) => c.chats.map((chat) => `${chat.name} (${chat.messages} msgs)`));
    ok(
        `fixtures: ${manifest.worlds.length} lorebooks, ${manifest.characters.length} card, chats ${chats.join(', ')}, ${manifest.images?.length ?? 0} images`,
    );
}

/**
 * Installs Maestro from the repository root. Link mode: a real folder with a copy of manifest.json and
 * junctions to dist/ (and any other folder the manifest points to), so `npm run build` / `npm run dev`
 * output is live after a page reload. Copy mode: what tools/deploy-local.mjs does.
 */
function installMaestro(mode = 'link') {
    const dest = path.join(EXT_DIR, MAESTRO.folder);
    const hasDist = fs.existsSync(path.join(REPO, 'dist', 'index.js'));
    removeTree(dest);
    if (mode === 'copy') {
        if (!hasDist) {
            fail('Maestro: dist/index.js is missing — run `npm run build`, then `npm run deploy:local`');
            return { mode, hasDist };
        }
        const result = spawnSync(process.execPath, [path.join(TOOLS, 'deploy-local.mjs'), '--target', dest], {
            stdio: 'inherit',
        });
        if (result.status !== 0) fail('Maestro: deploy-local failed');
        return { mode, hasDist };
    }
    const manifest = readManifest(REPO);
    const roots = manifestRoots(manifest);
    ensureDir(dest);
    for (const file of [...roots.files, ...EXTRA_FILES]) {
        if (fs.existsSync(path.join(REPO, file))) fs.copyFileSync(path.join(REPO, file), path.join(dest, file));
    }
    for (const dir of roots.dirs) linkDir(path.join(REPO, dir), path.join(dest, dir));
    if (hasDist) ok(`Maestro ${manifest.version}: linked (${roots.dirs.map((d) => `${d}/`).join(', ')} -> repository)`);
    else
        warn(
            `Maestro ${manifest.version}: linked, but dist/index.js is missing — run \`npm run build\` (or \`npm run dev\`)`,
        );
    return { mode, hasDist };
}

/** Link mode keeps a copy of manifest.json: refresh it so manifest edits apply on the next start. */
function refreshMaestroManifest() {
    const dest = path.join(EXT_DIR, MAESTRO.folder);
    if (isLink(path.join(dest, 'dist')) && fs.existsSync(path.join(REPO, 'manifest.json'))) {
        fs.copyFileSync(path.join(REPO, 'manifest.json'), path.join(dest, 'manifest.json'));
    }
}

/* ------------------------------------------------------------------ commands */

async function setup(options) {
    say('Setting up the Maestro bench');
    const stVersion = checkSillyTavern();
    ok(`SillyTavern ${stVersion} at ${ST_DIR}`);
    if (await isRunning('st')) die('SillyTavern of the bench is running — run `stop` first');
    for (const dir of [DATA, USER, EXT_DIR, CONFIG_DIR, VENDOR, REQUESTS, LOGS]) ensureDir(dir);
    writeConfig();

    const manifest = loadFixtureManifest();
    let presetName = null;
    let preset = null;
    if (typeof options.preset === 'string') {
        const file = path.resolve(options.preset);
        preset = readJson(file);
        presetName = path.basename(file, '.json');
        const presets = ensureDir(path.join(USER, 'OpenAI Settings'));
        fs.copyFileSync(file, path.join(presets, `${presetName}.json`));
        ok(`preset "${presetName}" installed and applied`);
    }
    const settingsFile = path.join(USER, 'settings.json');
    if (!fs.existsSync(settingsFile) || options.force || preset) {
        writeJson(settingsFile, buildSettings(manifest, presetName, preset));
        ok(
            `settings.json: Chat Completion "custom" -> ${MOCK_URL} (${CONNECTION.model}), streaming on, user ${manifest.user?.name}`,
        );
    } else {
        ok('settings.json kept (use --force to rewrite it)');
    }

    const neighbours = options.neighbours === false ? [] : installNeighbours();
    const bunnymo = options.neighbours === false ? null : installBunnyMo();
    installFixtures(manifest);
    const maestro = installMaestro(options.maestro === 'copy' ? 'copy' : 'link');

    writeJson(STATE, {
        setupAt: new Date().toISOString(),
        stDir: ST_DIR,
        stVersion,
        ports: { st: ST_PORT, mock: MOCK_PORT },
        neighbours,
        bunnymo,
        maestro,
        fixtures: manifest.characters.map((c) => c.avatar),
    });
    const failed = neighbours.filter((n) => n.error);
    say();
    say(failed.length ? `Setup finished with ${failed.length} problem(s).` : 'Setup finished.');
    say('Next: node tools/stand/stand.mjs start');
}

async function isRunning(name) {
    const pids = readJson(PIDS, {});
    return isAlive(pids[name]?.pid);
}

function spawnLogged(name, args, cwd, extraEnv = {}) {
    ensureDir(LOGS);
    const logFile = path.join(LOGS, `${name}.log`);
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ${name} start =====\n`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, args, {
        cwd,
        env: { ...env, ...extraEnv },
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
    });
    child.unref();
    fs.closeSync(out);
    return child.pid;
}

function mockArgs() {
    return [path.join(TOOLS, 'mock-llm', 'server.mjs'), '--port', String(MOCK_PORT), '--record-dir', REQUESTS];
}

function stArgs() {
    return [
        path.join(ST_DIR, 'server.js'),
        `--configPath=${CONFIG_FILE}`,
        `--dataRoot=${DATA}`,
        `--port=${ST_PORT}`,
        '--listen=false',
        '--whitelist=true',
        '--basicAuthMode=false',
        '--browserLaunchEnabled=false',
    ];
}

async function waitFor(url, pid, label, logFile, timeoutMs) {
    const started = Date.now();
    let dots = 0;
    while (Date.now() - started < timeoutMs) {
        const response = await httpGet(url, 2000);
        if (response.status >= 200 && response.status < 500) return response;
        if (pid && !isAlive(pid)) {
            fail(`${label} exited during startup. Last log lines:`);
            say(tail(logFile, 40));
            return null;
        }
        await sleep(1000);
        if (++dots % 15 === 0) say(`  ...   waiting for ${label} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    fail(`${label} did not answer ${url} within ${Math.round(timeoutMs / 1000)} s (log: ${logFile})`);
    return null;
}

function ensureSetUp() {
    if (!fs.existsSync(CONFIG_FILE) || !fs.existsSync(path.join(USER, 'settings.json'))) {
        die('the bench is not set up — run `node tools/stand/stand.mjs setup` first');
    }
}

async function start() {
    ensureSetUp();
    checkSillyTavern();
    refreshMaestroManifest();
    if (!fs.existsSync(path.join(REPO, 'dist', 'index.js'))) {
        warn('Maestro dist/index.js is missing: SillyTavern will start without Maestro — run `npm run build`');
    }
    const pids = readJson(PIDS, {});

    if (isAlive(pids.mock?.pid)) {
        ok(`mock LLM already running (pid ${pids.mock.pid})`);
    } else {
        if ((await httpGet(`${MOCK_URL}/models`, 1500)).status === 200)
            die(`port ${MOCK_PORT} is taken by another process`);
        const pid = spawnLogged('mock', mockArgs(), REPO);
        pids.mock = { pid, port: MOCK_PORT, startedAt: new Date().toISOString() };
        writeJson(PIDS, pids);
        if (!(await waitFor(`${MOCK_URL}/models`, pid, 'mock LLM', path.join(LOGS, 'mock.log'), 15000)))
            process.exit(1);
        ok(`mock LLM started (pid ${pid})`);
    }

    if (isAlive(pids.st?.pid)) {
        ok(`SillyTavern already running (pid ${pids.st.pid})`);
    } else {
        if ((await httpGet(ST_URL, 1500)).status !== 0) die(`port ${ST_PORT} is taken by another process`);
        const pid = spawnLogged('st', stArgs(), ST_DIR, { NODE_ENV: 'production', FORCE_COLOR: '0' });
        pids.st = { pid, port: ST_PORT, startedAt: new Date().toISOString() };
        writeJson(PIDS, pids);
        say('  ...   starting SillyTavern (the first start compiles frontend libraries, up to a few minutes)');
        const response = await waitFor(ST_URL, pid, 'SillyTavern', path.join(LOGS, 'st.log'), 300000);
        if (!response) process.exit(1);
        ok(`SillyTavern started (pid ${pid}, HTTP ${response.status})`);
    }
    say();
    say(`  SillyTavern  ${ST_URL}`);
    say(`  mock LLM     ${MOCK_URL}   (requests: http://127.0.0.1:${MOCK_PORT}/__requests)`);
    say(`  logs         ${path.relative(REPO, LOGS)}`);
}

async function run() {
    ensureSetUp();
    checkSillyTavern();
    refreshMaestroManifest();
    const children = [];
    const prefix = (name, stream) => {
        let buffer = '';
        stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) console.log(`[${name}] ${line}`);
        });
    };
    for (const [name, args, cwd, extra] of [
        ['mock', mockArgs(), REPO, {}],
        ['st', stArgs(), ST_DIR, { NODE_ENV: 'production', FORCE_COLOR: '0' }],
    ]) {
        const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, windowsHide: true });
        prefix(name, child.stdout);
        prefix(name, child.stderr);
        child.on('exit', (code) => {
            console.log(`[${name}] exited with ${code}`);
            for (const other of children) if (other !== child) killTree(other.pid);
            process.exitCode = code ?? 0;
        });
        children.push(child);
    }
    writeJson(PIDS, { mock: { pid: children[0].pid, port: MOCK_PORT }, st: { pid: children[1].pid, port: ST_PORT } });
    const stop = () => {
        for (const child of children) killTree(child.pid);
        setTimeout(() => process.exit(0), 500);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    say(`run: SillyTavern ${ST_URL}, mock ${MOCK_URL} — Ctrl+C stops both`);
}

async function stop() {
    const pids = readJson(PIDS, {});
    for (const name of ['st', 'mock']) {
        const pid = pids[name]?.pid;
        if (isAlive(pid)) {
            killTree(pid);
            for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(250);
            if (isAlive(pid)) fail(`${name}: pid ${pid} is still alive`);
            else ok(`${name} stopped (pid ${pid})`);
        } else {
            ok(`${name} not running`);
        }
    }
    removeTree(PIDS);
    const stPort = (await httpGet(ST_URL, 1000)).status;
    const mockPort = (await httpGet(`${MOCK_URL}/models`, 1000)).status;
    if (stPort) warn(`something still answers on ${ST_URL} (not started by the bench?)`);
    if (mockPort) warn(`something still answers on ${MOCK_URL} (not started by the bench?)`);
}

async function reset() {
    await stop();
    for (const target of [DATA, CONFIG_DIR, REQUESTS, LOGS, STATE, PIDS]) removeTree(target);
    ok(`runtime wiped (kept ${path.relative(REPO, VENDOR)})`);
    say('Next: node tools/stand/stand.mjs setup');
}

async function status() {
    say('Maestro bench status');
    const state = readJson(STATE, null);
    say(`  SillyTavern source  ${ST_DIR}${fs.existsSync(path.join(ST_DIR, 'server.js')) ? '' : '  (MISSING)'}`);
    say(`  runtime             ${RUNTIME}${state ? `  (setup ${state.setupAt})` : '  (not set up)'}`);
    if (state) {
        for (const n of state.neighbours ?? []) {
            const installed = fs.existsSync(path.join(EXT_DIR, n.folder, 'manifest.json'));
            say(
                `    ${n.error ? 'FAIL' : installed ? 'ok  ' : 'gone'}  ${n.folder} ${n.version ?? ''} ${n.commit ? `@${String(n.commit).slice(0, 7)}` : (n.error ?? '')}`,
            );
        }
        if (state.bunnymo?.books) say(`    ok    BunnyMo ${state.bunnymo.version}: ${state.bunnymo.books} lorebooks`);
    }
    const maestroDir = path.join(EXT_DIR, MAESTRO.folder);
    const distLink = isLink(path.join(maestroDir, 'dist'));
    const built = fs.existsSync(path.join(REPO, 'dist', 'index.js'));
    say(
        `  Maestro             ${exists(maestroDir) ? (distLink ? 'linked' : 'copied') : 'not installed'}, ` +
            `dist ${built ? `built ${fs.statSync(path.join(REPO, 'dist', 'index.js')).mtime.toISOString()}` : 'MISSING (npm run build)'}`,
    );
    const pids = readJson(PIDS, {});
    const mock = await httpGet(`${MOCK_URL}/models`, 1500);
    const st = await httpGet(ST_URL, 3000);
    say(
        `  mock LLM            ${mock.status === 200 ? 'up' : 'down'} ${MOCK_URL}${pids.mock?.pid ? ` pid ${pids.mock.pid}${isAlive(pids.mock.pid) ? '' : ' (dead)'}` : ''}`,
    );
    say(
        `  SillyTavern         ${st.status ? `up (HTTP ${st.status})` : 'down'} ${ST_URL}${pids.st?.pid ? ` pid ${pids.st.pid}${isAlive(pids.st.pid) ? '' : ' (dead)'}` : ''}`,
    );
    const recorded = fs.existsSync(REQUESTS) ? fs.readdirSync(REQUESTS).filter((f) => f.endsWith('.json')).length : 0;
    say(`  recorded requests   ${recorded} in ${path.relative(REPO, REQUESTS)}`);
    if (fs.existsSync(VENDOR)) say(`  vendor cache        ${countFiles(VENDOR)} files`);
}

function logs(options) {
    const names = options._.length ? options._ : ['st', 'mock'];
    const lines = Number(options.n ?? 80) || 80;
    for (const name of names) {
        say(`===== ${name}.log (last ${lines} lines) =====`);
        say(tail(path.join(LOGS, `${name}.log`), lines) || '(empty)');
    }
}

async function main() {
    const [command = 'help', ...rest] = process.argv.slice(2);
    const options = parseOptions(rest);
    switch (command) {
        case 'setup':
            return setup(options);
        case 'start':
            return start();
        case 'run':
            return run();
        case 'stop':
            return stop();
        case 'restart':
            await stop();
            return start();
        case 'reset':
            return reset();
        case 'status':
            return status();
        case 'logs':
            return logs(options);
        case 'help':
        case '--help':
        case '-h':
            say(HELP);
            return undefined;
        default:
            say(HELP);
            die(`unknown command "${command}"`);
    }
    return undefined;
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
