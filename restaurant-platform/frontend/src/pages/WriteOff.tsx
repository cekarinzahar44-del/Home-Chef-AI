import { useState } from 'react'
import { Send, Loader2, CheckCircle, XCircle, RefreshCw } from 'lucide-react'
import { writeOffApi } from '../api/client'

interface WriteOffEntry {
  id: string
  text: string
  success: boolean
  message: string
  sync?: Record<string, string>
  timestamp: Date
}

const EXAMPLES = [
  'списать 1 кг яблок порча',
  'списать 2 бутылки вина истечение срока',
  'списать 500 г муки производство',
  'списать 3 порции борща производство',
]

export default function WriteOff() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [feed, setFeed] = useState<WriteOffEntry[]>([])

  const submit = async (inputText = text) => {
    if (!inputText.trim()) return
    setLoading(true)
    const id = Date.now().toString()
    try {
      const res = await writeOffApi.create(inputText)
      const { success, message, data } = res.data
      setFeed((f) => [{ id, text: inputText, success, message, sync: data?.sync, timestamp: new Date() }, ...f])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка'
      setFeed((f) => [{ id, text: inputText, success: false, message: msg, timestamp: new Date() }, ...f])
    } finally {
      setLoading(false)
      setText('')
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">Списание</h1>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            placeholder="Введите команду на русском... (например: списать 1 кг яблок порча)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
            rows={2}
          />
          <button
            onClick={() => submit()}
            disabled={loading || !text.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg px-3 flex items-center"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => submit(ex)}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 hover:text-gray-100 rounded-full px-3 py-1 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {feed.map((entry) => (
          <div
            key={entry.id}
            className={`bg-gray-900 rounded-xl border p-4 ${
              entry.success ? 'border-green-500/30' : 'border-red-500/30'
            }`}
          >
            <div className="flex items-start gap-2">
              {entry.success
                ? <CheckCircle size={18} className="text-green-400 shrink-0 mt-0.5" />
                : <XCircle size={18} className="text-red-400 shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-500 mb-1 font-mono">{entry.text}</p>
                <p className={`text-sm ${entry.success ? 'text-gray-200' : 'text-red-300'}`}>{entry.message}</p>
                {entry.sync && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {Object.entries(entry.sync).map(([sys, status]) => (
                      <span
                        key={sys}
                        className={`text-xs px-2 py-0.5 rounded-full border ${
                          status === 'synced'
                            ? 'bg-green-500/10 border-green-500/30 text-green-400'
                            : 'bg-red-500/10 border-red-500/30 text-red-400'
                        }`}
                      >
                        <RefreshCw size={10} className="inline mr-1" />
                        {sys}: {status}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="text-xs text-gray-600 shrink-0">
                {entry.timestamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
