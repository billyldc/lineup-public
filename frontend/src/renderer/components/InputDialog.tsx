import { useState, useRef, useEffect } from 'react'

interface InputDialogProps {
  title: string
  placeholder?: string
  initial?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ title, placeholder, initial, onSubmit, onCancel }: InputDialogProps) {
  const [value, setValue] = useState(initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // Select all when there's a prefilled value, so user can just type to replace
    if (initial) inputRef.current?.select()
  }, [initial])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // If input is empty but placeholder exists, use the placeholder (Tab shortcut)
    const trimmed = value.trim() || placeholder?.trim() || ''
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div className="bg-popover border border-border rounded-lg shadow-xl p-4 w-80" onClick={e => e.stopPropagation()}>
        <div className="font-medium text-sm mb-3">{title}</div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-input border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={e => {
              if (e.key === 'Escape') onCancel()
              // Tab = accept placeholder as value
              if (e.key === 'Tab' && !value.trim() && placeholder) {
                e.preventDefault()
                setValue(placeholder)
              }
            }}
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
            >
              确定
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
