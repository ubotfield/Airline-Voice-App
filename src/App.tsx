import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Home as HomeIcon, Plane, Star, MoreHorizontal } from 'lucide-react';
import { MicFilled } from './components/icons/MicFilled';
import { DeltaLogo } from './components/icons/DeltaLogo';
import { Home } from './components/Home';
import { Trips } from './components/Trips';
import { BoardingPass } from './components/BoardingPass';
import { CheckIn } from './components/CheckIn';
import { SkyMiles } from './components/SkyMiles';
import { Profile } from './components/Profile';
import { VoiceAssistant } from './components/VoiceAssistant';
import { NotificationStack } from './components/NotificationStack';
import { NotificationProvider } from './lib/notifications';
import { DebugConsole } from './components/DebugConsole';
import { apiUrl } from './lib/api-base';

type Tab = 'home' | 'trips' | 'boardingpass' | 'checkin' | 'skymiles' | 'profile';

export interface DemoState {
  seat: string;
  cabin: string;
  miles: number;
  milesJustCredited: number;
  upgradeConfirmed: boolean;
  milesCredited: boolean;
}

const DEMO_STATE_DEFAULTS: DemoState = {
  seat: "24B", cabin: "Main Cabin", miles: 42850,
  milesJustCredited: 0, upgradeConfirmed: false, milesCredited: false,
};

