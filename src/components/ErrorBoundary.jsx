import { Component } from 'react';
import { Brand } from './Ui';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('tail-aside UI failed:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-state">
        <Brand />
        <div>
          <h1>The console hit a snag.</h1>
          <p>Your Aside session is still on the Mac. Reload this private console to reconnect.</p>
        </div>
        <button type="button" onClick={() => window.location.reload()}>Reload tail-aside</button>
      </main>
    );
  }
}
