export type LauncherPosition = 'bottom-left' | 'bottom-right';
export declare const positionOf: (value: unknown) => LauncherPosition;
export interface FeedbackWidgetProps {
    /** Base URL of the feedback server. Defaults to "/__feedback". */
    endpoint?: string;
    /** Which bottom corner holds the launcher and its panels. Defaults to "bottom-left". */
    position?: LauncherPosition;
    /** "on" shows the step-by-step shortcut banner while a capture mode is active. Defaults to "off" (press ? for the shortcuts). */
    hints?: 'on' | 'off';
}
export default function FeedbackWidget({ endpoint, position, hints }: FeedbackWidgetProps): import("react").JSX.Element;
