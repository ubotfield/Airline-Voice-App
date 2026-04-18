import React, { useState } from 'react';
import { motion } from 'motion/react';

interface SeatMapProps {
  selectedSeat?: string;
  onSelectSeat?: (seatId: string) => void;
  /** Optional pricing info to show below the map */
  pricing?: { miles: string; copay: string; cash: string };
  /** Callback when user taps "Confirm Upgrade" */
  onConfirm?: (paymentMethod: 'miles' | 'cash') => void;
}

type SeatStatus = 'available' | 'occupied' | 'selected';

/**
 * First Class layout — Boeing 737-900
 * 4 columns: A B (aisle) C D, 5 rows
 * Per spec: seats 2A, 3A, 3B are available; rest occupied.
 * 2A is the "window" seat the customer will most likely pick.
 */
const ROWS = [
  { row: 1, seats: [
    { id: '1A', status: 'occupied' }, { id: '1B', status: 'occupied' },
    { id: '1C', status: 'occupied' }, { id: '1D', status: 'occupied' },
  ]},
  { row: 2, seats: [
    { id: '2A', status: 'available' }, { id: '2B', status: 'occupied' },
    { id: '2C', status: 'occupied' }, { id: '2D', status: 'occupied' },
  ]},
  { row: 3, seats: [
    { id: '3A', status: 'available' }, { id: '3B', status: 'available' },
    { id: '3C', status: 'occupied' }, { id: '3D', status: 'occupied' },
  ]},
  { row: 4, seats: [
    { id: '4A', status: 'occupied' }, { id: '4B', status: 'occupied' },
    { id: '4C', status: 'occupied' }, { id: '4D', status: 'occupied' },
  ]},
  { row: 5, seats: [
    { id: '5A', status: 'occupied' }, { id: '5B', status: 'occupied' },
    { id: '5C', status: 'occupied' }, { id: '5D', status: 'occupied' },
  ]},
] as const;

const SEAT_W = 28;
const SEAT_H = 24;
const GAP_X = 28;   // aisle width between B and C columns
const COL_GAP = 6;  // gap between A-B and C-D
const PAD_X = 16;
const PAD_Y = 12;
const ROW_GAP = 6;
const HEADER_H = 48; // space for nose + labels

