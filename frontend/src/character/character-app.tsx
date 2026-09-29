import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from './studio/Workspace';

// A render error keeps the page usable instead of blanking the whole application.
class AppBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="character-factory workspace">
      <p className="workspace-error" role="alert">화면 오류 · {this.state.error.message}</p>
      <button onClick={() => this.setState({ error: undefined })}>다시 표시</button>
      <button onClick={() => location.reload()}>새로고침</button>
    </div>;
  }
}

// One application. Old bookmarks retain their character/job, not their old screen.
const query = new URLSearchParams(location.search);
for (const key of ['stage', 'view']) query.delete(key);
history.replaceState(null, '', `/${query.size ? `?${query}` : ''}`);
createRoot(document.getElementById('app')!).render(<AppBoundary><Workspace /></AppBoundary>);
