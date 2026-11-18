export declare function modifiers(): {
    command: string;
    alt: string;
    shift: string;
    commandKey: string;
};
export declare function keyLabel(...keys: string[]): string;
export declare function isInput(target: EventTarget | null): boolean;
export declare function isWidgetEvent(event: Event): boolean;
export declare function keyboardTarget(event: Event): Element | null;
export declare function nativeButtonActivation(event: KeyboardEvent): boolean;
export declare function useShortcuts(step: string, run: (action: string) => void): void;
