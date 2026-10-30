/** Index of the neighbouring tab, wrapping around the ends. */
export function neighbour(index: number, count: number, step: 1 | -1): number {
  return (index + step + count) % count;
}
