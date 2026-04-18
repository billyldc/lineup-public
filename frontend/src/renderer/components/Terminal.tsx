import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  cwd: string
  // Optional one-shot command. If provided the shell runs it via `-c`
  // (e.g. `claude --resume <session_id>`) and exits when done.
  command?: string
  // Notify parent when the underlying pty has exited.
  onExit?: (exitCode: number) => void
  // Font size in px. Changes apply live and trigger a re-fit.
  fontSize?: number
}

/**
 * React wrapper around xterm.js + a real pty in main.
 * Lifecycle: spawns one pty on mount, kills it on unmount.
 * Resize: a ResizeObserver on the host div re-fits xterm on layout changes.
 */
export function Terminal({ cwd, command, onExit, fontSize = 13 }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)

  // Apply font size changes to a live xterm instance.
  useEffect(() => {
    const term = xtermRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = fontSize
    try {
      fit.fit()
      const id = ptyIdRef.current
      if (id) window.lineup.resizePty(id, term.cols, term.rows)
    } catch { /* host detached */ }
  }, [fontSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        selectionBackground: '#3a3a3a',
      },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // First fit before spawning so we send correct cols/rows
    try { fit.fit() } catch { /* host not yet sized */ }

    xtermRef.current = term
    fitRef.current = fit

    let disposeData: (() => void) | null = null
    let disposeExit: (() => void) | null = null
    let disposed = false

    const cols = term.cols || 80
    const rows = term.rows || 24

    window.lineup.createPty({ cwd, cols, rows, command }).then((res) => {
      if (disposed) {
        if (res.id) window.lineup.killPty(res.id)
        return
      }
      if (res.error || !res.id) {
        term.write(`\r\n\x1b[31m[failed to start pty: ${res.error || 'unknown'}]\x1b[0m\r\n`)
        return
      }
      ptyIdRef.current = res.id

      disposeData = window.lineup.onPtyData((id, data) => {
        if (id === res.id) term.write(data)
      })
      disposeExit = window.lineup.onPtyExit((id, exitCode) => {
        if (id !== res.id) return
        term.write(`\r\n\x1b[2m[exit ${exitCode}]\x1b[0m\r\n`)
        onExit?.(exitCode)
      })
      term.onData((data) => {
        window.lineup.writePty(res.id, data)
      })
    })

    // Capture-phase handler for Ctrl+O (Claude Code's "expand tool details"
    // shortcut). Something between the browser and xterm swallows it in our
    // embedded setup, so we intercept in capture phase and write \x0f
    // (ASCII SI = Ctrl+O) directly to the pty. Only fires when focus is
    // inside THIS terminal's host element.
    const onCtrlO = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && !e.metaKey && !e.altKey)) return
      if (e.key !== 'o' && e.key !== 'O') return
      if (!host.contains(document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      const id = ptyIdRef.current
      if (id) window.lineup.writePty(id, '\x0f')
    }
    window.addEventListener('keydown', onCtrlO, true)

    // Re-fit on container size changes
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const id = ptyIdRef.current
        if (id) window.lineup.resizePty(id, term.cols, term.rows)
      } catch { /* ignore */ }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      window.removeEventListener('keydown', onCtrlO, true)
      disposeData?.()
      disposeExit?.()
      const id = ptyIdRef.current
      if (id) window.lineup.killPty(id)
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      ptyIdRef.current = null
    }
    // We deliberately spawn ONCE per Terminal instance. Changes to cwd/command
    // require a fresh tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Finder drag-and-drop: paste file paths into the pty, matching what
  // Terminal.app does. Electron's File objects have a .path property.
  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer.files
    if (files.length === 0) return
    const paths = Array.from(files)
      .map(f => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
    if (paths.length === 0) return
    const id = ptyIdRef.current
    if (!id) return
    // Shell-escape paths that contain spaces/special chars
    const escaped = paths.map(p =>
      /[^a-zA-Z0-9._/~-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p
    ).join(' ')
    window.lineup.writePty(id, escaped)
  }

  return (
    <div
      ref={hostRef}
      className="w-full h-full bg-[#0a0a0a]"
      onDrop={handleFileDrop}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
    />
  )
}
