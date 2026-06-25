import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { UtensilsCrossed, Loader2 } from 'lucide-react'
import { authApi } from '../api/client'
import { useAuthStore } from '../stores/authStore'

export default function Login() {
  const [email, setEmail] = useState('admin@restaurant.ru')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await authApi.login(email, password)
      const { access_token, user_id, role } = res.data
      const me = await authApi.me()
      setAuth(access_token, { id: user_id, email, role, full_name: me.data.full_name })
      navigate('/')
    } catch {
      setError('Неверный email или пароль')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#030712] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="bg-blue-600 p-3 rounded-2xl mb-4">
            <UtensilsCrossed size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-100">Restaurant AI</h1>
          <p className="text-gray-500 text-sm mt-1">Платформа автоматизации</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-gray-100 text-sm focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-gray-100 text-sm focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            Войти
          </button>
        </form>
      </div>
    </div>
  )
}
