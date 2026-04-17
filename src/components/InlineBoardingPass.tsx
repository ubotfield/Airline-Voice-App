import React from 'react';
import { motion } from 'motion/react';
import { Plane, Smartphone } from 'lucide-react';
import { DeltaLogo } from './icons/DeltaLogo';

interface InlineBoardingPassProps {
  seat: string;
  cabin: string;
  /** Miles deducted for upgrade, e.g. "15,000" */
  milesUsed?: string;
  /** New balance after upgrade */
  newBalance?: string;
}

/**
 * Compact boarding pass card rendered inline in the voice assistant drawer
 * after an upgrade is confirmed. Matches the spec's "Updated First Class
 * Boarding Pass" design (page 11).
 */
export const InlineBoardingPass: React.FC<InlineBoardingPassProps> = ({
  seat,
  cabin,
  milesUsed,
  newBalance,
}) => {
  const isFirstClass = cabin.toLowerCase().includes('first');

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, rotateX: 15 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25, delay: 0.2 }}
      className="rounded-2xl overflow-hidden shadow-xl mb-4"
    >
      {/* Header — Midnight Blue Gradient */}
      <div className="bg-gradient-to-br from-primary-container to-primary px-5 py-5 text-on-primary relative">
        {/* Delta logo + cabin badge */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DeltaLogo size={16} />
            <span className="font-headline font-extrabold text-sm tracking-tight">DELTA</span>
          </div>
          {isFirstClass && (
            <span className="bg-[#d4af37] text-white text-[8px] font-black px-2 py-1 rounded uppercase tracking-widest">
              ✦ First Class
            </span>
          )}
        </div>

        {/* Passenger */}
        <p className="text-on-primary/50 text-[8px] uppercase font-bold tracking-widest">Passenger</p>
        <p className="font-headline font-bold text-base mb-4">Marcus Johnson</p>

        {/* Route */}
        <div className="flex items-center gap-3 mb-3">
          <div>
            <p className="font-headline text-3xl font-extrabold tracking-tighter">ATL</p>
            <p className="text-on-primary/50 text-[8px] uppercase">Atlanta</p>
          </div>
          <div className="flex flex-col items-center flex-1 px-2">
            <span className="text-[8px] text-on-primary/50 font-bold mb-1">DL 204 · Apr 10</span>
            <div className="w-full h-px bg-white/20 relative">
              <Plane size={10} className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 text-secondary" />
            </div>
          </div>
          <div className="text-right">
            <p className="font-headline text-3xl font-extrabold tracking-tighter">JFK</p>
            <p className="text-on-primary/50 text-[8px] uppercase">New York</p>
          </div>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-4 bg-white/5 rounded-lg p-3 gap-1">
          <div className="text-center">
            <p className="text-on-primary/50 text-[7px] uppercase font-bold tracking-widest">Departs</p>
            <p className="font-headline font-bold text-sm">8:45 AM</p>
          </div>
          <div className="text-center border-x border-white/10">
            <p className="text-on-primary/50 text-[7px] uppercase font-bold tracking-widest">Gate</p>
            <p className="font-headline font-bold text-sm">B22</p>
          </div>
          <div className="text-center border-r border-white/10">
            <p className="text-on-primary/50 text-[7px] uppercase font-bold tracking-widest">Boarding</p>
            <p className="font-headline font-bold text-sm">Group 1</p>
          </div>
          <div className="text-center">
            <p className="text-on-primary/50 text-[7px] uppercase font-bold tracking-widest">Status</p>
            <p className="font-headline font-bold text-sm text-[#d4af37]">Priority</p>
          </div>
        </div>
      </div>

      {/* Seat Assignment — white section */}
      <div className="bg-white px-5 py-4">
        <div className="flex items-center gap-3 bg-surface-container-low rounded-xl p-3">
          <Plane size={18} className="text-primary flex-shrink-0" />
          <div>
            <p className="text-[8px] text-on-surface-variant uppercase font-bold tracking-widest">Seat Assignment</p>
            <p className="font-headline font-bold text-lg text-primary">
              {seat} · Window
            </p>
            <p className="text-[9px] text-on-surface-variant">{cabin} · Upgraded ✓</p>
          </div>
        </div>

        {/* Barcode placeholder */}
        <div className="mt-3 flex flex-col items-center">
          <div className="w-full h-10 bg-[repeating-linear-gradient(90deg,#003366_0px,#003366_2px,transparent_2px,transparent_4px)] opacity-80 rounded" />
          <p className="mt-1 font-mono text-[7px] text-on-surface-variant tracking-[0.15em]">
            M1JOHNSON/MARCUS GHTK92 ATLJFKDL 0204 106Y008C002A
          </p>
        </div>
      </div>

      {/* Miles deduction footer */}
      {milesUsed && (
        <div className="bg-surface-container-low px-5 py-3 flex items-center justify-between">
          <motion.span
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 }}
            className="text-secondary font-bold text-sm"
          >
            –{milesUsed} miles used for upgrade
          </motion.span>
          {newBalance && (
            <span className="text-on-surface-variant text-xs font-medium">
              Balance: {newBalance}
            </span>
          )}
        </div>
      )}

      {/* Add to Wallet CTA */}
      <button
        onClick={() => { try { navigator?.vibrate?.(15); } catch {} }}
        className="w-full bg-black text-white py-3 font-headline font-bold text-sm flex items-center justify-center gap-2 hover:bg-gray-900 active:scale-[0.98] transition-all"
      >
        <Smartphone size={16} />
        Add to Apple Wallet
      </button>
    </motion.div>
  );
};
