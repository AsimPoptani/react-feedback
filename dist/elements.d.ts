import type { ElementTarget, Rect } from './types.js';
export declare const isWidget: (element: Element) => boolean;
export declare function selectorFor(element: Element): string;
export declare function componentChain(element: Element): string[];
export declare function rectFor(element: Element): Rect;
export declare function targetFor(element: Element): ElementTarget;
export declare function sectionFor(element: Element): Element;
