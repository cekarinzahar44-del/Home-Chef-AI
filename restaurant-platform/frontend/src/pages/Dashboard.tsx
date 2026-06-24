import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { LayoutDashboard, AlertTriangle, TrendingUp, Package, Users, Shield } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import { dashboardApi } from '../api/client';
import { useAuthStore } from '../stores/authStore';

const fmt = (n: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);

export default function Dashboard() {
  const { user } = useAuthStore();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(7);

  useEffect(() => {
    if (!user?.organization_id) return;
    setLoading(true);
    dashboardApi.getSummary(user.organization_id, period)
      .then(r => setData(r.data.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user, period]);

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-gray-500">Загрузка дашборда...</div>
  );

  const rev = data?.revenue || {};
  const risks = data?.risks || [];
  const alerts = data?.unread_alerts_count || 0;

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex gap-2">
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setPeriod(d)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${period === d ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
            {d} дней
          </button>
        ))}
      </div>

      {/* Risk alerts */}
      {risks.length > 0 && (
        <div className="space-y-2">
          {risks.map((r: any, i: number) => (
            <div key={i} className={`flex items-start gap-3 p-4 rounded-lg border
              ${r.severity === 'error' ? 'border-red-800 bg-red-950/40' : 'border-yellow-800 bg-yellow-950/30'}`}>
              <AlertTriangle size={16} className={r.severity === 'error' ? 'text-red-400 mt-0.5' : 'text-yellow-400 mt-0.5'} />
              <span className="text-sm text-gray-200">{r.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Выручка за период"
          value={fmt(rev.total || 0)}
          subtitle={`${data?.locations_count} объектов`}
          icon={<TrendingUp size={18} />}
        />
        <MetricCard
          title="Гостей"
          value={(rev.covers || 0).toLocaleString('ru-RU')}
          subtitle={`Средний чек ${fmt(rev.avg_check || 0)}`}
          icon={<Users size={18} />}
        />
        <MetricCard
          title="Food Cost"
          value={`${(rev.avg_food_cost_percent || 0).toFixed(1)}%`}
          subtitle="Норма ≤35%"
          icon={<Package size={18} />}
          variant={(rev.avg_food_cost_percent || 0) > 35 ? 'danger' : 'default'}
        />
        <MetricCard
          title="Непрочитанных алертов"
          value={alerts}
          subtitle="Требуют внимания"
          icon={<Shield size={18} />}
          variant={alerts > 0 ? 'warning' : 'default'}
        />
      </div>

      {/* Low stock */}
      {data?.inventory_alerts?.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
            <Package size={16} className="text-yellow-400" />
            Низкие остатки ({data.inventory_alerts.length} позиций)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.inventory_alerts.slice(0, 9).map((item: any) => (
              <div key={item.item_id} className="flex justify-between items-center bg-gray-800 rounded-lg px-3 py-2 text-sm">
                <span className="text-gray-200 truncate mr-2">{item.name}</span>
                <span className="text-yellow-400 shrink-0 font-mono text-xs">{item.current} / {item.min} {item.unit}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Write-off summary */}
      {data?.write_offs && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Списания за период</h3>
          <div className="flex gap-6 text-sm">
            <div><span className="text-gray-500">Операций: </span><span className="text-white font-medium">{data.write_offs.count}</span></div>
            <div><span className="text-gray-500">На сумму: </span><span className="text-white font-medium">{fmt(data.write_offs.total_cost)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
