import { useState, useEffect } from 'react'
import { authFetch } from '../lib/auth'

function Profile() {
  const [profile, setProfile] = useState({ email: '' })
  const [newEmail, setNewEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetchProfile()
  }, [])

  async function fetchProfile() {
    try {
      const res = await authFetch('/api/profile')
      const data = await res.json()
      setProfile(data)
      setNewEmail(data.email)
    } catch (err) {
      console.error('Failed to fetch profile:', err)
    }
  }

  async function handleUpdateEmail(e) {
    e.preventDefault()
    if (!newEmail || newEmail === profile.email) return

    setLoading(true)
    setMessage('')

    try {
      const res = await authFetch('/api/profile/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, password: currentPassword })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update email')
      }

      setMessage('Email updated successfully!')
      setProfile({ ...profile, email: newEmail })
      setCurrentPassword('')
    } catch (err) {
      setMessage('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdatePassword(e) {
    e.preventDefault()
    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage('Error: All password fields are required')
      return
    }

    if (newPassword !== confirmPassword) {
      setMessage('Error: New passwords do not match')
      return
    }

    if (newPassword.length < 8) {
      setMessage('Error: New password must be at least 8 characters')
      return
    }

    setLoading(true)
    setMessage('')

    try {
      const res = await authFetch('/api/profile/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update password')
      }

      setMessage('Password updated successfully!')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setMessage('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Profile</h1>

      {message && (
        <div style={{
          padding: '1rem',
          marginBottom: '1.5rem',
          background: message.startsWith('Error') ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
          border: `1px solid ${message.startsWith('Error') ? '#ef4444' : '#10b981'}`,
          borderRadius: '0.5rem',
          color: message.startsWith('Error') ? '#ef4444' : '#10b981'
        }}>
          {message}
        </div>
      )}

      <div style={{
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        padding: '1.5rem',
        marginBottom: '2rem'
      }}>
        <h2 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem' }}>📧 Email Address</h2>
        <form onSubmit={handleUpdateEmail}>
          <div className="form-group">
            <label>Current Email</label>
            <input
              type="email"
              value={profile.email}
              disabled
              style={{ opacity: 0.6, cursor: 'not-allowed' }}
            />
          </div>

          <div className="form-group">
            <label>New Email</label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new.email@example.com"
              required
            />
          </div>

          <div className="form-group">
            <label>Current Password (required to change email)</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter your current password"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Updating...' : 'Update Email'}
          </button>
        </form>
      </div>

      <div style={{
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        padding: '1.5rem'
      }}>
        <h2 style={{ margin: '0 0 1.5rem 0', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Lock size={20} color="white" />
          Change Password
        </h2>
        <form onSubmit={handleUpdatePassword}>
          <div className="form-group">
            <label>Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter your current password"
              required
            />
          </div>

          <div className="form-group">
            <label>New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password (min 8 characters)"
              required
            />
          </div>

          <div className="form-group">
            <label>Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default Profile
