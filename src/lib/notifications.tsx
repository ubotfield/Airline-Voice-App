import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface ActionNotification {
  id: string;
  type: 'miles_check' | 'miles_credit' | 'upgrade_eligible' | 'upgrade_complete' | 'flight_status' | 'seat_map' | 'loyalty_info' | 'recent_flights' | 'generic';
  title: string;
  subtitle: string;
  details?: { label: string; value: string }[];
  icon: 'check_circle' | 'star' | 'flight' | 'airline_seat_recline_normal' | 'credit_card' | 'info' | 'luggage';
  variant: 'success' | 'info' | 'warning';
  timestamp: number;
}

interface NotificationContextType {
  notifications: ActionNotification[];
  addNotification: (n: Omit<ActionNotification, 'id' | 'timestamp'>) => void;
  dismissNotification: (id: string) => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  addNotification: () => {},
  dismissNotification: () => {},
  clearAll: () => {},
});

export const useNotifications = () => useContext(NotificationContext);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<ActionNotification[]>([]);
  const counterRef = useRef(0);

  const addNotification = useCallback((n: Omit<ActionNotification, 'id' | 'timestamp'>) => {
    const id = `notif-${++counterRef.current}-${Date.now()}`;
    setNotifications(prev => [{ ...n, id, timestamp: Date.now() }, ...prev].slice(0, 5));

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
      setNotifications(prev => prev.filter(notif => notif.id !== id));
    }, 15000);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, dismissNotification, clearAll }}>
      {children}
    </NotificationContext.Provider>
  );
};

/**
 * Parse an agent response text to detect which action was invoked
 * and create appropriate notification data.
 */
export function parseAgentResponse(text: string): Omit<ActionNotification, 'id' | 'timestamp'> | null {
  const lower = text.toLowerCase();

  // Miles check / loyalty info
  if (lower.includes('miles') && (lower.includes('balance') || lower.includes('available') || lower.includes('status'))) {
    const milesMatch = text.match(/([\d,]+)\s*miles/i);
    const tierMatch = text.match(/(gold|silver|platinum|diamond)\s*medallion/i);
    return {
      type: 'miles_check',
      title: 'SkyMiles Balance',
      subtitle: milesMatch ? `${milesMatch[1]} miles available` : 'Miles info retrieved',
      details: [
        ...(milesMatch ? [{ label: 'Balance', value: `${milesMatch[1]} miles` }] : []),
        ...(tierMatch ? [{ label: 'Status', value: `${tierMatch[1]} Medallion` }] : []),
      ],
      icon: 'star',
      variant: 'info',
    };
  }

  // Miles credited
  if (lower.includes('credit') && lower.includes('miles')) {
    const milesMatch = text.match(/([\d,]+)\s*miles/i);
    return {
      type: 'miles_credit',
      title: 'Miles Credited',
      subtitle: milesMatch ? `${milesMatch[1]} miles added to your account` : 'Miles have been credited',
      details: milesMatch ? [{ label: 'Credited', value: `${milesMatch[1]} miles` }] : [],
      icon: 'check_circle',
      variant: 'success',
    };
  }

  // Upgrade eligible
  if (lower.includes('upgrade') && (lower.includes('eligible') || lower.includes('available'))) {
    const cabinMatch = text.match(/(first class|delta one|comfort\+|premium select)/i);
    const priceMatch = text.match(/\$(\d+)/);
    const milesMatch = text.match(/([\d,]+)\s*miles/i);
    return {
      type: 'upgrade_eligible',
      title: 'Upgrade Available',
      subtitle: cabinMatch ? `${cabinMatch[1]} upgrade option found` : 'Upgrade options available',
      details: [
        ...(cabinMatch ? [{ label: 'Cabin', value: cabinMatch[1] }] : []),
        ...(milesMatch ? [{ label: 'Miles', value: `${milesMatch[1]} miles` }] : []),
        ...(priceMatch ? [{ label: 'Cash', value: `$${priceMatch[1]}` }] : []),
      ],
      icon: 'airline_seat_recline_normal',
      variant: 'info',
    };
  }

  // Upgrade confirmed
  if (lower.includes('upgrade') && (lower.includes('confirmed') || lower.includes('processed') || lower.includes('complete'))) {
    const seatMatch = text.match(/seat\s*(\w+)/i);
    return {
      type: 'upgrade_complete',
      title: 'Upgrade Confirmed',
      subtitle: seatMatch ? `New seat: ${seatMatch[1]}` : 'Your upgrade has been processed',
      details: seatMatch ? [{ label: 'New Seat', value: seatMatch[1] }] : [],
      icon: 'check_circle',
      variant: 'success',
    };
  }

  // Flight status
  if (lower.includes('flight') && (lower.includes('on time') || lower.includes('delayed') || lower.includes('departed') || lower.includes('arrived') || lower.includes('gate'))) {
    const flightMatch = text.match(/DL\s*\d+/i);
    const gateMatch = text.match(/gate\s*(\w+)/i);
    const statusMatch = text.match(/(on time|delayed|departed|arrived|boarding)/i);
    return {
      type: 'flight_status',
      title: 'Flight Status',
      subtitle: flightMatch ? `${flightMatch[0]} — ${statusMatch?.[1] || 'Updated'}` : 'Flight info updated',
      details: [
        ...(flightMatch ? [{ label: 'Flight', value: flightMatch[0] }] : []),
        ...(statusMatch ? [{ label: 'Status', value: statusMatch[1] }] : []),
        ...(gateMatch ? [{ label: 'Gate', value: gateMatch[1] }] : []),
      ],
      icon: 'flight',
      variant: statusMatch?.[1]?.toLowerCase() === 'delayed' ? 'warning' : 'info',
    };
  }

  // Recent flights
  if (lower.includes('recent') && lower.includes('flight')) {
    const countMatch = text.match(/found\s*(\d+)/i);
    return {
      type: 'recent_flights',
      title: 'Recent Flights',
      subtitle: countMatch ? `${countMatch[1]} flights found` : 'Flight history retrieved',
      details: [],
      icon: 'flight',
      variant: 'info',
    };
  }

  // Loyalty info
  if (lower.includes('loyalty') || lower.includes('medallion') || lower.includes('skymiles')) {
    const tierMatch = text.match(/(gold|silver|platinum|diamond)\s*medallion/i);
    return {
      type: 'loyalty_info',
      title: 'Loyalty Status',
      subtitle: tierMatch ? `${tierMatch[1]} Medallion Member` : 'Loyalty info retrieved',
      details: tierMatch ? [{ label: 'Tier', value: `${tierMatch[1]} Medallion` }] : [],
      icon: 'star',
      variant: 'info',
    };
  }

  // If text is long enough and seems like a substantive response, show generic
  if (text.length > 50) {
    return {
      type: 'generic',
      title: 'Voice Request Processed',
      subtitle: text.substring(0, 80) + (text.length > 80 ? '...' : ''),
      details: [],
      icon: 'info',
      variant: 'info',
    };
  }

  return null;
}
