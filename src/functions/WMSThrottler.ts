type WMSKey = string;

type WMSParams = Record<string, string>;

type WMSRequest = {
  url: string;
  params?: WMSParams;
  resolve: (img: ImageBitmap) => void;
  reject: (err: any) => void;
  priority: number;     // lower = higher priority
  key: WMSKey;
};

type InflightEntry = {
  controller: AbortController;
  promises: Array<{ resolve: (b: ImageBitmap) => void; reject: (e: any) => void }>;
};

export default class WMSThrottler {
  private queue: WMSRequest[] = [];
  private inflight = new Map<WMSKey, InflightEntry>();
  private activeCount = 0;
  private maxConcurrentIdle: number;
  private maxConcurrentMoving: number;
  private paused = false;
  private _resumeTimer: any = null;
  private cameraMoving = false;

  constructor(opts?: { maxConcurrentIdle?: number; maxConcurrentMoving?: number }) {
    this.maxConcurrentIdle = opts?.maxConcurrentIdle ?? 8;
    this.maxConcurrentMoving = opts?.maxConcurrentMoving ?? 3;
  }

  setCameraMoving(moving: boolean) {
    this.cameraMoving = moving;
    this.processQueue();
  }

  // Build a stable dedupe key from URL+params (order-independent)
  private buildKey(url: string, params?: WMSParams): WMSKey {
    if (!params) return url;
    const usp = new URLSearchParams(params);
    // sort params for stable key
    const sorted = [...usp.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return url + "?" + new URLSearchParams(sorted).toString();
  }

  // Callers can supply a viewport priority hint (e.g., from screen tile index)
  request(url: string, params?: WMSParams, priority = 100): Promise<ImageBitmap> {
    const key = this.buildKey(url, params);

    // If inflight, attach to existing request
    const inflight = this.inflight.get(key);
    if (inflight) {
      return new Promise((resolve, reject) => {
        inflight.promises.push({ resolve, reject });
      });
    }

    // If already queued, bump priority (coalesce)
    const existing = this.queue.find(q => q.key === key);
    if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return new Promise((resolve, reject) => {
            const arr = this.queuedWaiters.get(key) ?? [];
            arr.push({ resolve, reject });
            this.queuedWaiters.set(key, arr);
        });
    }

    return new Promise((resolve, reject) => {
      const req: WMSRequest = { url, params, resolve, reject, priority, key };
      this.queue.push(req);
      this.processQueue();
    });
  }

  pause() {
    this.paused = true;
    clearTimeout(this._resumeTimer);
  }

  resume() {
    this.paused = false;
    this.processQueue();
  }

  resumeAfter(ms: number) {
    clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => this.resume(), ms);
  }

    cancelAll() {
        for (const [key, entry] of this.inflight) {
            entry.controller.abort();
            entry.promises.forEach(p => p.reject(new Error("Cancelled")));
        }
        this.inflight.clear();

        // Reject queued (not yet started)
        this.queue.forEach(req => req.reject(new Error("Cancelled")));
        this.queue = [];

        // Reject queued waiters attached to queued keys
        for (const [key, waiters] of this.queuedWaiters) {
            waiters.forEach(w => w.reject(new Error("Cancelled")));
        }
        this.queuedWaiters.clear();

        this.activeCount = 0;
    }

  private currentLimit(): number {
    return this.cameraMoving ? this.maxConcurrentMoving : this.maxConcurrentIdle;
  }

  private queuedWaiters = new Map<WMSKey, Array<{ resolve: (b: ImageBitmap) => void; reject: (e: any) => void }>>();

  private processQueue() {
    if (this.paused) return;

    // Sort by priority; use LIFO while moving to favor latest tiles
    this.queue.sort((a, b) => a.priority - b.priority);
    if (this.cameraMoving) {
      // reverse so newest with same priority pop first
      this.queue.reverse();
    }

    while (this.activeCount < this.currentLimit() && this.queue.length > 0) {
        const req = this.queue.pop()!;
        if (this.inflight.has(req.key)) continue;

        const controller = new AbortController();
        const waiters = this.queuedWaiters.get(req.key);
        this.queuedWaiters.delete(req.key);

        const promises = [{ resolve: req.resolve, reject: req.reject }];
        if (waiters?.length) promises.push(...waiters);

      this.inflight.set(req.key, { controller, promises: [{ resolve: req.resolve, reject: req.reject }] });
      this.activeCount++;
      this.fetchWMS(req, controller.signal)
        .then((bitmap) => {
          const entry = this.inflight.get(req.key);
            if (entry) {
                entry.promises.forEach(p => p.resolve(bitmap));
                this.inflight.delete(req.key);
                const waiters = this.queuedWaiters.get(req.key);
                if (waiters) {
                    waiters.forEach(w => w.resolve(bitmap));
                    this.queuedWaiters.delete(req.key);
                }
            }
        })
        .catch((err) => {
            const entry = this.inflight.get(req.key);
            if (entry) {
                entry.promises.forEach(p => p.reject(err));
                this.inflight.delete(req.key);
            }
            const waiters = this.queuedWaiters.get(req.key);
            if (waiters) {
                waiters.forEach(w => w.reject(err));
                this.queuedWaiters.delete(req.key);
            }
        })
        .finally(() => {
          this.activeCount--;
          this.processQueue();
        });
    }
  }

  private async fetchWMS(req: WMSRequest, signal: AbortSignal): Promise<ImageBitmap> {
    // Build URL
    let url = req.url;
    if (req.params) {
      const params = new URLSearchParams(req.params);
      url += (url.includes("?") ? "&" : "?") + params.toString();
    }

    const maxRetries = 2;
    let attempt = 0;
    const backoffBase = 150;

    while (true) {
      try {
        const res = await fetch(url, {
          mode: "cors",
          signal,
          headers: { Accept: "image/png,image/jpeg;q=0.9,*/*;q=0.1" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const blob = await res.blob();
        // Decode off-main-thread where supported
        const bitmap = await createImageBitmap(blob);
        return bitmap;
      } catch (e) {
        if (signal.aborted) throw e;
        if (attempt >= maxRetries) throw e;
        attempt++;
        const jitter = Math.random() * 0.5 + 0.75; // 0.75–1.25
        await new Promise(r => setTimeout(r, backoffBase * attempt * jitter));
        continue;
      }
    }
  }
}