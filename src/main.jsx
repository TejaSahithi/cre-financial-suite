import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import { registerChunkLoadRecovery } from '@/app/chunkRecovery'
import '@/index.css'

registerChunkLoadRecovery()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
