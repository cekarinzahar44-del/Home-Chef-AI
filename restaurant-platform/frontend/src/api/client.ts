import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1';

export const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', new URLSearchParams({ username: email, password })),
  me: () => api.get('/auth/me'),
};

export const dashboardApi = {
  getSummary: (orgId: number, days = 7) =>
    api.get('/dashboard/summary', { params: { organization_id: orgId, period_days: days } }),
  getAlerts: (orgId: number) =>
    api.get('/dashboard/alerts', { params: { organization_id: orgId } }),
  markAlertRead: (id: number) => api.post(`/dashboard/alerts/${id}/read`),
};

export const inventoryApi = {
  list: (locationId: number, lowStockOnly = false) =>
    api.get('/inventory', { params: { location_id: locationId, low_stock_only: lowStockOnly } }),
  create: (data: object) => api.post('/inventory', data),
  updateStock: (id: number, quantity: number) => api.put(`/inventory/${id}/stock`, { quantity }),
  getStopList: (locationId: number) =>
    api.get('/inventory/stop-list', { params: { location_id: locationId } }),
  getForecast: (locationId: number, days = 7) =>
    api.get('/inventory/forecast', { params: { location_id: locationId, days } }),
};

export const writeOffApi = {
  create: (text: string, locationId: number) =>
    api.post('/write-offs', { text, location_id: locationId }),
  list: (locationId: number, limit = 50) =>
    api.get('/write-offs', { params: { location_id: locationId, limit } }),
  stats: (locationId: number, days = 30) =>
    api.get('/write-offs/stats', { params: { location_id: locationId, days } }),
};

export const agentApi = {
  run: (agent: string, context: object) => api.post('/agents/run', { agent, context }),
  list: () => api.get('/agents/list'),
};