export const SeatMap: React.FC<SeatMapProps> = ({ selectedSeat, onSelectSeat, pricing, onConfirm }) => {
  const [tappedSeat, setTappedSeat] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'miles' | 'cash'>('miles');

  // 4 columns: A B | aisle | C D
  const leftGroupW = SEAT_W * 2 + COL_GAP;
  const rightGroupW = SEAT_W * 2 + COL_GAP;
  const totalW = PAD_X * 2 + leftGroupW + GAP_X + rightGroupW;
  const mapBodyH = ROWS.length * (SEAT_H + ROW_GAP) - ROW_GAP;
  const totalH = PAD_Y + HEADER_H + mapBodyH + PAD_Y;

  const activeSeat = tappedSeat || selectedSeat;

  const getSeatColor = (id: string, baseStatus: string): { fill: string; stroke: string; text: string } => {
    const isSelected = activeSeat?.toUpperCase() === id.toUpperCase();
    if (isSelected) return { fill: '#d4af37', stroke: '#b8960c', text: '#fff' };
    if (baseStatus === 'available') return { fill: 'transparent', stroke: '#003366', text: '#003366' };
    return { fill: '#9ca3af', stroke: '#6b7280', text: '#fff' };
  };

  const handleSeatTap = (seatId: string, status: string) => {
    if (status !== 'available') return;
    try { navigator?.vibrate?.(10); } catch {}
    setTappedSeat(seatId);
    onSelectSeat?.(seatId);
  };

  // Column X positions
  const colX = {
    A: PAD_X,
    B: PAD_X + SEAT_W + COL_GAP,
    C: PAD_X + leftGroupW + GAP_X,
    D: PAD_X + leftGroupW + GAP_X + SEAT_W + COL_GAP,
  };
  const colOrder = ['A', 'B', 'C', 'D'] as const;

  const availableCount = ROWS.reduce((count, r) => count + r.seats.filter(s => s.status === 'available').length, 0);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="bg-surface-container-low rounded-xl p-4 mb-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-black uppercase tracking-[0.15em] text-on-surface-variant">
          First Class Upgrade
        </p>
        <span className="text-[9px] font-bold text-secondary bg-secondary/10 px-2 py-0.5 rounded-full">
          {availableCount} seats open
        </span>
      </div>
      <p className="text-[9px] text-on-surface-variant/60 mb-1">DL 204 · ATL → JFK · Apr 10</p>
      {onSelectSeat && (
        <p className="text-[9px] text-on-surface-variant/60 mb-3">Tap an available seat or say it aloud</p>
      )}

      {/* SVG Seat Map */}
      <svg
        viewBox={`0 0 ${totalW} ${totalH}`}
        className="w-full max-w-[260px] mx-auto"
        role="img"
        aria-label="First Class Seat Map — Boeing 737-900"
        style={{ touchAction: 'manipulation' }}
      >
        {/* Aircraft Nose */}
        <path
          d={`M ${totalW / 2 - 20} ${PAD_Y + 16} Q ${totalW / 2} ${PAD_Y - 2} ${totalW / 2 + 20} ${PAD_Y + 16}`}
          fill="none"
          stroke="#c3c6d1"
          strokeWidth={1.5}
        />
        {/* Nose label */}
        <text
          x={totalW / 2}
          y={PAD_Y + 11}
          textAnchor="middle"
          className="text-[6px] fill-on-surface-variant/40 font-bold uppercase"
        >
          NOSE
        </text>

        {/* Section label */}
        <text
          x={totalW / 2}
          y={PAD_Y + 25}
          textAnchor="middle"
          className="text-[6px] fill-secondary font-bold uppercase"
        >
          ✦ FIRST CLASS ✦
        </text>

        {/* Column labels */}
        {colOrder.map((col) => (
          <text
            key={col}
            x={colX[col] + SEAT_W / 2}
            y={PAD_Y + 38}
            textAnchor="middle"
            className="text-[7px] fill-on-surface-variant/50 font-bold"
          >
            {col}
          </text>
        ))}

        {/* Rows */}
        {ROWS.map((row, ri) => {
          const y = PAD_Y + HEADER_H + ri * (SEAT_H + ROW_GAP);
          return (
            <g key={row.row}>
              {/* Row number in aisle */}
              <text
                x={PAD_X + leftGroupW + GAP_X / 2}
                y={y + SEAT_H / 2 + 3}
                textAnchor="middle"
                className="text-[7px] fill-on-surface-variant/40 font-bold"
              >
                {row.row}
              </text>

              {row.seats.map((seat) => {
                const col = seat.id.slice(-1) as 'A' | 'B' | 'C' | 'D';
                const x = colX[col];
                const colors = getSeatColor(seat.id, seat.status);
                const isAvailable = seat.status === 'available';
                const isActive = activeSeat?.toUpperCase() === seat.id.toUpperCase();

                return (
                  <g
                    key={seat.id}
                    onClick={(e) => { e.preventDefault(); handleSeatTap(seat.id, seat.status); }}
                    onTouchEnd={(e) => {
                      if (isAvailable) {
                        e.preventDefault();
                        e.stopPropagation();
                        handleSeatTap(seat.id, seat.status);
                      }
                    }}
                    onPointerDown={(e) => {
                      if (isAvailable) {
                        e.stopPropagation();
                      }
                    }}
                    style={{ cursor: isAvailable ? 'pointer' : 'default', touchAction: 'manipulation' }}
                    role={isAvailable ? 'button' : undefined}
                    aria-label={isAvailable ? `Select seat ${seat.id}` : `Seat ${seat.id} occupied`}
                    tabIndex={isAvailable ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (isAvailable && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        handleSeatTap(seat.id, seat.status);
                      }
                    }}
                  >
                    <rect
                      x={x}
                      y={y}
                      width={SEAT_W}
                      height={SEAT_H}
                      rx={3}
                      fill={colors.fill}
                      stroke={colors.stroke}
                      strokeWidth={isActive ? 2 : 1.2}
                    />
                    {/* Pulse ring on active seat */}
                    {isActive && (
                      <rect
                        x={x - 2}
                        y={y - 2}
                        width={SEAT_W + 4}
                        height={SEAT_H + 4}
                        rx={5}
                        fill="none"
                        stroke="#d4af37"
                        strokeWidth={1}
                        opacity={0.4}
                      />
                    )}
                    {/* Checkmark for selected, label for others */}
                    {isActive ? (
                      <text
                        x={x + SEAT_W / 2}
                        y={y + SEAT_H / 2 + 3}
                        textAnchor="middle"
                        fill={colors.text}
                        className="text-[7px] font-bold"
                        style={{ pointerEvents: 'none' }}
                      >
                        ✓{seat.id}
                      </text>
                    ) : (
                      <text
                        x={x + SEAT_W / 2}
                        y={y + SEAT_H / 2 + 3}
                        textAnchor="middle"
                        fill={colors.text}
                        className="text-[6px] font-bold"
                        style={{ pointerEvents: 'none' }}
                      >
                        {seat.id}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex justify-center gap-4 mt-3">
        {[
          { label: 'Available', color: 'border-2 border-primary' },
          { label: 'Occupied', color: 'bg-gray-400' },
          { label: 'Selected', color: 'bg-[#d4af37]' },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded-sm ${item.color}`} />
            <span className="text-[8px] text-on-surface-variant font-medium">{item.label}</span>
          </div>
        ))}
      </div>

      {/* ── Pricing Toggle (Miles+Copay vs Cash) — only when pricing data available ── */}
      {pricing && activeSeat && (
        <div className="mt-4 pt-3 border-t border-outline-variant/20">
          <p className="text-[9px] font-black uppercase tracking-[0.12em] text-on-surface-variant mb-2">
            Upgrade Pricing · Seat {activeSeat}
          </p>
          <div className="flex gap-2">
            {/* Miles option */}
            <button
              onClick={() => { setPaymentMethod('miles'); try { navigator?.vibrate?.(5); } catch {} }}
              className={`flex-1 p-3 rounded-xl border-2 transition-all text-left ${
                paymentMethod === 'miles'
                  ? 'border-primary bg-primary/5'
                  : 'border-outline-variant/20 bg-surface-container-lowest'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                  paymentMethod === 'miles' ? 'border-primary' : 'border-outline-variant'
                }`}>
                  {paymentMethod === 'miles' && (
                    <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </div>
                <span className="text-[10px] font-bold text-primary">{pricing.miles} miles</span>
              </div>
              <p className="text-[9px] text-on-surface-variant ml-[18px]">+ ${pricing.copay} charge</p>
            </button>

            {/* Cash option */}
            <button
              onClick={() => { setPaymentMethod('cash'); try { navigator?.vibrate?.(5); } catch {} }}
              className={`flex-1 p-3 rounded-xl border-2 transition-all text-left ${
                paymentMethod === 'cash'
                  ? 'border-primary bg-primary/5'
                  : 'border-outline-variant/20 bg-surface-container-lowest'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                  paymentMethod === 'cash' ? 'border-primary' : 'border-outline-variant'
                }`}>
                  {paymentMethod === 'cash' && (
                    <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </div>
                <span className="text-[10px] font-bold text-primary">${pricing.cash}</span>
              </div>
              <p className="text-[9px] text-on-surface-variant ml-[18px]">Full cash upgrade</p>
            </button>
          </div>
        </div>
      )}

      {/* ── Confirm Button — always visible when a seat is selected, even without pricing ── */}
      {onConfirm && activeSeat && (
        <div className={pricing ? "" : "mt-4 pt-3 border-t border-outline-variant/20"}>
          <button
            onClick={() => { try { navigator?.vibrate?.(15); } catch {} onConfirm(paymentMethod); }}
            className="w-full mt-3 bg-secondary text-white py-3.5 rounded-xl font-headline font-bold text-sm shadow-md hover:bg-secondary/90 active:scale-[0.98] transition-all"
          >
            Confirm Upgrade to Seat {activeSeat} →
          </button>
        </div>
      )}
    </motion.div>
  );
};
