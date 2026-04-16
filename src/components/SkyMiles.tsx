import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Star, Plane, ArrowRight } from 'lucide-react';
import { MicFilled } from './icons/MicFilled';

interface SkyMilesProps {
  demoState?: { seat: string; cabin: string; miles: number; milesJustCredited: number; upgradeConfirmed: boolean; milesCredited: boolean };
}

/** Animated number that counts up from previous value to new value */
function AnimatedCounter({ value, duration = 600 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) { setDisplay(to); return; }
    prevRef.current = to;
    const start = performance.now();
    let raf: number;
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{display.toLocaleString()}</>;
}

export const SkyMiles: React.FC<SkyMilesProps> = ({ demoState }) => {
  const miles = demoState?.miles || 42850;
  const isMilesCredited = demoState?.milesCredited === true;

  return (
    <div className="space-y-10">
      {/* Hero SkyMiles Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-br from-primary-container to-primary rounded-xl p-8 text-on-primary relative overflow-hidden"
      >
        <div className="absolute top-0 right-0 p-8 opacity-10">
          <Plane size={120} />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-6">
            <Star size={20} fill="currentColor" />
            <p className="font-bold tracking-tight uppercase text-xs">SkyMiles Medallion</p>
          </div>
          <p className="text-5xl font-extrabold mb-2">
            <AnimatedCounter value={miles} />
          </p>
          <p className="text-on-primary/60 text-sm font-medium">Miles Available</p>

          <div className="mt-8">
            <div className="flex justify-between text-[10px] font-bold mb-2 uppercase tracking-wider">
              <span>Gold Status Progress</span>
              <span>85%</span>
            </div>
            <div className="h-2.5 w-full bg-white/20 rounded-full overflow-hidden">
              <div className="h-full bg-secondary w-[85%] rounded-full shadow-[0_0_12px_rgba(224,25,51,0.5)]" />
            </div>
            <p className="text-xs mt-3 text-on-primary/50">55,000 MQMs · Next: Platinum Medallion</p>
          </div>
        </div>
      </motion.div>

      {/* Quick Stats */}
      <section className="grid grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-surface-container-lowest rounded-xl p-5"
        >
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-1">MQMs Earned</p>
          <p className="text-2xl font-extrabold text-primary">55,000</p>
          <p className="text-[10px] text-on-surface-variant mt-1">of 75,000 for Platinum</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-surface-container-lowest rounded-xl p-5"
        >
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-1">MQDs Earned</p>
          <p className="text-2xl font-extrabold text-primary">$8,200</p>
          <p className="text-[10px] text-on-surface-variant mt-1">of $12,000 for Platinum</p>
        </motion.div>
      </section>

      {/* Voice Prompt */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-surface-container-high rounded-xl p-5 flex items-center gap-4 cursor-pointer hover:bg-surface-container-highest transition-colors"
      >
        <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center text-on-primary flex-shrink-0">
          <MicFilled size={20} />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-primary text-sm">Ask About Your Miles</h3>
          <p className="text-xs text-on-surface-variant">Say "Check my miles" or "Credit missing miles"</p>
        </div>
        <ArrowRight size={18} className="text-on-surface-variant" />
      </motion.div>

      {/* Recent Activity */}
      <section className="space-y-4">
        <h2 className="text-lg font-extrabold text-primary tracking-tight">Recent Activity</h2>
        {[
          { route: 'ATL → LAX', flight: 'DL 423', date: 'Mar 15, 2026', miles: '+2,847', status: 'Pending' },
          { route: 'JFK → ATL', flight: 'DL 891', date: 'Mar 10, 2026', miles: '+1,200', status: 'Credited' },
          { route: 'ATL → SFO', flight: 'DL 1156', date: 'Feb 28, 2026', miles: '+3,450', status: 'Credited' },
          { route: 'LAX → ATL', flight: 'DL 520', date: 'Feb 20, 2026', miles: '+2,847', status: 'Credited' },
        ].map((activity, i) => {
          // If miles were credited via voice, flip the ATL→LAX "Pending" to "Credited"
          const displayStatus = (activity.status === 'Pending' && isMilesCredited) ? 'Credited' : activity.status;

          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + i * 0.05 }}
              className="bg-surface-container-lowest rounded-xl p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center">
                  <Plane size={16} className="text-primary" />
                </div>
                <div>
                  <p className="font-bold text-sm text-primary">{activity.route}</p>
                  <p className="text-[10px] text-on-surface-variant">{activity.flight} · {activity.date}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-bold text-sm text-primary">{activity.miles}</p>
                <p className={`text-[10px] font-bold ${displayStatus === 'Pending' ? 'text-amber-500' : 'text-green-600'}`}>
                  {displayStatus === 'Credited' && activity.status === 'Pending' ? 'Credited ✓' : displayStatus}
                </p>
              </div>
            </motion.div>
          );
        })}
      </section>
    </div>
  );
};
