import { useState, useEffect, useRef } from 'react';
import { Send, Mic, CheckCircle, XCircle, Clock, Wifi, WifiOff } from 'lucide-react';
import { writeOffApi } from '../api/client';

const LOCATION_ID = 1; // TODO: from store/select

interface WriteOffEntry {
  id: string;
  text: string;
  status: 'pending' | 'success' | 'error';
  result?: any;
  time: string;
}

export default function WriteOffPage() {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<WriteOffEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    writeOffApi.stats(LOCATION_ID, 30).then(r => setStats(r.data)).catch(() => {});
  }, [entries.length]);

  const submit = async (text: string) => {
    if (!text.trim()) return;
    const id = Date.now().toString();
    const entry: WriteOffEntry = {
      id, text, status: 'pending',
      time: new Date().toLocaleTimeString('ru-RU'),
    };
    setEntries(prev => [entry, ...prev]);
    setInput('');
    setLoading(true);

    try {
      const res = await writeOffApi.create(text, LOCATION_ID);
      const result = res.data;
      setEntries(prev => prev.map(e => e.id === id ? {
        ...e, status: result.success ? 'success' : 'error', result
      } : e));
    } catch (err: any) {
      setEntries(prev => prev.map(e => e.id === id ? {
        ...e, status: 'error', result: { message: 'Ошибка соединения' }
      } : e));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const examples = ['списать 2 кг помидоров', '500г говядины испортилось', 'разбили бутылку вина', 'питание сотрудника — 1 порция борща'];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Input */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Новое списание</h2>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit(input)}
            placeholder="Напишите что списать... например: списать 1 кг яблок"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button onClick={() => submit(input)} disabled={loading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2.5 rounded-lg text-white transition-colors">
            <Send size={18} />
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {examples.map(ex => (
            <button key={ex} onClick={() => submit(ex)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white px-3 py-1.5 rounded-full transition-colors">
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-2">За 30 дней</div>
          <div className="flex gap-6 text-sm">
            <div><span className="text-gray-400">Операций: </span>
              <span className="text-white font-semibold">{stats.total?.count || 0}</span></div>
            <div><span className="text-gray-400">На сумму: </span>
              <span className="text-white font-semibold">
                {(stats.total?.total_cost || 0).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })}
              </span></div>
          </div>
        </div>
      )}

      {/* Feed */}
      <div className="space-y-2">
        {entries.map(entry => (
          <div key={entry.id} className={`flex items-start gap-3 p-4 rounded-xl border transition-all
            ${entry.status === 'success' ? 'border-green-800 bg-green-950/20'
              : entry.status === 'error' ? 'border-red-800 bg-red-950/20'
              : 'border-gray-800 bg-gray-900'}`}>
            <div className="mt-0.5 shrink-0">
              {entry.status === 'success' && <CheckCircle size={18} className="text-green-400" />}
              {entry.status === 'error' && <XCircle size={18} className="text-red-400" />}
              {entry.status === 'pending' && <Clock size={18} className="text-gray-500 animate-pulse" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-300 font-medium">{entry.text}</p>
              {entry.result?.message && (
                <p className="text-xs text-gray-500 mt-1">{entry.result.message}</p>
              )}
              {entry.result?.data && (
                <div className="flex items-center gap-2 mt-1.5">
                  {entry.result.data.pos_synced
                    ? <span className="flex items-center gap-1 text-xs text-green-400"><Wifi size={12} /> Синхронизовано с POS</span>
                    : <span className="flex items-center gap-1 text-xs text-yellow-500"><WifiOff size={12} /> Только локально</span>}
                </div>
              )}
            </div>
            <span className="text-xs text-gray-600 shrink-0">{entry.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
