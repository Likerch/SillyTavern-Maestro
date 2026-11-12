// Pictures NAI Studio saved into SillyTavern's /user/images (release 1.33: chapter covers, the blind comparison): the
// stored path ("user/images/Alice/Alice_cover.png") as a URL the page can show. Pure.

export function userImageUrl(path: string): string {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/${clean.split('/').map(encodeURIComponent).join('/')}`;
}
