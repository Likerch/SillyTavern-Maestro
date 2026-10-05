// Pinned neighbours of the bench (dev-plan §2.1). Paths of local repositories are relative to the folder that
// holds the Maestro checkout (override with STAND_NEIGHBOURS_ROOT). A ref can be overridden per neighbour with
// STAND_REF_<ID>=<commit|HEAD|WORKTREE>, e.g. STAND_REF_NAI=WORKTREE to test uncommitted NAI Studio changes.

/**
 * @typedef {object} Neighbour
 * @property {string} id short id (also the STAND_REF_<ID> suffix)
 * @property {string} folder folder name under default-user/extensions (some neighbours depend on it)
 * @property {string | null} version expected manifest version (null: whatever the ref has)
 * @property {string} [repo] local repository, relative to the neighbours root
 * @property {string} [url] remote repository, cloned into runtime/vendor/<cache>
 * @property {string} [cache] clone folder under runtime/vendor
 * @property {string} ref commit sha, HEAD or WORKTREE
 * @property {string[]} [requires] files that must exist in the export
 * @property {string} note
 */

/** @type {Neighbour[]} */
export const NEIGHBOURS = [
    {
        id: 'qvink',
        folder: 'SillyTavern-MessageSummarize',
        version: '1.3.29',
        url: 'https://github.com/qvink/SillyTavern-MessageSummarize',
        cache: 'qvink',
        ref: '81b3326c1d81ea3411ab057280ecd5786fbe29a1',
        note: 'Qvink Memory, loading_order 1',
    },
    {
        id: 'des',
        folder: 'Dooms-Enhancement-Suite',
        version: '2.6.0',
        repo: 'SillyTavern-DES-RU/vendor/des',
        ref: '10ad241514d6d015b6c655d7542d561d47fd6cf0',
        note: "Doom's Enhancement Suite (DES-RU looks for this folder name first)",
    },
    {
        id: 'ck',
        folder: 'CarrotKernel',
        version: '1.0.0',
        repo: 'SillyTavern-DES-RU/vendor/CarrotKernel',
        ref: '145c273768bfaba437626c0178d8d8cad17db4df',
        note: 'CarrotKernel loads its files from third-party/CarrotKernel only',
    },
    {
        id: 'desru',
        folder: 'SillyTavern-Doom-Enhancement-Suite-RU',
        version: '0.8.0',
        repo: 'SillyTavern-DES-RU',
        ref: 'f32b711578ba87d3c02ccf831ffdc01b563ad669',
        note: 'DES-RU add-on',
    },
    {
        id: 'nai',
        folder: 'SillyTavern-NAI-Studio',
        version: '0.12.1',
        repo: 'SillyTavern-NAI-Studio',
        ref: 'c9fd6f5b214bb93c4bb2402e0d25b7a40b1678d3',
        requires: ['manifest.json', 'dist/index.js'],
        note: 'NAI Studio 0.12.1 (dist/ is committed); the server plugin is not installed',
    },
    {
        id: 'localizer',
        folder: 'SillyTavern-LorebookLocalizer',
        version: '0.2.0',
        repo: 'SillyTavern-LorebookLocalizer',
        ref: 'de3dec4d84bc1977d3351c2ff7c9f7a24d194470',
        note: 'Lorebook Localizer',
    },
];

/** BunnyMo V3.0 lorebooks, copied into default-user/worlds at setup (never stored in this repository). */
export const BUNNYMO = {
    repo: 'SillyTavern-DES-RU/vendor/BunnyMo',
    ref: '7a61c9f0959bf46a76a4e1339e80ce1a3d6a5aa9',
    version: 'V3.0',
    /** Paths inside the repository. `global: true` books are switched on globally in settings.json. */
    books: [
        { path: '✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V3.0.json', global: true },
        { path: 'BunnMo Packs/Species Pack (TCG Theme)/--BunnyCo-Pack v1.json', global: true },
        { path: 'BunnMo Packs/Dere Pack (Videogame Theme)/--BunnDere-Pack V2.json', global: true },
        {
            path: 'BunnMo Packs/Trait Packs (Infinite WIP + Grabbag Theme)/BunnTrAItsPack 1st Edition.json',
            global: true,
        },
        { path: 'BunnMo Packs/Dere Pack (Videogame Theme)/--BunDere-ExpanPack.json' },
        { path: 'BunnMo Packs/MBTI Pack (Pop Culture Theme + Thinking Guide)/--BunnMBTI-Pack V2.json' },
        { path: 'BunnMo Packs/Linguistics Pack (Coding Language Theme)/LinguisticsRepo.bny/---LINGUISTICS.bny.json' },
        { path: 'BunnMo Packs/CarrotCast (Streaming Service + Genre Theme)/--CarrotCast V1.0.json' },
        { path: 'BunnMo Packs/Tell Tail Lenses (Narrative Filter Pack)/--Tell Tail Lenses V1.json' },
        { path: 'BunnMo Packs/BSM-5 (Diagnostic Manual Theme)/--BSM-5 V1.json' },
        { path: 'BunnMo Packs/BSM-5 CoT Lenses (Perspective Shift Theme)/--BSM5 CoT Lenses V1.json' },
        { path: 'BunnMo Packs/BunnyRX (Prescription Pad Theme)/--BunnyRX V1.json' },
        { path: 'BunnMo Packs/HopSpital (Patient Chart Theme)/--HopSpital V1.json' },
    ],
};

/** Maestro itself: the repository root. */
export const MAESTRO = { folder: 'SillyTavern-Maestro' };

/** Connection of the bench SillyTavern to the mock model. */
export const CONNECTION = {
    stPort: 8123,
    mockPort: 5199,
    model: 'mock-deepseek-v4',
    userName: 'Кай',
};
