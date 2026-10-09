// Exports a pinned commit of a git repository into a plain folder without copying .git.
// Uses `git ls-tree` + one `git cat-file --batch` process: exact commit content, Unicode paths, no tar.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, removeTree } from './fsutil.mjs';

function git(args, options = {}) {
    const result = spawnSync('git', args, {
        maxBuffer: 1024 * 1024 * 1024,
        windowsHide: true,
        ...options,
    });
    if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
    if (result.status !== 0) {
        const stderr = String(result.stderr ?? '').trim();
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${stderr}`);
    }
    return result.stdout;
}

export function isGitRepo(dir) {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { windowsHide: true });
    return result.status === 0;
}

/** Full sha of a ref (commit, tag, HEAD) in a repository. */
export function resolveCommit(repoDir, ref) {
    return String(git(['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/** Short `git status` of the working tree (empty when clean). */
export function worktreeStatus(repoDir) {
    return String(git(['-C', repoDir, 'status', '--porcelain'])).trim();
}

/** Clones `url` into `dir` (if missing) and makes sure `commit` is present. */
export function ensureClone(url, dir, commit) {
    if (!isGitRepo(dir)) {
        removeTree(dir);
        ensureDir(path.dirname(dir));
        git(['clone', '--quiet', url, dir]);
    }
    const has = spawnSync('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`], { windowsHide: true });
    if (has.status !== 0) git(['-C', dir, 'fetch', '--quiet', 'origin']);
    return resolveCommit(dir, commit);
}

/**
 * Writes every blob of `commit` into `destDir` (replaced). `filter(path)` limits the files.
 * @returns {number} number of files written
 */
export function exportCommit(repoDir, commit, destDir, filter = () => true) {
    const listing = git(['-C', repoDir, 'ls-tree', '-r', '-z', '--full-tree', commit]);
    const entries = [];
    for (const record of listing.toString('utf8').split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        const [mode, type, sha] = record.slice(0, tab).split(' ');
        const file = record.slice(tab + 1);
        // Submodules (type commit) are skipped; symlinks (120000) become files holding the link text.
        if (type !== 'blob' || !filter(file)) continue;
        entries.push({ mode, sha, file });
    }
    removeTree(destDir);
    ensureDir(destDir);
    if (entries.length === 0) return 0;

    const output = git(['-C', repoDir, 'cat-file', '--batch'], { input: entries.map((e) => e.sha).join('\n') + '\n' });
    let offset = 0;
    for (const entry of entries) {
        const newline = output.indexOf(0x0a, offset);
        const header = output.toString('utf8', offset, newline).split(' ');
        if (header[0] !== entry.sha || header[1] !== 'blob') {
            throw new Error(`git cat-file: unexpected header "${header.join(' ')}" for ${entry.file}`);
        }
        const size = Number(header[2]);
        const start = newline + 1;
        const target = path.join(destDir, ...entry.file.split('/'));
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, output.subarray(start, start + size));
        offset = start + size + 1;
    }
    return entries.length;
}

/**
 * Copies the tracked files of the working tree (uncommitted edits included) into `destDir`; with `untracked` also the
 * new files git does not ignore (a fresh build of a neighbour that commits its dist/).
 */
export function exportWorktree(repoDir, destDir, filter = () => true, options = {}) {
    const args = ['-C', repoDir, 'ls-files', '-z', '--cached'];
    if (options.untracked) args.push('--others', '--exclude-standard');
    const listing = git(args);
    removeTree(destDir);
    ensureDir(destDir);
    let count = 0;
    for (const file of listing.toString('utf8').split('\0')) {
        if (!file || !filter(file)) continue;
        const from = path.join(repoDir, ...file.split('/'));
        if (!fs.existsSync(from)) continue;
        const target = path.join(destDir, ...file.split('/'));
        ensureDir(path.dirname(target));
        fs.copyFileSync(from, target);
        count++;
    }
    return count;
}
