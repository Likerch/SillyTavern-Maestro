// M43 «Сцена и вокруг»: the public face of the module (app.modules.api<SceneSplitApi>('sceneSplit'),
// MAESTRO_API.sceneSplit). Modules that list the characters of the scene (voice cards, the wardrobe line, mechanics,
// knowledge, the architect, MAESTRO_API.present()) leave out the ones `departed()` names: they add them to the names
// hidden from DES's «Present Characters».

export interface SceneSplitApi {
    /** The module runs and its switch is on (false in workshop chats: the module is paused there). */
    active(): boolean;
    /** The tag of the block: 'offscreen'. */
    readonly tag: string;
    /**
     * Characters of the DES tracker of the committed reply (the reply before the player's last message) whose leaving
     * the narration shows, as the tracker writes their names; [] while not active. `chat` defaults to the open chat; a
     * caller that takes the newest reply for the scene (it counts before it is answered) passes `{ latest: true }`.
     * Never throws.
     */
    departed(chat?: readonly unknown[], options?: { latest?: boolean }): string[];
}
