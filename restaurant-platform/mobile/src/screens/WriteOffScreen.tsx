import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { writeOffApi } from '../api/client';

const C = {
  bg: '#030712', card: '#111827', border: '#1f2937',
  text: '#f9fafb', muted: '#6b7280', blue: '#3b82f6',
  red: '#ef4444', green: '#22c55e',
};

const EXAMPLES = [
  'списать 1 кг яблок порча',
  'списать 500 г муки',
  'списать 2 бутылки вина',
  'списать 3 порции борща',
];

interface FeedEntry {
  id: string;
  text: string;
  success: boolean;
  message: string;
  sync?: Record<string, string>;
}

export default function WriteOffScreen() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);

  const submit = async (inputText = text) => {
    if (!inputText.trim() || loading) return;
    setLoading(true);
    const id = Date.now().toString();
    try {
      const res = await writeOffApi.create(inputText);
      const { success, message, data } = res.data;
      setFeed((f) => [{ id, text: inputText, success, message, sync: data?.sync }, ...f]);
    } catch {
      setFeed((f) => [{ id, text: inputText, success: false, message: 'Ошибка сети' }, ...f]);
    } finally {
      setLoading(false);
      setText('');
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Списание</Text>

        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder="Введите команду..."
            placeholderTextColor={C.muted}
            multiline
            returnKeyType="send"
            onSubmitEditing={() => submit()}
          />
          <TouchableOpacity onPress={() => submit()} disabled={loading || !text.trim()} style={s.sendBtn}>
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name="send" size={20} color="#fff" />}
          </TouchableOpacity>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.exampleScroll}>
          {EXAMPLES.map((ex) => (
            <TouchableOpacity key={ex} onPress={() => submit(ex)} style={s.chip}>
              <Text style={s.chipText}>{ex}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={s.feed}>
          {feed.map((entry) => (
            <View key={entry.id} style={[s.feedItem, { borderColor: entry.success ? C.green : C.red }]}>
              <View style={s.feedHeader}>
                <Ionicons
                  name={entry.success ? 'checkmark-circle' : 'close-circle'}
                  size={16}
                  color={entry.success ? C.green : C.red}
                />
                <Text style={s.feedText} numberOfLines={1}>{entry.text}</Text>
              </View>
              <Text style={{ color: entry.success ? '#d1fae5' : '#fca5a5', fontSize: 13, marginTop: 4 }}>
                {entry.message}
              </Text>
              {entry.sync && (
                <View style={s.syncRow}>
                  {Object.entries(entry.sync).map(([sys, status]) => (
                    <View key={sys} style={[s.syncBadge, { borderColor: status === 'synced' ? C.green : C.red }]}>
                      <Text style={{ color: status === 'synced' ? C.green : C.red, fontSize: 11 }}>
                        {sys}: {status}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 16, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: '700', color: C.text, marginBottom: 16 },
  inputRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  input: { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, color: C.text, fontSize: 14, minHeight: 60 },
  sendBtn: { backgroundColor: C.blue, borderRadius: 12, width: 52, justifyContent: 'center', alignItems: 'center' },
  exampleScroll: { marginBottom: 16 },
  chip: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  chipText: { color: C.muted, fontSize: 12 },
  feed: { gap: 10 },
  feedItem: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, padding: 12 },
  feedHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  feedText: { color: C.muted, fontSize: 12, flex: 1 },
  syncRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  syncBadge: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
});
