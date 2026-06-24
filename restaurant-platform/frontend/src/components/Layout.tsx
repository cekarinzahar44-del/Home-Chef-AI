import { ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, PackageSearch, Trash2, ShoppingCart,
  Users, BarChart3, Shield, Bot, Settings, LogOut, Bell, ChevronLeft, Menu
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import clsx from 'clsx';

const NAV = [
  { path: '/', label: 'Дашборд', icon: LayoutDashboard },
  { path: '/inventory', label: 'Склад', icon: PackageSearch },
  { path: '/write-offs', label: 'Списания', icon: Trash2 },
  { path: '/procurement', label: 'Закупки', icon: ShoppingCart },
  { path: '/staff', label: 'Персонал', icon: Users },
  { path: '/revenue', label: 'Выручка', icon: BarChart3 },
  { path: '/audit', label: 'КРО / Аудит', icon: Shield },
  { path: '/agents', label: 'AI Агенты', icon: Bot },
  { path: '/settings', label: 'Настройки', icon: Settings },
];

export default function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className={clsx('flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200',
        collapsed ? 'w-16' : 'w-60')}>
        <div className="flex items-center justify-between p-4 border-b border-gray-800 h-16">
          {!collapsed && <span className="font-bold text-blue-400 text-sm">Restaurant AI</span>}
          <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded hover:bg-gray-800">
            {collapsed ? <Menu size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {NAV.map(({ path, label, icon: Icon }) => (
            <Link key={path} to={path}
              className={clsx('flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg mb-0.5 text-sm transition-colors',
                location.pathname === path
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white')}>
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-800">
          {!collapsed && (
            <div className="text-xs text-gray-500 mb-3 truncate">
              <div className="font-medium text-gray-300">{user?.full_name}</div>
              <div>{user?.role}</div>
            </div>
          )}
          <button onClick={handleLogout}
            className="flex items-center gap-2 text-gray-400 hover:text-red-400 text-sm w-full">
            <LogOut size={16} />
            {!collapsed && 'Выйти'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6">
          <h1 className="text-lg font-semibold text-white">
            {NAV.find(n => n.path === location.pathname)?.label || 'Restaurant AI Platform'}
          </h1>
          <button className="relative p-2 rounded-lg hover:bg-gray-800">
            <Bell size={20} className="text-gray-400" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-6 bg-gray-950">
          {children}
        </main>
      </div>
    </div>
  );
}
