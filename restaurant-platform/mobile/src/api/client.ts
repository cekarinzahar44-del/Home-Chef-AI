import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://your-api.restaurant-ai.ru/api/v1';

export const api = axios.create({ baseURL: API_URL, timeout: 15000 });

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  r => r,
  async (error) => {
    if (error.response?.status === 401) {
      await SecureStore.deleteItemAsync('auth_token');
    }
    return Promise.reject(error);
  }
);

export const writeOffApi = {
  create: (text: string, locationId: number) =>
    api.post('/write-offs', { text, location_id: locationId }),
  list: (locationId: number) =>
    api.get('/write-offs', { params: { location_id: locationId, limit: 30 } }),
};

export const inventoryApi = {
  list: (locationId: number) =>
    api.get('/inventory', { params: { location_id: locationId } }),
  stopList: (locationId: number) =>
    api.get('/inventory/stop-list', { params: { location_id: locationId } }),
};

export const dashboardApi = {
  summary: (orgId: number) =>
    api.get('/dashboard/summary', { params: { organization_id: orgId, period_days: 7 } }),
  alerts: (orgId: number) =>
    api.get('/dashboard/alerts', { params: { organization_id: orgId } }),
};

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', new URLSearchParams({ username: email, password })),
};
