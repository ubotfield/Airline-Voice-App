import React, { useState } from 'react';
import { motion } from 'motion/react';

interface SeatMapProps {
  selectedSeat?: string;
  onSelectSeat?: (seatId: string) => void;
}

type SeatStatus = 'available' | 'occupied' | 'selected';

const ROWS = [
  { row: 1, seats: [{ id: '1A', status: 'occupied' }, { id: '1B', status: 'occupied' }] },
  { row: 2, seats: [{ id: '2A', status: 'available' }, { id: '2B', status: 'occupied' }] },
  { row: 3, seats: [{ id: '3A', status: 'available' }, { id: '3B', status: 'available' }] },
  { row: 4, seats: [{ id: '4A', status: 'occupied' }, { id: '4B', status: 'occupied' }] },
  { row: 5, seats: [{ id: '5A', status: 'occupied' }, { id: '5B', status: 'occupied' }] },
] as const;

const SEAT_W = 36;
const SEAT_H = 32;
const GAP_X = 48; // aisle width
const PAD_X = 24;
const PAD_Y = 16;
const ROW_GAP = 8;

export const SeatMap: React.FC<SeatMapProps> = ({ selectedSeat, onSelectSeat }) => {
  const [tappedSeat, setTappedSeat] = useState<string | null>(null);
  const totalW = PAD_X * 2 + SEAT_W * 2 + GAP_X;
  const totalH = PAD_Y * 2 + ROWS.length * (SEAT_H + ROW_GAP) - ROW_GAP + 24; // +24 for header

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

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="bg-surface-container-low rounded-xl p-4 mb-3"
    >
      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-on-surface-variant mb-1">First Class · 737-900</p>
      {onSelectSeat && (
        <p className="text-[9px] text-on-surface-variant/60 mb-3">Tap an available seat or say it aloud</p>
      )}

      <svg viewBox={`0 0 ${totalW} ${totalH}`} className="w-full max-w-[200px] mx-auto" role="img" aria-label="First Class Seat Map">
        {/* Row numbers + Seats */}
        {ROWS.map((row, ri) => {
          const y = PAD_Y + 20 + ri * (SEAT_H + ROW_GAP);
          return (
            <g key={row.row}>
              {/* Row number in aisle */}
              <text
                x={totalW / 2}
                y={y + SEAT_H / 2 + 4}
                textAnchor="middle"
                className="text-[9px] fill-on-surface-variant/40 font-bold"
              >
                {row.row}
              </text>

              {row.seats.map((seat, si) => {
                const x = si === 0 ? PAD_X : PAD_X + SEAT_W + GAP_X;
                const colors = getSeatColor(seat.id, seat.status);
                const isAvailable = seat.status === 'available';
                const isActive = activeSeat?.toUpperCase() === seat.id.toUpperCase();

                return (
                  <g
                    key={seat.id}
                    onClick={() => handleSeatTap(seat.id, seat.status)}
                    style={{ cursor: isAvailable ? 'pointer' : 'default' }}
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
                      rx={4}
                      fill={colors.fill}
                      stroke={colors.stroke}
                      strokeWidth={isActive ? 2.5 : 1.5}
                    />
                    {/* Pulse ring on active seat */}
                    {isActive && (
                      <rect
                        x={x - 3}
                        y={y - 3}
                        width={SEAT_W + 6}
                        height={SEAT_H + 6}
                        rx={6}
                        fill="none"
                        stroke="#d4af37"
                        strokeWidth={1}
                        opacity={0.4}
                      />
                    )}
                    <text
                      x={x + SEAT_W / 2}
                      y={y + SEAT_H / 2 + 4}
                      textAnchor="middle"
                      fill={colors.text}
                      className="text-[8px] font-bold"
                      style={{ pointerEvents: 'none' }}
                    >
                      {seat.id}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Column labels */}
        <text x={PAD_X + SEAT_W / 2} y={PAD_Y + 12} textAnchor="middle" className="text-[8px] fill-on-surface-variant/50 font-bold">A</text>
        <text x={PAD_X + SEAT_W + GAP_X + SEAT_W / 2} y={PAD_Y + 12} textAnchor="middle" className="text-[8px] fill-on-surface-variant/50 font-bold">B</text>
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
    </motion.div>
  );
};
