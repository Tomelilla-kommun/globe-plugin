type WMSKey = string;

type WMSParams = Record<string, string>;

type Waiter = { resolve: (img: ImageBitmap) => void; reject: (err: any) => void };

type WMSRequest = {
  url: string;
  params?: WMSParams;
  resolve: (img: ImageBitmap) => void;
  reject: (err: any) => void;
  priority: number;
  key: WMSKey;
  waiters: Waiter[];
  computedUrl: string;
  createdAt: number;
  heapIndex: number;
};

type InflightEntry = {
  controller: AbortController;
  promises: Array<{ resolve: (b: ImageBitmap) => void; reject: (e: any) => void }>;
};

export default class WMSThrottler {
  private queue: WMSRequest[] = [];
  private inflight = new Map<WMSKey, InflightEntry>();
  private queuedRequests = new Map<WMSKey, WMSRequest>();
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
    const existing = this.queuedRequests.get(key);
    if (existing) {
      const previousPriority = existing.priority;
      existing.priority = Math.min(existing.priority, priority);
      return new Promise((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
        if (existing.heapIndex >= 0 && existing.priority !== previousPriority) {
          this.reheapify(existing.heapIndex);
        }
      });
    }

    return new Promise((resolve, reject) => {
      const req: WMSRequest = {
        url,
        params,
        resolve,
        reject,
        priority,
        key,
        waiters: [],
        computedUrl: this.buildFullUrl(url, params),
        createdAt: Date.now(),
        heapIndex: -1
      };
      this.pushRequest(req);
      this.processQueue();
    });
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    clearTimeout(this._resumeTimer);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.processQueue();
  }

  resumeAfter(ms: number) {
    clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => this.resume(), ms);
  }

  cancelAll() {
    const error = new Error("Cancelled");
    for (const [, entry] of this.inflight) {
      entry.controller.abort();
      entry.promises.forEach((p) => p.reject(error));
    }
    this.inflight.clear();

    this.queue.forEach((req) => {
      req.reject(error);
      req.waiters.forEach((w) => w.reject(error));
      req.heapIndex = -1;
    });
    this.queue = [];
    this.queuedRequests.clear();

    this.activeCount = 0;
  }

  private currentLimit(): number {
    return this.cameraMoving ? this.maxConcurrentMoving : this.maxConcurrentIdle;
  }

  private processQueue() {
    if (this.paused) return;

    while (this.activeCount < this.currentLimit()) {
      const req = this.popRequest();
      if (!req) break;
      if (this.inflight.has(req.key)) {
        continue;
      }

      const controller = new AbortController();
      const promises: Waiter[] = [{ resolve: req.resolve, reject: req.reject }, ...req.waiters];

      this.inflight.set(req.key, { controller, promises });
      this.activeCount++;
      this.fetchWMS(req, controller.signal)
        .then((bitmap) => {
          const entry = this.inflight.get(req.key);
            if (entry) {
                entry.promises.forEach(p => p.resolve(bitmap));
                this.inflight.delete(req.key);
            }
        })
        .catch((err) => {
            const entry = this.inflight.get(req.key);
            if (entry) {
                entry.promises.forEach(p => p.reject(err));
                this.inflight.delete(req.key);
            }
        })
        .finally(() => {
          this.activeCount--;
          this.processQueue();
        });
    }
  }

  private async fetchWMS(req: WMSRequest, signal: AbortSignal): Promise<ImageBitmap> {
    const maxRetries = 2;
    let attempt = 0;
    const backoffBase = 150;

    while (true) {
      try {
        const res = await fetch(req.computedUrl, {
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

  private buildFullUrl(url: string, params?: WMSParams): string {
    if (!params) {
      return url;
    }
    const paramString = new URLSearchParams(params).toString();
    return url + (url.includes("?") ? "&" : "?") + paramString;
  }

  private compare(a: WMSRequest, b: WMSRequest): number {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return b.createdAt - a.createdAt;
  }

  private pushRequest(req: WMSRequest) {
    req.heapIndex = this.queue.length;
    this.queue.push(req);
    this.queuedRequests.set(req.key, req);
    this.bubbleUp(req.heapIndex);
  }

  private popRequest(): WMSRequest | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }

    const top = this.queue[0];
    const last = this.queue.pop()!;
    if (this.queue.length > 0) {
      this.queue[0] = last;
      last.heapIndex = 0;
      this.bubbleDown(0);
    }
    this.queuedRequests.delete(top.key);
    top.heapIndex = -1;
    return top;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.queue[index], this.queue[parent]) >= 0) {
        break;
      }
      this.swap(index, parent);
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    const length = this.queue.length;
    while (true) {
      let left = (index << 1) + 1;
      let right = left + 1;
      let smallest = index;

      if (left < length && this.compare(this.queue[left], this.queue[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.queue[right], this.queue[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private reheapify(index: number) {
    this.bubbleUp(index);
    this.bubbleDown(index);
  }

  private swap(i: number, j: number) {
    const tmp = this.queue[i];
    this.queue[i] = this.queue[j];
    this.queue[j] = tmp;
    this.queue[i].heapIndex = i;
    this.queue[j].heapIndex = j;
  }
}