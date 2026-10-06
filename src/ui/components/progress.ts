// A thin progress bar: determinate with done/total, otherwise an indeterminate sweep (reduced motion: static).
import { el } from './dom';

export function progressBar(done: number | undefined, total: number | undefined, label: string): HTMLElement {
    const determinate = typeof total === 'number' && total > 0 && typeof done === 'number';
    const percent = determinate ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    const bar = el('div', { class: 'maestro-progress-bar' });
    if (determinate) bar.style.width = `${percent}%`;
    return el(
        'div',
        {
            class: ['maestro-progress', determinate ? null : 'maestro-progress-indeterminate'],
            attrs: {
                role: 'progressbar',
                'aria-label': label,
                'aria-valuemin': determinate ? 0 : undefined,
                'aria-valuemax': determinate ? total : undefined,
                'aria-valuenow': determinate ? done : undefined,
            },
        },
        [bar],
    );
}
