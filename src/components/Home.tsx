import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, Plane, Star, Clock, Shield, X, CheckCircle, Mic } from 'lucide-react';
import { MicFilled } from './icons/MicFilled';

interface HomeProps {
  onNavigate: (tab: string) => void;
  voiceResult?: { userText: string; agentText: string } | null;
  onDismissVoiceResult?: () => void;
  demoState?: { seat: string; cabin: string; miles: number; milesJustCredited: number; upgradeConfirmed: boolean; milesCredited: boolean };
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

/** Extract key results from agent text for the Voice Request Processed card */
function extractVoiceResults(agentText: string): Array<{ icon: 'check' | 'seat' | 'miles' | 'flight'; label: string; value: string }> {
  const results: Array<{ icon: 'check' | 'seat' | 'miles' | 'flight'; label: string; value: string }> = [];
  const lower = agentText.toLowerCase();

  // Miles/points detection
  const milesMatch = agentText.match(/([\d,]+)\s*miles/i);
  if (milesMatch) {
    results.push({ icon: 'check', label: 'Loyalty Points', value: `${milesMatch[1]} Miles` });
  }

  // Tier detection
  const tierMatch = agentText.match(/(gold|silver|platinum|diamond)\s*medallion/i);
  if (tierMatch) {
    results.push({ icon: 'miles', label: 'Medallion Status', value: tierMatch[0] });
  }

  // Seat detection
  const seatMatch = agentText.match(/seat\s*(\w{2,4})/i);
  if (seatMatch) {
    results.push({ icon: 'seat', label: 'Seat Update', value: `Updated to ${seatMatch[1]}` });
  }

  // Flight detection
  const flightMatch = agentText.match(/DL\s*\d+/i);
  if (flightMatch) {
    results.push({ icon: 'flight', label: 'Flight', value: flightMatch[0] });
  }

  // Gate detection
  const gateMatch = agentText.match(/gate\s*(\w+)/i);
  if (gateMatch) {
    results.push({ icon: 'check', label: 'Gate Info', value: `Gate ${gateMatch[1]}` });
  }

  // If nothing specific, show a generic result
  if (results.length === 0) {
    // Take first sentence as summary
    const firstSentence = agentText.split(/[.!?]/)[0]?.trim();
    if (firstSentence) {
      results.push({ icon: 'check', label: 'Response', value: firstSentence.substring(0, 60) + (firstSentence.length > 60 ? '...' : '') });
    }
  }

  return results.slice(0, 2); // Max 2 items for the card
}

export const Home: React.FC<HomeProps> = ({ onNavigate, voiceResult, onDismissVoiceResult, demoState }) => {
  return (
    <div className="space-y-8">
      {/* Hero: Upcoming Flight Card */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div
          whileHover={{ scale: 1.01 }}
          className="lg:col-span-2 bg-surface-container-lowest rounded-xl p-8 flex flex-col justify-between relative overflow-hidden group"
        >
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <Plane size={120} />
          </div>
          <div className="relative z-10">
            <div className="flex justify-between items-start mb-6">
              <div>
                <p className="text-xs font-bold text-on-surface-variant tracking-widest uppercase mb-1">{getGreeting()}, Marcus</p>
                <h2 className="font-headline text-3xl font-extrabold text-primary tracking-tight">ATL → JFK</h2>
              </div>
              <div className="bg-primary-container text-on-primary px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                On Time
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
              <div>
                <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">Departure</p>
                <p className="text-xl font-bold text-primary">8:45 AM</p>
              </div>
              <div>
                <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">Gate</p>
                <p className="text-xl font-bold text-primary">B22</p>
              </div>
              <div>
                <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">Seat</p>
                <p className="text-xl font-bold text-primary">{demoState?.seat || "24B"}</p>
              </div>
              {demoState?.cabin && demoState.cabin !== "Main Cabin" && (
                <div>
                  <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">Cabin</p>
                  <motion.p
                    key={demoState.cabin}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="text-xl font-bold text-secondary"
                  >
                    {demoState.cabin}
                  </motion.p>
                </div>
              )}
              <div>
                <p className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider">Flight</p>
                <p className="text-xl font-bold text-primary">DL 204</p>
              </div>
            </div>
          </div>

          <div className="relative z-10">
            <button
              onClick={() => onNavigate('checkin')}
              className="w-full bg-secondary text-on-secondary py-4 rounded-md font-bold text-base hover:brightness-110 active:scale-[0.98] transition-all shadow-lg shadow-secondary/20"
            >
              Check In
            </button>
          </div>
        </motion.div>

        {/* SkyMiles Card */}
        <motion.div
          whileHover={{ scale: 1.01 }}
          onClick={() => onNavigate('skymiles')}
          className="bg-gradient-to-br from-primary-container to-primary rounded-xl p-8 flex flex-col justify-between text-on-primary cursor-pointer"
        >
          <div>
            <div className="flex items-center gap-2 mb-6">
              <Star size={18} fill="currentColor" />
              <p className="font-bold tracking-tight uppercase text-xs">SkyMiles Medallion</p>
            </div>
            <p className="text-4xl font-extrabold mb-1">
              {(demoState?.miles || 42850).toLocaleString()}
              {demoState?.milesJustCredited ? (
                <motion.span
                  key={demoState.milesJustCredited}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-sm font-bold text-green-400 ml-2"
                >
                  +{demoState.milesJustCredited.toLocaleString()}
                </motion.span>
              ) : null}
            </p>
            <p className="text-on-primary-container text-sm font-medium">Miles Available</p>
          </div>
          <div className="mt-6">
            <div className="flex justify-between text-[10px] font-bold mb-2 uppercase tracking-wider">
              <span>Gold Status Progress</span>
              <span>85%</span>
            </div>
            <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden">
              <div className="h-full bg-secondary w-[85%] rounded-full shadow-[0_0_12px_rgba(224,25,51,0.5)]" />
            </div>
            <p className="text-[10px] mt-3 text-on-primary-container">55,000 MQMs · Next: Platinum</p>
          </div>
        </motion.div>
      </section>

      {/* ── Voice Request Processed Card ── */}
      <AnimatePresence>
        {voiceResult && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="bg-primary text-white rounded-2xl p-6 shadow-2xl border-l-4 border-secondary"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="bg-secondary rounded-full p-2 flex items-center justify-center animate-pulse">
                  <Mic size={18} className="text-white" />
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-on-primary-container">Voice Request Processed</p>
                  <h3 className="font-headline font-extrabold text-base italic">"{voiceResult.userText}"</h3>
                </div>
              </div>
              <button
                onClick={onDismissVoiceResult}
                className="text-white/60 hover:text-white transition-colors p-1"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {extractVoiceResults(voiceResult.agentText).map((item, idx) => (
                <div key={idx} className="bg-white/10 rounded-xl p-4 flex items-center gap-4 border border-white/10">
                  <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 flex-shrink-0">
                    <CheckCircle size={20} />
                  </div>
                  <div>
                    <p className="text-[10px] uppercase font-bold text-white/50 tracking-wider">{item.label}</p>
                    <p className="text-base font-bold">{item.value}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick Action Cards */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Delta Assistant Card */}
        <motion.div
          whileHover={{ scale: 1.02 }}
          className="lg:col-span-2 bg-surface-container-high rounded-xl p-6 flex items-center gap-5 group cursor-pointer hover:bg-surface-container-highest transition-all"
        >
          <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-on-primary shadow-inner flex-shrink-0">
            <MicFilled size={24} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-primary mb-0.5">Delta Sky Assistant</h3>
            <p className="text-sm text-on-surface-variant leading-relaxed">Ask about flights, upgrades, miles, or baggage with voice commands.</p>
          </div>
        </motion.div>

        {/* Weather Card */}
        <motion.div
          whileHover={{ scale: 1.02 }}
          className="bg-surface-container-lowest rounded-xl p-5 flex flex-col justify-between"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">New York</p>
              <p className="text-2xl font-bold text-primary">72°F</p>
            </div>
            <span className="text-2xl">☀️</span>
          </div>
          <p className="text-[10px] text-on-surface-variant mt-3">Clear skies at JFK</p>
        </motion.div>

        {/* Security Wait Card */}
        <motion.div
          whileHover={{ scale: 1.02 }}
          className="bg-surface-container-lowest rounded-xl p-5 flex flex-col justify-between"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Security</p>
              <p className="text-2xl font-bold text-primary">5-8 min</p>
            </div>
            <Clock size={24} className="text-primary" />
          </div>
          <p className="text-[10px] text-on-surface-variant mt-3">Wait time at ATL South</p>
        </motion.div>
      </section>

      {/* Explore Destinations */}
      <section className="space-y-4">
        <div className="flex justify-between items-end">
          <div>
            <h2 className="text-xl font-extrabold text-primary tracking-tight">Explore Destinations</h2>
            <p className="text-on-surface-variant text-xs">Curated for your next escape</p>
          </div>
          <button className="text-secondary font-bold text-xs flex items-center gap-1">
            View All <ArrowRight size={14} />
          </button>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-4 -mx-6 px-6" style={{ scrollbarWidth: 'none' }}>
          {[
            { city: 'Sydney, Australia', desc: 'Vibrant harbor life', price: '$849', img: 'https://lh3.googleusercontent.com/aida-public/AB6AXuA4LW-GXF598myGhJtrpF5IvbHS5olEenpWIIs4fmJqIsLYLu1rN0tLhBsgjmVxbmER8aQ-X6waV39x3j0vpzm_I7ofYOHFzbwfT74ZinIM2epXqWm-S4PJqXhK7hLH3Li2NpBCkm1FzoII3GorNlV_bQjwhI5G-AaJprInVig3TJ71SwDSsnArtwOY11LzRa5IDxi4rnFRiSzQC-IWk9bTWGom9VnUltrGZ3Z4k93J32J7V7U4pLNxEb7GIWqYArtorcAkksakqusM' },
            { city: 'Kyoto, Japan', desc: 'Temples & serene gardens', price: '$1,120', img: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAG1RyuELEpyheqa1nzrrsbqTveUp5xf072DLisRJC_ysHdzdhOksopWj7NFHgo1vvuNEZhP_sk-_cogv-ytzrKWmfmLvniXzTxSszixwcy3y-fBY2jcRWDYvPgqKzNsTKO5kAQMXnXM6-dfw81Ws3HP_QacdlYTHL4IPzBnlZzNuwfwynnTIsVcHY4fsbB4QfNlBzFHwtf1uQVP_R_8qmBQvtOkgm_2bVJ3NWg3e-zBZQhqaY4rge7MY6xrkSjmlPcwRgNQw-peWVA' },
            { city: 'Santorini, Greece', desc: 'Blue domed vistas', price: '$965', img: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCYkMSpFAsEkSREgl3Ok-ODJyn02e4f7YoOm4FnRKYYaIWP8loGQKmhv-caCAe839IkWRq7DX3C0F87y-WVFZxUdDcvekH81al_BxppXGQSgnFz45QERbonzsVxPH2xI1iMQm6k5wzU7MzZneI2jAD_QV7UzpurlEhtF-_np0wI0hCJkTclIXmSgoyBwodFl8UOFFKLrFIHFYDvpejEu55Chc-0wPLRVDDidvx3wF56b86NfLhnCkqGAdRWlm4QwD-mYkYnpYXvYWl_' },
            { city: 'Paris, France', desc: 'World-class cuisine', price: '$750', img: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCQdURnS2QTKkxLrzJtqOR2IgwI_0igCrTFMqpD4Fs4YfDuaNVWAXa9RbwQfuMUFMRTBlRVC8km1vYqSR6Z_ahydfI-0o3uI9c0nUIZ3Dg3TutWlzc2CyE5puEaVMnQ2JlaNWFssmBDxjamPJamEDJf-dWPzD6-zXX9ppttmEpfwS0oHkvV7E5GNmaSBQphdiigdPgHT9qkwWqcs3tsnC2XJ9Armq1YoAC_Ml6mkdIK6pvzwXb9SZK2seTemhi8E6p5-pkKAxGRY-Pt' },
          ].map((dest) => (
            <motion.div key={dest.city} whileHover={{ scale: 1.02 }} className="flex-none w-64 group cursor-pointer">
              <div className="h-40 w-full rounded-xl overflow-hidden mb-3 relative">
                <img
                  alt={dest.city}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  src={dest.img}
                />
                <div className="absolute top-2 right-2 bg-white/90 backdrop-blur text-primary px-3 py-1 rounded-full text-[10px] font-bold shadow-sm">
                  from {dest.price}
                </div>
              </div>
              <h4 className="font-bold text-primary text-sm">{dest.city}</h4>
              <p className="text-[10px] text-on-surface-variant">{dest.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
};
