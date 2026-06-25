import { useState } from 'react'
import { Play, Loader2, Bot, CheckCircle } from 'lucide-react'
import { agentApi } from '../api/client'

interface AgentCard {
  id: string
  title: string
  description: string
  run: () => Promise<unknown>
}

const AGENTS: AgentCard[] = [
  { id: 'inventory', title: 'Инвентаризация', description: 'Проверка остатков, стоп-лист, перераспределение', run: () => agentApi.inventory() },
  { id: 'owner', title: 'Дашборд владельца', description: 'KPI, food cost, анализ рисков за 7 дней', run: () => agentApi.owner(7) },
  { id: 'audit', title: 'Аудит / КРО', description: 'Сверка с ОФД, ЕГАИС, анализ списаний', run: () => agentApi.audit(30) },
  { id: 'procurement', title: 'Закупки', description: 'Прогноз потребностей, формирование заявок', run: () => agentApi.procurement(7) },
  { id: 'staff', title: 'Персонал', description: 'Проверка смен, перераспределение, дисциплина', run: () => agentApi.staff() },
  { id: 'flow', title: 'Пассажиропоток', description: 'Прогноз по рейсам, рекомендации по подготовке', run: () => agentApi.passengerFlow(24) },
]

export default function Agents() {
  const [results, setResults] = useState<Record<string, { loading: boolean; data?: unknown; error?: string }>>({})

  const runAgent = async (agent: AgentCard) => {
    setResults((r) => ({ ...r, [agent.id]: { loading: true } }))
    try {
      const res = await agent.run() as { data: { success: boolean; message: string; data: unknown } }
      setResults((r) => ({ ...r, [agent.id]: { loading: false, data: res.data } }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка'
      setResults((r) => ({ ...r, [agent.id]: { loading: false, error: msg } }))
    }
  }

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">AI Агенты</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {AGENTS.map((agent) => {
          const state = results[agent.id]
          return (
            <div key={agent.id} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="bg-blue-500/10 text-blue-400 p-2 rounded-lg shrink-0">
                  <Bot size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm text-gray-200">{agent.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{agent.description}</p>
                </div>
              </div>

              {state?.data && (
                <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400 max-h-32 overflow-y-auto">
                  {(state.data as { message?: string }).message && (
                    <p className="text-green-400 mb-1 flex items-center gap-1">
                      <CheckCircle size={12} /> {(state.data as { message: string }).message}
                    </p>
                  )}
                  <pre className="whitespace-pre-wrap text-gray-500 text-[10px]">
                    {JSON.stringify((state.data as { data?: unknown }).data, null, 2)?.slice(0, 500)}
                  </pre>
                </div>
              )}

              {state?.error && (
                <p className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2">{state.error}</p>
              )}

              <button
                onClick={() => runAgent(agent)}
                disabled={state?.loading}
                className="w-full flex items-center justify-center gap-2 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-500/20 text-blue-400 rounded-lg py-2 text-sm transition-colors disabled:opacity-50"
              >
                {state?.loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {state?.loading ? 'Выполняется...' : 'Запустить'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
