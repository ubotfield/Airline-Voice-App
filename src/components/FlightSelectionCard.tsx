import React from 'react';
import { motion } from 'motion/react';
import { Plane, ChevronRight } from 'lucide-react';

export interface RecentFlight {
  from: string;
  fromCity: string;
  to: string;
  toCity: string;
  flightNumber: string;
  date: string;
  pnr: string;
  status: 'pending' | 'credited';
}

interface FlightSelectionCardProps {
  flights: RecentFlight[];
  /** Called when user taps a flight row */
  onSelectFlight?: (flight: RecentFlight) => void;
  /** Highlight a specific PNR (e.g. after voice/tap selection) */
  selectedPnr?: string;
}

/**
 * Flight Selection Card — renders inline in the voice assistant drawer.
 * Shows a tappable list of recently flown flights with miles status badges.
 * Per spec (Use Case 1, Step 3): ATL→LAX shows "Pending" in amber,
 * all other flights show "Credited ✓" in green.
 */
export const FlightSelectionCard: React.FC<FlightSelectionCardProps> = ({
  flights,
  onSelectFlight,
  selectedPnr,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className="bg-surface-container-low rounded-2xl overflow-hidden mb-4"
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <Plane size={14} className="text-secondary" />
          <p className="text-[10px] font-black uppercase tracking-[0.15em] text-on-surface-variant">
            Select the flight with missing miles
          </p>
        </div>
        <p className="text-[9px] text-on-surface-variant/60">
          Tap to select the affected flight
        </p>
      </div>

      {/* Flight List */}
      <div className="divide-y divide-outline-variant/10">
        {flights.map((flight, i) => {
          const isSelected = selectedPnr?.toUpperCase() === flight.pnr.toUpperCase();
          const isPending = flight.status === 'pending';

          return (
            <motion.button
              key={flight.pnr}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.06 }}
              onClick={() => {
                try { navigator?.vibrate?.(10); } catch {}
                onSelectFlight?.(flight);
              }}
              className={`w-full px-5 py-4 flex items-center gap-3 text-left transition-all active:scale-[0.98] ${
                isSelected
                  ? 'bg-primary/5 border-l-3 border-primary'
                  : 'hover:bg-surface-container'
              }`}
            >
              {/* Plane icon */}
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                isPending ? 'bg-amber-50' : 'bg-surface-container'
              }`}>
                <Plane
                  size={16}
                  className={isPending ? 'text-amber-600 rotate-45' : 'text-primary/40 rotate-45'}
                />
              </div>

              {/* Flight info */}
              <div className="flex-1 min-w-0">
                <p className="font-headline font-bold text-sm text-primary truncate">
                  {flight.fromCity} → {flight.toCity}
                </p>
                <p className="text-[10px] text-on-surface-variant truncate">
                  {flight.flightNumber} · {flight.date} · PNR: {flight.pnr}
                </p>
              </div>

              {/* Status badge */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {isPending ? (
                  <span className="text-[9px] font-black uppercase tracking-wider text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                    Pending
                  </span>
                ) : (
                  <span className="text-[9px] font-black uppercase tracking-wider text-green-700 bg-green-50 px-2.5 py-1 rounded-full">
                    ✓ Credited
                  </span>
                )}
                <ChevronRight size={14} className="text-on-surface-variant/30" />
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 bg-surface-container/50">
        <p className="text-[9px] text-on-surface-variant/50 text-center font-medium">
          Last 30 days · {flights.length} flights
        </p>
      </div>
    </motion.div>
  );
};

/**
 * Default demo flights matching the spec (Use Case 1, page 3).
 * ATL→LAX is "Pending", all others are "Credited".
 */
export const DEMO_RECENT_FLIGHTS: RecentFlight[] = [
  {
    from: 'ATL', fromCity: 'Atlanta',
    to: 'LAX', toCity: 'Los Angeles',
    flightNumber: 'DL 423', date: 'Mar 28, 2025',
    pnr: 'GHTK92', status: 'pending',
  },
  {
    from: 'JFK', fromCity: 'New York',
    to: 'ATL', toCity: 'Atlanta',
    flightNumber: 'DL 110', date: 'Mar 21, 2025',
    pnr: 'BXNM44', status: 'credited',
  },
  {
    from: 'ORD', fromCity: 'Chicago',
    to: 'ATL', toCity: 'Atlanta',
    flightNumber: 'DL 882', date: 'Mar 14, 2025',
    pnr: 'RQZP71', status: 'credited',
  },
  {
    from: 'ATL', fromCity: 'Atlanta',
    to: 'BOS', toCity: 'Boston',
    flightNumber: 'DL 551', date: 'Mar 8, 2025',
    pnr: 'KLWZ29', status: 'credited',
  },
];
