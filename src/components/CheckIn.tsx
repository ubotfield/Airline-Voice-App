import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Plane, Plus, Minus, Info, ChevronRight, CheckCircle } from 'lucide-react';
import { MicFilled } from './icons/MicFilled';

type CheckInStep = 'flight' | 'bags' | 'review';

export const CheckIn: React.FC = () => {
  const [activeStep, setActiveStep] = useState<CheckInStep>('bags');
  const [bagCount, setBagCount] = useState(1);

  const steps: { id: CheckInStep; label: string }[] = [
    { id: 'flight', label: 'Flight' },
    { id: 'bags', label: 'Bags & Seats' },
    { id: 'review', label: 'Review' },
  ];

  const bagPrice = bagCount * 30;

  return (
    <div className="space-y-6">
      {/* Voice Interaction Banner */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-primary-container text-white p-5 rounded-2xl shadow-xl flex items-center gap-5 border-b-4 border-secondary"
      >
        <div className="flex-shrink-0 w-12 h-12 bg-secondary rounded-full flex items-center justify-center animate-pulse">
          <MicFilled size={20} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/70">Delta Assistant</span>
            <CheckCircle size={12} className="text-white/70" />
          </div>
          <p className="font-headline text-base font-bold leading-tight">
            "I've started your check-in for flight DL 204."
          </p>
        </div>
      </motion.div>

      {/* Progress Steps */}
      <nav className="flex justify-between items-center border-b border-outline-variant/20 pb-4">
        {steps.map((step) => (
          <button
            key={step.id}
            onClick={() => setActiveStep(step.id)}
            className={`flex-1 text-center relative pb-2 ${
              activeStep === step.id
                ? 'text-primary font-bold'
                : 'text-on-surface-variant'
            }`}
          >
            <span className="font-headline text-xs uppercase tracking-widest">{step.label}</span>
            {activeStep === step.id && (
              <motion.div
                layoutId="step-indicator"
                className="absolute bottom-0 left-0 right-0 h-[3px] bg-secondary rounded-full"
              />
            )}
          </button>
        ))}
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Main Flow */}
        <div className="lg:col-span-8 space-y-6">
          {/* Flight Header Card */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-surface-container-lowest rounded-xl p-6 overflow-hidden relative"
          >
            <div className="absolute top-0 right-0 p-6 opacity-5">
              <Plane size={80} />
            </div>
            <div className="flex justify-between items-start relative z-10">
              <div>
                <div className="text-secondary font-bold text-xs tracking-tight mb-2 uppercase">Now Checking In</div>
                <h1 className="font-headline text-3xl font-extrabold tracking-tight text-primary mb-1">DL 204</h1>
                <p className="text-on-surface-variant font-medium text-sm">Atlanta (ATL) to New York (JFK)</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-headline font-bold text-primary">8:45 AM</div>
                <div className="text-xs font-medium text-on-surface-variant">Gate B22</div>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-4 py-3 px-5 bg-surface-container-low rounded-lg border-l-4 border-primary">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-primary flex-shrink-0">
                <path d="M7.59 5.41c-.78-.78-.78-2.05 0-2.83.78-.78 2.05-.78 2.83 0 .78.78.78 2.05 0 2.83-.79.79-2.05.79-2.83 0zM6 16V7H4v9c0 2.76 2.24 5 5 5h6v-2H9c-1.66 0-3-1.34-3-3zm14 4.07L14.93 15H11.5v-3.68c1.4 1.15 3.6 2.16 5.5 2.16v-2.16c-1.66.02-3.61-.87-4.67-2.04l-1.4-1.55c-.19-.21-.43-.38-.69-.5-.29-.14-.62-.23-.96-.23h-.03C8.01 7 7 8.01 7 9.25V15c0 1.66 1.34 3 3 3h5.07l3.5 3.5L20 20.07z"/>
              </svg>
              <div>
                <span className="block text-[10px] uppercase text-on-surface-variant font-bold">Current Seat</span>
                <span className="font-headline text-base font-bold text-primary">24B · Main Cabin</span>
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-green-700 bg-green-100 px-3 py-1 rounded-full">
                <CheckCircle size={12} />
                <span className="text-[10px] font-bold uppercase tracking-tight">Confirmed</span>
              </div>
            </div>
          </motion.div>

          {/* Bag Selection Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="bg-surface-container-lowest p-6 rounded-xl flex flex-col justify-between border-2 border-secondary/20"
            >
              <div>
                <div className="flex justify-between items-start mb-2">
                  <h3 className="font-headline text-xl font-bold text-primary">Checked Bags</h3>
                  {bagCount > 0 && (
                    <span className="bg-secondary text-white text-[10px] font-black px-2 py-1 rounded uppercase tracking-widest">
                      Added
                    </span>
                  )}
                </div>
                <p className="text-on-surface-variant text-sm mb-5 leading-relaxed">
                  Add checked bags for your flight to JFK.
                </p>
              </div>
              <div className="flex items-center justify-between border-t border-outline-variant/20 pt-5">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setBagCount(Math.max(0, bagCount - 1))}
                    className="w-10 h-10 rounded-full border border-outline-variant flex items-center justify-center text-primary hover:bg-surface-container-high transition-colors"
                  >
                    <Minus size={16} />
                  </button>
                  <span className="font-headline text-2xl font-bold w-6 text-center">{bagCount}</span>
                  <button
                    onClick={() => setBagCount(Math.min(5, bagCount + 1))}
                    className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-white hover:opacity-90 transition-opacity"
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold text-on-surface-variant uppercase">Estimated Fees</div>
                  <div className="text-xl font-headline font-bold text-primary">${bagPrice}.00</div>
                </div>
              </div>
            </motion.div>

            {/* SkyPriority Card */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="relative overflow-hidden rounded-xl bg-gradient-to-br from-primary-container to-primary text-white p-6 group"
            >
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                </svg>
              </div>
              <div className="relative z-10 h-full flex flex-col justify-between">
                <div>
                  <div className="inline-flex items-center gap-2 px-3 py-1 bg-secondary rounded-full text-[10px] font-bold uppercase tracking-widest mb-4">
                    Gold Medallion
                  </div>
                  <h3 className="font-headline text-xl font-bold mb-2">SkyPriority®</h3>
                  <p className="text-white/60 text-sm leading-relaxed">
                    Accelerate your journey with dedicated check-in and security lanes.
                  </p>
                </div>
                <button className="mt-5 flex items-center gap-2 text-sm font-bold group-hover:gap-4 transition-all">
                  VIEW BENEFITS <ChevronRight size={16} />
                </button>
              </div>
            </motion.div>
          </div>

          {/* Bag Allowance Info */}
          <div className="bg-surface-container-low p-5 rounded-xl">
            <div className="flex items-start gap-3">
              <Info size={18} className="text-on-surface-variant flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-sm text-primary mb-1">Standard Bag Allowance</h4>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  Gold Medallion members receive complimentary first checked bag. Additional checked bag fees are based on your destination.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Summary Sidebar */}
        <aside className="lg:col-span-4 space-y-6">
          <div className="bg-surface-container-lowest rounded-xl p-6 sticky top-24 shadow-sm border border-outline-variant/10">
            <h3 className="font-headline text-lg font-extrabold text-primary mb-5">Journey Summary</h3>
            <div className="space-y-3 mb-6">
              {[
                { label: 'Passenger', value: 'Marcus Johnson' },
                { label: 'Seat', value: '24B (Main Cabin)' },
                { label: 'Bags', value: `${bagCount} Bag${bagCount !== 1 ? 's' : ''}` },
              ].map((item) => (
                <div key={item.label} className="flex justify-between items-center py-3 border-b border-outline-variant/10">
                  <span className="text-on-surface-variant text-sm font-medium">{item.label}</span>
                  <span className="text-primary font-bold text-sm">{item.value}</span>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center mb-6">
              <span className="text-on-surface-variant font-bold text-sm uppercase tracking-tighter">Total Due</span>
              <span className="text-3xl font-headline font-black text-primary">${bagPrice}.00</span>
            </div>

            <button className="w-full bg-secondary text-white font-headline font-bold py-4 rounded-lg active:scale-[0.98] transition-transform shadow-lg shadow-secondary/20 uppercase tracking-widest text-sm">
              Complete Check-in
            </button>

            <p className="text-[10px] text-center text-on-surface-variant mt-5 px-2 uppercase tracking-tighter leading-tight">
              By clicking complete, you agree to the hazardous materials regulations and Delta's contract of carriage.
            </p>
          </div>

          {/* Upgrade Available Card */}
          <div className="rounded-xl overflow-hidden h-48 relative">
            <img
              alt="Delta Aircraft Wing"
              className="w-full h-full object-cover"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBykWOAlcrkHEK-b0MWM37DElzj3xZgUkyVKdDiFF8ugWm7DeaYh6P-fkqf7Wwb9QxCYfMJCo63wDj9IWt4LKfrLxGEPclngEvm5FnOJOIy4-kRIo6LnE9SQplYHXh7AfHggl9_UqwW97a-lzNQu3eq4WVWPZQHt6Wkzt01xyPU6MiZ4vaJDvxklAqmA9k5bRZbq_G_iN-3JTEF1676xl1kg9D2HZWbdXJV9yfoI6lWdZY5qoUzHo0ILCgTB4E2PA9srDJi74wYUkZi"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-primary/80 to-transparent flex flex-col justify-end p-6">
              <span className="text-white text-xs font-bold uppercase tracking-widest mb-1">Upgrade Available</span>
              <p className="text-white font-headline text-sm font-bold">First Class starting at 5,000 miles</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
