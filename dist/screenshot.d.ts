import type { Capture, Rect } from './types.js';
export declare const PRIVATE = "[data-rf-private]";
export declare function blankPrivate(canvas: HTMLCanvasElement, scale: number, shift?: {
    x: number;
    y: number;
}): void;
export declare function canvasFor(width: number, height: number): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
};
export declare function loadImage(url: string): Promise<HTMLImageElement>;
export declare function cropRect(rect: Rect, width: number, height: number): Rect;
export declare function captureViewport(rect: Rect): Promise<Capture>;
export declare function pageSize(): {
    width: number;
    height: number;
};
export declare function capturePage(size: {
    width: number;
    height: number;
}): Promise<Capture>;
