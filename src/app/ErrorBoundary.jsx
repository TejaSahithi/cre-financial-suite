import React, { Component } from 'react';
import { isChunkLoadError, recoverFromChunkLoadError } from './chunkRecovery';

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

    if (isChunkLoadError(error)) {
      recoverFromChunkLoadError();
    }
  }

  render() {
    if (this.state.hasError) {
      const chunkLoadError = isChunkLoadError(this.state.error);

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
            <div className="w-14 h-14 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">!</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">
              {chunkLoadError ? 'New Application Version Available' : 'Something went wrong'}
            </h2>
            <p className="text-sm text-slate-500 mb-6">
              {chunkLoadError
                ? 'The application was updated or rolled back. Please click below to load the active version.'
                : (this.state.error?.message || 'An unexpected error occurred. Please refresh the page.')}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                if (chunkLoadError) {
                  recoverFromChunkLoadError();
                } else {
                  window.location.reload();
                }
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
