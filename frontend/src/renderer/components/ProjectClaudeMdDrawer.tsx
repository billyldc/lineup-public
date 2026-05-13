import { useState, useEffect, useCallback } from 'react'
import { showTransientToast } from '../lib/sendToMainAgent'

/** Editor for a project's CLAUDE.md.manual overlay (the user-owned slice
 *  of the system prompt that the project's main agent reads).
 *
 *  Layout: full-height overlay anchored on the right of the window,
 *  with a click-to-dismiss backdrop.
 *
 *  The auto-generated portion of CLAUDE.md (header / inventory / skills)
 *  is shown read-only below the editor for context — users sometimes
 *  want to know what the agent ALREADY sees before deciding what to add.
 */
export function ProjectClaudeMdDrawer({
  projectId,
  projectName,
  onClose,
}: {
  projectId: number
  projectName: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [original, setOriginal] = useState('')   // last-saved version
  const [draft, setDraft] = useState('')
  const [stacked, setStacked] = useState('')
  const [stackedExpanded, setStackedExpanded] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const r = await window.lineup.projectReadManual(projectId)
    setLoading(false)
    if (!r.ok) {
      setError(r.error || 'load failed')
      return
    }
    setOriginal(r.manual || '')
    setDraft(r.manual || '')
    setStacked(r.stacked || '')
    setManualPath(r.manualPath || '')
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  const dirty = draft !== original

  async function save() {
    setSaving(true)
    const r = await window.lineup.projectWriteManual(projectId, draft)
    setSaving(false)
    if (!r.ok) {
      setError(r.error || 'save failed')
      return
    }
    setOriginal(draft)
    showTransientToast(`💾 已保存 ${projectName} 的 CLAUDE.md.manual`)
    // Reload stacked so the user sees the merged version update.
    void refresh()
  }

  // Queue a meta-prompt asking the running agent to write the overlay
  // itself based on conversation history. Reuses the pending-send banner
  // (lineup:chat:queue-prompt) so the user confirms in the terminal.
  // After the agent saves the file, they re-open the drawer to verify.
  function queueSummaryPrompt() {
    const prompt = SUMMARY_META_PROMPT
    window.dispatchEvent(new CustomEvent('lineup:chat:queue-prompt', {
      detail: {
        projectId,
        projectName,
        prompt,
      },
    }))
    showTransientToast(`📤 已加入 ${projectName} 的发送队列 — 在终端 banner 里按 ▶`, 1800)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[720px] max-w-[92vw] bg-background border-l border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">
              📝 {projectName} · CLAUDE.md.manual
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              这是这个项目主 agent 的 system prompt 叠层 —— 自动生成的项目名 / inventory / skills 部分不用写，
              这里只放你想让 agent 一直记着的东西（命名规范、用户偏好、避免做的事 …）。
            </div>
            {manualPath && (
              <div className="text-[11px] text-muted-foreground mt-1 font-mono break-all">
                {manualPath}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent shrink-0"
          >✕ 关闭</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="text-xs px-3 py-2 rounded border border-destructive/40 bg-destructive/10 text-destructive-foreground">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-muted-foreground italic">加载中...</div>
          ) : (
            <>
              <div>
                <label className="text-xs text-muted-foreground flex items-center justify-between">
                  <span>
                    Manual overlay
                    {dirty && <span className="text-amber-400 ml-1">· 未保存</span>}
                  </span>
                  <span className="text-[10px]">{draft.length} 字</span>
                </label>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={MANUAL_PLACEHOLDER}
                  className="mt-1 w-full h-[360px] p-3 rounded border border-border bg-muted/30 font-mono text-xs leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                  spellCheck={false}
                />
              </div>

              {/* Summarize-from-history shortcut */}
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <div className="text-xs text-amber-200 font-medium">
                  ✨ 让 agent 自己从对话历史里总结
                </div>
                <div className="text-[11px] text-foreground/70">
                  把一条 meta-prompt 加入这个项目的发送队列。终端按 ▶ 后，agent 会用 Write 工具直接写到{" "}
                  <code className="font-mono text-foreground">CLAUDE.md.manual</code>。
                  完成后再打开这里查看 / 修改即可。
                </div>
                <button
                  onClick={queueSummaryPrompt}
                  className="text-xs px-3 py-1.5 rounded bg-amber-500 text-amber-950 font-medium hover:bg-amber-400"
                >📤 发送总结请求到 agent 队列</button>
              </div>

              {/* Read-only view of the merged CLAUDE.md so user sees what
                  the agent actually reads after stacking. */}
              <div className="rounded border border-border/60 bg-muted/10">
                <button
                  onClick={() => setStackedExpanded(s => !s)}
                  className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-accent/30"
                >
                  <span className="text-xs text-muted-foreground">
                    📖 查看 agent 实际读到的完整 CLAUDE.md（auto + manual 叠加后）
                  </span>
                  <span className="text-xs text-muted-foreground">{stackedExpanded ? '▾' : '▸'}</span>
                </button>
                {stackedExpanded && (
                  <pre className="px-3 py-2 border-t border-border/60 text-[11px] font-mono leading-snug whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto">
                    {stacked || '(empty)'}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-3 border-t border-border flex items-center gap-2">
          <button
            onClick={save}
            disabled={!dirty || saving || loading}
            className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-40"
          >{saving ? '保存中...' : '💾 保存'}</button>
          <button
            onClick={() => setDraft(original)}
            disabled={!dirty || saving}
            className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent disabled:opacity-40"
          >撤销修改</button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
          >关闭</button>
        </div>
      </div>
    </div>
  )
}


const MANUAL_PLACEHOLDER = `# Workflow / 偏好

- ……

# 命名规范

- ……

# 这个 agent 应该避免的做法

- ……
`


// Meta-prompt sent to the running project agent. It writes
// CLAUDE.md.manual itself based on conversation history; we deliberately
// don't ask it to "describe" the conventions in chat — direct file write
// is one round-trip vs two and avoids the user having to copy-paste.
const SUMMARY_META_PROMPT = `请基于到目前为止我们这场对话以及你对当前项目的了解，为这个项目写一份 \`./CLAUDE.md.manual\` 系统提示叠层。

**要求**：
- 直接用 Write 工具写到 \`./CLAUDE.md.manual\`（覆盖现有内容，不要先 Read）
- 中文 markdown
- 包括（以下任何一项有信息就写，没信息可以省略）：
  - 项目核心目标 / context
  - 用户偏好的命名规范 / 风格 / 工作流（之前讨论过的）
  - 你被纠正过的做法 → 应该改成什么
  - 用户提过的"以后再遇到 X 就应该……"这类指令
  - 该项目特有的领域知识或外部依赖
- **不要重复** CLAUDE.md 自动生成的部分（项目名 / description / Inventory & skills）—— 那些已经在上面了
- 不要写"我会努力做好"这种空话
- 不需要先问我，直接 Write

完成后输出一行 \`✓ CLAUDE.md.manual 已更新 (N 字)\` 即可。如果信息确实太少，写一个简短 placeholder 加上"（待补充：……）"列表。`
