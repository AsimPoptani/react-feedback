/** Notes saved but not yet delivered. Sent notes leave here and appear in the list. */
export declare function Outbox({ onSent }: {
    onSent?: () => void;
}): import("react").JSX.Element | null;
