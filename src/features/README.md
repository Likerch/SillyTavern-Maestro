# Features

One folder per plan module (`docs/plan.md` §6). Each exports a `MaestroModule` from `index.ts` and, when other
modules need it, a typed public API in `api.ts` (exposed with `app.modules.expose(key, api)`).
Modules are registered in `src/app/registry.ts`.
