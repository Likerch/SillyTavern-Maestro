import { defineConfig } from 'vite';

// Library build: a single ESM bundle that SillyTavern loads as <script type="module">.
// The bundle never imports SillyTavern by path at build time; host modules are loaded at runtime
// through src/host/modules.ts with an opaque URL.
export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.ts',
            formats: ['es'],
            fileName: () => 'index.js',
            cssFileName: 'style',
        },
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        minify: false,
        target: 'es2022',
    },
});
