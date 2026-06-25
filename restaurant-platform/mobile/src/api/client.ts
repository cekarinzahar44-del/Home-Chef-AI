import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

export const api = axios.create({ baseURL: BASE });

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', new URLSearchParams({ username: email, password })),
  me: () => api.get('/auth/me'),
};

export const dashboardApi = {
  summary: (days: number) => api.get(`/dashboard/summary?period_days=${days}`),
};

export const writeOffApi = {
  create: (text: string, locationId?: number) =>
    api.post('/write-offs/', { text, location_id: locationId }),
  list: () => api.get('/write-offs/?limit=20'),
};
