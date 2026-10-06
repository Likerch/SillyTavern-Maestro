#!/usr/bin/env node
// Real DES tracker wordings for the wardrobe tests (plan-2 §4 п. 8): reads the chats of a local SillyTavern data folder
// (every *.jsonl under it: chats, group chats, backups), collects the per-character detail fields of DES's tracker
// (`extra.dooms_tracker_swipes[*].characterThoughts`), drops duplicates, replaces character names with placeholders
// («Персонаж 1», …, also inside the texts) and writes tests/fixtures-private/des-appearance.json. That folder is in
// .gitignore: the samples are the user's own chats and never go into the public repository.
//
// Usage: node tools/extract-des-samples.mjs [data folder]   (or MAESTRO_ST_DATA=…; default: ../st-local-docker/data
// next to the repository's parent folder). Output: [--out file].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function parseArgs(argv) {
    const args = {
        data: process.env.MAESTRO_ST_DATA || '',
        out: path.join(repo, 'tests/fixtures-private/des-appearance.json'),
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') args.out = path.resolve(argv[++i] ?? args.out);
        else if (!argv[i].startsWith('--')) args.data = argv[i];
    }
    if (!args.data) {
        // The default layout of the author's workspace: <workspace>/st-local-docker/data.
        const candidates = [
            path.resolve(repo, '..', 'st-local-docker', 'data'),
            path.resolve(repo, '..', '..', 'st-local-docker', 'data'),
        ];
        args.data = candidates.find((item) => fs.existsSync(item)) ?? candidates[0];
    }
    return args;
}

function walk(dir, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
}

function parseLoose(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/** Characters of one DES swipe record (the list, {characters: [...]}, or the unified object). */
function charactersOf(record) {
    const thoughts = parseLoose(record?.characterThoughts);
    if (Array.isArray(thoughts)) return thoughts;
    if (thoughts && Array.isArray(thoughts.characters)) return thoughts.characters;
    return [];
}

function text(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object' && typeof value.value === 'string') return value.value.trim();
    return '';
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractSamples(files) {
    const names = new Map();
    const placeholder = (name) => {
        const key = name.trim().toLowerCase();
        if (!names.has(key)) names.set(key, { name: name.trim(), alias: `Персонаж ${names.size + 1}` });
        return names.get(key).alias;
    };
    const raw = [];
    const seen = new Set();
    for (const file of files) {
        let lines;
        try {
            lines = fs.readFileSync(file, 'utf8').split('\n');
        } catch {
            continue;
        }
        for (const line of lines) {
            if (!line.trim()) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            const swipes = message?.extra?.dooms_tracker_swipes;
            const records = Array.isArray(swipes)
                ? swipes
                : swipes && typeof swipes === 'object'
                  ? Object.values(swipes)
                  : [];
            for (const record of records) {
                for (const character of charactersOf(record)) {
                    const name = text(character?.name);
                    if (!name) continue;
                    const alias = placeholder(name);
                    const details =
                        character?.details && typeof character.details === 'object' ? character.details : {};
                    for (const [field, value] of Object.entries(details)) {
                        const body = text(value);
                        if (!body) continue;
                        const key = `${field}\u0000${body}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        raw.push({ field, text: body, character: alias });
                    }
                }
            }
        }
    }
    // Names inside the texts become their placeholders too (longest first: «Мира» before «Ми»).
    const known = [...names.values()].sort((a, b) => b.name.length - a.name.length);
    const anonymise = (value) =>
        known.reduce(
            (acc, item) => acc.replace(new RegExp(`(?<![\\p{L}])${escape(item.name)}(?![\\p{L}])`, 'giu'), item.alias),
            value,
        );
    return raw.map((item) => ({ ...item, text: anonymise(item.text) }));
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const files = walk(args.data);
    if (!files.length) {
        console.error(`No chats (*.jsonl) under ${args.data}`);
        process.exitCode = 1;
        return;
    }
    const samples = extractSamples(files);
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ samples }, null, 2) + '\n');
    const fields = samples.reduce((acc, item) => ({ ...acc, [item.field]: (acc[item.field] ?? 0) + 1 }), {});
    console.log(`${samples.length} distinct detail values from ${files.length} files → ${args.out}`);
    console.log(fields);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
