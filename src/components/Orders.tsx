import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Mic, ReceiptText, AudioLines, Send, CheckCircle, AlertCircle, Loader2, Mail } from 'lucide-react';
import { apiUrl } from '../lib/api-base';

export const Orders: React.FC = () => {
  const [orderNumber, setOrderNumber] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Load demo persona email as default
  useEffect(() => {
    fetch(apiUrl('/api/demo-persona'))
      .then(r => r.json())
      .then(data => {
        if (data.customerEmail) setRecipientEmail(data.customerEmail);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  async function handleSendReceipt() {
    if (!orderNumber.trim() || !recipientEmail.trim()) {
      setToast({ type: 'error', message: 'Enter both order number and email.' });
      return;
    }
    setSending(true);
    try {
      const res = await fetch(apiUrl('/api/send-receipt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: orderNumber.trim(), customerEmail: recipientEmail.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setToast({ type: 'success', message: data.result || 'Receipt sent!' });
      } else {
        setToast({ type: 'error', message: data.error || 'Failed to send receipt.' });
      }
    } catch {
      setToast({ type: 'error', message: 'Network error. Try again.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-10">
      <section className="space-y-2">
        <h2 className="font-headline text-4xl font-extrabold tracking-tight">Orders</h2>
        <p className="text-on-surface/70 font-medium">Track and manage your orders.</p>
      </section>

      {/* Send Receipt card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-br from-primary/5 to-primary/10 rounded-2xl p-6 space-y-5 border border-primary/10"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center">
            <Mail size={20} className="text-on-primary" />
          </div>
          <div>
            <h3 className="font-headline text-lg font-black text-on-surface">Send Receipt</h3>
            <p className="text-on-surface/50 text-xs font-medium">Email a receipt for any order</p>
          </div>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            placeholder="Order number (e.g. Order-0017)"
            className="w-full bg-white/80 rounded-xl px-4 py-3 text-on-surface text-sm font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
          <input
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            placeholder="Email address"
            className="w-full bg-white/80 rounded-xl px-4 py-3 text-on-surface text-sm font-medium placeholder:text-on-surface/30 outline-none focus:ring-2 focus:ring-primary/40 transition-all"
          />
        </div>

        <button
          onClick={handleSendReceipt}
          disabled={sending || !orderNumber.trim() || !recipientEmail.trim()}
          className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary rounded-xl py-3.5 font-headline font-bold hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          Send Receipt
        </button>
      </motion.div>

      {/* Voice ordering prompt */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-primary-container rounded-2xl p-8 text-center space-y-6"
      >
        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
          <AudioLines size={40} className="text-primary" />
        </div>
        <div className="space-y-2">
          <h3 className="font-headline text-2xl font-black text-on-surface">Order with Your Voice</h3>
          <p className="text-on-surface/70 font-medium max-w-md mx-auto">
            Use our AI voice assistant to place orders, check loyalty points, and track your meals — all hands-free.
            Tap the mic button to get started.
          </p>
        </div>
      </motion.div>

      {/* Suggestions */}
      <div className="space-y-4">
        <h3 className="font-headline text-xl font-bold text-on-surface/60 uppercase tracking-widest text-center">Try saying...</h3>
        {[
          "Show me the menu",
          "I'd like a Classic Fresh Burger with bacon",
          "Can I get a Grilled Chicken Bowl?",
          "Check my loyalty points",
        ].map((suggestion, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 + i * 0.1 }}
            className="bg-surface-container-high rounded-xl p-5 border border-primary/5 flex items-center gap-4"
          >
            <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
              <Mic size={16} className="text-primary" />
            </div>
            <span className="text-on-surface font-medium italic">"{suggestion}"</span>
          </motion.div>
        ))}
      </div>

      <div className="mt-12 text-center p-8 border-2 border-dashed border-primary/20 rounded-xl">
        <ReceiptText size={32} className="mx-auto text-on-surface/30 mb-3" />
        <p className="text-on-surface/60 font-medium italic">"Your order history will appear here after your first order."</p>
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
    </div>
  );
};
