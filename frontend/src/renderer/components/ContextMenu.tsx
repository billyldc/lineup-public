import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick: () => void
  separator?: false
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

interface ContextMenuProps {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  // Keep menu within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      if (rect.right > window.innerWidth) {
        menuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`
      }
      if (rect.bottom > window.innerHeight) {
        menuRef.current.style.top = `${window.innerHeight - rect.height - 8}px`
      }
    }
  }, [x, y])

  return createPortal(
    <>
      {/* Full-screen overlay with no-drag so clicks on blank space are captured
          (body has -webkit-app-region: drag which swallows mousedown on empty areas) */}
      <div
        onMouseDown={(e) => { e.stopPropagation(); onClose() }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      />
      {/* Menu */}
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 9999,
          width: 'fit-content',
          maxWidth: 280,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        className="min-w-48 bg-popover border border-border rounded-lg shadow-xl py-1 text-sm"
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="h-px bg-border my-1" />
          ) : (
            <button
              key={i}
              onClick={() => { item.onClick(); onClose() }}
              className="block w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>,
    document.body
  )
}
