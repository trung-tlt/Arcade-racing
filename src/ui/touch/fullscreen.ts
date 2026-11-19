/** Hides the browser address bar on phones: the first tap asks for fullscreen and tries to lock landscape.
 * Android Chrome supports it; iPhone Safari has no element fullscreen, so it silently does nothing there.
 * If the player leaves fullscreen on purpose we stop asking. */
export function installAutoFullscreen(doc: Document = document): void {
  const root = doc.documentElement;
  if (!doc.fullscreenEnabled || typeof root.requestFullscreen !== 'function') return;
  if (window.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches) return;

  let entered = false;
  let declined = false;
  const lockLandscape = (): void => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    o.lock?.('landscape').catch(() => undefined);
  };
  const request = (): void => {
    if (declined || doc.fullscreenElement) return;
    root
      .requestFullscreen({ navigationUI: 'hide' })
      .then(lockLandscape)
      .catch(() => undefined);
  };
  doc.addEventListener('fullscreenchange', () => {
    if (doc.fullscreenElement) entered = true;
    else if (entered) declined = true;
  });
  // A user gesture is required; pointerup counts, pointerdown does not on every browser.
  doc.addEventListener('pointerup', request, { passive: true });
}
