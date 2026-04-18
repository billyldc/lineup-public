import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-popover border border-border rounded-lg shadow-xl p-4 w-96"
        onClick={e => e.stopPropagation()}
      >
        <div className="font-medium text-sm mb-2">{title}</div>
        <div className="text-sm text-muted-foreground mb-4 whitespace-pre-wrap">{message}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); onConfirm() }
              else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }}
            className={`px-3 py-1.5 text-sm rounded-md transition-opacity hover:opacity-90 ${
              danger
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
