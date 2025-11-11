import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

import Home from './pages/Home'
import Room from './pages/Room'

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<Room />} />
    </Routes>
  </BrowserRouter>
)
