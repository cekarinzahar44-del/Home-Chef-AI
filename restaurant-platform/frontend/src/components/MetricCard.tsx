import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'

interface Props {
  title: string
  value: string | number
  subtitle?: string
  icon: LucideIcon
  variant?: 'default' | 'danger' | 'warning' | 'success'
}

const VARIANTS = {
  default: { card: 'border-gray-700', icon: 'bg-blue-500/10 text-blue-400' },
  danger: { card: 'border-red-500/40 bg-red-500/5', icon: 'bg-red-500/10 text-red-400' },
  warning: { card: 'border-yellow-500/40 bg-yellow-500/5', icon: 'bg-yellow-500/10 text-yellow-400' },
  success: { card: 'border-green-500/40 bg-green-500/5', icon: 'bg-green-500/10 text-green-400' },
}

export default function MetricCard({ title, value, subtitle, icon: Icon, variant = 'default' }: Props) {
  const v = VARIANTS[variant]
  return (
    <div className={clsx('rounded-xl border bg-gray-900 p-4 flex items-start gap-3', v.card)}>
      <div className={clsx('p-2.5 rounded-lg shrink-0', v.icon)}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 mb-0.5 truncate">{title}</p>
        <p className="text-2xl font-bold text-gray-100">{value}</p>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5 truncate">{subtitle}</p>}
      </div>
    </div>
  )
}
