import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, PackageMinus, AlertTriangle, Package } from 'lucide-react'
import { dashboardApi } from '../api/client'
import MetricCard from '../components/MetricCard'

const PERIODS = [7, 14, 30]

export default function Dashboard() {
  const [period, setPeriod] = useState(7)
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => dashboardApi.summary(period).then((r) => r.data),
  })

  const fmt = (n: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n)

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Дашборд</h1>
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded-md text-sm ${
                period === p ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {p}д
            </button>
          ))}
        </div>
      </div>

      {data?.alerts?.length > 0 && (
        <div className="space-y-2">
          {data.alerts.map((a: { id: number; severity: string; message: string }) => (
            <div
              key={a.id}
              className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
                a.severity === 'critical'
                  ? 'bg-red-500/10 border-red-500/30 text-red-300'
                  : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'
              }`}
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          title="Выручка"
          value={isLoading ? '...' : fmt(data?.total_revenue ?? 0)}
          subtitle={`за ${period} дней`}
          icon={TrendingUp}
          variant="success"
        />
        <MetricCard
          title="Списаний"
          value={isLoading ? '...' : data?.write_offs_count ?? 0}
          subtitle={`за ${period} дней`}
          icon={PackageMinus}
          variant={data?.write_offs_count > 20 ? 'warning' : 'default'}
        />
        <MetricCard
          title="Критич. остатки"
          value={isLoading ? '...' : data?.low_stock_items?.length ?? 0}
          subtitle="позиций"
          icon={AlertTriangle}
          variant={data?.low_stock_items?.length > 5 ? 'danger' : 'default'}
        />
        <MetricCard
          title="Активных алертов"
          value={isLoading ? '...' : data?.alerts?.length ?? 0}
          subtitle="требуют внимания"
          icon={Package}
          variant={data?.alerts?.length > 0 ? 'warning' : 'default'}
        />
      </div>

      {data?.low_stock_items?.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Критически низкий остаток</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.low_stock_items.map((item: { id: number; name: string; current: number; min: number; unit: string }) => (
              <div key={item.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-200 truncate">{item.name}</span>
                <span className="text-xs text-red-400 ml-2 shrink-0">
                  {item.current}/{item.min} {item.unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Сводка по списаниям</h2>
          <div className="flex items-center gap-6">
            <div>
              <p className="text-2xl font-bold">{data.write_offs_count}</p>
              <p className="text-xs text-gray-500">операций</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{data.write_offs_qty?.toFixed(1)}</p>
              <p className="text-xs text-gray-500">единиц списано</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
