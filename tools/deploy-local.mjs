#!/usr/bin/env node
// Copies the built extension into a local SillyTavern extensions folder.
//
//   node tools/deploy-local.mjs                      -> tools/stand/runtime/data/default-user/extensions/SillyTavern-Maestro
//   node tools/deploy-local.mjs --target <dir>       -> exactly <dir>
//   node tools/deploy-local.mjs --st <dir>           -> a SillyTavern checkout (public/scripts/extensions/third-party)
//                                                      or the Docker layout (<dir>/extensions)
//   env MAESTRO_DEPLOY_TARGET=<dir> works like --target.
//
// Copies manifest.json, dist/, every file the manifest references, README/LICENSE/CHANGELOG. Refuses to run
// without dist/index.js. A bench install in link mode (dist/ is a junction to this repository) is replaced
// by a plain copy; the link is removed, never followed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, ensureDir, removeTree } from './stand/lib/fsutil.mjs';
import { EXTRA_FILES, manifestFiles, manifestRoots, readManifest } from './stand/lib/maestro.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = 'SillyTavern-Maestro';
const DEFAULT_TARGET = path.join(REPO, 'tools', 'stand', 'runtime', 'data', 'default-user', 'extensions', FOLDER);

function argValue(args, name) {
    const index = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (index < 0) return null;
    const arg = args[index];
    return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (args[index + 1] ?? null);
}

function resolveTarget(args) {
    const target = argValue(args, '--target') ?? process.env.MAESTRO_DEPLOY_TARGET;
    if (target) return path.resolve(target);
    const st = argValue(args, '--st');
    if (st) {
        const stDir = path.resolve(st);
        const checkout = path.join(stDir, 'public', 'scripts', 'extensions');
        if (fs.existsSync(checkout)) return path.join(checkout, 'third-party', FOLDER);
        if (fs.existsSync(path.join(stDir, 'extensions'))) return path.join(stDir, 'extensions', FOLDER);
        throw new Error(`Not a SillyTavern folder: ${stDir}`);
    }
    return DEFAULT_TARGET;
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node tools/deploy-local.mjs [--target <dir> | --st <SillyTavern dir>]');
        return;
    }
    if (!fs.existsSync(path.join(REPO, 'dist', 'index.js'))) {
        console.error('deploy-local: dist/index.js is missing — run `npm run build` first');
        process.exit(1);
    }
    const manifest = readManifest(REPO);
    const missing = manifestFiles(manifest).filter((file) => !fs.existsSync(path.join(REPO, file)));
    if (missing.length) {
        console.error(`deploy-local: files referenced by manifest.json are missing: ${missing.join(', ')}`);
        process.exit(1);
    }
    const target = resolveTarget(args);
    if (path.resolve(target) === REPO || REPO.startsWith(path.resolve(target) + path.sep)) {
        console.error(`deploy-local: refusing to deploy into the repository itself (${target})`);
        process.exit(1);
    }
    removeTree(target);
    ensureDir(target);
    const roots = manifestRoots(manifest);
    for (const dir of roots.dirs) {
        if (fs.existsSync(path.join(REPO, dir))) copyTree(path.join(REPO, dir), path.join(target, dir));
    }
    for (const file of [...roots.files, ...EXTRA_FILES]) {
        if (fs.existsSync(path.join(REPO, file))) fs.copyFileSync(path.join(REPO, file), path.join(target, file));
    }
    console.log(`Maestro ${manifest.version} -> ${target} (reload the SillyTavern page)`);
}

try {
    main();
} catch (error) {
    console.error(`deploy-local: ${error.message}`);
    process.exit(1);
}
