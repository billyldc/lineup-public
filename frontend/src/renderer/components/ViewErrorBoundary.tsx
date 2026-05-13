import { Component, type ReactNode } from 'react'

/**
 * Catch render errors inside per-view components so a single broken view
 * doesn't black-screen the whole app. We hit this when the contacts view
 * crashed on `process.env.USER` (undefined in renderer context) and
 * App.tsx had `view='contacts'` persisted to localStorage — every reload
 * re-mounted the same crashing component → blank UI with no exit.
 *
 * The fallback offers a "返回项目视图" button that explicitly resets the
 * persisted `view` key + reloads, so the user has a one-click escape
 * even when the broken view is the default.
 */

interface Props {
  /** Stable key — when it changes (view switch), reset the error so the
   *  user can navigate away from a broken view without app reload. */
  resetKey?: string
  /** Localized name of the view, surfaced in the fallback message. */
  viewName?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ViewErrorBoundary]', this.props.viewName, error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    const msg = this.state.error.message || String(this.state.error)
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-background">
        <div className="max-w-[600px] rounded-lg border border-destructive/40 bg-destructive/10 p-5 space-y-3">
          <div className="text-sm font-semibold">
            ⚠️ {this.props.viewName || '当前视图'} 渲染失败
          </div>
          <pre className="text-xs whitespace-pre-wrap break-all font-mono text-foreground/80 max-h-[200px] overflow-y-auto">
            {msg}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => {
                // Reset persisted view so reload doesn't re-crash here.
                try {
                  localStorage.setItem('lineup:view', 'columns')
                } catch { /* ignore */ }
                window.location.reload()
              }}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
            >返回项目视图 + 重新加载</button>
            <button
              onClick={() => this.setState({ error: null })}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
            >重试渲染</button>
          </div>
          <div className="text-[11px] text-muted-foreground italic">
            console 里有完整堆栈。如果反复发生请告诉作者。
          </div>
        </div>
      </div>
    )
  }
}
