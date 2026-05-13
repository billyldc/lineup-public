/** Shared helper: copy `content` to the clipboard, open the main agent
 * tab (dispatching `lineup:chat:activate-main` — App.tsx listens), and
 * fire a 1-second toast. Used by the right-click "发送给通用 agent 处理"
 * menus in 收件箱 / 信息源.
 *
 * The clipboard-over-injection approach is deliberate:
 *   - We don't auto-type into the pty (surprising for the user, and
 *     what if they're mid-typing something else?)
 *   - Clipboard lets the user paste WHEN ready, after reading context
 *   - Also lets them alt-tab to Obsidian / email / etc. and paste there
 */

export async function sendToMainAgent(content: string): Promise<void> {
  if (!content || !content.trim()) return
  try {
    await navigator.clipboard.writeText(content)
  } catch {
    /* clipboard API denied — noop, user will see the agent open without
       paste-ready content */
  }
  window.dispatchEvent(new CustomEvent('lineup:chat:activate-main'))
  showTransientToast('📋 相关内容已复制到剪贴板')
}

/** Top-right toast with a click action + visual countdown bar. The
 * bar shrinks from full → 0 over `durationMs`; hovering the toast
 * pauses the countdown (and the auto-dismiss). Clicking anywhere on
 * the toast fires `onClick` and dismisses early.
 *
 * Used by flows that "did a thing in a different place" and want to
 * offer a quick jump-there shortcut — see CopyToPicker for the
 * canonical case (引用成功 → 跳转到新位置).
 */
export function showActionToast(opts: {
  message: string
  hint?: string         // small secondary line under the message
  durationMs?: number   // default 5000
  onClick?: () => void
}): void {
  const duration = opts.durationMs ?? 5000

  const wrap = document.createElement('div')
  wrap.setAttribute('data-lineup-toast', 'action')
  Object.assign(wrap.style, {
    position: 'fixed',
    top: '24px',
    right: '24px',
    minWidth: '260px',
    maxWidth: '340px',
    background: 'rgba(20, 20, 22, 0.96)',
    color: '#fff',
    borderRadius: '8px',
    fontSize: '13px',
    zIndex: '10000',
    opacity: '0',
    transform: 'translateY(-8px)',
    transition: 'opacity 180ms ease, transform 180ms ease',
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
    overflow: 'hidden',
    cursor: opts.onClick ? 'pointer' : 'default',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>)

  const body = document.createElement('div')
  Object.assign(body.style, { padding: '12px 14px 10px' } as Partial<CSSStyleDeclaration>)
  const msg = document.createElement('div')
  msg.textContent = opts.message
  msg.style.fontWeight = '500'
  body.appendChild(msg)
  if (opts.hint) {
    const hint = document.createElement('div')
    hint.textContent = opts.hint
    Object.assign(hint.style, {
      marginTop: '4px',
      fontSize: '11px',
      opacity: '0.7',
    } as Partial<CSSStyleDeclaration>)
    body.appendChild(hint)
  }
  wrap.appendChild(body)

  // Countdown bar — width animates linearly from 100% to 0%. The
  // transition's `transition-duration` IS the timer; we don't need a
  // separate setTimeout-driven RAF loop.
  const barTrack = document.createElement('div')
  Object.assign(barTrack.style, {
    height: '3px',
    background: 'rgba(255,255,255,0.12)',
  } as Partial<CSSStyleDeclaration>)
  const bar = document.createElement('div')
  Object.assign(bar.style, {
    height: '100%',
    width: '100%',
    background: opts.onClick ? '#60a5fa' : 'rgba(255,255,255,0.55)',
    transition: `width ${duration}ms linear`,
  } as Partial<CSSStyleDeclaration>)
  barTrack.appendChild(bar)
  wrap.appendChild(barTrack)

  document.body.appendChild(wrap)
  // Next paint → fade in + start countdown.
  requestAnimationFrame(() => {
    wrap.style.opacity = '1'
    wrap.style.transform = 'translateY(0)'
    requestAnimationFrame(() => { bar.style.width = '0%' })
  })

  // Auto-dismiss. Track remaining time so hover-pause + resume works.
  let remaining = duration
  let startedAt = performance.now()
  let timer: number | null = null
  const scheduleDismiss = (ms: number) => {
    timer = window.setTimeout(dismiss, ms)
  }
  const dismiss = () => {
    if (wrap.dataset.dismissed === '1') return
    wrap.dataset.dismissed = '1'
    if (timer != null) { clearTimeout(timer); timer = null }
    wrap.style.opacity = '0'
    wrap.style.transform = 'translateY(-8px)'
    setTimeout(() => wrap.remove(), 220)
  }
  scheduleDismiss(remaining)

  // Hover pauses the countdown (both visually and the timer). Mouse
  // leave resumes from where it left off.
  wrap.addEventListener('mouseenter', () => {
    if (timer != null) {
      clearTimeout(timer); timer = null
      remaining = Math.max(0, remaining - (performance.now() - startedAt))
    }
    // Freeze the bar at its current visual width.
    const computed = getComputedStyle(bar).width
    bar.style.transition = 'none'
    bar.style.width = computed
  })
  wrap.addEventListener('mouseleave', () => {
    if (wrap.dataset.dismissed === '1') return
    bar.style.transition = `width ${remaining}ms linear`
    requestAnimationFrame(() => { bar.style.width = '0%' })
    startedAt = performance.now()
    scheduleDismiss(remaining)
  })

  if (opts.onClick) {
    wrap.addEventListener('click', () => {
      try { opts.onClick!() } catch { /* swallow */ }
      dismiss()
    })
  }
}


/** Minimal toast: creates a fixed-position div, fades in / out, removes
 * itself after `durationMs`. No React state, no prop threading — anyone
 * can call it from anywhere. */
export function showTransientToast(message: string, durationMs = 1000): void {
  const el = document.createElement('div')
  el.textContent = message
  el.setAttribute('data-lineup-toast', '1')
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '80px',
    left: '50%',
    transform: 'translateX(-50%) translateY(20px)',
    background: 'rgba(0, 0, 0, 0.82)',
    color: '#fff',
    padding: '10px 18px',
    borderRadius: '8px',
    fontSize: '13px',
    zIndex: '10000',
    opacity: '0',
    transition: 'opacity 180ms ease, transform 180ms ease',
    pointerEvents: 'none',
    boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
  } as Partial<CSSStyleDeclaration>)
  document.body.appendChild(el)
  // Next paint → fade in
  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'translateX(-50%) translateY(0)'
  })
  // After `durationMs` → fade out + remove
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(-50%) translateY(10px)'
    setTimeout(() => el.remove(), 220)
  }, durationMs)
}
