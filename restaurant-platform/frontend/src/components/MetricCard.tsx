import { ReactNode } from 'react';
import clsx from 'clsx';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  variant?: 'default' | 'danger' | 'warning' | 'success';
}

const variantStyles = {
  default: 'border-gray-800 bg-gray-900',
  danger: 'border-red-800 bg-red-950/30',
  warning: 'border-yellow-800 bg-yellow-950/30',
  success: 'border-green-800 bg-green-950/30',
};

export default function MetricCard({
  title, value, subtitle, icon, trend, trendValue, variant = 'default'
}: MetricCardProps) {
  return (
    <div className={clsx('rounded-xl border p-5 flex flex-col gap-3', variantStyles[variant])}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">{title}</span>
        {icon && <span className="text-gray-500">{icon}</span>}
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="flex items-center justify-between">
        {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
        {trend && trendValue && (
          <span className={clsx('text-xs font-medium', {
            'text-green-400': trend === 'up',
            'text-red-400': trend === 'down',
            'text-gray-400': trend === 'neutral',
          })}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'} {trendValue}
          </span>
        )}
      </div>
    </div>
  );
}
