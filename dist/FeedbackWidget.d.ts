export interface FeedbackWidgetProps {
    /** Base URL of the feedback server. Defaults to "/__feedback". */
    endpoint?: string;
}
export default function FeedbackWidget({ endpoint }: FeedbackWidgetProps): import("react").JSX.Element;
