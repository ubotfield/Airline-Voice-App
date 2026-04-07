import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Save, Trash2, User, Phone, Mail, Star, Ticket, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { apiUrl } from '../lib/api-base';

interface PersonalInfoProps {
  onBack: () => void;
}

interface DemoPersona {
  id: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  skymilesNumber: string;
  pnr: string;
  isConfigured: boolean;
}

export const PersonalInfo: React.FC<PersonalInfoProps> = ({ onBack }) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [skymilesNumber, setSkymilesNumber] = useState('');
  const [pnr, setPnr] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    loadPersona();
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  async function loadPersona() {
    try {
      const res = await fetch(apiUrl('/api/demo-persona'));
      if (res.ok) {
        const data: DemoPersona = await res.json();
        setName(data.customerName);
        setPhone(data.customerPhone);
        setEmail(data.customerEmail);
        setSkymilesNumber(data.skymilesNumber || '');
        setPnr(data.pnr || '');
      }
    } catch (err) {
      console.error('Failed to load persona:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/demo-persona'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: name,
          customerPhone: phone,
          customerEmail: email,
          skymilesNumber,
          pnr,
        }),
      });
      if (res.ok) {
        setToast({ type: 'success', message: 'Saved! Agent will use this info.' });
      } else {
        setToast({ type: 'error', message: 'Failed to save. Try again.' });
      }
    } catch {
      setToast({ type: 'error', message: 'Network error. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/demo-persona'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: '',
          customerPhone: '',
          customerEmail: '',
          skymilesNumber: '',
          pnr: '',
        }),
      });
      if (res.ok) {
        setName('');
        setPhone('');
        setEmail('');
        setSkymilesNumber('');
        setPnr('');
        setToast({ type: 'success', message: 'Cleared! Agent will ask the customer.' });
      }
    } catch {
      setToast({ type: 'error', message: 'Failed to clear. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={32} className="text-primary animate-spin" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -30 }}
      className="space-y-8"
    >
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-primary/10 transition-colors"
        >
          <ArrowLeft size={20} className="text-on-surface" />
        </button>
        <h2 className="font-headline text-3xl font-extrabold tracking-tight">Personal Info</h2>
      </div>

      {/* Info card */}
      <div className="bg-primary-container/50 rounded-2xl p-5 text-sm text-on-surface/70 font-medium">
        Pre-fill customer info so the voice agent skips asking during demos. Leave empty for the agent to ask naturally.
      </div>

      {/* Form */}
      <div className="space-y-5">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-bold text-on-surface/60 uppercase tracking-widest">
            <User size={16} /> Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marcus Johnson"
            className="w-full bg-surface-container-high rounded-xl px-5 py-4 text-on-surface font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-bold text-on-surface/60 uppercase tracking-widest">
            <Phone size={16} /> Phone
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 4045551234"
            className="w-full bg-surface-container-high rounded-xl px-5 py-4 text-on-surface font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-bold text-on-surface/60 uppercase tracking-widest">
            <Mail size={16} /> Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. marcus.johnson@email.com"
            className="w-full bg-surface-container-high rounded-xl px-5 py-4 text-on-surface font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-bold text-on-surface/60 uppercase tracking-widest">
            <Star size={16} /> SkyMiles Number
          </label>
          <input
            type="text"
            value={skymilesNumber}
            onChange={(e) => setSkymilesNumber(e.target.value)}
            placeholder="e.g. 1234567890"
            className="w-full bg-surface-container-high rounded-xl px-5 py-4 text-on-surface font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-bold text-on-surface/60 uppercase tracking-widest">
            <Ticket size={16} /> Booking PNR
          </label>
          <input
            type="text"
            value={pnr}
            onChange={(e) => setPnr(e.target.value)}
            placeholder="e.g. GHTK92"
            className="w-full bg-surface-container-high rounded-xl px-5 py-4 text-on-surface font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-on-primary rounded-xl py-4 font-headline font-bold text-lg hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? <Loader2 size={20} className="animate-spin" /> : <Save size={20} />}
          Save
        </button>
        <button
          onClick={handleClear}
          disabled={saving || (!name && !phone && !email && !skymilesNumber && !pnr)}
          className="flex items-center justify-center gap-2 bg-surface-container-high text-on-surface/70 rounded-xl px-6 py-4 font-headline font-bold text-lg hover:bg-error/10 hover:text-error transition-all disabled:opacity-30"
        >
          <Trash2 size={20} />
          Clear
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className={`fixed bottom-28 left-4 right-4 mx-auto max-w-md flex items-center gap-3 rounded-xl px-5 py-4 shadow-lg z-[60] ${
            toast.type === 'success'
              ? 'bg-green-800 text-green-50'
              : 'bg-red-800 text-red-50'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
          <span className="font-medium">{toast.message}</span>
        </motion.div>
      )}
    </motion.div>
  );
};
