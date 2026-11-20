import { FPV } from '../core/Data';

/** A short notice in the upper middle of the screen: "CAMERA · COCKPIT", "HUD · MINIMAL". */
export class ViewToast {
  private readonly el = document.createElement('div');
  private timer = 0;

  constructor(root: HTMLElement) {
    this.el.className = 'view-toast';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    root.appendChild(this.el);
  }

  show(text: string): void {
    this.el.textContent = text;
    this.el.hidden = false;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (this.el.hidden = true), FPV.toastSec * 1000);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.el.remove();
  }
}
