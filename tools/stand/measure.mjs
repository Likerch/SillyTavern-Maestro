#!/usr/bin/env node
// R3 measurements on the bench (dev-plan 4.6, plan §14): reads the requests the mock LLM recorded, Maestro's per-chat
// metrics documents and the installed BunnyMo files, and prints a docs-ready Markdown report (or JSON).
//
//   node tools/stand/measure.mjs [--dir <requests>] [--mock <url>] [--baseline <requests dir>]
//                                [--files <user files dir>] [--worlds <dir>] [--from N] [--to N] [--last N]
//                                [--window 100] [--out report.md] [--json] [--no-packs]
//
// Defaults: --dir tools/stand/runtime/requests, --files tools/stand/runtime/data/default-user/user/files.
// --mock http://127.0.0.1:5199 reads the requests from the running mock (GET /__requests) instead of the folder.
// --baseline <dir>: a second recorded run of the same turns with Maestro's lore rules off (criterion 3).
// Read-only: nothing is started, stopped or written except --out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    analyseRecord,
    buildLoreIndex,
    compareRuns,
    metricsFromDoc,
    packIntegrity,
    parseArgs,
    renderReport,
    selectRecords,
    summarizeRun,
} from './measure-lib.mjs';
import { BUNNYMO } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUNTIME = path.resolve(process.env.STAND_RUNTIME ?? path.join(HERE, 'runtime'));
const USER = path.join(RUNTIME, 'data', 'default-user');
const NEIGHBOURS_ROOT = path.resolve(process.env.STAND_NEIGHBOURS_ROOT ?? path.join(REPO, '..'));
const RECORD_FILE = /^\d{8}-\d{6}-\d{3}-(\d{4,})\.json$/;
const METRICS_FILE = /^maestro-chat-[A-Za-z0-9_]+-metrics\.json$/;

const HELP = `Usage: node tools/stand/measure.mjs [options]

  --dir <dir>         recorded requests (default tools/stand/runtime/requests)
  --mock <url>        read the requests from a running mock instead (e.g. http://127.0.0.1:5199)
  --baseline <dir>    recorded requests of the same turns with Maestro's lore rules off (criterion 3)
  --files <dir>       SillyTavern user files with maestro-chat-*-metrics.json
  --metrics <file>    one metrics document instead of every one in --files
  --worlds <dir>      extra lorebook folder for recognising entries in prompts
  --from N / --to N   request numbers to include; --last N: only the newest N
  --window N          turns in the cost window (default 100)
  --out <file>        write the Markdown there (stdout otherwise); --json prints JSON
  --no-packs          skip the BunnyMo file comparison`;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recordsFromDir(dir) {
    if (!fs.existsSync(dir)) throw new Error(`no recorded requests in ${dir}`);
    const records = [];
    for (const file of fs
        .readdirSync(dir)
        .filter((name) => RECORD_FILE.test(name))
        .sort()) {
        try {
            records.push(readJson(path.join(dir, file)));
        } catch {
            // a half-written file from a killed run
        }
    }
    return records;
}

async function recordsFromMock(url) {
    const base = url.replace(/\/+$/, '').replace(/\/v1$/, '');
    const list = await (await fetch(`${base}/__requests`)).json();
    const records = [];
    for (const item of list.requests ?? []) {
        const response = await fetch(`${base}/__requests/${encodeURIComponent(item.n)}`);
        if (response.ok) records.push(await response.json());
    }
    return records;
}

/** Lorebooks for prompt probes: fixtures, the bench's worlds and --worlds. */
function loadWorlds(extra) {
    const dirs = [path.join(REPO, 'tools', 'fixtures', 'worlds'), path.join(USER, 'worlds')];
    if (extra) dirs.push(path.resolve(extra));
    const worlds = new Map();
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
            try {
                worlds.set(path.basename(file, '.json'), readJson(path.join(dir, file)));
            } catch {
                // not a lorebook
            }
        }
    }
    return [...worlds].map(([name, data]) => ({ name, data }));
}

function metricsDocs(options) {
    if (options.metrics) {
        const file = path.resolve(options.metrics);
        return [{ file: path.basename(file), raw: readJson(file) }];
    }
    const dir = path.resolve(options.files ?? path.join(USER, 'user', 'files'));
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => METRICS_FILE.test(name))
        .map((name) => ({
            file: name,
            raw: readJson(path.join(dir, name)),
            mtime: fs.statSync(path.join(dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
}

function fileStat(file) {
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/** Installed BunnyMo files against the pinned export (or the repository working tree when no export exists). */
function packPairs() {
    const exportDir = path.join(RUNTIME, 'vendor', 'exports', `BunnyMo@${BUNNYMO.ref.slice(0, 10)}`);
    const sourceRoot = fs.existsSync(exportDir) ? exportDir : path.join(NEIGHBOURS_ROOT, BUNNYMO.repo);
    return BUNNYMO.books.map((book) => {
        const name = path.basename(book.path);
        return {
            name,
            installed: fileStat(path.join(USER, 'worlds', name)),
            source: fileStat(path.join(sourceRoot, ...book.path.split('/'))),
        };
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.h) {
        console.log(HELP);
        return;
    }
    const dir = path.resolve(options.dir ?? path.join(RUNTIME, 'requests'));
    const records = selectRecords(options.mock ? await recordsFromMock(String(options.mock)) : recordsFromDir(dir), {
        from: options.from,
        to: options.to,
        last: options.last,
    });
    const index = buildLoreIndex(loadWorlds(options.worlds));
    const rows = records.map((record) => analyseRecord(record, index));
    const run = summarizeRun(rows);
    let comparison = null;
    if (options.baseline) {
        const baseRows = recordsFromDir(path.resolve(String(options.baseline))).map((record) =>
            analyseRecord(record, index),
        );
        comparison = compareRuns(baseRows, rows);
    }
    const window = Number(options.window) || undefined;
    const metrics = metricsDocs(options).map(({ file, raw }) => ({
        file,
        summary: metricsFromDoc(raw, { windowTurns: window }),
    }));
    const packs = options['no-packs'] ? null : packIntegrity(packPairs());
    const report = {
        run,
        comparison,
        metrics,
        packs,
        meta: {
            dir: options.mock ? String(options.mock) : path.relative(REPO, dir).split(path.sep).join('/'),
            baselineDir: options.baseline ? String(options.baseline) : undefined,
            generatedAt: Date.now(),
        },
    };
    const output = options.json ? JSON.stringify(report, null, 2) : renderReport(report);
    if (options.out) {
        fs.writeFileSync(path.resolve(String(options.out)), output + '\n', 'utf8');
        console.log(`measure: written ${path.resolve(String(options.out))}`);
    } else {
        console.log(output);
    }
}

main().catch((error) => {
    console.error(`measure: ${error.message}`);
    process.exit(2);
});
