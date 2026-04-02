import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle, Clock, MapPin, X, ReceiptText } from 'lucide-react';

interface OrderConfirmationModalProps {
  order: { orderNumber: string; timestamp: Date };
  onClose: () => void;
  onViewOrders: () => void;
}

export const OrderConfirmationModal: React.FC<OrderConfirmationModalProps> = ({
  order,
  onClose,
  onViewOrders,
}) => {
  const formattedTime = order.timestamp.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm px-6"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 30 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="bg-surface rounded-3xl w-full max-w-md overflow-hidden shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header with checkmark */}
          <div className="bg-gradient-to-br from-primary to-primary-dim pt-10 pb-8 px-6 text-center relative">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors"
            >
              <X size={16} className="text-on-primary" />
            </button>

            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.2 }}
              className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4"
            >
              <CheckCircle size={44} className="text-on-primary" />
            </motion.div>

            <h2 className="font-headline text-2xl font-black text-on-primary">
              Order Confirmed!
            </h2>
            <p className="text-on-primary/70 text-sm font-medium mt-1">
              Your order has been placed successfully
            </p>
          </div>

          {/* Order details */}
          <div className="px-6 py-6 space-y-4">
            {/* Order number */}
            <div className="bg-primary-container/30 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
                <ReceiptText size={20} className="text-primary" />
              </div>
              <div>
                <p className="text-on-surface/50 text-xs font-bold uppercase tracking-widest">Order Number</p>
                <p className="font-headline text-lg font-black text-on-surface">{order.orderNumber}</p>
              </div>
            </div>

            {/* Estimated time */}
            <div className="bg-primary-container/30 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
                <Clock size={20} className="text-primary" />
              </div>
              <div>
                <p className="text-on-surface/50 text-xs font-bold uppercase tracking-widest">Estimated Time</p>
                <p className="font-headline text-lg font-black text-on-surface">15–20 minutes</p>
                <p className="text-on-surface/50 text-xs font-medium">Placed at {formattedTime}</p>
              </div>
            </div>

            {/* Location */}
            <div className="bg-primary-container/30 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
                <MapPin size={20} className="text-primary" />
              </div>
              <div>
                <p className="text-on-surface/50 text-xs font-bold uppercase tracking-widest">Pickup Location</p>
                <p className="font-headline text-lg font-black text-on-surface">Scott's Kitchen</p>
                <p className="text-on-surface/50 text-xs font-medium">Market St</p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="px-6 pb-8 flex gap-3">
            <button
              onClick={onViewOrders}
              className="flex-1 flex items-center justify-center gap-2 bg-primary text-on-primary rounded-xl py-4 font-headline font-bold text-lg hover:opacity-90 transition-opacity"
            >
              View Orders
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center gap-2 bg-surface-container-high text-on-surface/70 rounded-xl px-6 py-4 font-headline font-bold text-lg hover:bg-surface-container-highest transition-colors"
            >
              Close
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
