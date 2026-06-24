import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Animated, KeyboardAvoidingView, Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { writeOffApi } from '../api/client';

const C = {
  bg: '#030712', card: '#111827', border: '#1f2937',
  text: '#f9fafb', muted: '#6b7280', blue: '#3b82f6',
  green: '#22c55e', red: '#ef4444', yellow: '#f59e0b',
};

const EXAMPLES = [
  '2 кг помидоров испортились',
  'разбили бутылку вина',
  '500г говядины — просрочка',
  'питание сотрудника 1 порция',
];

const LOCATION_ID = 1;

interface Entry {
  id: string;
  text: string;
  status: 'pending' | 'success' | 'error';
  message?: string;
  synced?: boolean;
}

export default function WriteOffScreen() {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const submit = async (text: string) => {
    if (!text.trim() || loading) return;
    const id = Date.now().toString();
    setEntries(prev => [{ id, text, status: 'pending' }, ...prev]);
    setInput('');
    setLoading(true);
    try {
      const res = await writeOffApi.create(text, LOCATION_ID);
      const result = res.data;
      setEntries(prev => prev.map(e => e.id === id ? {
        ...e,
        status: result.success ? 'success' : 'error',
        message: result.message,
        synced: result.data?.pos_synced,
      } : e));
    } catch {
      setEntries(prev => prev.map(e => e.id === id ? {
        ...e, status: 'error', message: 'Ошибка соединения'
      } : e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.container} keyboardShouldPersistTaps="handled">
        <View style={s.header}>
          <Text style={s.title}>Списание</Text>
          <Text style={s.subtitle}>Напишите что списать — AI распознает и отправит в систему</Text>
        </View>

        {/* Input */}
        <View style={s.inputCard}>
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => submit(input)}
            placeholder="например: списать 1 кг яблок"
            placeholderTextColor={C.muted}
            style={s.input}
            multiline
            returnKeyType="send"
          />
          <TouchableOpacity
            onPress={() => submit(input)}
            disabled={!input.trim() || loading}
            style={[s.sendBtn, (!input.trim() || loading) && { opacity: 0.4 }]}>
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Examples */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.examplesRow}>
          {EXAMPLES.map(ex => (
            <TouchableOpacity key={ex} onPress={() => submit(ex)} style={s.exampleChip}>
              <Text style={s.exampleText}>{ex}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Feed */}
        <View style={s.feed}>
          {entries.map(entry => (
            <View key={entry.id} style={[s.entry,
              entry.status === 'success' && s.entrySuccess,
              entry.status === 'error' && s.entryError,
              entry.status === 'pending' && s.entryPending,
            ]}>
              <View style={s.entryIcon}>
                {entry.status === 'success' && <Ionicons name="checkmark-circle" size={20} color={C.green} />}
                {entry.status === 'error' && <Ionicons name="close-circle" size={20} color={C.red} />}
                {entry.status === 'pending' && <Ionicons name="time" size={20} color={C.muted} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.entryText}>{entry.text}</Text>
                {entry.message && <Text style={s.entryMsg}>{entry.message}</Text>}
                {entry.status === 'success' && (
                  <View style={s.syncRow}>
                    <Ionicons
                      name={entry.synced ? 'wifi' : 'wifi-outline'}
                      size={12}
                      color={entry.synced ? C.green : C.yellow}
                    />
                    <Text style={[s.syncText, { color: entry.synced ? C.green : C.yellow }]}>
                      {entry.synced ? 'Синхронизовано с POS' : 'Только локально'}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { padding: 20, paddingTop: 60 },
  title: { fontSize: 26, fontWeight: '700', color: C.text },
  subtitle: { fontSize: 13, color: C.muted, marginTop: 4 },
  inputCard: { marginHorizontal: 16, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 10 },
  input: { flex: 1, color: C.text, fontSize: 15, maxHeight: 100, lineHeight: 22 },
  sendBtn: { backgroundColor: C.blue, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  examplesRow: { paddingVertical: 12, paddingLeft: 16 },
  exampleChip: { backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginRight: 8, borderWidth: 1, borderColor: C.border },
  exampleText: { fontSize: 12, color: C.muted },
  feed: { padding: 16, gap: 10 },
  entry: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 12, borderWidth: 1 },
  entrySuccess: { backgroundColor: '#052e16', borderColor: '#166534' },
  entryError: { backgroundColor: '#450a0a', borderColor: '#991b1b' },
  entryPending: { backgroundColor: C.card, borderColor: C.border },
  entryIcon: { paddingTop: 1 },
  entryText: { fontSize: 14, color: C.text, fontWeight: '500' },
  entryMsg: { fontSize: 12, color: C.muted, marginTop: 3 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  syncText: { fontSize: 11 },
});
