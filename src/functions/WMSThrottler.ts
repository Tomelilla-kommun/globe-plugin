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

    constructor(maxConcurrent: number = 5) {
        this.maxConcurrent = maxConcurrent;
    }

    /** Add a WMS request to the queue */
    request(url: string, params?: Record<string, string>): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            this.queue.push({ url, params, resolve, reject });
            this.processQueue();
        });
    }

    /** Pause processing (e.g., while camera moves) */
    pause() {
        this.paused = true;
    }

    /** Resume processing */
    resume() {
        this.paused = false;
        this.processQueue();
    }

    /** Cancel all queued requests (optional) */
    cancelAll() {
        this.queue.forEach(req => req.reject(new Error("Cancelled")));
        this.queue = [];
    }

    /** Internal queue processor */
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

    /** Internal fetch handler */
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
                req.resolve(img);
                resolve();
            };
            img.onerror = (err) => {
                req.reject(err);
                resolve();
            };
            img.src = url;
        });
    }
}
