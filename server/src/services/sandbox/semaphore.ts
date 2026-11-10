/** A tiny counting semaphore with a wait timeout. `acquire` resolves to a release function, or null on timeout. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(private readonly max: number) {}

  acquire(timeoutMs: number): Promise<(() => void) | null> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaser());
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // Hand the slot straight to the next waiter; otherwise free it.
      if (next) next.grant();
      else this.active--;
    };
  }

  get inUse(): number {
    return this.active;
  }
}
