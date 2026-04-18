import { useRef, useEffect, useState, useCallback } from 'react'
import { Terminal } from './Terminal'

export interface ChatTab {
  id: string
  label: string
  cwd: string
  // Optional one-shot command to run in this tab's pty (e.g. claude --resume)
  command?: string
  closable: boolean
}

interface ChatPanelProps {
  visible: boolean
  onToggle: () => void
  tabs: ChatTab[]
  activeTabId: string
  onActivateTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}

const MIN_HEIGHT = 150
const MAX_HEIGHT = 1200
const MIN_FONT = 9
const MAX_FONT = 28
const FONT_KEY = 'lineup:terminalFontSize'

export function ChatPanel({
  visible,
  onToggle,
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
}: ChatPanelProps) {
  const [height, setHeight] = useState(420)
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem(FONT_KEY)
    const n = saved ? parseInt(saved, 10) : NaN
    return Number.isFinite(n) && n >= MIN_FONT && n <= MAX_FONT ? n : 14
  })
  const dragStartY = useRef<number | null>(null)
  const dragStartHeight = useRef<number>(0)

  // Persist font size
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize))
  }, [fontSize])

  // Keyboard shortcuts: Cmd/Ctrl + = / - / 0 to zoom in / out / reset.
  // Only active while the chat panel is visible and an xterm is focused,
  // otherwise we'd steal these shortcuts from the rest of the app.
  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      // Only when focus is inside the chat panel / a terminal
      const target = e.target as HTMLElement | null
      const inPanel = target?.closest('.lineup-chat-panel')
      if (!inPanel) return
      const consume = () => {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
      if (e.key === '=' || e.key === '+') {
        consume()
        setFontSize(s => Math.min(MAX_FONT, s + 1))
      } else if (e.key === '-' || e.key === '_') {
        consume()
        setFontSize(s => Math.max(MIN_FONT, s - 1))
      } else if (e.key === '0') {
        consume()
        setFontSize(14)
      }
    }
    // Capture phase: intercept before xterm.js consumes the event
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0]

  // ── Drag-to-resize ─────────────────────────────────────────────

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (dragStartY.current == null) return
    const delta = dragStartY.current - e.clientY
    const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartHeight.current + delta))
    setHeight(newHeight)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragStartY.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', handleDragMove)
    window.removeEventListener('mouseup', handleDragEnd)
  }, [handleDragMove])

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartHeight.current = height
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleDragMove)
    window.addEventListener('mouseup', handleDragEnd)
  }

  // Make sure the active tab's terminal gets focus when the panel is shown
  // or when switching tabs. xterm focuses automatically on click but not on
  // mount, so we briefly delay to let layout settle.
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      const host = document.querySelector<HTMLTextAreaElement>(
        '.xterm-helper-textarea',
      )
      host?.focus()
    }, 50)
    return () => clearTimeout(t)
  }, [visible, activeTabId])

  if (!visible || !activeTab) return null

  return (
    <div
      className="lineup-chat-panel border-t border-border bg-card flex flex-col"
      style={{ height, minHeight: MIN_HEIGHT }}
    >
      {/* Drag handle (resize) */}
      <div
        onMouseDown={handleDragStart}
        className="h-1 -mt-px cursor-ns-resize bg-transparent hover:bg-primary/40 transition-colors shrink-0"
        title="拖动调整高度"
      />

      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={`flex items-center gap-1 px-3 py-1.5 border-r border-border text-xs cursor-pointer shrink-0
                ${isActive
                  ? 'bg-card text-foreground border-b-2 border-b-primary -mb-px'
                  : 'text-muted-foreground hover:bg-accent/50'
                }`}
              onClick={() => onActivateTab(tab.id)}
            >
              <span className="truncate max-w-[200px]">{tab.label}</span>
              {tab.closable && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}
                  className="opacity-50 hover:opacity-100 hover:text-destructive ml-1"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        <button
          onClick={onToggle}
          className="ml-auto px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
        >
          收起
        </button>
      </div>

      {/* cwd indicator */}
      <div className="px-4 py-1 border-b border-border flex items-center gap-2 text-xs shrink-0">
        <span className="text-muted-foreground truncate">cwd: {activeTab.cwd}</span>
      </div>

      {/* Terminals — every tab is mounted full-size; we toggle `visibility`
          (NOT `display`) so hidden terminals keep their layout box. With
          display:none xterm collapses to 0×0 and FitAddon picks the wrong
          column count when you switch back. */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
                zIndex: isActive ? 1 : 0,
              }}
            >
              <Terminal cwd={tab.cwd} command={tab.command} fontSize={fontSize} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
