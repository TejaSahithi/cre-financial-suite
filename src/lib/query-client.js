import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

function isAuthError(error) {
  const status = error?.status ?? error?.statusCode ?? error?.context?.status;
  const message = String(error?.message || '').toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    message.includes('auth') ||
    message.includes('jwt') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  );
}

function isNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('networkerror')
  );
}

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Retry network errors up to 3 times with exponential backoff.
      // Do not retry auth errors — they won't resolve on their own.
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false;
        return failureCount < 3;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15000),
    },
    mutations: {
      onError: (error) => {
        if (isNetworkError(error)) {
          toast.error('Connection lost. Check your internet connection and try again.');
          return;
        }
        if (isAuthError(error)) {
          // Auth errors are handled by AuthContext — don't double-toast.
          return;
        }
        const message = error?.message || 'An unexpected error occurred.';
        toast.error(message);
      },
    },
  },
});
