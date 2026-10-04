// Starts M22 the way the module manager does (init with own()), and stops it by running the owned disposers.
import type { RulesApi } from '../../src/features/rules/api';
import { rulesModule } from '../../src/features/rules';
import type { Unsubscribe } from '../../src/shared/contracts';
import type { RulesTestApp } from './rules-app';

export interface StartedRules {
    /** The module's facade implements every optional member of the contract. */
    api: Required<RulesApi>;
    stop(): Promise<void>;
}

export async function startRules(env: RulesTestApp): Promise<StartedRules> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await rulesModule.init({
        app: env.app,
        settings: env.settings.module('rules'),
        log: env.log,
        own: (dispose) => disposers.push(dispose),
    });
    const api = env.modules.api<RulesApi>('rules');
    if (!api) throw new Error('rules API not exposed');
    return {
        api: api as Required<RulesApi>,
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            env.modules.apis.delete('rules');
        },
    };
}
