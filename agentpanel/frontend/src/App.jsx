import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import CreateAgent from './components/CreateAgent'
import AgentDetail from './components/AgentDetail'

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="navbar">
          <div className="nav-brand">
            <Link to="/">🤖 AgentPanel</Link>
          </div>
          <div className="nav-links">
            <Link to="/" className="nav-link">Dashboard</Link>
            <Link to="/create" className="nav-link">Create Agent</Link>
          </div>
        </nav>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/create" element={<CreateAgent />} />
            <Route path="/agent/:id" element={<AgentDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
