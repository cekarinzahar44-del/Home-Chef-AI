import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, PackageMinus, Package, Bot,
  Bell, LogOut, ChevronLeft, ChevronRight, UtensilsCrossed
} from 'lucide-react'
import { useState } from 'react'
import { useAuthStore } from '../stores/authStore'
import clsx from 'clsx'

const NAV = [
  { to: '/', label: 'Дашборд', icon: LayoutDashboard, exact: true },
  { to: '/write-offs', label: 'Списание', icon: PackageMinus },
  { to: '/inventory', label: 'Склад', icon: Package },
  { to: '/agents', label: 'AI Агенты', icon: Bot },
]

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  const handleLogout = () => { logout(); navigate('/login') }

  return (
    <div className="flex h-screen bg-[#030712] text-gray-100">
      {/* Sidebar */}
      <aside
        className={clsx(
          'flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        <div className={clsx('flex items-center gap-2 h-14 px-3 border-b border-gray-800', collapsed && 'justify-center')}>
          <UtensilsCrossed className="text-blue-500 shrink-0" size={22} />
          {!collapsed && <span className="font-semibold text-sm truncate">Restaurant AI</span>}
        </div>

        <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, label, icon: Icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-blue-600/20 text-blue-400'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100',
                )
              }
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-gray-800 p-2">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="w-full flex items-center justify-center py-2 rounded-lg text-gray-500 hover:bg-gray-800"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-5">
          <span className="text-sm text-gray-400">{user?.full_name || user?.email}</span>
          <div className="flex items-center gap-2">
            <button className="p-2 rounded-lg text-gray-400 hover:bg-gray-800">
              <Bell size={18} />
            </button>
            <button onClick={handleLogout} className="p-2 rounded-lg text-gray-400 hover:bg-gray-800">
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-5">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
