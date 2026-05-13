import { useState, useEffect } from 'react'
import type { Project, ObjectRow, Todo } from '../../preload/index'

interface Props {
  projectId: number
  onNavigate: (id: number) => void
  onBack: () => void
  onHome: () => void
  onRefresh: () => void
  canGoBack: boolean
}

const typeLabels: Record<string, string> = {
  file: '文件',
  folder: '文件夹',
  url: '链接',
  zotero: '文献',
  trilium: '笔记',
  obsidian: '笔记',
  script: '脚本',
  project: '项目',
}

function ProgressBar({ percent }: { percent: number }) {
  const color = percent >= 80 ? 'bg-green-500' : percent >= 40 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-sm text-muted-foreground w-10 text-right">{percent}%</span>
    </div>
  )
}

export function ProjectDetail({ projectId, onNavigate, onBack, onHome, onRefresh, canGoBack }: Props) {
  const [project, setProject] = useState<Project | null>(null)
  const [subProjects, setSubProjects] = useState<Project[]>([])
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [todos, setTodos] = useState<Todo[]>([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [p, subs, objs, tds] = await Promise.all([
        window.lineup.getProject(projectId),
        window.lineup.getSubProjects(projectId),
        window.lineup.getObjects(projectId),
        window.lineup.getTodos(projectId),
      ])
      if (cancelled) return
      setProject(p ?? null)
      setSubProjects(subs)
      setObjects(objs)
      setTodos(tds)
    }
    load()
    return () => { cancelled = true }
  }, [projectId])

  if (!project) return <div className="p-8 text-muted-foreground">加载中...</div>

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        {canGoBack && (
          <button
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground text-lg"
            title="← 返回上级"
          >
            ←
          </button>
        )}
        <div>
          <h1 className="text-xl font-bold text-foreground">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-muted-foreground mt-1">{project.description}</p>
          )}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">优先级 {project.priority}</span>
      </div>

      {/* Progress */}
      {project.progress > 0 && (
        <div className="mb-6">
          <ProgressBar percent={project.progress} />
          {project.progress_note && (
            <p className="text-xs text-muted-foreground mt-1">{project.progress_note}</p>
          )}
        </div>
      )}

      {/* Sub-projects + Objects (unified list, projects first) */}
      {(subProjects.length > 0 || objects.length > 0) && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            项目 + 对象
          </h2>
          <div className="border border-border rounded-lg divide-y divide-border">
            {subProjects.map(sp => (
              <button
                key={`p:${sp.id}`}
                onClick={() => onNavigate(sp.id)}
                className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-accent/50 transition-colors"
              >
                <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                  项目
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{sp.name}</span>
                  {sp.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{sp.description}</p>
                  )}
                </div>
                {sp.progress > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">{sp.progress}%</span>
                )}
                <span className="text-muted-foreground shrink-0">→</span>
              </button>
            ))}
            {objects.map(o => (
              <div
                key={`o:${o.id}`}
                className="px-4 py-3 flex items-start gap-3"
              >
                <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                  {typeLabels[o.type] || o.type}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{o.name}</span>
                  <p className="text-xs text-muted-foreground mt-0.5 break-all">
                    {o.target}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {o.open_count > 0 ? `${o.open_count}次` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Todos */}
      {todos.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            待办 ({todos.length})
          </h2>
          <div className="space-y-2">
            {todos.map(t => (
              <div key={t.id} className="flex items-start gap-3 text-sm">
                <span className="text-muted-foreground mt-0.5">
                  {t.done ? '☑' : '☐'}
                </span>
                <span className="flex-1">{t.text}</span>
                {t.due_date && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t.due_date}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
