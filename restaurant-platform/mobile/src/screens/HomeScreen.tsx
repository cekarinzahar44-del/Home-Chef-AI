import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, RefreshControl,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { dashboardApi } from '../api/client';

const C = {
  bg: '#030712', card: '#111827', border: '#1f2937',
  text: '#f9fafb', muted: '#6b7280', blue: '#3b82f6',
  red: '#ef4444', yellow: '#f59e0b', green: '#22c55e',
};

interface KPI {
  label: string;
  value: string;
  color: string;
}

export default function HomeScreen() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await dashboardApi.summary(7);
      setData(res.data);
    } catch { /* ignore */ } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const fmt = (n: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);

  const kpis: KPI[] = data ? [
    { label: 'Выручка (7д)', value: fmt(data.total_revenue as number ?? 0), color: C.green },
    { label: 'Списаний', value: String(data.write_offs_count ?? 0), color: C.yellow },
    { label: 'Низкий остаток', value: String((data.low_stock_items as unknown[])?.length ?? 0), color: C.red },
    { label: 'Алертов', value: String((data.alerts as unknown[])?.length ?? 0), color: C.blue },
  ] : [];

  if (loading && !data) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.blue} />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.blue} />}
    >
      <Text style={s.title}>Дашборд</Text>

      {(data?.alerts as Array<{ id: number; severity: string; message: string }>)?.map((a) => (
        <View key={a.id} style={[s.alert, { borderColor: a.severity === 'critical' ? C.red : C.yellow }]}>
          <Text style={{ color: a.severity === 'critical' ? C.red : C.yellow, fontSize: 13 }}>{a.message}</Text>
        </View>
      ))}

      <View style={s.grid}>
        {kpis.map((k) => (
          <View key={k.label} style={s.kpiCard}>
            <Text style={[s.kpiValue, { color: k.color }]}>{k.value}</Text>
            <Text style={s.kpiLabel}>{k.label}</Text>
          </View>
        ))}
      </View>

      {(data?.low_stock_items as Array<{ id: number; name: string; current: number; min: number; unit: string }>)?.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>Низкий остаток</Text>
          {(data?.low_stock_items as Array<{ id: number; name: string; current: number; min: number; unit: string }>).map((item) => (
            <View key={item.id} style={s.stockRow}>
              <Text style={{ color: C.text, fontSize: 14 }}>{item.name}</Text>
              <Text style={{ color: C.red, fontSize: 13 }}>{item.current}/{item.min} {item.unit}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 16, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: '700', color: C.text, marginBottom: 16 },
  alert: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8, backgroundColor: 'rgba(239,68,68,0.08)' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  kpiCard: { flex: 1, minWidth: '45%', backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border },
  kpiValue: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  kpiLabel: { fontSize: 12, color: C.muted },
  section: { backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: C.muted, marginBottom: 10 },
  stockRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border },
});
