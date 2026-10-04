// Entry point loaded by SillyTavern as <script type="module">. Lifecycle hooks are the exported functions
// named in manifest.json `hooks`; ST calls them without arguments, each with a 5 s timeout.
// No side effects at module top level: ST imports this module even for the `enable` hook.
import './ui/style.css';
import { startMaestro } from './app/app';
import type { Runtime } from './app/app';

const INTERCEPTOR = 'MAESTRO_Intercept';

let runtime: Runtime | null = null;
let starting: Promise<Runtime> | null = null;

type InterceptorFn = (
    chat: STChatMessage[],
    contextSize: number,
    abort: (immediately: boolean) => void,
    type: string,
) => Promise<void>;

function installInterceptor(rt: Runtime): void {
    const fn: InterceptorFn = async (chat, _contextSize, _abort, type) => {
        await rt.turn.intercept(chat, type);
    };
    (globalThis as unknown as Record<string, unknown>)[INTERCEPTOR] = fn;
}

function removeInterceptor(): void {
    delete (globalThis as unknown as Record<string, unknown>)[INTERCEPTOR];
}

/** hooks.activate */
export async function onActivate(): Promise<void> {
    if (runtime || starting) return;
    starting = startMaestro();
    try {
        runtime = await starting;
        installInterceptor(runtime);
        console.info('[Maestro] activated');
    } catch (error) {
        console.error('[Maestro] activation failed', error);
    } finally {
        starting = null;
    }
}

/** hooks.disable: quick cleanup within ST's 5 s window (plan §4.9). */
export async function onDisable(): Promise<void> {
    removeInterceptor();
    const current = runtime;
    runtime = null;
    await current?.stop();
}

/** hooks.enable */
export async function onEnable(): Promise<void> {
    // ST reloads the page after enabling; activation happens then.
}

/** hooks.install */
export async function onInstall(): Promise<void> {
    // The first-run wizard opens on the next activation.
}

/** hooks.update */
export async function onUpdate(): Promise<void> {
    // Schema migrations run on activation.
}

/** hooks.delete */
export async function onDelete(): Promise<void> {
    await onDisable();
}

/** hooks.clean: removes Maestro settings; Maestro files are removed by "Prepare to disable" after export. */
export async function onClean(): Promise<void> {
    const current = runtime;
    await onDisable();
    current?.settings.reset();
}
