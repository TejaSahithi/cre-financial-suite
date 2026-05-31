import React from 'react';
import { Toaster } from "@/components/ui/sonner";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { AuthProvider } from '@/lib/AuthContext';
import { ModuleAccessProvider } from '@/lib/ModuleAccessContext';
import ErrorBoundary from './ErrorBoundary';

export default function AppProviders({ children }) {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <QueryClientProvider client={queryClientInstance}>
          <ModuleAccessProvider>
            {children}
          </ModuleAccessProvider>
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
