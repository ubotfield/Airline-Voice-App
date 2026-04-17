import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2 } from 'lucide-react';

interface MilesCreditConfirmationProps {
  /** Miles credited, e.g. 2847 */
  milesAdded: number;
  /** Previous balance before credit */
  previousBalance: number;
  /** New balance after credit */
  newBalance: number;
  /** Flight number, e.g. "DL 423" */
  flightNumber?: string;
  /** Route, e.g. "ATL → LAX" */
  route?: string;
  /** Flight date, e.g. "March 28, 2025" */
  flightDate?: string;
  /** PNR, e.g. "GHTK92" */
  pnr?: string;
  /** Transaction reference, e.g. "TXN-88291-DELTA" */
  transactionRef?: string;
}

/**
 * Miles Credit Confirmation Card — renders inline in the voice assistant
 * drawer after miles are successfully credited. Shows an animated counter
 * ticking from previous balance to new balance, flight details, and
 * transaction reference.
 *
 * Matches spec Use Case 1, Step 7 (page 5).
 */
export const MilesCreditConfirmation: React.FC<MilesCreditConfirmationProps> = ({
  milesAdded,
  previousBalance,
  newBalance,
  flightNumber = 'DL 423',
  route = 'ATL → LAX',
  flightDate = 'March 28, 2025',
  pnr = 'GHTK92',
  transactionRef = 'TXN-88291-DELTA',
}) => {
  // Animated counter — ticks from previousBalance to newBalance over 300ms
  const [displayBalance, setDisplayBalance] = useState(previousBalance);

  useEffect(() => {
    const duration = 800; // ms
    const steps = 30;
    const increment = (newBalance - previousBalance) / steps;
    let step = 0;

    const timer = setInterval(() => {
      step++;
      if (step >= steps) {
        setDisplayBalance(newBalance);
        clearInterval(timer);
      } else {
        setDisplayBalance(Math.round(previousBalance + increment * step));
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [previousBalance, newBalance]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className="bg-surface-container-low rounded-2xl overflow-hidden shadow-xl mb-4"
    >
      {/* Success Header — dark gradient with checkmark */}
      <div className="bg-gradient-to-br from-primary-container to-primary px-5 pt-6 pb-5 text-center relative overflow-hidden">
        {/* Background decorative circle */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 bg-white/5 rounded-full" />

        <motion.div
          initial={{ scale: 0, rotate: -180 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 15, delay: 0.2 }}
          className="relative z-10 mb-3"
        >
          <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center mx-auto">
            <CheckCircle2 size={28} className="text-green-400" />
          </div>
        </motion.div>

        <h3 className="font-headline font-extrabold text-lg text-white relative z-10">
          Miles Successfully Credited!
        </h3>
        <p className="text-white/50 text-xs mt-1 relative z-10">
          Your SkyMiles balance has been updated
        </p>
      </div>

      {/* Miles Counter — large animated number */}
      <div className="bg-white px-5 py-6 text-center">
        <motion.p
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.3, type: 'spring', stiffness: 300 }}
          className="text-4xl font-headline font-black text-secondary tracking-tight"
        >
          +{milesAdded.toLocaleString()}
        </motion.p>
        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-on-surface-variant mt-1">
          Miles Added to Account
        </p>

        {/* Balance transition */}
        <div className="flex items-center justify-center gap-2 mt-3">
          <span className="text-sm text-on-surface-variant/60 line-through">
            {previousBalance.toLocaleString()}
          </span>
          <span className="text-on-surface-variant/40">→</span>
          <motion.span
            className="text-lg font-headline font-bold text-primary"
          >
            {displayBalance.toLocaleString()} miles
          </motion.span>
        </div>
      </div>

      {/* Flight Details */}
      <div className="px-5 py-4 space-y-2.5">
        <DetailRow label="Flight" value={`${flightNumber} · ${route}`} />
        <DetailRow label="Flight Date" value={flightDate} />
        <DetailRow label="PNR" value={pnr} />
        <DetailRow
          label="Miles Credited"
          value={`+${milesAdded.toLocaleString()} miles`}
          valueClassName="text-secondary font-bold"
        />
        <DetailRow label="New Balance" value={`${newBalance.toLocaleString()} miles`} />
      </div>

      {/* Transaction Reference */}
      <div className="px-5 py-3 bg-surface-container/50 flex items-center justify-between">
        <span className="text-[8px] font-black uppercase tracking-[0.15em] text-on-surface-variant/50">
          Transaction Ref
        </span>
        <span className="text-[10px] font-mono font-bold text-on-surface-variant/70">
          {transactionRef}
        </span>
      </div>

      {/* CTA Button */}
      <button
        onClick={() => { try { navigator?.vibrate?.(15); } catch {} }}
        className="w-full bg-primary text-white py-3.5 font-headline font-bold text-sm flex items-center justify-center gap-2 hover:bg-primary-dim active:scale-[0.98] transition-all"
      >
        View SkyMiles Account →
      </button>
    </motion.div>
  );
};

/** Row component for flight detail key-value pairs */
const DetailRow: React.FC<{
  label: string;
  value: string;
  valueClassName?: string;
}> = ({ label, value, valueClassName = '' }) => (
  <div className="flex items-center justify-between">
    <span className="text-xs text-on-surface-variant/60">{label}</span>
    <span className={`text-sm font-medium text-on-surface ${valueClassName}`}>{value}</span>
  </div>
);
