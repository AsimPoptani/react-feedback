import { Component } from 'react';
import type { ReactNode } from 'react';

export class FeedbackErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private warned = false;

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) {
    if (this.warned) return;
    this.warned = true;
    console.warn('Feedback widget unavailable', error);
  }

  render() { return this.state.failed ? null : this.props.children; }
}
