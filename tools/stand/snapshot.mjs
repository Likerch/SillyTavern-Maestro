#!/usr/bin/env node
// Prompt snapshots: compares requests recorded by the mock LLM with golden copies.
//
//   node tools/stand/snapshot.mjs list                         recorded requests
//   node tools/stand/snapshot.mjs <name> [--request last|<n>|<file>] [--update]
//   node tools/stand/snapshot.mjs --all <prefix> [--filter story] [--update]
//   node tools/stand/snapshot.mjs show <name>                  summary of a golden file
//
// Golden files: tools/fixtures/golden/<name>.json. `--update` writes them. Exit code 1 on a difference.
// Options: --dir <recorded requests dir> (default tools/stand/runtime/requests), --golden <dir>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProbes, compareSnapshots, normalizeRequest, summarize } from './snapshot-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RECORD_FILE = /^\d{8}-\d{6}-\d{3}-(\d{4,})\.json$/;

function parseArgs(argv) {
    const options = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            options._.push(arg);
            continue;
        }
        const [flag, inline] = arg.slice(2).split('=', 2);
        if (['request', 'dir', 'golden', 'all', 'filter'].includes(flag)) options[flag] = inline ?? argv[++i];
        else options[flag] = inline ?? true;
    }
    return options;
}

function recordedFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => RECORD_FILE.test(f))
        .sort();
}

function loadRecord(dir, selector = 'last') {
    const files = recordedFiles(dir);
    let file;
    if (selector === 'last') file = files.at(-1);
    else if (/^\d+$/.test(String(selector)))
        file = files.find((f) => Number(RECORD_FILE.exec(f)[1]) === Number(selector));
    else file = path.resolve(String(selector));
    if (!file) throw new Error(`no recorded request "${selector}" in ${dir}`);
    const full = path.isAbsolute(file) ? file : path.join(dir, file);
    return { file: path.basename(full), record: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

/** Lorebooks to recognise in prompts: the fixtures plus whatever the bench installed. */
function loadProbes() {
    const dirs = [
        path.join(REPO, 'tools', 'fixtures', 'worlds'),
        path.join(HERE, 'runtime', 'data', 'default-user', 'worlds'),
    ];
    const worlds = new Map();
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            try {
                worlds.set(path.basename(file, '.json'), JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
            } catch {
                // not a lorebook
            }
        }
    }
    return buildProbes([...worlds].map(([name, data]) => ({ name, data })));
}

function snapshotOf(name, file, record, probes) {
    const normalized = normalizeRequest(record.body ?? {});
    return {
        name,
        source: { file, n: record.n ?? null, scenario: record.scenario ?? null },
        request: { model: normalized.model, params: normalized.params },
        summary: summarize(normalized.messages, probes),
        params: normalized.params,
        messages: normalized.messages,
    };
}

function check(name, file, record, options, probes) {
    const goldenDir = path.resolve(options.golden ?? path.join(REPO, 'tools', 'fixtures', 'golden'));
    const goldenFile = path.join(goldenDir, `${name}.json`);
    const current = snapshotOf(name, file, record, probes);
    const label = `snapshot "${name}" (${file}, ${record.scenario ?? '?'})`;
    if (options.update) {
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(goldenFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
        console.log(`${label}: golden written -> ${path.relative(REPO, goldenFile)}`);
        return true;
    }
    if (!fs.existsSync(goldenFile)) {
        console.log(`${label}: NO GOLDEN (${path.relative(REPO, goldenFile)}); run with --update to create it`);
        return false;
    }
    const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
    const { equal, lines } = compareSnapshots(golden, current, probes);
    console.log(`${label}: ${equal ? 'same' : 'DIFFERENT'}`);
    for (const line of lines) console.log(`  ${line}`);
    return equal;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const dir = path.resolve(options.dir ?? path.join(HERE, 'runtime', 'requests'));
    const [command] = options._;

    if (command === 'list' || (!command && !options.all)) {
        const files = recordedFiles(dir);
        if (!files.length) console.log(`no recorded requests in ${dir}`);
        for (const file of files) {
            try {
                const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                const messages = record.body?.messages ?? [];
                console.log(
                    `${String(record.n).padStart(4)}  ${file}  ${String(record.scenario).padEnd(28)} ${messages.length} msgs`,
                );
            } catch {
                console.log(`      ${file}  (unreadable)`);
            }
        }
        if (!command)
            console.log(
                '\nUsage: snapshot.mjs <name> [--request last|<n>|<file>] [--update] | --all <prefix> | show <name>',
            );
        return;
    }

    const probes = loadProbes();
    if (command === 'show') {
        const name = options._[1];
        const goldenFile = path.join(
            path.resolve(options.golden ?? path.join(REPO, 'tools', 'fixtures', 'golden')),
            `${name}.json`,
        );
        const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
        const { lines } = compareSnapshots(golden, golden, probes);
        console.log(`golden "${name}" from ${golden.source?.file ?? '?'}`);
        for (const line of lines) console.log(`  ${line}`);
        return;
    }

    if (options.all) {
        const files = recordedFiles(dir);
        const all = files.map((file) => ({ file, record: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
        const selected = options.filter
            ? all.filter((x) => String(x.record.scenario ?? '').startsWith(options.filter))
            : all;
        if (!selected.length) {
            console.log(`no recorded requests${options.filter ? ` matching "${options.filter}"` : ''} in ${dir}`);
            process.exit(1);
        }
        let failed = 0;
        selected.forEach(({ file, record }, i) => {
            if (!check(`${options.all}-${String(i + 1).padStart(3, '0')}`, file, record, options, probes)) failed++;
        });
        if (!options.update) console.log(`\n${selected.length - failed}/${selected.length} snapshots match`);
        process.exit(failed && !options.update ? 1 : 0);
    }

    const { file, record } = loadRecord(dir, options.request ?? 'last');
    const equal = check(command, file, record, options, probes);
    process.exit(equal || options.update ? 0 : 1);
}

try {
    main();
} catch (error) {
    console.error(`snapshot: ${error.message}`);
    process.exit(2);
}
