import React from "react";

export default class SemanticPanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("[SemanticPanelBoundary] optional semantic panel failed", error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Semantic details are temporarily unavailable. Core lease review remains available.
        </div>
      );
    }
    return this.props.children;
  }
}