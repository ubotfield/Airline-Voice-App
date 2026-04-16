import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plane, Clock, MapPin, ChevronRight } from 'lucide-react';

interface TripsProps {
  onViewBoardingPass: () => void;
  onCheckIn: () => void;
  demoState?: { seat: string; cabin: string; miles: number; milesJustCredited: number; upgradeConfirmed: boolean; milesCredited: boolean };
}

export const Trips: React.FC<TripsProps> = ({ onViewBoardingPass, onCheckIn, demoState }) => {
  const seat = demoState?.seat || "24B";
  const isUpgraded = demoState?.upgradeConfirmed === true;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-extrabold text-primary tracking-tight mb-1">My Trips</h2>
        <p className="text-on-surface-variant text-sm">Your upcoming and recent journeys</p>
      </div>

      {/* Upcoming Flight — Main Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm"
      >
        <div className="bg-gradient-to-r from-primary-container to-primary p-6 text-on-primary">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Upcoming · On Time</span>
          </div>
          <div className="flex justify-between items-end">
            <div>
              <p className="text-3xl font-extrabold tracking-tight">ATL</p>
              <p className="text-xs text-on-primary/60">Atlanta</p>
            </div>
            <div className="flex flex-col items-center px-6">
              <Plane size={18} className="text-on-primary/50 rotate-90" />
              <div className="w-24 h-px bg-white/20 my-2" />
              <span className="text-[10px] text-on-primary/50 font-bold">2h 15m</span>
            </div>
            <div className="text-right">
              <p className="text-3xl font-extrabold tracking-tight">JFK</p>
              <p className="text-xs text-on-primary/60">New York</p>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <div>
              <p className="text-[10px] text-on-surface-variant font-bold uppercase">Flight</p>
              <p className="font-bold text-primary text-sm">DL 204</p>
            </div>
            <div>
              <p className="text-[10px] text-on-surface-variant font-bold uppercase">Date</p>
              <p className="font-bold text-primary text-sm">Apr 10</p>
            </div>
            <div>
              <p className="text-[10px] text-on-surface-variant font-bold uppercase">Depart</p>
              <p className="font-bold text-primary text-sm">8:45 AM</p>
            </div>
            <div>
              <p className="text-[10px] text-on-surface-variant font-bold uppercase">Seat</p>
              <motion.p
                key={seat}
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                className={`font-bold text-sm ${isUpgraded ? 'text-[#d4af37]' : 'text-primary'}`}
              >
                {seat}
              </motion.p>
            </div>
          </div>

          {/* Cabin badge when upgraded */}
          <AnimatePresence>
            {isUpgraded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-gradient-to-r from-[#d4af37]/10 to-[#d4af37]/5 rounded-lg px-4 py-2 flex items-center gap-2"
              >
                <span className="text-[10px] font-black uppercase tracking-widest text-[#b8960c]">First Class</span>
                <span className="text-[10px] text-[#b8960c]/60">· Seat {seat}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-3">
            <button
              onClick={onCheckIn}
              className="flex-1 bg-secondary text-white py-3 rounded-lg font-bold text-sm hover:brightness-110 active:scale-[0.98] transition-all shadow-md shadow-secondary/20"
            >
              Check In
            </button>
            <button
              onClick={onViewBoardingPass}
              className="flex-1 bg-surface-container-high text-primary py-3 rounded-lg font-bold text-sm hover:bg-surface-container-highest transition-colors"
            >
              Boarding Pass
            </button>
          </div>
        </div>
      </motion.div>

      {/* Past Flights */}
      <section className="space-y-4">
        <h3 className="text-lg font-extrabold text-primary tracking-tight">Recent Trips</h3>
        {[
          { from: 'ATL', to: 'LAX', fromCity: 'Atlanta', toCity: 'Los Angeles', flight: 'DL 423', date: 'Mar 15, 2026', status: 'Completed' },
          { from: 'JFK', to: 'ATL', fromCity: 'New York', toCity: 'Atlanta', flight: 'DL 891', date: 'Mar 10, 2026', status: 'Completed' },
          { from: 'ATL', to: 'SFO', fromCity: 'Atlanta', toCity: 'San Francisco', flight: 'DL 1156', date: 'Feb 28, 2026', status: 'Completed' },
        ].map((trip, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.05 }}
            className="bg-surface-container-lowest rounded-xl p-4 flex items-center justify-between group cursor-pointer hover:bg-surface-container-low transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center">
                <Plane size={16} className="text-primary" />
              </div>
              <div>
                <p className="font-bold text-sm text-primary">{trip.from} → {trip.to}</p>
                <p className="text-[10px] text-on-surface-variant">{trip.flight} · {trip.date}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-1 rounded-full">{trip.status}</span>
              <ChevronRight size={16} className="text-on-surface-variant/30" />
            </div>
          </motion.div>
        ))}
      </section>
    </div>
  );
};
