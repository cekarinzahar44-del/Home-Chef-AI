import axios from 'axios'
import { useAuthStore } from '../stores/authStore'

const BASE = import.meta.env.VITE_API_URL || '/api/v1'

export const api = axios.create({ baseURL: BASE })

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  },
)

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', new URLSearchParams({ username: email, password })),
  me: () => api.get('/auth/me'),
}

export const dashboardApi = {
  summary: (days: number) => api.get(`/dashboard/summary?period_days=${days}`),
  kpi: (days: number) => api.get(`/dashboard/kpi?period_days=${days}`),
}

export const inventoryApi = {
  list: (params?: Record<string, unknown>) => api.get('/inventory/', { params }),
  stopList: (locationId?: number) => api.get('/inventory/stop-list', { params: { location_id: locationId } }),
  forecast: (days = 7, locationId?: number) =>
    api.get('/inventory/forecast', { params: { days, location_id: locationId } }),
}

export const writeOffApi = {
  create: (text: string, locationId?: number) =>
    api.post('/write-offs/', { text, location_id: locationId }),
  list: (params?: Record<string, unknown>) => api.get('/write-offs/', { params }),
  stats: (days = 7) => api.get(`/write-offs/stats?period_days=${days}`),
}

export const agentApi = {
  inventory: (action = 'check_all') => api.post(`/agents/inventory/check?action=${action}`),
  owner: (days = 7) => api.post(`/agents/owner/dashboard?period_days=${days}`),
  audit: (days = 30) => api.post(`/agents/audit?period_days=${days}`),
  procurement: (days = 7, autoCreate = false) =>
    api.post(`/agents/procurement?days_forecast=${days}&auto_create=${autoCreate}`),
  staff: (action = 'check_shifts') => api.post(`/agents/staff?action=${action}`),
  passengerFlow: (hours = 24) => api.post(`/agents/passenger-flow?forecast_hours=${hours}`),
}
