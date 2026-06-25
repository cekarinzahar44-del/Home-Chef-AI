import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, AlertTriangle, TrendingDown } from 'lucide-react'
import { inventoryApi } from '../api/client'

type Tab = 'all' | 'stoplist' | 'forecast'

const CATEGORY_COLORS: Record<string, string> = {
  meat: 'bg-red-500/10 text-red-400 border-red-500/20',
  dairy: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  vegetables: 'bg-green-500/10 text-green-400 border-green-500/20',
  alcohol: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  default: 'bg-gray-700 text-gray-400 border-gray-600',
}

export default function Inventory() {
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')

  const { data: items = [], isLoading: loadingItems } = useQuery({
    queryKey: ['inventory', search],
    queryFn: () => inventoryApi.list({ search: search || undefined }).then((r) => r.data),
    enabled: tab === 'all',
  })

  const { data: stopList, isLoading: loadingStop } = useQuery({
    queryKey: ['stop-list'],
    queryFn: () => inventoryApi.stopList().then((r) => r.data),
    enabled: tab === 'stoplist',
  })

  const { data: forecast, isLoading: loadingForecast } = useQuery({
    queryKey: ['forecast'],
    queryFn: () => inventoryApi.forecast(7).then((r) => r.data),
    enabled: tab === 'forecast',
  })

  const TABS: { id: Tab; label: string }[] = [
    { id: 'all', label: 'Все позиции' },
    { id: 'stoplist', label: 'Стоп-лист' },
    { id: 'forecast', label: 'Прогноз' },
  ]

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Склад</h1>

      <div className="flex gap-3 items-center">
        <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-1 gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'all' && (
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск..."
              className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-8 pr-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        )}
      </div>

      {tab === 'all' && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {loadingItems ? (
            <p className="p-6 text-center text-gray-500 text-sm">Загрузка...</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Название', 'Категория', 'Остаток', 'Минимум', 'Ед.'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item: { id: number; name: string; category: string; current_stock: number; min_stock_level: number; unit: string }) => (
                  <tr key={item.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 text-gray-200">{item.name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        CATEGORY_COLORS[item.category] || CATEGORY_COLORS.default
                      }`}>
                        {item.category}
                      </span>
                    </td>
                    <td className={`px-4 py-3 font-mono ${
                      item.current_stock <= item.min_stock_level ? 'text-red-400' : 'text-gray-200'
                    }`}>
                      {item.current_stock <= item.min_stock_level && <AlertTriangle size={12} className="inline mr-1" />}
                      {item.current_stock}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono">{item.min_stock_level}</td>
                    <td className="px-4 py-3 text-gray-500">{item.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'stoplist' && (
        <div className="space-y-2">
          {loadingStop ? (
            <p className="text-gray-500 text-sm">Загрузка...</p>
          ) : (
            (stopList?.stop_list || []).map((item: { id: number; name: string; category: string }) => (
              <div key={item.id} className="bg-gray-900 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3">
                <AlertTriangle size={16} className="text-red-400 shrink-0" />
                <span className="text-gray-200 text-sm">{item.name}</span>
                <span className="text-xs text-gray-500 ml-auto">{item.category}</span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'forecast' && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {loadingForecast ? (
            <p className="p-6 text-center text-gray-500 text-sm">Загрузка...</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Позиция', 'Ср.расход/день', 'Нужно (7д)', 'Остаток', 'Дефицит'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(forecast?.forecasts || []).map((f: { id: number; name: string; daily_avg: number; forecast_needed: number; current_stock: number; shortfall: number; unit: string }) => (
                  <tr key={f.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 text-gray-200">{f.name}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono">{f.daily_avg} {f.unit}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono">{f.forecast_needed} {f.unit}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono">{f.current_stock} {f.unit}</td>
                    <td className={`px-4 py-3 font-mono font-medium ${
                      f.shortfall > 0 ? 'text-red-400' : 'text-green-400'
                    }`}>
                      {f.shortfall > 0 ? (
                        <><TrendingDown size={12} className="inline mr-1" />{f.shortfall} {f.unit}</>
                      ) : '✓'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
