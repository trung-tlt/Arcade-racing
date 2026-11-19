/**
 * "Turn your phone sideways" (design artboard 25). Always in the DOM; touch.css shows it only on a touch device held
 * upright, so there is no JS orientation polling. The rotating-phone icon is inline SVG animated with CSS.
 */
export class RotateScreen {
  readonly el = document.createElement('div');

  constructor(root: HTMLElement) {
    this.el.id = 'rotate-screen';
    this.el.setAttribute('role', 'alert');
    this.el.innerHTML = `
      <svg class="rot-icon" viewBox="0 0 120 120" aria-hidden="true">
        <g class="rot-phone"><rect x="40" y="14" width="40" height="76" rx="8" fill="none" stroke="#2EC5FF" stroke-width="5"/><rect x="52" y="20" width="16" height="4" rx="2" fill="#2EC5FF"/><circle cx="60" cy="80" r="3.5" fill="#2EC5FF"/></g>
        <path class="rot-arrow" d="M20 104 A50 50 0 0 0 100 104" fill="none" stroke="#FF6A1A" stroke-width="5" stroke-linecap="round"/>
        <path d="M100 104 l-9 -2 M100 104 l-2 -9" stroke="#FF6A1A" stroke-width="5" stroke-linecap="round"/>
      </svg>
      <h2>Turn your phone sideways</h2>
      <p>VOLTLINE is played in landscape.</p>
      <img class="endorse" src="/assets/brand/endorsement_craftmann_app_on_dark.svg" alt="a CraftMann app" width="130" height="24" draggable="false" />`;
    root.appendChild(this.el);
  }

  dispose(): void {
    this.el.remove();
  }
}
