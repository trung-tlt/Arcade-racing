/** iPhone and iPad Safari have no fullscreen for web pages; the only way to lose its bars is a Home Screen install. */
const KEY = 'voltline.installHint';
const MAX_SHOWS = 2;
const SHOW_SEC = 14;

export interface HintEnv {
  userAgent: string;
  /** Mac-style platform string (iPadOS 13+ reports "MacIntel"). */
  platform: string;
  maxTouchPoints: number;
  /** Already launched from the Home Screen (navigator.standalone, or display-mode standalone / fullscreen). */
  standalone: boolean;
  /** How many times the hint has been shown, and whether the player closed it for good. */
  shown: number;
  dismissed: boolean;
}

/** True on iOS / iPadOS Safari, in a tab (not installed), and the player has not waved the hint away. */
export function shouldShowInstallHint(e: HintEnv): boolean {
  const ios = /iPhone|iPad|iPod/.test(e.userAgent) || (e.platform === 'MacIntel' && e.maxTouchPoints > 1);
  if (!ios || e.standalone || e.dismissed || e.shown >= MAX_SHOWS) return false;
  // Only Safari can install: Chrome / Firefox / Edge on iOS (CriOS, FxiOS, EdgiOS) have their own menus.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(e.userAgent);
}

function readEnv(): HintEnv {
  let shown = 0;
  let dismissed = false;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { shown?: number; dismissed?: boolean };
    shown = raw.shown ?? 0;
    dismissed = raw.dismissed === true;
  } catch {
    /* private mode: no memory, the hint may repeat */
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      !!window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches,
    shown,
    dismissed,
  };
}

function remember(patch: { shown?: number; dismissed?: boolean }): void {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as object;
    localStorage.setItem(KEY, JSON.stringify({ ...raw, ...patch }));
  } catch {
    /* ignore */
  }
}

/** A dismissible tip at the bottom of the screen: Share, then Add to Home Screen. Shown at most twice. */
export function installHint(root: HTMLElement): void {
  const env = readEnv();
  if (!shouldShowInstallHint(env)) return;
  remember({ shown: env.shown + 1 });
  const el = document.createElement('div');
  el.className = 'install-hint';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>For full screen, tap <b>Share</b> then <b>Add to Home Screen</b>, and open VOLTLINE from its icon.</span><button type="button" class="ok">Got it</button><button type="button" class="never" aria-label="Don't show again">Don't show again</button>`;
  const close = (): void => {
    window.clearTimeout(timer);
    el.remove();
  };
  el.querySelector('.ok')?.addEventListener('click', close);
  el.querySelector('.never')?.addEventListener('click', () => {
    remember({ dismissed: true });
    close();
  });
  const timer = window.setTimeout(close, SHOW_SEC * 1000);
  root.appendChild(el);
}
