import React, { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught error:', error, info);

    // Auto-recover when a Vercel deployment/rollback invalidates old JS asset chunk hashes
    const isChunkLoadError =
      error?.name === 'ChunkLoadError' ||
      /Failed to fetch dynamically imported module|Failed to load resource/i.test(error?.message || '');

    if (isChunkLoadError && typeof window !== 'undefined') {
      const storageKey = 'last_chunk_reload_ts';
      const lastReload = Number(sessionStorage.getItem(storageKey) || 0);
      const now = Date.now();
      // Reload automatically once if at least 10s has passed since last reload
      if (now - lastReload > 10000) {
        sessionStorage.setItem(storageKey, String(now));
        window.location.reload();
      }
    }
  }

  render() {
    if (this.state.hasError) {
      const isChunkLoadError =
        this.state.error?.name === 'ChunkLoadError' ||
        /Failed to fetch dynamically imported module|Failed to load resource/i.test(this.state.error?.message || '');

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
            <div className="w-14 h-14 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">⚠️</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              {isChunkLoadError ? 'New Application Version Available' : 'Something went wrong'}
            </h2>
            <p className="text-sm text-slate-500 mb-6">
              {isChunkLoadError
                ? 'The application was updated or rolled back. Please click below to load the active version.'
                : (this.state.error?.message || 'An unexpected error occurred. Please refresh the page.')}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="w-full h-11 bg-[#1a2744] hover:bg-[#243b67] text-white font-semibold rounded-xl transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
