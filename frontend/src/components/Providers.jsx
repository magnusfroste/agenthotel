import { useState, useEffect } from 'react';
import { authFetch } from '../lib/auth';
import { useToast } from './Toast';
import { Plus, Edit, Trash2, CheckCircle, XCircle } from 'lucide-react';

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
  const toast = useToast();

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
        toast.success(editingProvider ? 'Provider updated' : 'Provider created');
      } else {
        const err = await res.json();
        toast.error('Error: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Failed to save provider:', err);
      toast.error('Failed to save provider');
    }
  }

  async function handleDelete(id) {
    if (!confirm('Are you sure you want to delete this provider?')) return;
    try {
      const res = await authFetch(`/api/providers/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchProviders();
        toast.success('Provider deleted');
      } else {
        toast.error('Failed to delete provider');
      }
    } catch (err) {
      console.error('Failed to delete provider:', err);
      toast.error('Failed to delete provider');
    }
  }

  async function handleTest(provider) {
    if (!testModel) {
      toast.warning('Please select a model to test');
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
        toast.success(`Fetched ${data.length} models`);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      toast.error('Failed to fetch models from provider');
    }
  }

  if (loading) {
    return (
      <div className="loading">
        <div>
          <div className="loading-spinner" />
          <div>Loading providers...</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Providers</h1>
        <button onClick={handleAdd} className="btn btn-primary">
          <Plus size={18} />
          Add Provider
        </button>
      </div>

      {showForm && (
        <div className="settings-section">
          <h2>{editingProvider ? 'Edit Provider' : 'Add Provider'}</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                type="text"
                className="form-input"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., OpenAI, Anthropic, Local LLM"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select
                className="form-select"
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
              <label className="form-label">Base URL</label>
              <input
                type="url"
                className="form-input"
                value={formData.baseUrl}
                onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">API Key</label>
              <input
                type="password"
                className="form-input"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </div>

            <div className="form-group">
              <label className="form-label">Models (comma-separated)</label>
              <input
                type="text"
                className="form-input"
                value={formData.models}
                onChange={(e) => setFormData({ ...formData, models: e.target.value })}
                placeholder="gpt-4, gpt-3.5-turbo"
              />
              {editingProvider && (
                <button
                  type="button"
                  onClick={() => handleFetchModels(editingProvider)}
                  className="btn btn-secondary"
                  style={{ marginTop: '0.5rem' }}
                >
                  Fetch Models from API
                </button>
              )}
            </div>

            <div className="form-actions">
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

      <div className="grid" style={{ gap: '0.75rem' }}>
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="card"
            style={{ padding: '1rem', cursor: 'default' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '600' }}>{provider.name}</h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                  <span style={{ marginRight: '1rem' }}><strong>Type:</strong> {provider.type}</span>
                  <span><strong>URL:</strong> {provider.baseUrl}</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleEdit(provider)}
                  className="btn btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  <Edit size={14} />
                </button>
                <button
                  onClick={() => handleDelete(provider.id)}
                  className="btn btn-danger"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {provider.apiKey && (
                <div style={{ marginBottom: '0.25rem' }}>
                  <strong>API Key:</strong> •••••{provider.apiKey.slice(-4)}
                </div>
              )}
              {provider.models && provider.models.length > 0 && (
                <div>
                  <strong>Models:</strong> {Array.isArray(provider.models) ? provider.models.join(', ') : provider.models}
                </div>
              )}
            </div>

            <div style={{ paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <select
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                  className="form-select"
                  style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
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
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                >
                  {testing ? 'Testing...' : 'Test'}
                </button>
              </div>

              {testResult && (
                <div
                  className={`alert ${testResult.success ? 'alert-success' : 'alert-error'}`}
                  style={{ marginTop: '0.75rem', padding: '0.75rem', fontSize: '0.8rem' }}
                >
                  {testResult.success ? <CheckCircle size={16} /> : <XCircle size={16} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                      {testResult.success ? '✓ Test successful' : '✗ Test failed'}
                    </div>
                    <div style={{ fontSize: '0.75rem' }}>
                      {testResult.success ? testResult.response : testResult.error}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {providers.length === 0 && !showForm && (
          <div className="empty-state">
            <h2>No providers configured</h2>
            <p>Click "Add Provider" to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default Providers;
