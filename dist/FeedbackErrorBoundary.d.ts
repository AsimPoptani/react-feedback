import { Component } from 'react';
import type { ReactNode } from 'react';
export declare class FeedbackErrorBoundary extends Component<{
    children: ReactNode;
}, {
    failed: boolean;
}> {
    state: {
        failed: boolean;
    };
    private warned;
    static getDerivedStateFromError(): {
        failed: boolean;
    };
    componentDidCatch(error: Error): void;
    render(): ReactNode;
}
