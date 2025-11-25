type WMSRequest = {
    url: string;
    params?: Record<string, string>;
    resolve: (img: HTMLImageElement) => void;
    reject: (err: any) => void;
};

export default class WMSThrottler {
    private queue: WMSRequest[] = [];
    private activeCount = 0;
    private maxConcurrent: number;
    private paused = false;
    private _resumeTimer: any = null;

    constructor(maxConcurrent: number = 5) {
        this.maxConcurrent = maxConcurrent;
    }

    request(url: string, params?: Record<string, string>): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            this.queue.push({ url, params, resolve, reject });
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

    // NEW: Debounced resume
    resumeAfter(ms: number) {
        clearTimeout(this._resumeTimer);
        this._resumeTimer = setTimeout(() => this.resume(), ms);
    }

    cancelAll() {
        this.queue.forEach(req => req.reject(new Error("Cancelled")));
        this.queue = [];
    }

    private processQueue() {
        if (this.paused) return;
        while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
            const req = this.queue.shift()!;
            this.activeCount++;
            this.fetchWMS(req)
                .finally(() => {
                    this.activeCount--;
                    this.processQueue();
                });
        }
    }

    private fetchWMS(req: WMSRequest): Promise<void> {
        return new Promise((resolve) => {
            const img = new Image();
            let url = req.url;
            if (req.params) {
                const params = new URLSearchParams(req.params);
                url += (url.includes("?") ? "&" : "?") + params.toString();
            }
            img.crossOrigin = "anonymous";
            img.onload = () => {
                req.resolve(img); resolve();
            };
            img.onerror = (err) => {
                req.reject(err); resolve();
            };
            img.src = url;
        });
    }
}