function AppContent() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceResult, setVoiceResult] = useState<{ userText: string; agentText: string } | null>(null);

  // ─── Live demo state: updated when agent confirms actions ───
  const [demoState, setDemoState] = useState<DemoState>({ ...DEMO_STATE_DEFAULTS });
  const [resetToast, setResetToast] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doReset = () => {
    setDemoState({ ...DEMO_STATE_DEFAULTS });
    setVoiceResult(null);
    fetch(apiUrl("/api/demo-reset"), { method: "POST" }).catch(() => {});
    setResetToast(true);
    setTimeout(() => setResetToast(false), 1500);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'home':
        return <Home onNavigate={(tab: string) => setActiveTab(tab as Tab)} voiceResult={voiceResult} onDismissVoiceResult={() => setVoiceResult(null)} demoState={demoState} />;
      case 'trips':
        return (
          <Trips
            onViewBoardingPass={() => setActiveTab('boardingpass')}
            onCheckIn={() => setActiveTab('checkin')}
            demoState={demoState}
          />
        );
      case 'boardingpass':
        return <BoardingPass demoState={demoState} />;
      case 'checkin':
        return <CheckIn />;
      case 'skymiles':
        return <SkyMiles demoState={demoState} />;
      case 'profile':
        return <Profile />;
    }
  };

  // Map sub-pages to their parent tab for bottom nav highlighting
  const activeNavTab = (() => {
    if (activeTab === 'boardingpass' || activeTab === 'checkin') return 'trips';
    return activeTab;
  })();

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Top App Bar */}
      <header className="bg-surface/90 backdrop-blur-md flex justify-between items-center w-full px-6 py-4 fixed top-0 z-50 border-b border-outline-variant/20" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-3">
          <div
            className="select-none cursor-pointer flex items-center gap-2.5"
            onMouseDown={() => { resetTimerRef.current = setTimeout(doReset, 3000); }}
            onMouseUp={() => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }}
            onTouchStart={() => { resetTimerRef.current = setTimeout(doReset, 3000); }}
            onTouchEnd={() => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }}
          >
            <DeltaLogo size={26} />
            <h1 className="font-headline font-extrabold text-xl tracking-tighter text-primary uppercase">Fly Delta</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="text-on-surface-variant hover:text-primary transition-colors p-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </button>
          <div className="w-9 h-9 rounded-full bg-primary-container overflow-hidden border-2 border-primary-dim">
            <img
              alt="Marcus Johnson"
              className="w-full h-full object-cover"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuA-VbsUrhdq7dOm4YgojIxNGQhUdD90xpSAkzNfirKNHEmH1TPGA2qG3fye-kdk5vR7Ko7IJtIyWul36fwFQ5L6iZk1ox0y95FYxQtFhzHzbgeGyBa0fLNIQYpbZRov6V-dIZDGb_JJtSY667YwRGu9BIJjcIxFAsenX12fjcIGh8kK6MXw2a_RQ3AfAcjN_9LqVkeoE-kdUPIaEarYQK49MCB596qu5vhfKLpsrN2c58kfh3hpZ5WVGAE3HPJ3hH-xCVmw9oTyap0a"
            />
          </div>
        </div>
      </header>

      {/* Demo Reset Toast */}
      <AnimatePresence>
        {resetToast && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[200] bg-primary text-white px-4 py-2 rounded-full text-xs font-bold shadow-lg"
          >
            Demo Reset ✓
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-grow pt-24 pb-32 px-6 max-w-5xl mx-auto w-full">
        {/* Cascading Notification Stack */}
        <NotificationStack />

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Voice Assistant — triggered from bottom nav */}
      <VoiceAssistant
        isOpen={voiceOpen}
        onToggle={() => setVoiceOpen(false)}
        onVoiceResult={(result) => {
          setVoiceResult(result);
          const lower = result.agentText.toLowerCase();

          // Upgrade confirmed → update seat + cabin on home screen
          if ((lower.includes("upgrade") && (lower.includes("confirmed") || lower.includes("complete"))) ||
              lower.includes("upgraded to first class") || lower.includes("upgrade has been")) {
            const seatMatch = result.agentText.match(/seat\s*(\w{2,4})/i);
            setDemoState(prev => ({
              ...prev,
              cabin: "First Class",
              seat: seatMatch?.[1] || "2A",
              upgradeConfirmed: true,
            }));
          }

          // Miles credited → update miles balance on home screen
          if (lower.includes("credited") && lower.includes("miles")) {
            const milesMatch = result.agentText.match(/([\d,]+)\s*miles/i);
            const credited = milesMatch ? parseInt(milesMatch[1].replace(/,/g, ""), 10) : 2847;
            setDemoState(prev => ({
              ...prev,
              miles: prev.miles + credited,
              milesJustCredited: credited,
              milesCredited: true,
            }));
          }
        }}
      />

      {/* In-App Debug Console */}
      <DebugConsole />

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-end px-4 pb-8 pt-3 bg-white/80 backdrop-blur-xl rounded-t-2xl shadow-[0_-4px_24px_rgba(0,27,60,0.1)]">
        {[
          { id: 'home', icon: HomeIcon, label: 'Home' },
          { id: 'trips', icon: Plane, label: 'My Trips' },
          { id: 'assistant', label: 'Assistant', isSpecial: true },
          { id: 'skymiles', icon: Star, label: 'SkyMiles' },
          { id: 'profile', icon: MoreHorizontal, label: 'More' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              if (tab.id === 'assistant') {
                setVoiceOpen(v => !v);
              } else {
                setActiveTab(tab.id as Tab);
              }
            }}
            className={`flex flex-col items-center justify-center px-3 py-1 transition-all duration-300 ${
              tab.isSpecial
                ? 'text-secondary font-bold'
                : activeNavTab === tab.id
                  ? 'text-primary-dim'
                  : 'text-on-surface-variant hover:text-primary-dim'
            }`}
          >
            {tab.isSpecial ? (
              <div className="relative -mt-7">
                <div className={`w-16 h-16 rounded-full bg-secondary flex items-center justify-center shadow-[0_0_0_6px_rgba(224,25,51,0.15)] ${voiceOpen ? 'animate-pulse' : ''}`}>
                  <MicFilled size={28} className="text-white" />
                </div>
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-white rounded-full animate-ping" />
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-white rounded-full" />
              </div>
            ) : (
              <tab.icon size={22} fill={activeNavTab === tab.id ? "currentColor" : "none"} />
            )}
            <span className="font-body font-medium text-[10px] tracking-wide mt-1">
              {tab.label}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <NotificationProvider>
      <AppContent />
    </NotificationProvider>
  );
}
