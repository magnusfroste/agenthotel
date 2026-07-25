import { useState, useEffect } from 'react';
import { authFetch } from '../lib/auth';

function Providers() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    type: 'openai',
    baseUrl: '',
    apiKey: '',
    models: ''
  });
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testModel, setTestModel] = useState('');

  useEffect(() => {
    fetchProviders();
  }, []);

  async function fetchProviders() {
    try {
      const res = await authFetch('/api/providers');
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      console.error('Failed to fetch providers:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleEdit(provider) {
    setEditingProvider(provider);
    setFormData({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || '',
      apiKey: provider.apiKey || '',
      models: Array.isArray(provider.models) ? provider.models.join(', ') : ''
    });
    setShowForm(true);
  }

  function handleAdd() {
    setEditingProvider(null);
    setFormData({
      name: '',
      type: 'openai',
      baseUrl: '',
      apiKey: '',
      models: ''
    });
    setShowForm(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      const modelsArray = formData.models.split(',').map(m => m.trim()).filter(m => m);
      const payload = {
        ...formData,
        models: modelsArray
      };

      const url = editingProvider 
        ? `/api/providers/${editingProvider.id}`
        : '/api/providers';
      const method = editingProvider ? 'PUT' : 'POST';

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setShowForm(false);
        fetchProviders();
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Failed to save provider:', err);
      alert('Failed to save provider');
    }
  }

  async function handleDelete(id) {
    if (!confirm('Are you sure you want to delete this provider?')) return;
    try {
      const res = await authFetch(`/api/providers/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchProviders();
      } else {
        alert('Failed to delete provider');
      }
    } catch (err) {
      console.error('Failed to delete provider:', err);
    }
  }

  async function handleTest(provider) {
    if (!testModel) {
      alert('Please select a model to test');
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch(`/api/providers/${provider.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: testModel })
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      console.error('Test failed:', err);
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleFetchModels(provider) {
    try {
      const res = await authFetch(`/api/providers/${provider.id}/models`);
      const data = await res.json();
      if (Array.isArray(data)) {
        const modelNames = data.map(m => m.id || m.name || m).join(', ');
        setFormData({ ...formData, models: modelNames });
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      alert('Failed to fetch models from provider');
    }
  }

  if (loading) {
    return <div className="loading">Loading providers...</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Providers</h1>
        <button onClick={handleAdd} className="btn btn-primary">+ Add Provider</button>
      </div>

      {showForm && (
        <div style={{
          background: 'var(--bg-secondary)',
          padding: '1.5rem',
          borderRadius: '0.5rem',
          marginBottom: '2rem',
          border: '1px solid var(--border)'
        }}>
          <h2 style={{ marginTop: 0 }}>{editingProvider ? 'Edit Provider' : 'Add Provider'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., OpenAI, Anthropic, Local LLM"
                required
              />
            </div>

            <div className="form-group">
              <label>Type</label>
              <select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              >
                <option value="openai">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div className="form-group">
              <label>Base URL</label>
              <input
                type="url"
                value={formData.baseUrl}
                onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                required
              />
            </div>

            <div className="form-group">
              <label>API Key</label>
              <input
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </div>

            <div className="form-group">
              <label>Models (comma-separated)</label>
              <input
                type="text"
                value={formData.models}
                onChange={(e) => setFormData({ ...formData, models: e.target.value })}
                placeholder="gpt-4, gpt-3.5-turbo"
              />
              {editingProvider && (
                <button
                  type="button"
                  onClick={() => handleFetchModels(editingProvider)}
                  style={{ marginTop: '0.5rem' }}
                  className="btn btn-secondary"
                >
                  Fetch Models from API
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button type="submit" className="btn btn-primary">
                {editingProvider ? 'Update' : 'Add'} Provider
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div style={{ display: 'grid', gap: '1rem' }}>
        {providers.map((provider) => (
          <div
            key={provider.id}
            style={{
              background: 'var(--bg-secondary)',
              padding: '1.5rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--border)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0 }}>{provider.name}</h3>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                  <div><strong>Type:</strong> {provider.type}</div>
                  <div><strong>URL:</strong> {provider.baseUrl}</div>
                  {provider.apiKey && (
                    <div><strong>API Key:</strong> •••••{provider.apiKey.slice(-4)}</div>
                  )}
                  {provider.models && provider.models.length > 0 && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <strong>Models:</strong>
                      <div style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                        {Array.isArray(provider.models) 
                          ? provider.models.join(', ')
                          : provider.models}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleEdit(provider)}
                  className="btn btn-secondary"
                  style={{ padding: '0.5rem 1rem' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="btn btn-danger"
                  style={{ padding: '0.5rem 1rem' }}
                >
                  Delete
                </button>
              </div>
            </div>

            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <select
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">Select model to test...</option>
                  {provider.models && Array.isArray(provider.models) && provider.models.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
                <button
                  onClick={() => handleTest(provider)}
                  disabled={testing || !testModel}
                  className="btn btn-primary"
                  style={{ padding: '0.5rem 1rem' }}
                >
                  {testing ? 'Testing...' : 'Test'}
                </button>
              </div>

              {testResult && (
                <div
                  style={{
                    marginTop: '1rem',
                    padding: '1rem',
                    borderRadius: '0.25rem',
                    background: testResult.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    border: `1px solid ${testResult.success ? '#10b981' : '#ef4444'}`
                  }}
                >
                  {testResult.success ? (
                    <div>
                      <div style={{ fontWeight: 'bold', color: '#10b981', marginBottom: '0.5rem' }}>
                        ✓ Test successful
                      </div>
                      <div style={{ fontSize: '0.875rem' }}>
                        <strong>Response:</strong> {testResult.response}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontWeight: 'bold', color: '#ef4444', marginBottom: '0.5rem' }}>
                        ✗ Test failed
                      </div>
                      <div style={{ fontSize: '0.875rem' }}>
                        <strong>Error:</strong> {testResult.error}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {providers.length === 0 && !showForm && (
          <div style={{
            textAlign: 'center',
            padding: '3rem',
            color: 'var(--text-secondary)'
          }}>
            <p>No providers configured yet.</p>
            <p>Click "Add Provider" to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default Providers;
