/**
 * The page's background landscape: soft glows, drifting cloud forms and layered
 * mountain silhouettes.
 *
 * Rendered ONCE by the Shell, not per page. It used to live inside Home, which
 * meant the dashboard sat in a lit landscape and every other page — Tutor,
 * Quizzes, Progress, a Space, a Project — sat on flat white. Walking from Home
 * into the Tutor looked like leaving the product.
 *
 * Rendering it in the Shell also makes it survive navigation: `main` is keyed on
 * the pathname so React remounts it and the page-enter animation replays, and
 * anything inside that key would be torn down and rebuilt on every click. The
 * background is not part of the page transition; it is the thing the pages move
 * across, so it is mounted outside the key and never re-renders.
 *
 * Everything here is at the background layer — `position: fixed`, `z-index: -1`,
 * `pointer-events: none` — so it can never sit over a card, take a click, or
 * change how anything above it is laid out. Purely decorative, hence
 * `aria-hidden`: it carries no information and a screen reader announcing
 * "sparkle" three times would be worse than silence.
 *
 * Built from clip-path and gradients rather than images: it scales to any
 * viewport, costs nothing to download, and tints from the same palette
 * variables as the rest of the UI, so a palette change carries here for free.
 */
export function PageDecor() {
  return (
    <div className="page-decor" aria-hidden="true">
      <span className="decor-glow decor-glow-1" />
      <span className="decor-glow decor-glow-2" />
      <span className="decor-glow decor-glow-3" />
      <span className="decor-cloud decor-cloud-1" />
      <span className="decor-cloud decor-cloud-2" />
      <span className="decor-curve" />
      <span className="decor-range decor-range-left">
        <i />
        <i />
        <i />
      </span>
      <span className="decor-range decor-range-right">
        <i />
        <i />
      </span>
      <span className="decor-sparkle decor-sparkle-1">✦</span>
      <span className="decor-sparkle decor-sparkle-2">✦</span>
      <span className="decor-sparkle decor-sparkle-3">✦</span>
    </div>
  );
}
