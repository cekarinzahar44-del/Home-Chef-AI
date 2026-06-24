import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { dashboardApi } from '../api/client';

const C = {
  bg: '#030712', card: '#111827', border: '#1f2937',
  text: '#f9fafb', muted: '#6b7280', blue: '#3b82f6',
  red: '#ef4444', yellow: '#f59e0b', green: '#22c55e',
};

const fmt = (n: number) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);

export default function HomeScreen() {
  const [data, setData] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const res = await dashboardApi.summary(1);
      setData(res.data.data);
    } catch (e) { console.error(e); }
  };

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  useEffect(() => { load(); }, []);

  const rev = data?.revenue || {};
  const risks = data?.risks || [];

  return (
    <ScrollView style={s.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />}>
      <View style={s.header}>
        <Text style={s.headerTitle}>🍽️ Restaurant AI</Text>
        <Text style={s.headerSub}>{data?.locations_count || 0} объектов в сети</Text>
      </View>

      {/* Risk alerts */}
      {risks.map((r: any, i: number) => (
        <View key={i} style={[s.alert, { borderColor: r.severity === 'error' ? C.red : C.yellow }]}>
          <Ionicons name="warning" size={16} color={r.severity === 'error' ? C.red : C.yellow} />
          <Text style={[s.alertText, { color: r.severity === 'error' ? C.red : C.yellow }]}>{r.message}</Text>
        </View>
      ))}

      {/* KPI Grid */}
      <View style={s.grid}>
        <MetricCard label="Выручка (7 дней)" value={fmt(rev.total || 0)} icon="trending-up" />
        <MetricCard label="Гостей" value={(rev.covers || 0).toLocaleString('ru-RU')} icon="people" />
        <MetricCard label="Food Cost" value={`${(rev.avg_food_cost_percent || 0).toFixed(1)}%`}
          icon="restaurant" alert={(rev.avg_food_cost_percent || 0) > 35} />
        <MetricCard label="Алертов" value={String(data?.unread_alerts_count || 0)}
          icon="notifications" alert={(data?.unread_alerts_count || 0) > 0} />
      </View>

      {/* Low stock */}
      {data?.inventory_alerts?.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>⚠️ Низкие остатки</Text>
          {data.inventory_alerts.slice(0, 5).map((item: any) => (
            <View key={item.item_id} style={s.stockRow}>
              <Text style={s.stockName}>{item.name}</Text>
              <Text style={s.stockQty}>{item.current} / {item.min} {item.unit}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function MetricCard({ label, value, icon, alert }: any) {
  return (
    <View style={[s.metric, alert && { borderColor: C.yellow }]}>
      <Ionicons name={icon} size={20} color={alert ? C.yellow : C.blue} />
      <Text style={s.metricValue}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { padding: 20, paddingTop: 60 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: C.text },
  headerSub: { fontSize: 13, color: C.muted, marginTop: 2 },
  alert: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertText: { fontSize: 13, flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 8, marginHorizontal: 8 },
  metric: { width: '47%', backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, alignItems: 'flex-start', gap: 6 },
  metricValue: { fontSize: 20, fontWeight: '700', color: C.text },
  metricLabel: { fontSize: 11, color: C.muted },
  section: { margin: 16, backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 10 },
  stockRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border },
  stockName: { fontSize: 13, color: C.text, flex: 1 },
  stockQty: { fontSize: 12, color: C.yellow, fontVariant: ['tabular-nums'] },
});
