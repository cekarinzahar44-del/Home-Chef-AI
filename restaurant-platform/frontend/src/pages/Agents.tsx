import { useState } from 'react';
import { Bot, Play, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { agentApi } from '../api/client';
import { useAuthStore } from '../stores/authStore';

const AGENTS = [
  { id: 'owner', name: 'Агент собственника', desc: 'Сводка KPI и рисков по всей сети', icon: '👑' },
  { id: 'inventory', name: 'Инвентаризация', desc: 'Проверка остатков, стоп-лист, прогноз', icon: '📦' },
  { id: 'audit', name: 'Аудит / КРО', desc: 'Касса vs ОФД, ЕГАИС, подозрительные операции', icon: '🛡️' },
  { id: 'procurement', name: 'Закупки', desc: 'Автозаказ поставщикам на основе остатков', icon: '🛒' },
  { id: 'staff', name: 'Персонал', desc: 'Контроль смен, дисциплина, перераспределение', icon: '👥' },
  { id: 'passenger_flow', name: 'Пассажиропоток', desc: 'Прогноз выручки аэропорт по рейсам', icon: '✈️' },
];

export default function AgentsPage() {
  const { user } = useAuthStore();
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});

  const runAgent = async (agentId: string) => {
    setRunning(agentId);
    try {
      const context: any = { organization_id: user?.organization_id, location_id: 1 };
      if (agentId === 'owner') context.period_days = 7;
      if (agentId === 'audit') context.checks = ['revenue', 'write_offs', 'staff'];
      const res = await agentApi.run(agentId, context);
      setResults(prev => ({ ...prev, [agentId]: res.data }));
    } catch (err: any) {
      setResults(prev => ({ ...prev, [agentId]: { success: false, message: err.message } }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">Запускайте AI-агентов вручную или они работают автоматически по расписанию</p>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {AGENTS.map(agent => {
          const result = results[agent.id];
          const isRunning = running === agent.id;

          return (
            <div key={agent.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xl">{agent.icon}</span>
                    <h3 className="font-semibold text-gray-200 text-sm">{agent.name}</h3>
                  </div>
                  <p className="text-xs text-gray-500">{agent.desc}</p>
                </div>
              </div>

              {result && (
                <div className={`rounded-lg p-3 text-xs ${result.success ? 'bg-green-950/30 border border-green-900' : 'bg-red-950/30 border border-red-900'}`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {result.success
                      ? <CheckCircle size={12} className="text-green-400" />
                      : <XCircle size={12} className="text-red-400" />}
                    <span className={result.success ? 'text-green-300' : 'text-red-300'}>
                      {result.message}
                    </span>
                  </div>
                  {result.alerts?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {result.alerts.slice(0, 3).map((a: any, i: number) => (
                        <div key={i} className="text-yellow-400">⚠ {a.message}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button onClick={() => runAgent(agent.id)} disabled={isRunning}
                className="flex items-center justify-center gap-2 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm text-white transition-colors mt-auto">
                {isRunning
                  ? <><Loader2 size={14} className="animate-spin" /> Работает...</>
                  : <><Play size={14} /> Запустить</>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
