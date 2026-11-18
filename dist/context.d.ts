interface LogEntry {
    level: 'warn' | 'error';
    message: string;
}
interface FailedFetch {
    method: string;
    url: string;
    status?: number;
    error?: string;
}
interface Capture {
    console: LogEntry[];
    failedFetches: FailedFetch[];
}
export declare function cleanUrl(raw: string): string;
export declare function installCapture(): Capture;
export declare function getContext(): {
    url: string;
    title: string;
    route: string;
    viewport: {
        width: number;
        height: number;
    };
    scroll: {
        x: number;
        y: number;
    };
    devicePixelRatio: number;
    userAgent: string;
    'prefers-color-scheme': string;
    ts: string;
    console: LogEntry[];
    failedFetches: FailedFetch[];
};
export {};
