import React, { useState } from 'react';
import { User, Settings, CreditCard, ShieldCheck, LogOut, Mic, Star, ChevronRight, Plane } from 'lucide-react';
import { PersonalInfo } from './PersonalInfo';

export const Profile: React.FC = () => {
  const [showPersonalInfo, setShowPersonalInfo] = useState(false);

  if (showPersonalInfo) {
    return <PersonalInfo onBack={() => setShowPersonalInfo(false)} />;
  }

  return (
    <div className="space-y-10">
      <section className="flex items-center gap-6 p-4">
        <div className="w-24 h-24 rounded-full bg-primary-container overflow-hidden border-4 border-primary/20">
          <img
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuA-VbsUrhdq7dOm4YgojIxNGQhUdD90xpSAkzNfirKNHEmH1TPGA2qG3fye-kdk5vR7Ko7IJtIyWul36fwFQ5L6iZk1ox0y95FYxQtFhzHzbgeGyBa0fLNIQYpbZRov6V-dIZDGb_JJtSY667YwRGu9BIJjcIxFAsenX12fjcIGh8kK6MXw2a_RQ3AfAcjN_9LqVkeoE-kdUPIaEarYQK49MCB596qu5vhfKLpsrN2c58kfh3hpZ5WVGAE3HPJ3hH-xCVmw9oTyap0a"
            alt="Marcus Johnson"
            className="w-full h-full object-cover"
          />
        </div>
        <div>
          <h2 className="font-headline text-3xl font-black text-primary">Marcus Johnson</h2>
          <p className="text-xs text-on-surface/60 font-bold uppercase tracking-widest">Gold Medallion Member</p>
        </div>
      </section>

      {/* SkyMiles Medallion Card */}
      <div className="bg-gradient-to-br from-primary-container to-primary rounded-2xl p-6 text-on-primary space-y-4 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-6 opacity-10">
          <Plane size={80} />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <Star size={24} fill="currentColor" />
            <span className="font-headline font-black text-lg uppercase tracking-wide">SkyMiles Medallion</span>
          </div>
          <div className="mt-3">
            <p className="text-4xl font-extrabold">42,850</p>
            <p className="text-on-primary/70 text-sm font-medium mt-1">Miles Available</p>
          </div>
          <div className="mt-4">
            <div className="flex justify-between text-[10px] font-bold mb-2 uppercase tracking-wider">
              <span>Gold Status Progress</span>
              <span>85%</span>
            </div>
            <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden">
              <div className="h-full bg-secondary w-[85%] rounded-full shadow-[0_0_12px_rgba(224,25,51,0.5)]" />
            </div>
            <p className="text-[10px] mt-2 text-on-primary/60">55,000 MQMs · Next: Platinum</p>
          </div>
          <div className="flex items-center gap-2 bg-white/15 rounded-full px-4 py-2 w-fit mt-4">
            <Mic size={16} fill="currentColor" />
            <span className="text-sm font-bold">Say "Check my miles balance"</span>
          </div>
        </div>
      </div>

      <nav className="space-y-2">
        {/* Personal Info — wired to panel */}
        <button
          onClick={() => setShowPersonalInfo(true)}
          className="w-full flex items-center gap-4 px-6 py-5 text-on-surface hover:bg-surface-container-high rounded-xl transition-all font-headline font-semibold text-lg text-left"
        >
          <User size={24} className="text-primary" />
          <span className="flex-1">Personal Info</span>
          <ChevronRight size={20} className="text-on-surface/30" />
        </button>

        {/* Other nav items */}
        {[
          { icon: CreditCard, label: "Payment Methods" },
          { icon: ShieldCheck, label: "Privacy & Security" },
          { icon: Settings, label: "App Settings" },
        ].map((item, i) => (
          <button
            key={i}
            className="w-full flex items-center gap-4 px-6 py-5 text-on-surface hover:bg-surface-container-high rounded-xl transition-all font-headline font-semibold text-lg text-left"
          >
            <item.icon size={24} className="text-primary" />
            <span>{item.label}</span>
          </button>
        ))}

        <button className="w-full flex items-center gap-4 px-6 py-5 text-primary hover:bg-primary/5 rounded-xl transition-all font-headline font-semibold text-lg text-left mt-8">
          <LogOut size={24} />
          <span>Sign Out</span>
        </button>
      </nav>
    </div>
  );
};
