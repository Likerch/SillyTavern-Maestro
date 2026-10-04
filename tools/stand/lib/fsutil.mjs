// File helpers for the bench. Windows-friendly: directory links are junctions, and removal never
// follows a link (a junction to the repo's dist/ must not take the repo with it).
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** True for symlinks and Windows junctions (lstat reports both as links). */
export function isLink(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

export function exists(target) {
    try {
        fs.lstatSync(target);
        return true;
    } catch {
        return false;
    }
}

function unlinkLink(target) {
    try {
        fs.unlinkSync(target);
    } catch {
        fs.rmdirSync(target);
    }
}

/** Deletes a file or a directory tree. Links (junctions, symlinks) are removed, never entered. */
export function removeTree(target) {
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch {
        return;
    }
    if (stat.isSymbolicLink()) {
        unlinkLink(target);
        return;
    }
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
        fs.rmdirSync(target);
        return;
    }
    try {
        fs.unlinkSync(target);
    } catch (error) {
        if (error.code !== 'EPERM') throw error;
        fs.chmodSync(target, 0o666);
        fs.unlinkSync(target);
    }
}

/** Copies a directory tree (links are copied as their targets' content). */
export function copyTree(from, to) {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
        ensureDir(to);
        for (const entry of fs.readdirSync(from)) copyTree(path.join(from, entry), path.join(to, entry));
    } else {
        ensureDir(path.dirname(to));
        fs.copyFileSync(from, to);
    }
}

/** Creates a directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
export function linkDir(target, linkPath) {
    removeTree(linkPath);
    ensureDir(path.dirname(linkPath));
    fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function readJson(file, fallback = undefined) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (fallback !== undefined) return fallback;
        throw error;
    }
}

export function writeJson(file, value, indent = 4) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, indent) + '\n', 'utf8');
}

/** Number of files under a directory (links are not followed). */
export function countFiles(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
        else total++;
    }
    return total;
}
