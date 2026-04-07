import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, CheckCircle, Star, Plane, Info, AlertTriangle } from 'lucide-react';
import { useNotifications, ActionNotification } from '../lib/notifications';

const iconMap: Record<ActionNotification['icon'], React.FC<{ size: number; className?: string }>> = {
  check_circle: (p) => <CheckCircle {...p} />,
  star: (p) => <Star {...p} fill="currentColor" />,
  flight: (p) => <Plane {...p} />,
  airline_seat_recline_normal: (p) => (
    <svg width={p.size} height={p.size} viewBox="0 0 24 24" fill="currentColor" className={p.className}>
      <path d="M7.59 5.41c-.78-.78-.78-2.05 0-2.83.78-.78 2.05-.78 2.83 0 .78.78.78 2.05 0 2.83-.79.79-2.05.79-2.83 0zM6 16V7H4v9c0 2.76 2.24 5 5 5h6v-2H9c-1.66 0-3-1.34-3-3zm14 4.07L14.93 15H11.5v-3.68c1.4 1.15 3.6 2.16 5.5 2.16v-2.16c-1.66.02-3.61-.87-4.67-2.04l-1.4-1.55c-.19-.21-.43-.38-.69-.5-.29-.14-.62-.23-.96-.23h-.03C8.01 7 7 8.01 7 9.25V15c0 1.66 1.34 3 3 3h5.07l3.5 3.5L20 20.07z"/>
    </svg>
  ),
  credit_card: (p) => (
    <svg width={p.size} height={p.size} viewBox="0 0 24 24" fill="currentColor" className={p.className}>
      <path d="M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>
    </svg>
  ),
  info: (p) => <Info {...p} />,
  luggage: (p) => (
    <svg width={p.size} height={p.size} viewBox="0 0 24 24" fill="currentColor" className={p.className}>
      <path d="M17 6h-2V3c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v3H7c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2 0 .55.45 1 1 1s1-.45 1-1h6c0 .55.45 1 1 1s1-.45 1-1c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM9.5 18H8V9h1.5v9zm3.25 0h-1.5V9h1.5v9zM14.5 6h-5V3.5h5V6zM16 18h-1.5V9H16v9z"/>
    </svg>
  ),
};

const variantStyles: Record<ActionNotification['variant'], { bg: string; iconBg: string; iconColor: string }> = {
  success: { bg: 'bg-green-500/20', iconBg: 'bg-green-500/20', iconColor: 'text-green-400' },
  info: { bg: 'bg-blue-500/20', iconBg: 'bg-blue-500/10', iconColor: 'text-blue-300' },
  warning: { bg: 'bg-amber-500/20', iconBg: 'bg-amber-500/20', iconColor: 'text-amber-400' },
};

export const NotificationStack: React.FC = () => {
  const { notifications, dismissNotification } = useNotifications();

  if (notifications.length === 0) return null;

  return (
    <div className="space-y-3 mb-6">
      <AnimatePresence mode="popLayout">
        {notifications.map((notif, index) => {
          const Icon = iconMap[notif.icon] || iconMap.info;
          const style = variantStyles[notif.variant];

          return (
            <motion.div
              key={notif.id}
              layout
              initial={{ opacity: 0, y: -30, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.9 }}
              transition={{
                type: 'spring',
                stiffness: 400,
                damping: 30,
                delay: index * 0.05,
              }}
              className="bg-primary text-white rounded-2xl p-5 shadow-2xl border-l-4 border-secondary relative overflow-hidden"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  <div className={`w-10 h-10 rounded-full ${style.iconBg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={20} className={style.iconColor} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] uppercase font-bold text-white/50 tracking-wider mb-0.5">
                      Voice Request Processed
                    </p>
                    <h3 className="font-headline font-extrabold text-base leading-tight">{notif.title}</h3>
                    <p className="text-white/70 text-sm mt-1 leading-snug">{notif.subtitle}</p>

                    {notif.details && notif.details.length > 0 && (
                      <div className="flex flex-wrap gap-3 mt-3">
                        {notif.details.map((d, i) => (
                          <div key={i} className="bg-white/10 rounded-lg px-3 py-2 border border-white/10">
                            <p className="text-[9px] uppercase font-bold text-white/40 tracking-wider">{d.label}</p>
                            <p className="text-sm font-bold">{d.value}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => dismissNotification(notif.id)}
                  className="text-white/40 hover:text-white transition-colors flex-shrink-0 p-1"
                >
                  <X size={16} />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
