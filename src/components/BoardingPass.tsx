import React from 'react';
import { motion } from 'motion/react';
import { Plane, Wifi, UtensilsCrossed, Luggage, Smartphone } from 'lucide-react';

export const BoardingPass: React.FC = () => {
  return (
    <div className="max-w-md mx-auto space-y-8">
      {/* Main Boarding Pass Card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-[0_8px_32px_rgba(0,27,60,0.12)] border border-outline-variant/20"
      >
        {/* Pass Header (Midnight Blue Gradient) */}
        <div className="bg-gradient-to-br from-primary-container to-primary px-6 py-8 text-on-primary">
          <div className="flex justify-between items-end mb-6">
            <div>
              <p className="text-on-primary/60 text-[10px] font-bold uppercase tracking-widest mb-1">Atlanta</p>
              <h1 className="font-headline text-5xl font-extrabold tracking-tighter">ATL</h1>
            </div>
            <div className="flex flex-col items-center pb-2">
              <Plane size={28} className="text-on-primary/60" />
              <div className="h-[2px] w-12 bg-white/20 mt-2" />
            </div>
            <div className="text-right">
              <p className="text-on-primary/60 text-[10px] font-bold uppercase tracking-widest mb-1">New York</p>
              <h1 className="font-headline text-5xl font-extrabold tracking-tighter">JFK</h1>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-y-6 pt-6 border-t border-white/10">
            <div>
              <p className="text-on-primary/50 text-[10px] uppercase font-bold tracking-widest">Passenger</p>
              <p className="font-headline font-bold text-lg">JOHNSON / MARCUS</p>
            </div>
            <div className="text-right">
              <p className="text-on-primary/50 text-[10px] uppercase font-bold tracking-widest">Date</p>
              <p className="font-headline font-bold text-lg">10 APR 26</p>
            </div>

            <div className="grid grid-cols-3 col-span-2 bg-white/5 rounded-lg p-4 mt-2">
              <div className="text-center">
                <p className="text-on-primary/50 text-[10px] uppercase font-bold tracking-widest">Gate</p>
                <p className="font-headline font-bold text-xl text-white">B22</p>
              </div>
              <div className="text-center border-x border-white/10">
                <p className="text-on-primary/50 text-[10px] uppercase font-bold tracking-widest">Boarding</p>
                <p className="font-headline font-bold text-xl text-white">08:15</p>
              </div>
              <div className="text-center">
                <p className="text-on-primary/50 text-[10px] uppercase font-bold tracking-widest">Seat</p>
                <p className="font-headline font-bold text-xl text-white">24B</p>
              </div>
            </div>
          </div>
        </div>

        {/* Scannable Area */}
        <div className="px-8 py-10 flex flex-col items-center bg-white border-t border-b border-dashed border-outline-variant/30">
          <div className="mb-8 flex flex-col items-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant mb-4">Scan at Gate</p>
            <div className="bg-white p-3 border border-outline-variant/30 rounded-lg shadow-sm">
              {/* QR Code Placeholder */}
              <div className="w-48 h-48 bg-primary/5 rounded flex items-center justify-center relative overflow-hidden">
                <div className="grid grid-cols-8 gap-[2px] p-4">
                  {Array.from({ length: 64 }).map((_, i) => (
                    <div
                      key={i}
                      className={`w-4 h-4 rounded-sm ${Math.random() > 0.45 ? 'bg-primary' : 'bg-transparent'}`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <p className="mt-4 font-mono text-[10px] text-on-surface-variant tracking-widest">ETKT 0062408315201</p>
          </div>

          <div className="flex justify-between w-full gap-3">
            <div className="flex-1 bg-surface-container-low p-3 rounded-lg text-center">
              <p className="text-on-surface-variant text-[10px] font-bold uppercase mb-1">Status</p>
              <p className="text-secondary font-headline font-extrabold text-sm tracking-tight">GOLD</p>
            </div>
            <div className="flex-1 bg-surface-container-low p-3 rounded-lg text-center">
              <p className="text-on-surface-variant text-[10px] font-bold uppercase mb-1">Zone</p>
              <p className="text-primary font-headline font-extrabold text-sm uppercase">Zone 2</p>
            </div>
            <div className="flex-1 bg-surface-container-low p-3 rounded-lg text-center">
              <p className="text-on-surface-variant text-[10px] font-bold uppercase mb-1">Cabin</p>
              <p className="text-primary font-headline font-extrabold text-sm uppercase">Main</p>
            </div>
          </div>
        </div>

        {/* Utility Section */}
        <div className="bg-surface-container-low p-6 space-y-3">
          <div className="flex items-center justify-between p-4 bg-surface-container-lowest rounded-xl">
            <div className="flex items-center gap-3">
              <UtensilsCrossed size={20} className="text-primary" />
              <p className="font-bold text-sm">Meal Preference</p>
            </div>
            <p className="text-on-surface-variant text-xs font-medium">Standard</p>
          </div>
          <div className="flex items-center justify-between p-4 bg-surface-container-lowest rounded-xl">
            <div className="flex items-center gap-3">
              <Wifi size={20} className="text-primary" />
              <p className="font-bold text-sm">Free Wi-Fi</p>
            </div>
            <span className="bg-primary-container text-white px-2 py-1 rounded text-[10px] font-bold">ACTIVE</span>
          </div>
          <div className="flex items-center justify-between p-4 bg-surface-container-lowest rounded-xl">
            <div className="flex items-center gap-3">
              <Luggage size={20} className="text-primary" />
              <p className="font-bold text-sm">Bag Tracking</p>
            </div>
            <p className="text-primary font-bold text-xs">Checked In (1/1)</p>
          </div>
        </div>
      </motion.div>

      {/* Add to Wallet CTA */}
      <div className="flex flex-col gap-4 items-center">
        <button className="bg-black text-white flex items-center gap-3 px-8 py-4 rounded-xl shadow-lg hover:scale-105 transition-transform duration-200">
          <Smartphone size={20} />
          <span className="font-headline font-bold">Add to Apple Wallet</span>
        </button>
        <p className="text-on-surface-variant text-[10px] font-medium uppercase tracking-widest">
          Flight DL 204 · Operated by Delta Air Lines
        </p>
      </div>
    </div>
  );
};
