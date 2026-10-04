// What of the Maestro repository SillyTavern needs: manifest.json plus every file the manifest points to.
import fs from 'node:fs';
import path from 'node:path';

/** Files referenced by an extension manifest (js, css, i18n), relative to the extension root. */
export function manifestFiles(manifest) {
    const files = new Set(['manifest.json']);
    for (const key of ['js', 'css']) {
        if (typeof manifest?.[key] === 'string' && manifest[key]) files.add(manifest[key].replace(/^\.?\//, ''));
    }
    for (const value of Object.values(manifest?.i18n ?? {})) {
        if (typeof value === 'string' && value) files.add(value.replace(/^\.?\//, ''));
    }
    return [...files];
}

/** Top-level folders those files live in (`dist`, `i18n`, ...), and top-level files. */
export function manifestRoots(manifest) {
    const dirs = new Set(['dist']);
    const files = new Set(['manifest.json']);
    for (const file of manifestFiles(manifest)) {
        const [first, ...rest] = file.split('/');
        if (rest.length > 0) dirs.add(first);
        else files.add(first);
    }
    return { dirs: [...dirs], files: [...files] };
}

export function readManifest(repo) {
    return JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8'));
}

/** Optional files shipped next to the build. */
export const EXTRA_FILES = ['README.md', 'README.ru.md', 'LICENSE', 'CHANGELOG.md'];
