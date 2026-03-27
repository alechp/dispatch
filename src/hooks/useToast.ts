import { createContext, useContext, useState, useCallback, useRef } from "react";

interface ToastState {
  message: string;
  id: number;
}

interface ToastContextValue {
  toast: ToastState | null;
  showToast: (message: string) => void;
}

export const ToastContext = createContext<ToastContextValue>({
  toast: null,
  showToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

export function useToastProvider(): ToastContextValue {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const idRef = useRef(0);

  const showToast = useCallback((message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const id = ++idRef.current;
    setToast({ message, id });
    timerRef.current = setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 3000);
  }, []);

  return { toast, showToast };
}
