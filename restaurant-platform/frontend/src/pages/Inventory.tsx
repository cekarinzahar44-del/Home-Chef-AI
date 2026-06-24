import { useEffect, useState } from 'react';
import { Package, AlertTriangle, Search, RefreshCw } from 'lucide-react';
import { inventoryApi } from '../api/client';

const LOCATION_ID = 1;

export default function InventoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [stopList, setStopList] = useState<any>(null);
  const [forecast, setForecast] = useState<any>(null);
  const [tab, setTab] = useState<'all' | 'stoplist' | 'forecast'>('all');

  const load = async () => {
    setLoading(true);
    try {
      const res = await inventoryApi.list(LOCATION_ID, lowOnly);
      setItems(res.data);
    } finally {
      setLoading(false);
    }
  };

  const loadStopList = async () => {
    const res = await inventoryApi.getStopList(LOCATION_ID);
    setStopList(res.data.data);
  };

  const loadForecast = async () => {
    const res = await inventoryApi.getForecast(LOCATION_ID, 7);
    setForecast(res.data.data);
  };

  useEffect(() => { load(); }, [lowOnly]);
  useEffect(() => {
    if (tab === 'stoplist' && !stopList) loadStopList();
    if (tab === 'forecast' && !forecast) loadForecast();
  }, [tab]);

  const filtered = items.filter(i => i.name.toLowerCase().includes(search.toLowerCase()));

  const categoryColor: Record<string, string> = {
    food: 'bg-blue-900/40 text-blue-300',
    beverage: 'bg-purple-900/40 text-purple-300',
    alcohol: 'bg-pink-900/40 text-pink-300',
    packaging: 'bg-gray-800 text-gray-400',
    cleaning: 'bg-green-900/40 text-green-300',
  };

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-800 pb-0">
        {(['all', 'stoplist', 'forecast'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors
              ${tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'all' ? 'Все остатки' : t === 'stoplist' ? 'Стоп-лист' : 'Прогноз'}
          </button>
        ))}
      </div>

      {tab === 'all' && (
        <>
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Поиск по названию..."
                className="w-full pl-9 pr-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)}
                className="rounded border-gray-600" />
              Только низкие
            </label>
            <button onClick={load} className="p-2 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800">
              <RefreshCw size={16} className={loading ? 'animate-spin text-blue-400' : 'text-gray-400'} />
            </button>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="text-left px-4 py-3">Название</th>
                  <th className="text-left px-4 py-3">Категория</th>
                  <th className="text-right px-4 py-3">Остаток</th>
                  <th className="text-right px-4 py-3">Мин.</th>
                  <th className="text-right px-4 py-3">Стоимость</th>
                  <th className="text-center px-4 py-3">Статус</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-3 font-medium text-gray-200">{item.name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${categoryColor[item.category] || 'bg-gray-800 text-gray-400'}`}>
                        {item.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-200">
                      {item.current_stock} {item.unit}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-500">
                      {item.min_stock} {item.unit}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">
                      {item.stock_value ? `${item.stock_value.toLocaleString('ru-RU')} ₽` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {item.is_low_stock
                        ? <AlertTriangle size={14} className="text-yellow-400 mx-auto" />
                        : <Package size={14} className="text-green-400 mx-auto" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-12 text-gray-500">Позиции не найдены</div>
            )}
          </div>
        </>
      )}

      {tab === 'stoplist' && stopList && (
        <div className="space-y-4">
          {stopList.ai_recommendation && (
            <div className="bg-blue-950/30 border border-blue-800 rounded-xl p-4 text-sm text-blue-200">
              🤖 {stopList.ai_recommendation}
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-gray-900 border border-red-900 rounded-xl p-4">
              <h3 className="font-semibold text-red-400 mb-3">Стоп-лист ({stopList.stop_list?.length})</h3>
              {stopList.stop_list?.map((i: any) => (
                <div key={i.id} className="py-2 border-b border-gray-800 text-sm text-gray-300">{i.name}</div>
              ))}
            </div>
            <div className="bg-gray-900 border border-yellow-900 rounded-xl p-4">
              <h3 className="font-semibold text-yellow-400 mb-3">Заканчивается ({stopList.warning_list?.length})</h3>
              {stopList.warning_list?.map((i: any) => (
                <div key={i.id} className="flex justify-between py-2 border-b border-gray-800 text-sm">
                  <span className="text-gray-300">{i.name}</span>
                  <span className="text-yellow-400 font-mono">{i.remaining} {i.unit}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'forecast' && forecast && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-gray-800">
            <h3 className="font-semibold text-gray-200">Прогноз потребностей на 7 дней</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500">
                <th className="text-left px-4 py-3">Товар</th>
                <th className="text-right px-4 py-3">Осталось</th>
                <th className="text-right px-4 py-3">Дней до 0</th>
                <th className="text-right px-4 py-3">Заказать</th>
                <th className="text-center px-4 py-3">Срочность</th>
              </tr>
            </thead>
            <tbody>
              {forecast.items_to_order?.map((item: any) => (
                <tr key={item.item_id} className="border-b border-gray-800/50">
                  <td className="px-4 py-3 text-gray-200">{item.name}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-400">{item.current_stock} {item.unit}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">{item.days_until_stockout}</td>
                  <td className="px-4 py-3 text-right font-mono text-blue-300">{item.recommended_order} {item.unit}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${item.urgency === 'critical' ? 'bg-red-900/60 text-red-300' : 'bg-yellow-900/40 text-yellow-300'}`}>
                      {item.urgency === 'critical' ? 'Критично' : 'Скоро'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
